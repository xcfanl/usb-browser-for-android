package com.usbfile.usbstorage

import android.util.Log
import me.jahnen.libaums.core.driver.BlockDeviceDriver
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer

/**
 * JNI binding of libusbfs.so: exFAT (relan/exfat) and NTFS (ntfs-3g), read-write, plus
 * mkexfatfs / mkntfs. Strings cross the boundary as UTF-8 byte arrays. Not thread safe:
 * all calls must come from the plugin's single I/O thread.
 */
internal object NativeFs {
  const val EXFAT = 1
  const val NTFS = 2

  /** Why the native library is unavailable, or null when it is loaded. */
  val loadError: String?

  init {
    loadError = try {
      // host unit tests load the library from an explicit path
      val override = System.getProperty("usbfs.native.lib")
      if (!override.isNullOrEmpty()) System.load(override) else System.loadLibrary("usbfs")
      null
    } catch (e: Throwable) {
      runCatching { Log.w("UsbStorage", "libusbfs unavailable", e) }
      e.toString()
    }
  }

  val available get() = loadError == null

  @JvmStatic external fun registerDevice(dev: NativeBlockDevice, size: Long, sectorSize: Int, partStart: Long): Int
  @JvmStatic external fun unregisterDevice(slot: Int)
  @JvmStatic external fun mount(type: Int, slot: Int, readOnly: Boolean): Long
  @JvmStatic external fun unmount(h: Long)
  @JvmStatic external fun isReadOnly(h: Long): Boolean
  @JvmStatic external fun roReason(h: Long): ByteArray
  @JvmStatic external fun label(h: Long): ByteArray
  @JvmStatic external fun space(h: Long): LongArray
  @JvmStatic external fun list(h: Long, path: ByteArray): ByteArray
  @JvmStatic external fun stat(h: Long, path: ByteArray): ByteArray?
  @JvmStatic external fun read(h: Long, path: ByteArray, offset: Long, buf: ByteArray, len: Int): Int
  @JvmStatic external fun openWrite(h: Long, path: ByteArray): Long
  @JvmStatic external fun write(h: Long, fh: Long, offset: Long, buf: ByteArray, len: Int)
  @JvmStatic external fun closeWrite(h: Long, fh: Long)
  @JvmStatic external fun mkdir(h: Long, path: ByteArray)
  @JvmStatic external fun remove(h: Long, path: ByteArray)
  @JvmStatic external fun rename(h: Long, from: ByteArray, to: ByteArray)
  @JvmStatic external fun sync(h: Long)
  @JvmStatic external fun mkfs(type: Int, slot: Int, label: ByteArray)

  fun typeOf(name: String): Int = when (name.lowercase()) {
    "exfat" -> EXFAT
    "ntfs" -> NTFS
    else -> throw UserError("不支持的文件系统：$name")
  }

  /** Creates a file system of [type] on [dev] (a partition starting at sector [partStart]). */
  fun format(dev: NativeBlockDevice, type: Int, partStart: Long, label: String) {
    if (!available) throw UserError("原生 exFAT/NTFS 组件加载失败：$loadError")
    val slot = registerDevice(dev, dev.sizeBytes, dev.sectorSize, partStart)
    try {
      mkfs(type, slot, label.toByteArray(Charsets.UTF_8))
      dev.sync()
    } finally {
      unregisterDevice(slot)
    }
  }
}

/**
 * Byte-addressed block device handed to the native code. Offsets are relative to the start
 * of the partition. Called from JNI with the plugin's shared 1 MiB transfer buffer.
 */
internal abstract class NativeBlockDevice(val sectorSize: Int, val sizeBytes: Long) {
  /** Reads [len] bytes at [offset] into buf[0 until len]. */
  abstract fun read(offset: Long, buf: ByteArray, len: Int): Int
  /** Writes buf[0 until len] at [offset]. */
  abstract fun write(offset: Long, buf: ByteArray, len: Int): Int
  /** Commits written data to stable storage. */
  abstract fun sync()

  protected fun checkRange(offset: Long, len: Int) {
    if (offset < 0 || len < 0 || offset + len > sizeBytes) {
      throw IOException("access beyond end of partition (offset=$offset len=$len size=$sizeBytes)")
    }
  }
}

/**
 * A partition on a libaums SCSI block device ([raw] is LBA addressed). Sub-sector accesses are
 * done with read-modify-write; small reads go through a 64 KiB-chunk LRU cache (libntfs-3g and
 * libexfat issue many small metadata reads, each of which would otherwise be a SCSI round trip).
 * Writes are write-through and update cached chunks.
 */
internal class ScsiPartitionDevice(
  private val raw: BlockDeviceDriver,
  private val startLba: Long,
  sectors: Long,
  private val syncCache: () -> Unit,
) : NativeBlockDevice(raw.blockSize, sectors * raw.blockSize) {
  private val bs = raw.blockSize
  // many USB bridges reject large transfers (Linux usb-storage defaults to 120 KiB)
  private val maxXfer = maxOf(bs, 64 * 1024 / bs * bs)
  private val chunk = 64 * 1024
  private val cache = object : LinkedHashMap<Long, ByteArray>(256, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Long, ByteArray>?) = size > 128
  }

  /** Aligned read of whole sectors directly from the medium. */
  private fun rawRead(byteOff: Long, dst: ByteArray, dstOff: Int, len: Int) {
    var done = 0
    while (done < len) {
      val n = minOf(maxXfer, len - done)
      raw.read(startLba + (byteOff + done) / bs, ByteBuffer.wrap(dst, dstOff + done, n))
      done += n
    }
  }

  private fun rawWrite(byteOff: Long, src: ByteArray, srcOff: Int, len: Int) {
    var done = 0
    while (done < len) {
      val n = minOf(maxXfer, len - done)
      raw.write(startLba + (byteOff + done) / bs, ByteBuffer.wrap(src, srcOff + done, n))
      done += n
    }
  }

  private fun chunkAt(index: Long): ByteArray {
    cache[index]?.let { return it }
    val off = index * chunk
    val len = minOf(chunk.toLong(), sizeBytes - off).toInt()
    val b = ByteArray(len)
    rawRead(off, b, 0, len)
    cache[index] = b
    return b
  }

  override fun read(offset: Long, buf: ByteArray, len: Int): Int {
    checkRange(offset, len)
    if (len >= chunk && offset % bs == 0L && len % bs == 0) {
      rawRead(offset, buf, 0, len)
      // cached chunks are kept coherent by write(), so they cannot be stale here
      return len
    }
    var done = 0
    while (done < len) {
      val pos = offset + done
      val c = chunkAt(pos / chunk)
      val inChunk = (pos % chunk).toInt()
      val n = minOf(len - done, c.size - inChunk)
      System.arraycopy(c, inChunk, buf, done, n)
      done += n
    }
    return len
  }

  override fun write(offset: Long, buf: ByteArray, len: Int): Int {
    checkRange(offset, len)
    if (offset % bs == 0L && len % bs == 0) {
      rawWrite(offset, buf, 0, len)
    } else {
      // read-modify-write of the covering sectors
      val first = offset / bs * bs
      val end = (offset + len + bs - 1) / bs * bs
      val tmp = ByteArray((end - first).toInt())
      read(first, tmp, tmp.size)
      System.arraycopy(buf, 0, tmp, (offset - first).toInt(), len)
      rawWrite(first, tmp, 0, tmp.size)
    }
    // keep cached chunks coherent
    var i = offset / chunk
    while (i * chunk < offset + len) {
      cache[i]?.let { c ->
        val cStart = i * chunk
        val from = maxOf(offset, cStart)
        val to = minOf(offset + len, cStart + c.size)
        if (to > from) System.arraycopy(buf, (from - offset).toInt(), c, (from - cStart).toInt(), (to - from).toInt())
      }
      i++
    }
    return len
  }

  override fun sync() = syncCache()
}

/** File-backed device for host unit tests (a partition inside an image file). */
internal class FileBlockDevice(
  private val file: RandomAccessFile,
  private val startByte: Long,
  size: Long,
  sectorSize: Int = 512,
) : NativeBlockDevice(sectorSize, size) {
  var syncs = 0
    private set

  override fun read(offset: Long, buf: ByteArray, len: Int): Int {
    checkRange(offset, len)
    file.seek(startByte + offset)
    file.readFully(buf, 0, len)
    return len
  }

  override fun write(offset: Long, buf: ByteArray, len: Int): Int {
    checkRange(offset, len)
    file.seek(startByte + offset)
    file.write(buf, 0, len)
    return len
  }

  override fun sync() {
    syncs++
    file.fd.sync()
  }
}

/** exFAT / NTFS through the native libraries: read and write. */
internal class NativeRawFs private constructor(
  private val dev: NativeBlockDevice,
  private val slot: Int,
  private var h: Long,
  override val typeName: String,
) : RawFs {
  companion object {
    private const val IO_BUF = 1024 * 1024

    /**
     * Mounts [dev] (a partition starting at sector [partStart] of the disk) read-write, or
     * read-only when [readOnly] is set or the volume cannot be written safely (e.g. NTFS of a
     * hibernated Windows / Fast Startup).
     */
    fun mount(dev: NativeBlockDevice, type: Int, partStart: Long, readOnly: Boolean = false): NativeRawFs {
      if (!NativeFs.available) throw UserError("原生 exFAT/NTFS 组件加载失败：${NativeFs.loadError}")
      val slot = NativeFs.registerDevice(dev, dev.sizeBytes, dev.sectorSize, partStart)
      try {
        val h = NativeFs.mount(type, slot, readOnly)
        return NativeRawFs(dev, slot, h, if (type == NativeFs.NTFS) "NTFS" else "exFAT")
      } catch (e: Throwable) {
        NativeFs.unregisterDevice(slot)
        throw e
      }
    }

    private fun b(s: String) = s.toByteArray(Charsets.UTF_8)

    fun parseEntry(s: String): RawEntry {
      val p = s.split('|', limit = 4)
      return RawEntry(p[3], p[0] == "d", p[1].toLong(), p[2].toLong())
    }
  }

  private fun handle(): Long = if (h != 0L) h else throw IOException("文件系统已关闭")

  override val label: String = String(NativeFs.label(h), Charsets.UTF_8).trim()
  override val readOnly: Boolean = NativeFs.isReadOnly(h)
  /** Why the volume was mounted read-only (empty when writable or opened read-only on purpose). */
  override val readOnlyReason: String = String(NativeFs.roReason(h), Charsets.UTF_8)

  override fun capacity(): Long = NativeFs.space(handle())[0]
  override fun free(): Long = NativeFs.space(handle())[1]

  private fun norm(path: String): String = "/" + splitPath(path).joinToString("/")

  private fun statOrNull(path: String): RawEntry? =
    NativeFs.stat(handle(), b(norm(path)))?.let { parseEntry(String(it, Charsets.UTF_8)) }

  override fun list(path: String): List<RawEntry> {
    val st = statOrNull(path) ?: throw FileNotFoundException(path)
    if (!st.isDir) throw UserError("不是目录")
    val all = NativeFs.list(handle(), b(norm(path)))
    val out = ArrayList<RawEntry>()
    var start = 0
    for (i in all.indices) {
      if (all[i].toInt() == 0) {
        out.add(parseEntry(String(all, start, i - start, Charsets.UTF_8)))
        start = i + 1
      }
    }
    return out
  }

  override fun stat(path: String): RawEntry {
    if (splitPath(path).isEmpty()) return RawEntry("", true, 0, 0)
    return statOrNull(path) ?: throw FileNotFoundException(path)
  }

  override fun readTo(path: String, out: OutputStream, max: Long) {
    val st = stat(path)
    if (st.isDir) throw UserError("这是一个目录")
    val p = b(norm(path))
    val buf = ByteArray(IO_BUF)
    var off = 0L
    val total = minOf(st.size, max)
    while (off < total) {
      val n = NativeFs.read(handle(), p, off, buf, minOf(IO_BUF.toLong(), total - off).toInt())
      if (n <= 0) break
      out.write(buf, 0, n)
      off += n
    }
  }

  private fun checkName(name: String) {
    if (name.isEmpty() || name.length > 255) throw UserError("非法文件名")
    if (name.any { it.code < 0x20 || "\"*/:<>?\\|".indexOf(it) >= 0 }) {
      throw UserError("文件名不能包含 \\ / : * ? \" < > | 等字符")
    }
    if (name.endsWith(" ") || name.endsWith(".")) throw UserError("文件名不能以空格或句点结尾")
  }

  private fun requireWritable() {
    if (readOnly) throw UserError(if (readOnlyReason.isNotEmpty()) readOnlyReason else "$typeName 卷为只读")
  }

  override fun writeFrom(path: String, input: InputStream) {
    requireWritable()
    checkName(nameOf(path))
    val parent = statOrNull(parentOf(path)) ?: throw FileNotFoundException(parentOf(path))
    if (!parent.isDir && splitPath(parentOf(path)).isNotEmpty()) throw UserError("父路径不是目录")
    statOrNull(path)?.let { if (it.isDir) throw UserError("目标是一个目录") }
    val p = b(norm(path))
    val fh = NativeFs.openWrite(handle(), p)
    var ok = false
    try {
      val buf = ByteArray(IO_BUF)
      var off = 0L
      while (true) {
        // fill the buffer completely: fewer, larger native writes
        var n = 0
        while (n < buf.size) {
          val r = input.read(buf, n, buf.size - n)
          if (r < 0) break
          n += r
        }
        if (n == 0) break
        NativeFs.write(handle(), fh, off, buf, n)
        off += n
        if (n < buf.size) break
      }
      ok = true
    } finally {
      NativeFs.closeWrite(handle(), fh)
      if (!ok) runCatching { NativeFs.remove(handle(), p) } // do not leave a truncated file behind
    }
  }

  override fun mkdir(path: String) {
    requireWritable()
    checkName(nameOf(path))
    if (statOrNull(path) != null) throw UserError("目标名称已存在")
    NativeFs.mkdir(handle(), b(norm(path)))
  }

  override fun delete(path: String) {
    requireWritable()
    if (splitPath(path).isEmpty()) throw UserError("不能删除根目录")
    deleteRec(norm(path), stat(path))
  }

  private fun deleteRec(path: String, e: RawEntry) {
    if (e.isDir) for (c in list(path)) deleteRec(childPath(path, c.name), c)
    NativeFs.remove(handle(), b(path))
  }

  override fun rename(path: String, newName: String) {
    requireWritable()
    if (splitPath(path).isEmpty()) throw UserError("不能重命名根目录")
    checkName(newName)
    val old = nameOf(path)
    if (old == newName) return
    val target = childPath(parentOf(path), newName)
    // both file systems are case-insensitive: a case-only change renames the same entry
    if (!old.equals(newName, ignoreCase = true) && statOrNull(target) != null) throw UserError("目标名称已存在")
    NativeFs.rename(handle(), b(norm(path)), b(norm(target)))
  }

  override fun flush() {
    if (h != 0L && !readOnly) NativeFs.sync(h)
  }

  /** Writes everything back, marks the volume clean and releases the device slot. */
  override fun close() {
    val handle = h
    if (handle == 0L) return
    h = 0L
    try {
      NativeFs.unmount(handle)
    } finally {
      NativeFs.unregisterDevice(slot)
    }
  }
}
