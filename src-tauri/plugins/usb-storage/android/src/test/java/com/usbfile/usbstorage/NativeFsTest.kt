package com.usbfile.usbstorage

import me.jahnen.libaums.core.driver.file.FileBlockDeviceDriver
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import kotlin.random.Random

/**
 * exFAT / NTFS read-write through libusbfs (relan/exfat, ntfs-3g), on disk images accessed via
 * libaums' FileBlockDeviceDriver + ScsiPartitionDevice (the same path as a real USB drive).
 * Needs USBFS_IMAGES (scripts/make-test-images.sh) and USBFS_NATIVE_LIB
 * (scripts/build-native-host.sh). Images are left behind for fsck.exfat / ntfsfix checks.
 */
class NativeFsTest {
  private val dir: File? = System.getenv("USBFS_IMAGES")?.let(::File)?.takeIf { it.isDirectory }

  private fun need() {
    assumeTrue("USBFS_IMAGES not set", dir != null)
    assumeTrue("libusbfs not loaded: ${NativeFs.loadError}", NativeFs.available)
  }

  private fun copyOf(name: String, to: String): File {
    need()
    val src = File(dir, name)
    assumeTrue("missing $name", src.isFile)
    return File(dir, to).also { src.copyTo(it, overwrite = true) }
  }

  private fun probe(f: File): RawFs {
    val r = VolumeProbe.probe(FileBlockDeviceDriver(f))
    assertNotNull("probe ${f.name}: detected=${r.detected} error=${r.error}", r.fs)
    return r.fs!!
  }

  private fun read(fs: RawFs, path: String): ByteArray =
    ByteArrayOutputStream().also { fs.readTo(path, it) }.toByteArray()

  private fun names(fs: RawFs, path: String) = fs.list(path).map { it.name }.sorted()

  /** create / write / overwrite / rename / delete / nested dirs, then verify after remount */
  private fun exercise(img: File, type: String) {
    val small = Random.nextBytes(100_000)
    val big = Random.nextBytes(5_000_000 + 123)
    val uni = "中文 文件名 😀 ü.txt"
    probe(img).let { fs ->
      assertEquals(type, fs.typeName)
      assertFalse(fs.readOnly)
      if (type == "NTFS") assertEquals("hello from usb\n", String(read(fs, "/hello.txt")))
      val free0 = fs.free()
      fs.mkdir("/dir")
      fs.mkdir("/dir/sub")
      fs.mkdir("/dir/sub/deeper")
      fs.writeFrom("/dir/small.bin", ByteArrayInputStream(small))
      fs.writeFrom("/dir/sub/deeper/big.bin", ByteArrayInputStream(big))
      fs.writeFrom("/empty.txt", ByteArrayInputStream(ByteArray(0)))
      fs.writeFrom("/$uni", ByteArrayInputStream("unicode".toByteArray()))
      fs.writeFrom("/over.txt", ByteArrayInputStream(ByteArray(300_000) { 7 }))
      fs.writeFrom("/over.txt", ByteArrayInputStream("short".toByteArray())) // overwrite, shrink
      fs.writeFrom("/todelete.txt", ByteArrayInputStream("x".toByteArray()))
      fs.mkdir("/deltree")
      fs.mkdir("/deltree/a")
      fs.writeFrom("/deltree/a/f.txt", ByteArrayInputStream(Random.nextBytes(70_000)))
      assertTrue("free space must shrink", fs.free() < free0)
      try { fs.mkdir("/dir"); fail("mkdir existing") } catch (e: UserError) { }
      try { fs.writeFrom("/dir", ByteArrayInputStream(ByteArray(1))); fail("overwrite dir") } catch (e: UserError) { }
      try { fs.writeFrom("/bad:name", ByteArrayInputStream(ByteArray(1))); fail("bad name") } catch (e: UserError) { }
      try { fs.rename("/over.txt", "empty.txt"); fail("rename onto existing") } catch (e: UserError) { }

      fs.rename("/dir/small.bin", "small renamed.bin")
      fs.rename("/over.txt", "OVER.TXT") // case-only change
      fs.rename("/dir/sub", "sub2") // directory
      fs.delete("/todelete.txt")
      fs.delete("/deltree") // recursive
      assertArrayEquals(small, read(fs, "/dir/small renamed.bin"))
      fs.flush()
      fs.close()
    }
    probe(img).let { fs ->
      assertFalse(fs.readOnly)
      val root = names(fs, "/")
      assertTrue(root.toString(), root.containsAll(listOf("dir", "empty.txt", uni, "OVER.TXT")))
      assertFalse(root.contains("todelete.txt") || root.contains("deltree") || root.contains("over.txt"))
      assertEquals(listOf("small renamed.bin", "sub2"), names(fs, "/dir"))
      assertArrayEquals(small, read(fs, "/dir/small renamed.bin"))
      assertArrayEquals(big, read(fs, "/dir/sub2/deeper/big.bin"))
      assertEquals(big.size.toLong(), fs.stat("/dir/sub2/deeper/big.bin").size)
      assertTrue(fs.stat("/dir/sub2").isDir)
      assertEquals(0L, fs.stat("/empty.txt").size)
      assertEquals("unicode", String(read(fs, "/$uni")))
      assertEquals("short", String(read(fs, "/OVER.TXT")))
      assertTrue(fs.stat("/dir/small renamed.bin").mtime > 1_600_000_000_000L)
      try { fs.stat("/nope"); fail() } catch (e: FileNotFoundException) { }
      if (type == "NTFS") assertFalse(fs.list("/").any { it.name.startsWith("$") })
      fs.close()
    }
    assertClean(img, type)
    // cross-check with an independent implementation (java-fs, read-only)
    javaFs(img, type).let { j ->
      assertArrayEquals(small, read(j, "/dir/small renamed.bin"))
      assertArrayEquals(big, read(j, "/dir/sub2/deeper/big.bin"))
      assertEquals("unicode", String(read(j, "/$uni")))
      assertEquals("short", String(read(j, "/OVER.TXT")))
      assertTrue(names(j, "/").containsAll(listOf("dir", "empty.txt", uni, "OVER.TXT")))
      j.close()
    }
  }

  private fun javaFs(img: File, type: String): RawFs {
    val raw = FileBlockDeviceDriver(img)
    val startLba = RandomAccessFile(img, "r").use { partitionStart(it) } / 512
    val bytes = img.length() - startLba * 512
    val api = JnodeBlockApi(me.jahnen.libaums.core.driver.ByteBlockDevice(raw, startLba), 512, bytes)
    val t: org.jnode.fs.BlockDeviceFileSystemType<*> =
      if (type == "NTFS") org.jnode.fs.ntfs.NTFSFileSystemType() else org.jnode.fs.exfat.ExFatFileSystemType()
    return JnodeFs(t.create(JnodeDevice(api), true), type, bytes)
  }

  /** The volume must not be left dirty after a normal close. */
  private fun assertClean(img: File, type: String) {
    RandomAccessFile(img, "r").use { f ->
      val start = partitionStart(f)
      val boot = ByteArray(512)
      f.seek(start); f.readFully(boot)
      if (type == "exFAT") {
        val flags = (boot[106].toInt() and 0xff) or ((boot[107].toInt() and 0xff) shl 8)
        assertEquals("exFAT VolumeDirty flag", 0, flags and 2)
      }
    }
  }

  private fun partitionStart(f: RandomAccessFile): Long {
    val mbr = ByteArray(512)
    f.seek(0); f.readFully(mbr)
    val oem = String(mbr, 3, 8, Charsets.US_ASCII)
    if (oem == "EXFAT   " || oem == "NTFS    ") return 0
    return (ByteBuffer.wrap(mbr).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt(446 + 8).toLong()) * 512
  }

  @Test fun exfatReadWrite() = exercise(copyOf("exfat_mbr.img", "exfat_rw.img"), "exFAT")

  @Test fun exfatSuperfloppyReadWrite() {
    val img = copyOf("exfat_raw.img", "exfat_raw_rw.img")
    probe(img).let { fs ->
      assertEquals("EXRAW", fs.label)
      fs.writeFrom("/a.txt", ByteArrayInputStream("raw".toByteArray()))
      fs.close()
    }
    probe(img).let { fs -> assertEquals("raw", String(read(fs, "/a.txt"))); fs.close() }
    assertClean(img, "exFAT")
  }

  @Test fun ntfsReadWrite() = exercise(copyOf("ntfs_mbr.img", "ntfs_rw.img"), "NTFS")

  @Test fun readOnlyMountRejectsWrites() {
    val img = copyOf("ntfs_mbr.img", "ntfs_ro.img")
    val dev = ScsiPartitionDevice(FileBlockDeviceDriver(img), 2048, (img.length() / 512) - 2048) {}
    val fs = NativeRawFs.mount(dev, NativeFs.NTFS, 2048, readOnly = true)
    assertTrue(fs.readOnly)
    assertEquals("hello from usb\n", String(read(fs, "/hello.txt")))
    try { fs.mkdir("/x"); fail("read-only") } catch (e: Exception) { }
    fs.close()
  }

  /** NTFS of a hibernated / Fast Startup Windows must open read-only, with a reason. */
  @Test fun ntfsHibernatedOpensReadOnly() {
    val img = copyOf("ntfs_mbr.img", "ntfs_hiber.img")
    probe(img).let { fs ->
      fs.writeFrom("/hiberfil.sys", ByteArrayInputStream("HIBR".toByteArray() + ByteArray(8192)))
      fs.close()
    }
    probe(img).let { fs ->
      assertEquals("NTFS", fs.typeName)
      assertTrue(fs.readOnly)
      assertTrue(fs.readOnlyReason, fs.readOnlyReason.contains("快速启动"))
      assertEquals("hello from usb\n", String(read(fs, "/hello.txt")))
      try { fs.mkdir("/x"); fail("read-only") } catch (e: UserError) { }
      fs.close()
    }
  }

  private fun formatImage(name: String, size: Long, type: Int, label: String): File {
    need()
    val img = File(dir, name)
    RandomAccessFile(img, "rw").use { it.setLength(0); it.setLength(size) }
    // an old FAT32 volume + garbage must not survive
    Fat32Formatter.format(FileBlockDeviceDriver(img), "OLD")
    RandomAccessFile(img, "rw").use { it.write(Random.nextBytes(4096)) }
    NativeFormatter.format(FileBlockDeviceDriver(img), type, NativeFormatter.normalizeLabel(type, label)) {}
    return img
  }

  @Test fun formatExfat() {
    val img = formatImage("fmt_exfat.img", 1L shl 30, NativeFs.EXFAT, "U盘 exFAT")
    probe(img).let { fs ->
      assertEquals("exFAT", fs.typeName)
      assertEquals("U盘 exFAT", fs.label)
      assertFalse(fs.readOnly)
      assertTrue(fs.list("/").isEmpty())
      assertTrue(fs.capacity() > 1000L shl 20)
      assertTrue(fs.free() > 1000L shl 20)
      fs.writeFrom("/x.txt", ByteArrayInputStream("x".toByteArray()))
      fs.close()
    }
    assertClean(img, "exFAT")
  }

  @Test fun formatNtfs() {
    val img = formatImage("fmt_ntfs.img", 1L shl 30, NativeFs.NTFS, "测试 NTFS 卷")
    probe(img).let { fs ->
      assertEquals("NTFS", fs.typeName)
      assertEquals("测试 NTFS 卷", fs.label)
      assertFalse(fs.readOnly)
      assertTrue(fs.list("/").none { !it.name.startsWith("System Volume") })
      assertTrue(fs.capacity() > 1000L shl 20)
      fs.writeFrom("/x.txt", ByteArrayInputStream("x".toByteArray()))
      fs.close()
    }
  }

  /** mkfs twice in one process (getopt / global state of mkntfs must be reset). */
  @Test fun formatNtfsTwiceAndLarge() {
    formatImage("fmt_ntfs2.img", 256L shl 20, NativeFs.NTFS, "")
    val img = formatImage("fmt_ntfs_600g.img", 600L shl 30, NativeFs.NTFS, "BIG")
    probe(img).let { fs ->
      assertTrue(fs.capacity() > 590L shl 30)
      fs.writeFrom("/x.txt", ByteArrayInputStream("x".toByteArray()))
      fs.close()
    }
    val ex = formatImage("fmt_exfat_600g.img", 600L shl 30, NativeFs.EXFAT, "BIG")
    probe(ex).let { fs ->
      assertTrue(fs.capacity() > 590L shl 30)
      assertTrue(fs.free() > 590L shl 30)
      fs.close()
    }
  }

  @Test fun labelRules() {
    assertEquals("12345678901", NativeFormatter.normalizeLabel(NativeFs.EXFAT, " 12345678901 "))
    try { NativeFormatter.normalizeLabel(NativeFs.EXFAT, "123456789012"); fail() } catch (e: UserError) { }
    try { NativeFormatter.normalizeLabel(NativeFs.NTFS, "a/b"); fail() } catch (e: UserError) { }
    assertEquals("中文卷标", NativeFormatter.normalizeLabel(NativeFs.NTFS, "中文卷标"))
  }

  /** Stream of [size] bytes where every 8-byte word holds its own offset. */
  private class PatternStream(private val size: Long) : InputStream() {
    private var pos = 0L
    override fun read(): Int {
      val b = ByteArray(1)
      return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff
    }
    override fun read(b: ByteArray, off: Int, len: Int): Int {
      if (pos >= size) return -1
      val n = minOf(len.toLong(), size - pos).toInt()
      for (i in 0 until n) {
        val p = pos + i
        b[off + i] = ((p and 7L.inv()) ushr (8 * (p and 7L).toInt())).toByte()
      }
      pos += n
      return n
    }
  }

  private class PatternCheck : OutputStream() {
    var pos = 0L
    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
    override fun write(b: ByteArray, off: Int, len: Int) {
      for (i in 0 until len) {
        val p = pos + i
        val want = ((p and 7L.inv()) ushr (8 * (p and 7L).toInt())).toByte()
        if (b[off + i] != want) throw AssertionError("mismatch at byte $p")
      }
      pos += len
    }
  }

  /** A file larger than 4 GiB (impossible on FAT32). Set USBFS_BIGFILE=0 to skip. */
  private fun bigFile(type: Int, name: String) {
    need()
    assumeTrue(System.getenv("USBFS_BIGFILE") != "0")
    val img = formatImage(name, 6L shl 30, type, "BIGFILE")
    val size = (4L shl 30) + 12_345_678L
    probe(img).let { fs ->
      fs.writeFrom("/big file.bin", PatternStream(size))
      fs.close()
    }
    probe(img).let { fs ->
      assertEquals(size, fs.stat("/big file.bin").size)
      val chk = PatternCheck()
      fs.readTo("/big file.bin", chk)
      assertEquals(size, chk.pos)
      fs.close()
    }
    if (type == NativeFs.EXFAT) assertClean(img, "exFAT")
  }

  @Test fun exfatFileOver4G() = bigFile(NativeFs.EXFAT, "big_exfat.img")
  @Test fun ntfsFileOver4G() = bigFile(NativeFs.NTFS, "big_ntfs.img")
}
