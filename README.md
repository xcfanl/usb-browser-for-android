# USB文件浏览器（USB File Browser for Android）

基于 Tauri v2（Rust + Android WebView）+ React 构建的 Android 文件浏览器，支持浏览手机本机存储与 USB 外接存储（OTG），并内置文本编辑器与多种格式的文件预览。

## 功能

- 主页选择存储位置：内部存储 / USB 外接存储（插入拔出自动刷新）
- 文件浏览：面包屑导航、排序（名称/大小/时间）、隐藏文件、目录内搜索
- 多选操作：长按文件或文件夹进入多选，支持全选、复制、剪切、删除、重命名
- 文本编辑器：CodeMirror 6，多语言高亮，编码自动检测（UTF-8 / GBK / UTF-16）
- 文件预览：Markdown / HTML / 图片 / PDF / DOCX / XLSX / PPTX / 视频 / 音频
- 「用系统打开」调用第三方应用，支持分享
- U 盘直接模式（USB Host / libaums）：系统没有挂载的 U 盘（NTFS、ext4、未开启 OTG 等）也能读取
- U 盘管理：显示文件系统、卷标、容量 / 已用 / 可用；直接模式下支持「弹出」和「格式化为 FAT32」
- 全新绿色 USB 图标（自适应图标）

## 下载安装

前往 [Releases](../../releases) 下载 APK：

- `universal`：包含 arm64-v8a 与 armeabi-v7a，适合大多数设备（Android 11+）
- `arm64-v8a` / `armeabi-v7a`：单架构包，体积更小

安装前需允许「安装未知应用」；首次使用需在系统设置中授予「所有文件访问」权限。

## U 盘支持说明

应用通过两条路径访问 U 盘：

1. **系统挂载**：Android 自己识别并挂载的 U 盘（出现在 `/storage/XXXX-XXXX`），通过「所有文件访问」权限读写。
   支持哪些格式取决于手机系统，通常是 FAT32 / exFAT，部分机型支持 NTFS。
2. **直接模式**：应用通过 USB Host API 直接与 U 盘通信（需要在系统弹窗中允许 USB 访问），
   绕过系统挂载，打开后系统挂载会被断开。

| 文件系统 | 系统挂载 | 直接模式 | 直接模式实现 |
| --- | --- | --- | --- |
| 文件系统 | 系统挂载 | 直接模式 | 直接模式格式化 | 直接模式实现 |
| --- | --- | --- | --- | --- |
| FAT32 | 读写（系统支持时） | **读写** | ✅ | libaums（格式化为自研，按 fatgen103） |
| exFAT | 读写（系统支持时） | **读写**（单文件可超过 4 GB） | ✅ | relan/exfat 1.4.0（libexfat + mkexfatfs，NDK 原生库） |
| NTFS | 视机型 | **读写**（单文件可超过 4 GB） | ✅ | ntfs-3g 2022.10.3（libntfs-3g + mkntfs，NDK 原生库） |
| ext2 / ext3 / ext4 | 通常不支持 | 只读 | — | java-fs（JNode） |
| FAT12 / FAT16 | 读写（系统支持时） | 只读 | — | java-fs（JNode） |
| HFS+ | 不支持 | 只读（未测试） | — | java-fs（JNode） |

注：ext4 / HFS+ 的写入没有可靠、可在 Android 上嵌入的实现，保持只读。
Windows 休眠或开启「快速启动」后关机的 NTFS 盘会以只读方式打开并提示原因（与 ntfs-3g 行为一致），
在 Windows 中完全关机（或关闭快速启动）后即可写入。原生库加载失败时 exFAT / NTFS 自动退回 java-fs 只读。

直接模式限制：仅支持 SCSI Bulk-Only 协议的设备（绝大多数 U 盘、读卡器、移动硬盘），
容量不超过 2 TB（READ CAPACITY(10)），分区表支持 MBR / GPT / 无分区表。

**弹出 / 格式化**

| 操作 | 系统挂载的 U 盘 | 直接模式 |
| --- | --- | --- |
| 弹出 | 应用无法直接弹出（Android 的卸载接口仅对系统应用开放），提供「系统存储设置」入口 | 写入缓存（含 SCSI SYNCHRONIZE CACHE）、关闭文件系统并释放 USB 接口，之后可安全拔出 |
| 格式化 | 应用无法直接格式化，请在系统存储设置中操作；或「改用直接模式」后格式化 | **FAT32 / exFAT / NTFS**：整盘写入 MBR + 单个分区（1 MiB 对齐，类型 0x0C / 0x07），容量上限 1 TiB（libaums 32 位 LBA）；FAT32 至少约 33 MB，exFAT / NTFS 至少 16 MB |

直接模式下每次修改（写入、新建、删除、重命名）后都会写回缓存；弹出时卸载文件系统，
exFAT 的 VolumeDirty 标志与 NTFS 的脏标志会被清除，不会让电脑提示「需要修复」。

## 从源码构建

依赖：Node.js 20+、pnpm、Rust（android targets）、Android SDK/NDK。

```bash
pnpm install
pnpm tauri android init   # 已初始化可跳过
pnpm tauri android build --apk --target aarch64 --target armv7
```

产物位于 `src-tauri/gen/android/app/build/outputs/apk/`。

打 tag（`v*`）推送后，GitHub Actions 会自动构建并发布 Release。

exFAT / NTFS 原生库（`src-tauri/plugins/usb-storage/android/src/main/cpp`）由 Gradle 通过 CMake 3.22.1 + NDK
自动编译（优先 NDK 27.3.13750724，其次 `NDK_HOME`）。

插件单元测试（在电脑上用磁盘镜像验证各文件系统的读写、格式化，含大于 4 GB 的文件）：

```bash
scripts/make-test-images.sh /tmp/fsimg   # 需要 exfatprogs ntfs-3g e2fsprogs dosfstools mtools
scripts/build-native-host.sh /tmp/usbfs-host   # 为电脑 JVM 编译 libusbfs.so（需要 cmake、gcc、JDK）
cd src-tauri/gen/android
USBFS_IMAGES=/tmp/fsimg USBFS_NATIVE_LIB=/tmp/usbfs-host/libusbfs.so USBFS_TEST_JAVA=/path/to/jdk11/bin/java \
  ./gradlew :tauri-plugin-usb-storage:testReleaseUnitTest   # USBFS_BIGFILE=0 跳过 >4 GB 文件测试
```

## 技术栈

Tauri 2 · Rust · React 19 · Vite · CodeMirror 6 · pdf.js · mammoth · SheetJS · pptx-preview

## License

**GPL-3.0-or-later**（见 [LICENSE](LICENSE)）。自 v0.4.0 起应用静态链接了 GPL 组件，因此整体以 GPL-3.0-or-later 发布；
v0.3.x 及更早版本的代码原以 MIT 发布。

第三方组件（完整列表与修改说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）：

- [ntfs-3g](https://github.com/tuxera/ntfs-3g) 2022.10.3（libntfs-3g、mkntfs）— GPL-2.0-or-later
- [exfat](https://github.com/relan/exfat) 1.4.0（libexfat、mkexfatfs）— GPL-2.0-or-later
- [libaums](https://github.com/magnusja/libaums) `me.jahnen.libaums:core` — Apache-2.0
- [java-fs](https://github.com/magnusja/java-fs) `me.jahnen:java-fs`（基于 JNode）— LGPL-2.1；其依赖 log4j 1.2.17（Apache-2.0，仅使用日志 API，不加载任何配置）
- `JnodeDevice.kt` 移植自 libaums 的 javafs 模块 — Apache-2.0
