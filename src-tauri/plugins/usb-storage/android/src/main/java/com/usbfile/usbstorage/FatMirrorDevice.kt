package com.usbfile.usbstorage

import me.jahnen.libaums.core.driver.BlockDeviceDriver
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * libaums 0.10.0 only ever updates the first FAT (FAT.kt writes to fatOffset[0]) even when the
 * boot sector says the FATs are mirrored, which leaves the second copy stale ("FATs differ" in
 * fsck.fat / chkdsk). This byte-addressed wrapper duplicates every write that falls into FAT #0
 * into the other FAT copies, keeping the volume consistent for other operating systems.
 */
internal class FatMirrorDevice private constructor(
  private val inner: BlockDeviceDriver,
  private val fatStart: Long,
  private val fatBytes: Long,
  private val copies: Int,
) : BlockDeviceDriver {
  override val blockSize: Int get() = inner.blockSize
  override val blocks: Long get() = inner.blocks
  override fun init() = inner.init()
  override fun read(deviceOffset: Long, buffer: ByteBuffer) = inner.read(deviceOffset, buffer)

  override fun write(deviceOffset: Long, buffer: ByteBuffer) {
    val pos = buffer.position()
    val len = buffer.remaining().toLong()
    inner.write(deviceOffset, buffer)
    val s = maxOf(deviceOffset, fatStart)
    val e = minOf(deviceOffset + len, fatStart + fatBytes)
    if (s >= e) return
    for (k in 1 until copies) {
      val dup = ByteBuffer.wrap(buffer.array(), buffer.arrayOffset() + pos + (s - deviceOffset).toInt(), (e - s).toInt())
      inner.write(s + k * fatBytes, dup)
    }
  }

  companion object {
    /** [part] is byte addressed (ByteBlockDevice); [boot] the partition's first sector. */
    fun wrap(part: BlockDeviceDriver, boot: ByteArray): BlockDeviceDriver {
      if (boot.size < 512) return part
      val b = ByteBuffer.wrap(boot).order(ByteOrder.LITTLE_ENDIAN)
      val bps = b.getShort(11).toInt() and 0xffff
      val reserved = b.getShort(14).toInt() and 0xffff
      val fats = b.get(16).toInt() and 0xff
      val fatSectors = b.getInt(36).toLong() and 0xffffffffL
      val mirrored = (b.getShort(40).toInt() and 0x80) == 0
      if (!mirrored || fats < 2 || bps == 0 || fatSectors == 0L) return part
      return FatMirrorDevice(part, reserved.toLong() * bps, fatSectors * bps, fats)
    }
  }
}
