# 弹幕播放器（Danmaku Player）

本地视频与 XML、ASS 弹幕同步播放器。视频不会上传，弹幕文件与延迟设置按视频保存在本机。

桌面运行层使用 **Tauri 2 + Rust + 系统 WebView**，不再捆绑 Electron、Chromium 或 Node.js。原有 React 页面、CSS、布局和按钮保留。Windows 使用 WebView2，macOS 使用 WKWebView，Linux 使用 WebKitGTK。实际内存与包体大小还受系统 WebView、FFmpeg、媒体依赖和视频内容影响。

## 功能

- XML、ASS 弹幕解析与同步显示
- 全局、逐条及“从此条开始”的批量延迟
- 按时间或文字搜索弹幕
- 播放速度、音量、循环、画面适应和全屏
- 原生视频选择、视频/弹幕拖放、系统“打开方式”和单实例打开
- Linux AppImage、Windows NSIS、macOS DMG 桌面打包与视频文件关联
- 内置 FFmpeg/ffprobe，支持 MP4、MKV、AVI、MOV、WMV、FLV、TS/M2TS、MPEG/VOB、WebM、OGV、3GP、RM/RMVB 等常见容器与编码

## 使用方法

1. 选择本地视频或将视频拖入播放区域。桌面版也支持通过系统“打开方式”打开视频。
2. 选择对应的 Bilibili XML 或 ASS 弹幕文件，也可以同时拖入视频和弹幕。
3. 在侧栏调整透明度、字号、滚动时间和轨道；可通过文字或时间（如 `01:25`）搜索。
4. 调整全局延迟，或通过列表中的 `−` / `＋` 调整单条弹幕。右键一条弹幕可批量调整其后弹幕。正数表示延后，负数表示提前。
5. 点击弹幕列表中的条目，即可跳转到调整后的对应时间。

| 快捷键 | 功能 |
| --- | --- |
| `Space` | 播放 / 暂停 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `M` | 静音开关 |
| `D` | 弹幕开关 |
| `F` | 全屏 |

输入框或下拉选择框获得焦点时，播放器快捷键不生效。

弹幕及设置继续使用 IndexedDB，按视频名称、大小和修改时间保存。更换 WebView 后，旧 Electron 的 IndexedDB 不能直接由新引擎读取，需要重新加载弹幕；原 Electron 数据目录不会删除。清除新应用数据会丢失新保存的记录。原视频文件不会修改。

## 多格式播放

Rust 媒体服务检查视频和音轨编码：兼容的 MP4/WebM 直接播放；其他格式由内置 FFmpeg 实时转换为 H.264/AAC，通过仅监听 `127.0.0.1` 的私有随机 URL 交给原有界面。系统 WebView 无法直接播放的编码会回退到兼容模式。无需上传视频或生成完整转码副本。

兼容模式保留暂停、音量、倍速、循环、全屏和弹幕设置。进度条、方向键和点击弹幕定位会从目标时间重新解码，并继续使用原视频时间轴。切换视频、跳转、关闭窗口和断开播放连接会终止对应解码进程。高分辨率视频的软件解码/转码可能消耗较多 CPU。

系统 WebView 必须能够播放 H.264/AAC。Linux 使用 GStreamer：开发时需要安装相应插件，AppImage 配置了 `bundleMediaFramework` 打包媒体框架。不同系统 WebView 的字体、视频解码和渲染可能存在差异。网页版本继续使用浏览器原生解码。

## 开发

网页开发需要 Node.js `>=22.13.0`。桌面开发还需要 Rust stable 和 [Tauri 平台前置依赖](https://v2.tauri.app/start/prerequisites/)。Node.js 仅用于开发构建，不随应用发布。

```bash
npm ci
npm run dev          # 网页开发
npm run desktop:dev  # 构建原有前端、准备 FFmpeg，然后启动 Tauri
```

Linux 开发环境示例：

```bash
# Arch / CachyOS
sudo pacman -S --needed rust webkit2gtk-4.1 gstreamer base-devel openssl librsvg patchelf gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav

# Ubuntu / Debian
sudo apt-get install libwebkit2gtk-4.1-dev build-essential libxdo-dev libssl-dev librsvg2-dev patchelf libgstreamer1.0-dev gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

Windows 需要 Microsoft C++ Build Tools 和 WebView2；macOS 需要 Xcode Command Line Tools。桌面开发命令先构建前端，修改后需要重启命令。

首次安装依赖会下载 FFmpeg。若包管理器阻止了 `ffmpeg-static` 的安装脚本，可以执行：

```bash
node node_modules/ffmpeg-static/install.js
```

## 构建

```bash
npm run build          # 网页构建，产物位于 dist/
npm run start          # 启动网页服务
npm run desktop:build  # 桌面前端，产物位于 desktop-dist/
npm run linux:native    # Linux 原生压缩包，使用系统 WebKit/GStreamer
npm run appimage       # Linux AppImage
npm run windows       # Windows x64 NSIS 安装程序
npm run macos         # Intel x64、Apple Silicon arm64 两个 DMG
```

安装包会复制到 `release/`。建议在目标系统构建；macOS 命令分别构建两个架构，并为每个架构准备相应 FFmpeg/ffprobe。

Linux 原生压缩包解压后运行 `启动弹幕播放器.sh`，可传入视频路径。它只包含应用、FFmpeg/ffprobe 和图标，使用系统已有的 WebKitGTK 4.1 与 GStreamer 插件。AppImage 同时打包 WebKit 和媒体框架，体积通常更大；更换桌面运行层并不保证 AppImage 比旧 Electron 包小。

`scripts/bundle-media.cjs` 按目标平台/架构从锁定的 npm 包或缓存准备二进制，存放在 `src-tauri/media-binaries/`，Tauri 将其打包到资源目录的 `media/`。目标架构由构建脚本传入，避免混入主机的解码器。FFmpeg 使用 GPL 许可证，随包保留许可证与源码来源说明，来源见 [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 和 [ffprobe-static](https://github.com/joshwnj/ffprobe-static)。

Linux 将 AppImage、图标与安装脚本放在同一目录，然后执行：

```bash
bash release/安装弹幕播放器.sh
# 若目录内有多个版本，可显式传入 AppImage 路径。
bash release/安装弹幕播放器.sh --uninstall
```

脚本安装到当前用户的 `~/.local/bin/`，注册应用列表和视频“打开方式”。

`.github/workflows/desktop-build.yml` 配置了 Linux、Windows、macOS 原生构建、回归测试和安装包上传。三个系统的 CI 结果需要实际运行工作流确认；本机 Linux 验证不代表 Windows/macOS 已验证。公开发布的签名与公证需要另行配置。

## 验证

```bash
npm run lint
npx tsc --noEmit
npm test                # 网页构建、页面回归、生产 Rust 服务真实多格式解码
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run test:media      # 单独运行真实媒体测试
npm run test:desktop    # 有图形环境：实际 Tauri 系统 WebView 的播放、跳转、弹幕、倍速、循环
```

运行 Rust 窗口测试前先执行 `npm run desktop:prepare`，以准备前端和资源。桌面交互测试使用临时目录中的视频，通过仅限 debug 构建的测试脚本入口操作真实控件；发布构建不启用该入口。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `app/page.tsx`、`app/globals.css` | 原有播放器 UI、弹幕解析、同步和本地设置 |
| `src/main.tsx`、`src/desktop.ts` | 桌面前端入口与 Tauri 桥接 |
| `src-tauri/src/` | 原生窗口、文件选择、关联打开和窗口尺寸 |
| `src-tauri/media/` | Rust 本地媒体服务、FFmpeg 生命周期及测试适配器 |
| `src-tauri/tauri.conf.json`、`capabilities/` | 桌面打包、文件关联、CSP 与权限 |
| `shared/video-formats.json` | 网页与桌面共用的视频格式列表 |
| `scripts/` | 构建、图标、媒体资源和安装脚本 |
| `build-resources/icon.png` | 原有图标源文件 |
| `src-tauri/icons/` | 由同一 PNG 生成的原生平台图标 |
| `tests/` | 页面、媒体服务和原生 WebView 播放测试 |

保留 `package-lock.json` 与 `src-tauri/Cargo.lock`。依赖、构建目录、原生资源缓存、安装包和测试输出由 `.gitignore` 排除，不提交生成的前端或编译产物。
