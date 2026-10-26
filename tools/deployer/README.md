> Historical source only: this custom deployment GUI is retired from builds and releases. Use [native MSI / DEB / RPM / PKG packages](../installer/README.md).

# 校园作业分析 · 桌面版一键部署器

**v0.2.1-rc4（build26102501）** · MIT License · 单文件、无外部运行时依赖

新版部署器是一个 **C++17 桌面应用**（GLFW + Dear ImGui + miniz，全部静态编译进单文件），
取代原来的 C++ 控制台部署器：启动后在「本地版 / 服务器版」之间选择，按向导完成
下载运行时 → 校验 → 解压 → 写入配置 → 启动/注册服务 → 健康检查，全程可视化。

- **Apple 风格 UI**：浅色玻璃质感卡片、圆角、轻阴影、系统字体；Windows 11 使用 Mica/Acrylic
  系统级毛玻璃，macOS 使用 `NSVisualEffectView` 真实毛玻璃，Linux 使用透明窗口 + 柔和玻璃光效。
- **零依赖**：目标机不需要预装 Node.js、npm、Git、Python 或 VC++ 运行库；应用运行时与 Node
  二进制由部署器下载/解压（也支持离线 zip）。
- **安装包/本体单文件**：每个平台一个可执行文件，见 GitHub Releases 的 `v0.2.1-rc4` 附件。

## 界面预览

![欢迎页](../../docs/screenshots-v0.2.1/deployer-welcome.png)
![配置页](../../docs/screenshots-v0.2.1/deployer-configure.png)
![安装进度](../../docs/screenshots-v0.2.1/deployer-installing.png)
![完成页](../../docs/screenshots-v0.2.1/deployer-result.png)
![关于页](../../docs/screenshots-v0.2.1/deployer-about.png)

## 两个版本

| | 本地版 | 服务器版 |
| --- | --- | --- |
| 使用场景 | 一台电脑自己用 | 班级/学校服务器、局域网或公网访问 |
| 监听地址 | `127.0.0.1` | 默认 `0.0.0.0`（可关闭局域网） |
| 开机自启 | 可选 | 可选（Windows 计划任务 / systemd / launchd） |
| 防火墙 | 不需要 | 可自动放行端口（需管理员授权） |
| 数据目录 | 安装目录 `data/` | 安装目录 `data/`，可改到独立磁盘 |
| 完成后 | 自动打开浏览器 | 展示局域网访问地址与运维提示 |

> 一个可执行文件即可完成两种版本：首屏选择本地版或服务器版。

## 支持的系统

| 系统 | 架构 | 部署器 | 应用运行时 |
| --- | --- | --- | --- |
| Windows 10 / 11 | x64 | ✅ | ✅（Node.js 24 x64） |
| Windows 10 / 11 | arm64 | ✅ | ✅（Node.js 24 arm64） |
| Windows 10 / 11 | x86 | ✅ | ⚠️ 官方 Node.js 24 已无 32 位版本；部署器可运行/配置，应用运行需 64 位设备或服务器 |
| Debian / Ubuntu 等 Debian 系 | x64 / x86 / arm64 | ✅ | x64/arm64 ✅；x86 ⚠️（同 Node.js 32 位限制） |
| RHEL / Rocky / AlmaLinux 等 RHEL 系 | x64 / x86 / arm64 | ✅ | x64/arm64 ✅；x86 ⚠️ |
| 银河麒麟（Kylin V10 SP2+） | x64 / x86 / arm64 | ✅ | x64/arm64 ✅；x86 ⚠️ |
| macOS 11+ | Apple Silicon（arm64） | ✅ | ✅（Node.js 24 arm64） |

说明：

- Linux 构建目标为 glibc ≥ 2.31（Debian 11+ / Ubuntu 20.04+ / RHEL 9+ / Kylin V10 SP2+）；
  其它发行版若 glibc 过旧，请用容器或升级系统。
- macOS 目前只提供 Apple Silicon 单文件（Intel Mac 可通过 Rosetta 或源码构建）。
- 部署器本体可在所有列出的系统/架构运行；应用运行时是否需要 64 位取决于是否有对应
  Node.js 官方二进制（Node 24 不再提供 32 位 Windows/Linux 版本）。

## 下载

前往 [GitHub Releases](https://github.com/turtlelnc/MES-Homework/releases) 的
`v0.2.1-rc4`（构建 `26102501`），按平台下载单个可执行文件：

```
mes-deployer-windows-x64.exe
mes-deployer-windows-x86.exe
mes-deployer-windows-arm64.exe
mes-deployer-linux-x64
mes-deployer-linux-x86
mes-deployer-linux-arm64
mes-deployer-macos-arm64
```

应用运行时包（部署器自动下载，也可手动离线使用）：

```
mes-homework-app-windows-x64.zip / -windows-arm64 / -linux-x64 / -linux-arm64 / -macos-arm64
mes-homework-app-manifest.json   （版本与 SHA-256 清单）
SHA256SUMS.txt                   （全部资产校验值）
```

Windows 首次运行 SmartScreen 可能提示“未知发布者”，选择“更多信息 → 仍要运行”；
macOS 需在“隐私与安全性”中允许打开（或 `xattr -dr com.apple.quarantine`）。

## 使用

1. 双击运行部署器（无需安装）。
2. 选择「本地版」或「服务器版」。
3. 确认安装目录、端口与安装包来源：
   - 默认自动下载 GitHub Release 中对应平台的运行时包（需要联网）；
   - 离线部署：把 `mes-homework-app-<平台>-<架构>.zip` 放在部署器同目录，或点击“选择本地 zip”。
4. 点击「开始部署」，等待下载、校验、解压、启动与健康检查完成。
5. 完成后自动打开浏览器；服务器版会显示局域网地址，并把服务注册为开机自启（可选）。

部署器命令行：

```
mes-deployer --self-test    # 核心自检（CI/诊断用，无窗口）
mes-deployer --demo         # 演示模式：不联网、不写真实目录
mes-deployer --version      # 版本号
mes-deployer --help
```

## 构建

要求：CMake 3.16+、C++17 编译器（MSVC 2019+/MinGW-w64/Clang）、Git 网络（首次下载
GLFW 3.4、Dear ImGui v1.91.9b、miniz 3.0.2；或用 `-DMES_DEPLOYER_DEPS_DIR=<dir>` 指向
已下载的 `glfw/`、`imgui/`、`miniz/` 源码目录离线构建）。

Windows（MinGW-w64 或 Visual Studio）：

```powershell
powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1
# 产物：dist-deployer/mes-deployer.exe
```

Linux（Debian/Ubuntu 构建依赖）：

```bash
sudo apt-get install -y cmake ninja-build g++ libx11-dev libxrandr-dev \
  libxinerama-dev libxcursor-dev libxi-dev libgl1-mesa-dev xorg-dev
cmake -S tools/deployer -B tools/deployer/build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build tools/deployer/build --parallel
./tools/deployer/build/mes-deployer --self-test
```

macOS（Apple Silicon）：

```bash
cmake -S tools/deployer -B tools/deployer/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0
cmake --build tools/deployer/build --parallel
./tools/deployer/build/mes-deployer --self-test
```

单元测试：构建后运行 `ctest --test-dir tools/deployer/build --output-on-failure` 或
`mes-deployer-test`。

## 运行时包结构

部署器解压 `mes-homework-app-<os>-<arch>.zip` 后按如下结构安装：

```
<安装目录>/
  runtime/node[.exe]       # Node.js 24 官方运行时
  app/                     # server/ + dist/ + node_modules/ + package*.json
  data/                    # SQLite 与上传文件
  logs/                    # 服务日志
  .env                     # APP_SECRET / PORT / HOST / NODE_ENV / DATA_DIR
  start.*                  # 本地版启动脚本（服务器版含服务定义）
  state.json               # 安装记录（供部署器识别/修复/卸载）
```

发布流程（维护者）：`.github/workflows/deployer-release.yml` 在推动分支/打 tag 时构建
各平台部署器与运行时包并上传 artifact；打 `v*` tag 时自动创建 GitHub Release 并附加
`manifest` / `SHA256SUMS.txt`。也可用：

```bash
node tools/deployer/packaging/build-app-bundle.mjs --out release/mes-homework-app-linux-x64.zip
node tools/deployer/packaging/build-manifest.mjs --dir release --version v0.2.1-rc4 --build 26102501
```

## 安全与限制

- 下载与应用运行时包校验 SHA-256；解压拒绝 `..`、绝对路径与符号链接条目（zip-slip 防护）。
- 服务器版的服务注册、防火墙放行需要管理员/root 权限，会显式请求授权；拒绝授权时不影响
  本地版使用。
- 日志不记录 APP_SECRET、API Key 或 OAuth Token；`.env` 仅写入本机安装目录。
- 服务器版默认 `NODE_ENV=development`（HTTP 可登录）；若勾选“生产模式”，必须在外层配置
  HTTPS 反向代理（如 Cloudflare/Nginx），否则浏览器会拒绝 Secure 会话 Cookie。
- 32 位系统没有官方 Node.js 24 运行时，无法在本机运行应用；部署器仍可运行、生成配置与
  访问说明。请使用 64 位系统或服务器版部署到 64 位机器。
- 可选隧道/自定义域名请按 [OPERATIONS.md](../../OPERATIONS.md) 使用 cloudflared 或 Nginx，
  部署器当前聚焦本地/局域网一键部署与开机自启。
