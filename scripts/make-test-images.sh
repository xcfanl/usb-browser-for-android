#!/usr/bin/env bash
# Builds disk images for the usb-storage plugin JVM tests (UsbFsTest).
# Needs: exfatprogs, ntfs-3g, e2fsprogs, dosfstools, mtools, python3.
# Usage:
#   scripts/make-test-images.sh /tmp/fsimg
#   cd src-tauri/gen/android && USBFS_IMAGES=/tmp/fsimg USBFS_TEST_JAVA=/path/to/jdk11/bin/java \
#     ./gradlew :tauri-plugin-usb-storage:testReleaseUnitTest
# (java-fs needs java.security.acl, which exists on Android but was removed from desktop JDK 14+;
#  without USBFS_TEST_JAVA the ext4 test fails on a newer JDK.)
set -euo pipefail
export PATH="$PATH:/usr/sbin:/sbin"
out=${1:?output dir}
mkdir -p "$out/content/sub"
cd "$out"
rm -f ./*.img
printf 'hello from usb\n' > content/hello.txt
printf 'nested 你好\n' > content/sub/nested.txt
head -c 300000 /dev/urandom > content/sub/big.bin

mbr() { # image type-hex: one partition starting at 1 MiB
  python3 - "$1" "$2" <<'PY'
import os, struct, sys
path, t = sys.argv[1], int(sys.argv[2], 16)
n = os.path.getsize(path) // 512
with open(path, 'r+b') as f:
    f.seek(446); f.write(struct.pack('<B3sB3sII', 0, b'\xfe\xff\xff', t, b'\xfe\xff\xff', 2048, n - 2048))
    f.seek(510); f.write(b'\x55\xaa')
PY
}
mkpart() { # out type partimg
  dd if=/dev/zero of="$1" bs=1M count=1 status=none; cat "$3" >> "$1"; rm "$3"; mbr "$1" "$2"
}
truncate -s 128M p.img && mkfs.exfat -L EXFATVOL p.img >/dev/null && mkpart exfat_mbr.img 7 p.img
truncate -s 128M exfat_raw.img && mkfs.exfat -L EXRAW exfat_raw.img >/dev/null
truncate -s 128M p.img && mkfs.ntfs -q -F -Q -L NTFSVOL -p 2048 p.img 2>/dev/null \
  && ntfscp p.img content/hello.txt hello.txt && mkpart ntfs_mbr.img 7 p.img
truncate -s 128M p.img && mkfs.ext4 -q -F -L EXT4VOL -d content p.img && mkpart ext4_mbr.img 83 p.img
truncate -s 300M p.img && mkfs.fat -F 32 -n MKFSFAT p.img >/dev/null && mcopy -s -i p.img content/* ::/ \
  && mkpart fat32_mbr.img c p.img
truncate -s 64M p.img && mkfs.fat -F 16 -n FAT16VOL p.img >/dev/null && mcopy -s -i p.img content/* ::/ \
  && mkpart fat16_mbr.img 6 p.img
ls -la "$out"
