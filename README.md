# USB文件浏览器（USB File Browser for Android）

基于 Tauri v2（Rust + Android WebView）+ React 构建的 Android 文件浏览器，支持浏览手机本机存储与 USB 外接存储（OTG），并内置文本编辑器与多种格式的文件预览。

## 功能

- 主页选择存储位置：内部存储 / USB 外接存储（插入拔出自动刷新）
- 文件浏览：面包屑导航、排序（名称/大小/时间）、隐藏文件、目录内搜索
- 多选操作：长按文件或文件夹进入多选，支持全选、复制、剪切、删除、重命名
- 文本编辑器：CodeMirror 6，多语言高亮，编码自动检测（UTF-8 / GBK / UTF-16）
- 文件预览：Markdown / HTML / 图片 / PDF / DOCX / XLSX / PPTX / 视频 / 音频
- 「用系统打开」调用第三方应用，支持分享
- 全新绿色 USB 图标（自适应图标）

## 下载安装

前往 [Releases](../../releases) 下载 APK：

- `universal`：包含 arm64-v8a 与 armeabi-v7a，适合大多数设备（Android 11+）
- `arm64-v8a` / `armeabi-v7a`：单架构包，体积更小

安装前需允许「安装未知应用」；首次使用需在系统设置中授予「所有文件访问」权限。

## 从源码构建

依赖：Node.js 20+、pnpm、Rust（android targets）、Android SDK/NDK。

```bash
pnpm install
pnpm tauri android init   # 已初始化可跳过
pnpm tauri android build --apk --target aarch64 --target armv7
```

产物位于 `src-tauri/gen/android/app/build/outputs/apk/`。

打 tag（`v*`）推送后，GitHub Actions 会自动构建并发布 Release。

## 技术栈

Tauri 2 · Rust · React 19 · Vite · CodeMirror 6 · pdf.js · mammoth · SheetJS · pptx-preview

## License

MIT
