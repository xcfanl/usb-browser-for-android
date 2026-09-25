package com.usbfile.usbstorage

/** Identifies a file system from its first bytes (for display, even when it can't be opened). */
internal object FsSniffer {
  private fun ascii(b: ByteArray, off: Int, len: Int): String =
    if (b.size < off + len) "" else String(b, off, len, Charsets.US_ASCII)

  private fun u16(b: ByteArray, off: Int) =
    if (b.size < off + 2) -1 else (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8)

  private fun u32(b: ByteArray, off: Int): Long =
    if (b.size < off + 4) -1 else (u16(b, off).toLong() or (u16(b, off + 2).toLong() shl 16))

  fun hasBootSignature(b: ByteArray) = b.size >= 512 && b[510] == 0x55.toByte() && b[511] == 0xAA.toByte()

  fun isFat32(b: ByteArray) = hasBootSignature(b) && ascii(b, 82, 8) == "FAT32   "

  /** True if [head] (first bytes of the device) is a volume boot record rather than an MBR/GPT. */
  fun looksLikeVbr(head: ByteArray): Boolean {
    val oem = ascii(head, 3, 8)
    if (oem == "EXFAT   " || oem == "NTFS    ") return true
    if (isFat32(head)) return true
    val t = ascii(head, 54, 5)
    return hasBootSignature(head) && (t == "FAT12" || t == "FAT16")
  }

  /**
   * @param head first 4 KiB of the partition
   * @param superblock bytes at partition offset 1024 (1 KiB) for ext / HFS+ / F2FS detection
   */
  fun sniff(head: ByteArray, superblock: ByteArray): String? {
    val oem = ascii(head, 3, 8)
    if (oem == "EXFAT   ") return "exFAT"
    if (oem == "NTFS    ") return "NTFS"
    if (isFat32(head)) return "FAT32"
    val fat = ascii(head, 54, 5)
    if (hasBootSignature(head) && (fat == "FAT12" || fat == "FAT16")) return fat
    if (u16(superblock, 56) == 0xEF53) {
      val compat = u32(superblock, 92)
      val incompat = u32(superblock, 96)
      return when {
        incompat and 0x40L != 0L || incompat and 0x200L != 0L -> "ext4" // extents / flex_bg
        compat and 0x4L != 0L -> "ext3" // has_journal
        else -> "ext2"
      }
    }
    if (ascii(superblock, 0, 2) == "H+" || ascii(superblock, 0, 2) == "HX") return "HFS+"
    if (u32(superblock, 0) == 0xF2F52010L) return "F2FS"
    if (ascii(head, 0, 4) == "XFSB") return "XFS"
    if (ascii(head, 32, 4) == "NXSB") return "APFS"
    return null
  }
}
