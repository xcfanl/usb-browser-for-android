package com.usbfile.usbstorage

import me.jahnen.libaums.core.driver.BlockDeviceDriver

/**
 * exFAT / NTFS formatting in direct mode: an MBR with one partition (type 0x07) starting at
 * 1 MiB, the file system created by mkexfatfs (relan/exfat) or mkntfs (ntfs-3g).
 */
internal object NativeFormatter {
  /** Validates the volume label for [type]; returns the trimmed label. */
  fun normalizeLabel(type: Int, label: String): String {
    val l = label.trim()
    val max = if (type == NativeFs.EXFAT) 11 else 32
    // exFAT stores at most 11 UTF-16 code units
    if (l.length > max) throw UserError("${if (type == NativeFs.EXFAT) "exFAT" else "NTFS"} 卷标最多 $max 个字符")
    if (l.any { it.code < 0x20 || "\"*/:<>?\\|".indexOf(it) >= 0 }) {
      throw UserError("卷标不能包含 \\ / : * ? \" < > | 等字符")
    }
    return l
  }

  fun checkSize(raw: BlockDeviceDriver) {
    // libaums issues 32-bit SCSI READ(10)/WRITE(10) with a signed int LBA; MBR fields are 32-bit
    if (raw.blocks > Int.MAX_VALUE.toLong()) {
      throw UserError("容量过大（超过 ${Int.MAX_VALUE.toLong() * raw.blockSize / (1L shl 30)} GiB），无法在直接模式下格式化")
    }
    if (raw.blocks * raw.blockSize < 16L shl 20) throw UserError("容量太小（至少需要 16 MB）")
  }

  fun format(raw: BlockDeviceDriver, type: Int, label: String, syncCache: () -> Unit) {
    checkSize(raw)
    val bs = raw.blockSize
    val start = (1024L * 1024L) / bs
    val sectors = raw.blocks - start
    // 1. partition table area and backup GPT, plus the start of the partition (old boot sectors)
    Mbr.wipe(raw, start)
    Fat32Formatter.zero(raw, start, minOf(sectors, start))
    // 2. file system
    NativeFs.format(ScsiPartitionDevice(raw, start, sectors, syncCache), type, start, label)
    // 3. MBR last, so an interrupted format never leaves a valid-looking volume
    Mbr.write(raw, start, sectors, 0x07)
  }
}
