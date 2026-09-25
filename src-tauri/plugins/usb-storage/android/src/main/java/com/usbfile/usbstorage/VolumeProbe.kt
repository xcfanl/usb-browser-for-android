package com.usbfile.usbstorage

import android.util.Log
import me.jahnen.libaums.core.driver.BlockDeviceDriver
import me.jahnen.libaums.core.driver.ByteBlockDevice
import me.jahnen.libaums.core.fs.FileSystemFactory
import me.jahnen.libaums.core.partition.PartitionTableEntry
import me.jahnen.libaums.core.partition.PartitionTableFactory
import org.jnode.fs.BlockDeviceFileSystemType
import org.jnode.fs.exfat.ExFatFileSystemType
import org.jnode.fs.ext2.Ext2FileSystemType
import org.jnode.fs.hfsplus.HfsPlusFileSystemType
import org.jnode.fs.ntfs.NTFSFileSystemType
import java.nio.ByteBuffer

/** Result of probing a whole block device for a usable file system. */
internal class ProbeResult(
  val fs: RawFs?,
  /** Detected file-system name, also when it could not be opened (e.g. "F2FS"). */
  val detected: String,
  val error: String,
)

/** Finds partitions on [raw] (LBA addressed) and opens the first supported file system. */
internal object VolumeProbe {
  private const val TAG = "UsbStorage"

  fun readBytes(dev: BlockDeviceDriver, byteOffset: Long, len: Int): ByteArray {
    val b = ByteBuffer.allocate(len)
    return try {
      dev.read(byteOffset, b)
      b.array()
    } catch (e: Exception) {
      ByteArray(len)
    }
  }

  private fun jnodeTypes(): List<Pair<String, BlockDeviceFileSystemType<*>>> = listOf(
    "exFAT" to ExFatFileSystemType(),
    "NTFS" to NTFSFileSystemType(),
    "ext" to Ext2FileSystemType(),
    "FAT" to org.jnode.fs.jfat.FatFileSystemType(),
    "HFS+" to HfsPlusFileSystemType(),
  )

  fun partitions(raw: BlockDeviceDriver): List<PartitionTableEntry> {
    val head = readBytes(ByteBlockDevice(raw, 0), 0, maxOf(4096, raw.blockSize))
    // "Superfloppy" (no partition table): the MBR parser would misread boot code as partitions
    if (FsSniffer.looksLikeVbr(head)) return listOf(PartitionTableEntry(0, 0, raw.blocks))
    val entries = try {
      PartitionTableFactory.createPartitionTable(raw).partitionTableEntries
    } catch (e: Exception) {
      Log.i(TAG, "no partition table: $e")
      emptyList()
    }
    return entries.ifEmpty { listOf(PartitionTableEntry(0, 0, raw.blocks)) }
  }

  /** [syncCache] commits the drive's write cache (SCSI SYNCHRONIZE CACHE). */
  fun probe(raw: BlockDeviceDriver, syncCache: () -> Unit = {}): ProbeResult {
    val bs = raw.blockSize
    var detected = ""
    var lastError = ""
    for (entry in partitions(raw)) {
      val part = ByteBlockDevice(raw, entry.logicalBlockAddress)
      val head = readBytes(part, 0, 4096)
      val sb = readBytes(part, 1024, 1024)
      val kind = FsSniffer.sniff(head, sb)
      if (detected.isEmpty() && kind != null) detected = kind
      val sectors = if (entry.totalNumberOfSectors > 0) entry.totalNumberOfSectors
      else raw.blocks - entry.logicalBlockAddress

      // 1. FAT32 via libaums (read + write)
      if (FsSniffer.isFat32(head)) {
        try {
          return ProbeResult(AumsFs(FileSystemFactory.createFileSystem(entry, FatMirrorDevice.wrap(part, head))), "FAT32", "")
        } catch (e: Exception) {
          Log.w(TAG, "libaums FAT32 failed", e)
          lastError = e.message ?: e.toString()
        }
      }
      // 2. exFAT / NTFS via the native libraries (read + write; read-only if unsafe to write)
      if ((kind == "exFAT" || kind == "NTFS") && NativeFs.available) {
        val type = if (kind == "NTFS") NativeFs.NTFS else NativeFs.EXFAT
        val dev = ScsiPartitionDevice(raw, entry.logicalBlockAddress.toLong(), sectors, syncCache)
        for (ro in listOf(false, true)) {
          try {
            return ProbeResult(NativeRawFs.mount(dev, type, entry.logicalBlockAddress.toLong(), ro), kind, "")
          } catch (e: Throwable) {
            Log.w(TAG, "native $kind mount (ro=$ro) failed", e)
            lastError = e.message ?: e.toString()
          }
        }
      }
      // 3. everything else (and fallback) via java-fs, read-only
      val api = JnodeBlockApi(part, bs, sectors * bs)
      for ((name, type) in jnodeTypes()) {
        try {
          if (!type.supports(api.partitionTableEntry, head, api)) continue
          val jfs = type.create(JnodeDevice(api), true)
          val shown = when (name) {
            "ext" -> kind ?: "ext2/3/4"
            "FAT" -> kind ?: "FAT"
            else -> name
          }
          return ProbeResult(JnodeFs(jfs, shown, sectors * bs), shown, "")
        } catch (e: Throwable) {
          Log.w(TAG, "java-fs $name failed", e)
          lastError = "$name: ${e.message ?: e.toString()}"
        }
      }
    }
    val msg = when {
      detected.isNotEmpty() && lastError.isNotEmpty() -> "无法读取 $detected 文件系统（$lastError）"
      detected.isNotEmpty() -> "不支持的文件系统：$detected"
      else -> "无法识别的文件系统（可能未格式化或分区表损坏）"
    }
    return ProbeResult(null, detected, msg)
  }
}
