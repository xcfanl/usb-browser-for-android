# Third-party notices

USB File Browser is licensed under the **GNU General Public License v3.0 or later**
(see [LICENSE](LICENSE)). Since v0.4.0 the Android app statically links GPL code (ntfs-3g,
relan/exfat) into `libusbfs.so`, so the app as a whole is distributed under GPL-3.0-or-later.
The complete corresponding source code is this repository (including the vendored sources under
`src-tauri/plugins/usb-storage/android/src/main/cpp/third_party/`).

## Native code (compiled into libusbfs.so)

| Component | Version | License | Use | Source |
| --- | --- | --- | --- | --- |
| ntfs-3g (libntfs-3g, mkntfs) | 2022.10.3 | GPL-2.0-or-later (see `third_party/ntfs-3g/COPYING`; `COPYING.LIB` is shipped with upstream) | NTFS read/write, NTFS formatting | https://github.com/tuxera/ntfs-3g — tarball `ntfs-3g_ntfsprogs-2022.10.3.tgz`, sha256 `f20e36ee68074b845e3629e6bced4706ad053804cbaf062fbae60738f854170c` |
| exfat (libexfat, mkexfatfs) by Andrew Nayenko | 1.4.0 | GPL-2.0-or-later (see `third_party/exfat/COPYING`) | exFAT read/write, exFAT formatting | https://github.com/relan/exfat (tag v1.4.0) |

Vendored subset and changes:

- ntfs-3g: `include/ntfs-3g/*.h`, `libntfs-3g/*.c` (without `unix_io.c` / `win32_io.c`) and
  `ntfsprogs/{mkntfs.c,utils.c,utils.h,attrdef.*,boot.*,sd.*,list.h}` — unmodified.
  The device layer is provided by `cpp/ntfs_io.c` (our code); `mkntfs.c` is compiled unchanged
  inside `cpp/mkfs_ntfs.c`. `config.h` was written by hand from the upstream `configure` output.
- exfat: `libexfat/*` and `mkfs/*`. Modified: `libexfat/io.c` (device I/O compiled out under
  `USBFS_CUSTOM_IO`, replaced by `cpp/exfat_io.c`) and `libexfat/log.c` (errors are also
  recorded for the app). Both files carry a modification notice. `mkfs/main.c` is compiled
  unchanged inside `cpp/mkfs_exfat.c`.

## Android / Java libraries

| Component | License | Use |
| --- | --- | --- |
| [libaums](https://github.com/magnusja/libaums) `me.jahnen.libaums:core:0.10.0` | Apache-2.0 | USB mass-storage (SCSI bulk-only) driver, partition tables, FAT32 read/write |
| [java-fs](https://github.com/magnusja/java-fs) `me.jahnen:java-fs:0.1.4` (JNode) | LGPL-2.1 | read-only ext2/3/4, FAT12/16, HFS+ (and fallback for exFAT/NTFS) |
| log4j 1.2.17 (dependency of java-fs) | Apache-2.0 | logging API only, no configuration is loaded |
| `JnodeDevice.kt`, ported from libaums' javafs module | Apache-2.0 | adapter between libaums block devices and java-fs |
| AndroidX (core-ktx, appcompat, webkit, activity) | Apache-2.0 | Android support libraries |

## Rust crates (main ones)

tauri, tauri-plugin-opener (Apache-2.0 OR MIT), serde, serde_json (MIT OR Apache-2.0),
libc (MIT OR Apache-2.0), jni (MIT OR Apache-2.0), chardetng (Apache-2.0 OR MIT),
encoding_rs ((Apache-2.0 OR MIT) AND BSD-3-Clause).

## Frontend (JavaScript)

React, react-dom, react-markdown, remark-gfm, rehype-highlight, CodeMirror 6 packages (MIT);
highlight.js (BSD-3-Clause); mammoth (BSD-2-Clause); pdfjs-dist (Apache-2.0);
xlsx / SheetJS CE (Apache-2.0); pptx-preview (ISC); @tauri-apps/api (Apache-2.0 OR MIT).

All of the above licenses are compatible with GPL-3.0-or-later. The full license texts of each
dependency are included in their respective packages / source distributions.
