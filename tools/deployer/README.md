# 一键部署器（C++ 控制台程序）

把「校园作业分析」网站部署到任意一台 Windows 电脑上：自动检测并安装依赖、准备源码、构建、启动服务，并按需开放**局域网**或**公网（Cloudflare 隧道 / 自己的域名）**访问。

- 纯 Win32 + C++17 实现，只依赖 Windows 自带组件（curl、tar、Winsock），不需要额外运行库
- 单文件可执行程序，约 3 MB，静态链接
- 两种使用方式：**控制台交互菜单** 与 **内置可视化 Web 控制台**

## 快速开始

```
campus-deploy.exe                  交互式菜单（推荐首次使用）
campus-deploy.exe --web            打开浏览器可视化部署控制台
campus-deploy.exe --mode lan       直接部署到局域网
campus-deploy.exe --mode tunnel    直接部署并用 Cloudflare 临时域名公开
campus-deploy.exe --mode domain --domain hw.example.com --api-token cf_xxx
```

## 三种部署方式

| 方式 | 适用场景 | 访问地址 |
| --- | --- | --- |
| `--mode lan` | 课堂、办公室：同一 WiFi / 局域网内的电脑、平板、手机都能打开 | `http://<本机IP>:8787` |
| `--mode tunnel` | 需要临时给校外的人看：自动生成 `https://xxx.trycloudflare.com`，程序关闭即失效，无需域名和账号 | 自动分配 |
| `--mode domain` | 长期稳定使用自己的域名（域名需已托管在 Cloudflare） | `https://你的域名` |

### 自定义域名需要什么

1. 域名已托管在 Cloudflare（DNS 在 Cloudflare 上）。
2. 一个 API Token，权限为 `Zone → DNS → Edit`（在 Cloudflare 面板「我的个人资料 → API 令牌」创建）。
3. 二选一提供隧道凭据：
   - 只给 API Token：程序会在你的账户里自动创建名为 `smart-campus-homework` 的命名隧道；
   - 或者先在 Zero Trust 面板创建隧道，把**连接器令牌**用 `--tunnel-token` 传入。

程序会自动完成：定位 DNS 区域 → 创建/更新指向隧道的 CNAME 记录 → 写入 `~/.cloudflared/config.yml` → 启动连接器并等待隧道就绪。

## 命令行参数

| 参数 | 说明 |
| --- | --- |
| `--mode lan\|tunnel\|domain` | 部署方式；不指定则进入交互菜单 |
| `--domain <域名>` | 自定义域名 |
| `--api-token <令牌>` | Cloudflare API Token（写 DNS 记录） |
| `--tunnel-token <令牌>` | 命名隧道连接器令牌 |
| `--tunnel-id <ID>` | 已有隧道 ID（可选） |
| `--port <端口>` | 服务端口，默认 8787 |
| `--dir <目录>` | 指定源码目录；缺省自动探测，找不到就从 GitHub 下载 |
| `--repo <地址>` | 源码仓库地址 |
| `--web` / `--web-port <端口>` | 启用可视化控制台（默认端口 8899） |
| `--skip-install` / `--skip-build` | 跳过 npm install / npm run build |
| `--verbose` | 输出完整构建日志 |
| `--help` / `--version` | 帮助 / 版本 |

## 依赖自动安装策略

程序按「先检测、再安装、装完复检」的顺序处理：

| 依赖 | 是否必需 | 安装方式 |
| --- | --- | --- |
| Node.js ≥ 24 | 必需 | 优先 `winget install OpenJS.NodeJS`；无 winget 时提示手动安装 |
| npm | 必需 | 随 Node.js 安装 |
| curl | 必需 | Windows 10 1803+ 自带，缺失时明确报错 |
| cloudflared | 公网模式必需 | 优先 winget；失败则从 Cloudflare 官方 GitHub Release 下载到 `%LOCALAPPDATA%\SmartCampusDeployer\tools` 并加入用户 PATH |
| Git | 可选 | 无 git 时直接用源码压缩包，不影响部署 |

安装到自定义目录后程序会**同时更新注册表 PATH 和当前进程 PATH**，因此同一次运行内即可继续使用刚装好的命令。

## 源码获取顺序

1. `--dir` 指定的目录（若确实是本项目）
2. 可执行文件所在目录（部署包与源码放在一起时）
3. 可执行文件下的 `source/`、`MES-Homework/`、`app/` 子目录
4. 以上都没有 → 从 GitHub 下载源码压缩包并解压（失败再回退 `git clone`）

## 可视化 Web 控制台

`--web` 会启动一个**仅监听 127.0.0.1** 的小型 HTTP 服务并自动打开浏览器，页面提供：

- 依赖检测结果与「安装缺失依赖」按钮
- 三种部署方式选择，自定义域名模式带域名 / API Token / 隧道令牌输入框
- 七步部署进度条（准备源码 → 安装依赖 → 构建 → 生成配置 → 启动服务 → 健康检查 → 开放访问）
- 彩色实时运行日志与最终访问地址（可点击）

Web 控制台只在本机回环地址上监听，不对外暴露。

## 构建

需要 MinGW-w64（含 g++）或 Visual Studio 生成工具，以及 CMake：

```powershell
powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1
# 产物：dist-deployer/campus-deploy.exe
```

没有 CMake 时脚本会直接用 g++ 编译。手动编译等价命令：

```powershell
g++ -std=c++17 -O2 -static -static-libgcc -static-libstdc++ `
  tools/deployer/src/*.cpp -o dist-deployer/campus-deploy.exe `
  -lws2_32 -liphlpapi -lshell32 -ladvapi32 -lole32
```

产物为静态链接的单文件程序，可直接拷到其它 Windows 10/11 机器运行。

### 运行 JSON 解析器测试

Cloudflare API 与隧道凭证都依赖自带的极简 JSON 解析器，可用真实响应形态验证：

```powershell
cmake --build tools/deployer/build --target json-test
dist-deployer/json-test.exe
```

## 源码结构

```
tools/deployer/
├── CMakeLists.txt          构建配置
├── build.ps1               一键构建脚本
├── tests/json_test.cpp     JSON 解析器测试（真实 API 响应形态）
└── src/
    ├── main.cpp            入口、控制台交互菜单、命令行参数分发
    ├── deploy.h/.cpp       部署核心：依赖检测与安装、源码准备、构建、启动、隧道
    ├── util.h/.cpp         基础设施：UTF-8 控制台、彩色日志、进程管道、HTTP(curl)、网卡枚举
    ├── json.h/.cpp         极简 JSON 解析（Cloudflare API 与错误信息解析）
    ├── cloudflare.h/.cpp   Cloudflare API：Token 校验、区域定位、隧道的 DNS 记录写入
    └── webconsole.h/.cpp   内置 Web 部署控制台（页面 + 状态/部署/日志接口）
```

## 安全说明

- 部署时会在源码目录写入 `.env`，其中 `APP_SECRET` 为随机生成并**在后续部署中复用**（避免每次部署让所有登录态失效）。该文件已被 `.gitignore` 排除，请勿提交或外传。
- 公网模式会把服务暴露到互联网。`.env` 中 `HOST=0.0.0.0` 表示监听全部网卡；如果只想本机用，可改为 `127.0.0.1`。
- 临时隧道（trycloudflare）没有可用性保证，切勿用于长期生产。

## 已知限制

- 仅支持 Windows（使用 Win32 API）。
- 首次在局域网内访问若被防火墙拦截，程序会打印一条 `netsh advfirewall` 命令，需要管理员权限执行一次。
- 自定义域名模式依赖 Cloudflare API；若域名未托管在 Cloudflare，程序会明确报错并建议改用手动配置。
