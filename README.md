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
| FAT32 | 读写（系统支持时） | **读写** | libaums |
| exFAT | 读写（系统支持时） | 只读 | java-fs（JNode） |
| NTFS | 视机型 | 只读 | java-fs（JNode） |
| ext2 / ext3 / ext4 | 通常不支持 | 只读 | java-fs（JNode） |
| FAT12 / FAT16 | 读写（系统支持时） | 只读 | java-fs（JNode） |
| HFS+ | 不支持 | 只读（未测试） | java-fs（JNode） |

直接模式限制：仅支持 SCSI Bulk-Only 协议的设备（绝大多数 U 盘、读卡器、移动硬盘），
容量不超过 2 TB（READ CAPACITY(10)），分区表支持 MBR / GPT / 无分区表。

**弹出 / 格式化**

| 操作 | 系统挂载的 U 盘 | 直接模式 |
| --- | --- | --- |
| 弹出 | 应用无法直接弹出（Android 的卸载接口仅对系统应用开放），提供「系统存储设置」入口 | 写入缓存（含 SCSI SYNCHRONIZE CACHE）、关闭文件系统并释放 USB 接口，之后可安全拔出 |
| 格式化 | 应用无法直接格式化，请在系统存储设置中操作；或「改用直接模式」后格式化 | **仅 FAT32**：整盘写入 MBR + 单个 FAT32 分区（1 MiB 对齐），容量 33 MB ~ 1 TB |

exFAT / NTFS 格式化暂不提供：目前没有许可证兼容且经过验证的 Java 实现（exfatprogs / ntfs-3g 的 mkfs 为 GPL）。

## 从源码构建

依赖：Node.js 20+、pnpm、Rust（android targets）、Android SDK/NDK。

```bash
pnpm install
pnpm tauri android init   # 已初始化可跳过
pnpm tauri android build --apk --target aarch64 --target armv7
```

产物位于 `src-tauri/gen/android/app/build/outputs/apk/`。

打 tag（`v*`）推送后，GitHub Actions 会自动构建并发布 Release。

插件单元测试（在电脑上用磁盘镜像验证各文件系统的读取、FAT32 格式化与写入）：

```bash
scripts/make-test-images.sh /tmp/fsimg   # 需要 exfatprogs ntfs-3g e2fsprogs dosfstools mtools
cd src-tauri/gen/android
USBFS_IMAGES=/tmp/fsimg USBFS_TEST_JAVA=/path/to/jdk11/bin/java ./gradlew :tauri-plugin-usb-storage:testReleaseUnitTest
```

## 技术栈

Tauri 2 · Rust · React 19 · Vite · CodeMirror 6 · pdf.js · mammoth · SheetJS · pptx-preview

## License

MIT

第三方库（直接模式）：

- [libaums](https://github.com/magnusja/libaums) `me.jahnen.libaums:core` — Apache-2.0
- [java-fs](https://github.com/magnusja/java-fs) `me.jahnen:java-fs`（基于 JNode）— LGPL-2.1，以独立依赖库形式动态链接，未做修改；其依赖 log4j 1.2.17（Apache-2.0，仅使用日志 API，不加载任何配置）
- `JnodeDevice.kt` 移植自 libaums 的 javafs 模块 — Apache-2.0
