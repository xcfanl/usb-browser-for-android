package com.usbfile.usbstorage

import me.jahnen.libaums.core.driver.BlockDeviceDriver
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.random.Random

/**
 * Writes a fresh MBR (one FAT32 LBA partition, type 0x0C, starting at 1 MiB) and a FAT32
 * file system following Microsoft's "FAT: General Overview of On-Disk Format" (fatgen103).
 * [raw] is the whole-device SCSI block device (LBA addressed).
 */
internal object Fat32Formatter {
  private const val RESERVED_MIN = 32
  private const val NUM_FATS = 2
  private const val MIN_CLUSTERS = 65525L
  private const val MAX_CLUSTERS = 0x0FFFFFF5L

  /** Validates / normalizes an 11 byte FAT volume label (ASCII only, upper case). */
  fun normalizeLabel(label: String): String {
    val l = label.trim().uppercase()
    if (l.length > 11) throw UserError("卷标最多 11 个字符")
    for (c in l) {
      if (c.code < 0x20 || c.code > 0x7e || "\"*+,./:;<=>?[\\]|".indexOf(c) >= 0) {
        throw UserError("FAT32 卷标仅支持英文字母、数字、空格和 - _ 等符号")
      }
    }
    return l
  }

  data class Layout(
    val bps: Int, val start: Long, val sectors: Long, val spc: Int,
    val reserved: Int, val fatSize: Long, val clusters: Long,
  )

  fun plan(bps: Int, deviceBlocks: Long): Layout {
    if (bps !in intArrayOf(512, 1024, 2048, 4096)) throw UserError("不支持的扇区大小：$bps")
    val start = (1024L * 1024L) / bps // 1 MiB alignment
    val sectors = deviceBlocks - start
    // libaums issues 32-bit SCSI READ(10)/WRITE(10) with a signed int LBA; MBR fields are 32-bit
    if (deviceBlocks > Int.MAX_VALUE.toLong()) throw UserError("容量过大（超过 ${Int.MAX_VALUE.toLong() * bps / (1L shl 30)} GiB），无法在直接模式下格式化为 FAT32")
    if (sectors <= 0) throw UserError("容量太小")
    val bytes = sectors * bps
    // Microsoft default cluster sizes for FAT32
    val clusterBytes = when {
      bytes <= 260L shl 20 -> 512
      bytes <= 8L shl 30 -> 4096
      bytes <= 16L shl 30 -> 8192
      bytes <= 32L shl 30 -> 16384
      else -> 32768
    }
    var spc = maxOf(1, clusterBytes / bps)
    while (true) {
      val l = layoutFor(bps, start, sectors, spc)
      when {
        l.clusters < MIN_CLUSTERS && spc > 1 -> spc /= 2
        l.clusters < MIN_CLUSTERS -> throw UserError("容量太小（需要至少约 33 MB），无法格式化为 FAT32")
        l.clusters > MAX_CLUSTERS && spc * bps < 65536 -> spc *= 2
        l.clusters > MAX_CLUSTERS -> throw UserError("容量过大，无法格式化为 FAT32")
        else -> return l
      }
    }
  }

  private fun layoutFor(bps: Int, start: Long, sectors: Long, spc: Int): Layout {
    val entriesPerSector = bps / 4
    // smallest FAT size F with F*entriesPerSector >= clusters + 2
    val d = sectors - RESERVED_MIN
    val fat = (d + 2L * spc + (entriesPerSector.toLong() * spc + NUM_FATS) - 1) /
      (entriesPerSector.toLong() * spc + NUM_FATS)
    // pad reserved area so the data region starts on a cluster boundary
    val pad = ((spc - ((RESERVED_MIN + NUM_FATS * fat) % spc)) % spc).toInt()
    val reserved = RESERVED_MIN + pad
    val clusters = (sectors - reserved - NUM_FATS * fat) / spc
    return Layout(bps, start, sectors, spc, reserved, fat, clusters)
  }

  fun format(raw: BlockDeviceDriver, label: String) {
    val lbl = normalizeLabel(label)
    val l = plan(raw.blockSize, raw.blocks)
    val bps = l.bps

    // 1. wipe partition table area (MBR + old GPT header/entries) and the GPT backup at the end
    zero(raw, 0, l.start)
    zero(raw, raw.blocks - 34, 34)

    // 2. reserved area + both FATs + root directory cluster
    val dataStart = l.start + l.reserved + NUM_FATS * l.fatSize
    zero(raw, l.start, l.reserved + NUM_FATS * l.fatSize + l.spc)

    // 3. boot sector (+ backup), FSInfo (+ backup)
    val volId = Random.nextInt()
    val boot = bootSector(l, lbl, volId)
    write(raw, l.start, boot)
    write(raw, l.start + 6, boot)
    val info = fsInfo(l)
    write(raw, l.start + 1, info)
    write(raw, l.start + 7, info)
    // sector 2 (and backup 8) of the FAT32 boot region carry the 0xAA55 signature too
    val third = sector(bps).also { it.put(510, 0x55); it.put(511, 0xAA.toByte()) }
    write(raw, l.start + 2, third)
    write(raw, l.start + 8, third)

    // 4. first FAT sectors: media descriptor, EOC, root directory cluster (2) = EOC
    val fat0 = sector(bps)
    fat0.putInt(0, 0x0FFFFFF8)
    fat0.putInt(4, 0x0FFFFFFF)
    fat0.putInt(8, 0x0FFFFFFF)
    for (i in 0 until NUM_FATS) write(raw, l.start + l.reserved + i * l.fatSize, fat0)

    // 5. root directory: volume label entry
    if (lbl.isNotEmpty()) {
      val root = sector(bps)
      val name = lbl.padEnd(11, ' ').toByteArray(Charsets.US_ASCII)
      for (i in 0 until 11) root.put(i, name[i])
      root.put(11, 0x08) // ATTR_VOLUME_ID
      write(raw, dataStart, root)
    }

    // 6. MBR last, so an interrupted format never leaves a valid-looking volume
    write(raw, 0, mbr(l))
  }

  private fun sector(bps: Int): ByteBuffer = ByteBuffer.allocate(bps).order(ByteOrder.LITTLE_ENDIAN)

  private fun write(raw: BlockDeviceDriver, lba: Long, buf: ByteBuffer) {
    buf.clear()
    raw.write(lba, buf)
  }

  private fun zero(raw: BlockDeviceDriver, lba: Long, count: Long) {
    if (count <= 0) return
    val bps = raw.blockSize
    val chunkSectors = maxOf(1, (64 * 1024) / bps)
    val buf = ByteBuffer.allocate(chunkSectors * bps)
    var done = 0L
    while (done < count) {
      val n = minOf(chunkSectors.toLong(), count - done).toInt()
      buf.clear()
      buf.limit(n * bps)
      raw.write(lba + done, buf)
      done += n
    }
  }

  private fun bootSector(l: Layout, label: String, volId: Int): ByteBuffer {
    val b = sector(l.bps)
    b.put(0, 0xEB.toByte()); b.put(1, 0x58); b.put(2, 0x90.toByte())
    "MSWIN4.1".toByteArray(Charsets.US_ASCII).forEachIndexed { i, c -> b.put(3 + i, c) }
    b.putShort(11, l.bps.toShort())
    b.put(13, l.spc.toByte())
    b.putShort(14, l.reserved.toShort())
    b.put(16, NUM_FATS.toByte())
    b.putShort(17, 0) // root entries (FAT32: 0)
    b.putShort(19, 0) // total sectors 16
    b.put(21, 0xF8.toByte()) // media: fixed
    b.putShort(22, 0) // FAT size 16
    b.putShort(24, 63) // sectors per track
    b.putShort(26, 255) // heads
    b.putInt(28, l.start.toInt()) // hidden sectors
    b.putInt(32, l.sectors.toInt()) // total sectors 32
    b.putInt(36, l.fatSize.toInt())
    b.putShort(40, 0) // ext flags: FAT mirroring
    b.putShort(42, 0) // version 0.0
    b.putInt(44, 2) // root cluster
    b.putShort(48, 1) // FSInfo sector
    b.putShort(50, 6) // backup boot sector
    b.put(64, 0x80.toByte()) // drive number
    b.put(66, 0x29) // extended boot signature
    b.putInt(67, volId)
    val lab = (if (label.isEmpty()) "NO NAME" else label).padEnd(11, ' ').toByteArray(Charsets.US_ASCII)
    for (i in 0 until 11) b.put(71 + i, lab[i])
    "FAT32   ".toByteArray(Charsets.US_ASCII).forEachIndexed { i, c -> b.put(82 + i, c) }
    // boot code: "not bootable" loop (hlt; jmp $-1)
    b.put(90, 0xF4.toByte()); b.put(91, 0xEB.toByte()); b.put(92, 0xFD.toByte())
    b.put(510, 0x55); b.put(511, 0xAA.toByte())
    return b
  }

  private fun fsInfo(l: Layout): ByteBuffer {
    val b = sector(l.bps)
    b.putInt(0, 0x41615252)
    b.putInt(484, 0x61417272)
    b.putInt(488, (l.clusters - 1).toInt()) // free clusters (root dir uses one)
    b.putInt(492, 3) // next free hint
    b.putInt(508, 0xAA550000.toInt())
    return b
  }

  private fun mbr(l: Layout): ByteBuffer {
    val b = sector(l.bps)
    val e = 446
    b.put(e, 0x00) // not bootable
    b.put(e + 1, 0xFE.toByte()); b.put(e + 2, 0xFF.toByte()); b.put(e + 3, 0xFF.toByte()) // CHS: use LBA
    b.put(e + 4, 0x0C) // FAT32 LBA
    b.put(e + 5, 0xFE.toByte()); b.put(e + 6, 0xFF.toByte()); b.put(e + 7, 0xFF.toByte())
    b.putInt(e + 8, l.start.toInt())
    b.putInt(e + 12, l.sectors.toInt())
    b.putInt(440, Random.nextInt()) // disk signature
    b.put(510, 0x55); b.put(511, 0xAA.toByte())
    return b
  }
}
