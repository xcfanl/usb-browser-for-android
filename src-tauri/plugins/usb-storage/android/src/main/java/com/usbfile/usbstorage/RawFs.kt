package com.usbfile.usbstorage

import org.jnode.fs.exfat.ExFatFileSystem
import me.jahnen.libaums.core.fs.FileSystem
import me.jahnen.libaums.core.fs.UsbFile
import me.jahnen.libaums.core.fs.UsbFileStreamFactory
import org.jnode.fs.FSEntry
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer

/** Error whose message is shown to the user as-is. */
internal class UserError(msg: String) : IOException(msg)

internal data class RawEntry(val name: String, val isDir: Boolean, val size: Long, val mtime: Long)

/** Minimal file-system view used by the plugin; paths are "/"-separated and absolute. */
internal interface RawFs {
  val typeName: String
  val label: String
  val readOnly: Boolean
  /** Why a normally writable volume is read-only (e.g. hibernated Windows); empty otherwise. */
  val readOnlyReason: String get() = ""
  fun capacity(): Long
  fun free(): Long
  fun list(path: String): List<RawEntry>
  fun stat(path: String): RawEntry
  fun readTo(path: String, out: OutputStream, max: Long = Long.MAX_VALUE)
  fun writeFrom(path: String, input: InputStream)
  fun mkdir(path: String)
  fun delete(path: String)
  fun rename(path: String, newName: String)
  fun flush()
  fun close()
}

internal fun splitPath(path: String): List<String> =
  path.split('/').filter { it.isNotEmpty() && it != "." }.also { parts ->
    if (parts.any { it == ".." }) throw UserError("非法路径")
  }

internal fun parentOf(path: String): String {
  val p = splitPath(path)
  return if (p.size <= 1) "/" else "/" + p.dropLast(1).joinToString("/")
}

internal fun nameOf(path: String): String = splitPath(path).lastOrNull() ?: ""

internal fun childPath(dir: String, name: String): String =
  if (dir == "/" || dir.isEmpty()) "/$name" else "${dir.trimEnd('/')}/$name"

private const val COPY_BUF = 64 * 1024

/** FAT32 through libaums' own implementation: read and write. */
internal class AumsFs(private val fs: FileSystem) : RawFs {
  override val typeName = "FAT32"
  override val label: String get() = runCatching { fs.volumeLabel.trim() }.getOrDefault("")
  override val readOnly = false
  override fun capacity() = runCatching { fs.capacity }.getOrDefault(0L)
  override fun free() = runCatching { fs.freeSpace }.getOrDefault(0L)

  private fun resolve(path: String): UsbFile {
    val parts = splitPath(path)
    var cur = fs.rootDirectory
    for (p in parts) {
      if (!cur.isDirectory) throw FileNotFoundException(path)
      cur = cur.listFiles().firstOrNull { it.name == p }
        ?: cur.listFiles().firstOrNull { it.name.equals(p, ignoreCase = true) }
        ?: throw FileNotFoundException(path)
    }
    return cur
  }

  private fun entryOf(f: UsbFile) = RawEntry(
    f.name,
    f.isDirectory,
    if (f.isDirectory) 0L else f.length,
    if (f.isRoot) 0L else runCatching { f.lastModified() }.getOrDefault(0L),
  )

  override fun list(path: String): List<RawEntry> {
    val dir = resolve(path)
    if (!dir.isDirectory) throw UserError("不是目录")
    return dir.listFiles().map { entryOf(it) }
  }

  override fun stat(path: String): RawEntry {
    val f = resolve(path)
    return if (f.isRoot) RawEntry("", true, 0, 0) else entryOf(f)
  }

  override fun readTo(path: String, out: OutputStream, max: Long) {
    val f = resolve(path)
    if (f.isDirectory) throw UserError("这是一个目录")
    UsbFileStreamFactory.createBufferedInputStream(f, fs).use { input ->
      copyLimited(input, out, max)
    }
  }

  override fun writeFrom(path: String, input: InputStream) {
    val parent = resolve(parentOf(path))
    val name = nameOf(path)
    if (name.isEmpty()) throw UserError("非法文件名")
    parent.listFiles().firstOrNull { it.name.equals(name, ignoreCase = true) }?.let {
      if (it.isDirectory) throw UserError("目标是一个目录")
      it.delete()
    }
    val file = parent.createFile(name)
    UsbFileStreamFactory.createBufferedOutputStream(file, fs).use { out -> input.copyTo(out, COPY_BUF) }
  }

  override fun mkdir(path: String) {
    val parent = resolve(parentOf(path))
    val name = nameOf(path)
    if (parent.listFiles().any { it.name.equals(name, ignoreCase = true) }) throw UserError("目标名称已存在")
    parent.createDirectory(name)
  }

  override fun delete(path: String) {
    val f = resolve(path)
    if (f.isRoot) throw UserError("不能删除根目录")
    deleteRec(f)
  }

  private fun deleteRec(f: UsbFile) {
    if (f.isDirectory) f.listFiles().forEach { deleteRec(it) }
    f.delete()
  }

  override fun rename(path: String, newName: String) {
    val f = resolve(path)
    if (f.isRoot) throw UserError("不能重命名根目录")
    val parent = resolve(parentOf(path))
    if (parent.listFiles().any { it.name == newName }) throw UserError("目标名称已存在")
    f.name = newName
  }

  override fun flush() {
    runCatching { fs.rootDirectory.flush() }
  }

  override fun close() {}
}

/** Other file systems through java-fs (JNode). Always opened read-only. */
internal class JnodeFs(
  private val fs: org.jnode.fs.FileSystem<*>,
  override val typeName: String,
  /** Partition size, used when the file system cannot report its own size. */
  private val partitionBytes: Long = 0L,
) : RawFs {
  override val readOnly = true
  override val label: String get() = runCatching { fs.volumeName?.trim() ?: "" }.getOrDefault("")

  // java-fs returns -1 for exFAT and FAT12/16; computed once (the volume is read-only here)
  private val space: Pair<Long, Long> by lazy { computeSpace() }
  override fun capacity() = space.first
  /** -1 when unknown. */
  override fun free() = space.second

  private fun computeSpace(): Pair<Long, Long> {
    val ex = fs as? ExFatFileSystem
    if (ex != null) {
      return runCatching {
        val bpc = ex.superBlock.bytesPerCluster.toLong()
        val clusters = ex.clusterBitmap.clusterCount
        Pair(clusters * bpc, (clusters - exfatUsedClusters(ex, clusters)).coerceAtLeast(0L) * bpc)
      }.getOrElse { Pair(partitionBytes, -1L) }
    }
    val total = runCatching { fs.totalSpace }.getOrDefault(-1L)
    val free = runCatching { fs.freeSpace }.getOrDefault(-1L)
    return Pair(if (total > 0) total else partitionBytes, if (free >= 0) free else -1L)
  }

  /** Counts set bits of the exFAT allocation bitmap with bulk reads (java-fs reads it byte by byte). */
  private fun exfatUsedClusters(fs: ExFatFileSystem, clusters: Long): Long {
    val bitmap = fs.clusterBitmap
    val offset = fs.superBlock.clusterToOffset(bitmap.startCluster)
    val bytes = (clusters + 7) / 8
    val buf = ByteBuffer.allocate(64 * 1024)
    var used = 0L
    var pos = 0L
    while (pos < bytes) {
      val n = minOf(buf.capacity().toLong(), bytes - pos).toInt()
      buf.clear(); buf.limit(n)
      fs.api.read(offset + pos, buf)
      for (i in 0 until n) {
        var b = buf.get(i).toInt() and 0xff
        val bitIndex = (pos + i) * 8
        if (bitIndex + 8 > clusters) b = b and ((1 shl (clusters - bitIndex).toInt()) - 1)
        used += Integer.bitCount(b)
      }
      pos += n
    }
    return used
  }

  private fun resolve(path: String): FSEntry {
    var cur: FSEntry = fs.rootEntry
    for (p in splitPath(path)) {
      if (!cur.isDirectory) throw FileNotFoundException(path)
      val dir = cur.directory
      cur = runCatching { dir.getEntry(p) }.getOrNull()
        ?: children(cur).firstOrNull { it.name.equals(p, ignoreCase = true) }
        ?: throw FileNotFoundException(path)
    }
    return cur
  }

  private fun children(dir: FSEntry): List<FSEntry> {
    val out = ArrayList<FSEntry>()
    val it = dir.directory.iterator()
    while (it.hasNext()) {
      val e = it.next() ?: continue
      val n = e.name ?: continue
      if (n.isEmpty() || n == "." || n == "..") continue
      out.add(e)
    }
    return out
  }

  private fun entryOf(e: FSEntry): RawEntry {
    val dir = e.isDirectory
    val size = if (dir) 0L else runCatching { e.file.length }.getOrDefault(0L)
    return RawEntry(e.name, dir, size, runCatching { e.lastModified }.getOrDefault(0L))
  }

  override fun list(path: String): List<RawEntry> {
    val d = resolve(path)
    if (!d.isDirectory) throw UserError("不是目录")
    val atRoot = splitPath(path).isEmpty()
    return children(d)
      // hide NTFS metadata files ($MFT, $Bitmap, ...) in the root
      .filterNot { atRoot && typeName == "NTFS" && it.name.startsWith("$") }
      .map { entryOf(it) }
  }

  override fun stat(path: String): RawEntry {
    if (splitPath(path).isEmpty()) return RawEntry("", true, 0, 0)
    return entryOf(resolve(path))
  }

  override fun readTo(path: String, out: OutputStream, max: Long) {
    val e = resolve(path)
    if (e.isDirectory) throw UserError("这是一个目录")
    val f = e.file
    val total = minOf(f.length, max)
    var off = 0L
    val buf = ByteBuffer.allocate(COPY_BUF)
    while (off < total) {
      val n = minOf(COPY_BUF.toLong(), total - off).toInt()
      buf.clear()
      buf.limit(n)
      f.read(off, buf)
      out.write(buf.array(), 0, n)
      off += n
    }
  }

  private fun ro(): Nothing = throw UserError("$typeName 在直接读取模式下为只读，不支持修改")
  override fun writeFrom(path: String, input: InputStream) = ro()
  override fun mkdir(path: String) = ro()
  override fun delete(path: String) = ro()
  override fun rename(path: String, newName: String) = ro()
  override fun flush() {}
  override fun close() {
    runCatching { fs.close() }
  }
}

internal fun copyLimited(input: InputStream, out: OutputStream, max: Long) {
  val buf = ByteArray(COPY_BUF)
  var left = max
  while (left > 0) {
    val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
    if (n <= 0) break
    out.write(buf, 0, n)
    left -= n
  }
}
