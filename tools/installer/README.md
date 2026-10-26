# 原生安装包

替代旧的 C++/ImGui 自绘部署向导。安装由系统原生工具负责；安装完成后从系统应用列表打开 MES Homework，应用在后台启动并打开默认浏览器。WebGUI 源码与接口不由本次安装器改动。

## 平台与安装格式

已核对 GitHub v0.2.1-rc3 Pre-release 及 v0.2.1-rc4 Draft：实际应用运行时只有以下五个平台。历史 x86 资产只是旧部署器，Node 24 没有配套的 32 位应用运行时，因此不生成误导性的 x86 完整安装包。

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | MSI |
| Windows ARM64 | MSI |
| Linux x64 | DEB、RPM |
| Linux ARM64 | DEB、RPM |
| macOS Apple Silicon | PKG，安装到 /Applications/MES Homework.app |

Windows 使用 WiX 5.0.2 的标准中文 MSI 界面（MIT 许可页、功能选择、目录选择、进度与卸载），不使用旧 GUI。应用启动器为小型 Win32 程序，静态链接 CRT；不是另一个安装向导。Node 和生产依赖随包提供，不在用户安装时下载 npm/Git/编译器。Linux 系统库依赖从实际 ELF 计算，RPM 自动生成库依赖；包管理器仍可能需要安装系统依赖。Windows 的系统要求沿用所携带 Node 24（Windows 10/Server 2016 或更新版本）；Linux 的具体库版本以实际包元数据为准。

未配置发行证书：MSI/PKG 当前没有 Authenticode/Developer ID 签名或 Apple 公证。SHA-256 清单验证文件完整性，不能代替发布者签名。系统可能显示未知发布者提示，不应关闭系统安全功能。CI 验证系统工具安装，不声称已经完成每个目标系统的可视化人工验收。

## 本机模式

- Windows：开始菜单 `MES Homework`、`Stop MES Homework`。
- Linux：应用列表中的相同两个入口；也可执行 `/opt/mes-homework/bin/mes-homework` 或追加 `--stop`。
- macOS：打开 `/Applications/MES Homework.app`；停止：`"/Applications/MES Homework.app/Contents/MacOS/MESHomework" --stop`。

启动后只监听 loopback。本机模式使用 development Cookie 策略，便于纯本机 HTTP 访问，不等于运行 Vite 开发服务器。默认端口是产品配置 8787；若本机模式端口已被其他程序占用，向 OS 申请空闲端口，实际 URL 写入 instance.json。重复打开复用当前实例。关浏览器不停止后台应用，停止入口会请求正常关闭；Windows Job Object 和监督器提供兜底回收。

| 系统 | 默认用户配置/数据根目录 |
| --- | --- |
| Windows | 实际 LOCALAPPDATA 下的 MESHomework |
| Linux | 实际 XDG_DATA_HOME 下的 mes-homework；未设置时为 ~/.local/share/mes-homework |
| macOS | ~/Library/Application Support/MESHomework |

根目录保存 `.env`、`data/`、有界日志及实例控制信息。密钥首次运行在本机随机生成，任何安装包或 MSI 命令行都不携带固定 APP_SECRET。配置存在时保留原字节，不重写额外配置。现有数据库缺少 APP_SECRET 时拒绝生成替代密钥。数据目录不在安装目录内，卸载默认保留。日志每轮最多写 5 MiB，满额停止追加；下一次启动截断满额日志，避免无限占盘。

## 服务器模式

服务器配置与每用户本机数据独立，默认仍只监听 127.0.0.1。公开提供服务前需要 HTTPS 反向代理、正确 APP_ORIGIN/可信代理配置及管理员明确设置；安装不自动开放防火墙或把数据暴露到网络。

- Windows MSI 的“Windows server service”是默认不选择的可选功能；管理员可在功能树选择，或静默安装指定 `ADDLOCAL=Application,Server`。服务名称 `MESHomework`，账户 `NT AUTHORITY\LocalService`，使用实际 ProgramData 下的 MESHomework，ACL 仅允许 SYSTEM、Administrators、LocalService；目录根由 SYSTEM 拥有，LocalService 可以管理内容但不能替换目录根或改写其 ACL。使用 Windows 服务管理器或管理员 PowerShell 的 Start/Stop-Service 管理。服务异常退出由 SCM 重启；应用及子进程在 Job Object 中统一回收，内存硬预算取实际物理内存的 75%（明确分配策略）。
- Linux 安装 mes-homework.service，首次安装默认不启动/不启用；管理员执行 `sudo systemctl enable --now mes-homework`。专用账户 mes-homework，配置 `/etc/mes-homework/environment`（root:mes-homework，0640），数据 `/var/lib/mes-homework/data`。升级时若服务原本运行，则先停后重启；卸载停止服务，保留配置、数据及账户。MemoryHigh/Max=60%/75% 为显式策略，程序继续读取实际资源计算预算。
- macOS 可执行 `"/Applications/MES Homework.app/Contents/MacOS/MESHomework" --install-agent`，注册当前用户的 LaunchAgent，在用户登录后后台运行服务器模式。数据为 `~/Library/Application Support/MESHomeworkServer`。这是用户登录服务，不是无需登录的系统 LaunchDaemon。停止并取消自启：`launchctl bootout "gui/$(id -u)/org.mes-homework.server"`，再移除该用户的 `~/Library/LaunchAgents/org.mes-homework.server.plist`。卸载 App 前应先取消 Agent。需要常驻系统服务的管理员可按实际服务账户另行配置 LaunchDaemon，包不会以 root 启动 Web 服务。

配置/机器规格改动后重启服务。本机启动器与监督器使用私有 IPC 正常停机；API 无响应时仍有超时终止。实例锁使用独立 SQLite 事务，进程崩溃时 OS 释放锁，重启不依赖手工删除 PID 文件。控制端口为 OS 分配的 loopback 端口，随机凭据只在用户受限目录的实例文件中，控制请求限制连接、长度与时间。

## 升级、卸载与旧部署器迁移

新 MSI 使用稳定 UpgradeCode/组件标识，支持原生大版本替换、修复和卸载；同版本重打包允许替换。MSI/PKG 数字版本由源码 SemVer 映射：patch×1000 + alpha100/beta200/rc500+序号，稳定版+999，超出 MSI 范围则拒绝构建；避免把 rc4 与稳定版都错误标为同一 MSI 版本。build 标识保留在包文件元数据和应用 health 中，不伪装成 MSI 能排序的完整构建号。

安装升级前先停止本机应用；原生文件占用提示需要正常处理。Linux 服务升级脚本只管理自己的服务，不扫描/强杀其他用户的应用。本机数据、服务数据、APP_SECRET 和外部 BACKUP_DIR 均不会随卸载自动删除。macOS 卸载为先停止应用/Agent、将 App 移到废纸篓；PKG 收据可由管理员 pkgutil --forget org.mes-homework.installer 清除，用户数据独立保留。

旧部署器未注册为 MSI 产品，原有自定义目录不会自动迁移、删除或被扫描读取。先按 BACKUPS.md 备份并停止旧实例，再将 `MES_HOMEWORK_CONFIG` 指向旧 `.env`（或将原配置复制到新配置位置），保留原 APP_SECRET，DATA_DIR 改为原数据的绝对路径。确认数据访问权限符合新服务账户后启动新包。不要让旧/新实例同时访问同一 DATA_DIR，也不要在未保留密钥时只复制数据库。本机与服务器模式的数据不同，首次使用默认新目录会显示一个新的学校空间。

## 构建与验证

发布入口 `.github/workflows/native-installers.yml`；五个平台实际构建、安装/启动/停止、重复启动、修复/重复安装和卸载保留验证后，聚合七个原生安装包、`mes-homework-installers.json` 和 SHA256SUMS。Tag 流程只创建 Draft Pre-release；功能分支/PR 不发布公共 Release，不修改旧历史发行资产。旧的自绘部署器不再构建或上传。

本地先 `npm ci && npm run build`。用独立目录准备生产依赖，保留前端开发依赖以便 Claude 并行修改，例如：

```sh
mkdir -p /tmp/mes-production
cp package.json package-lock.json /tmp/mes-production/
npm ci --omit=dev --libc=glibc --prefix /tmp/mes-production
node tools/installer/build.mjs --modules /tmp/mes-production/node_modules --out release-native
```

Linux 需要 dpkg-dev/rpm；Windows 需要 CMake、MSVC、WiX 5.0.2 及 UI/Util 扩展，先构建 `tools/installer/windows`，再给 build.mjs 传 `--launcher <MESHomework.exe> --wix <wix.exe>`；Mac 使用系统 pkgbuild/productbuild，最低系统版本从实际 Mach-O 文件提取，安装器限制 ARM64。构建器检查真实 PE 架构、Node 平台、生产依赖及启动结果，不允许把当前 CPU 的运行时重标为另一架构。只复制包声明与当前 OS/CPU/libc 相容的依赖。`--deb-only` 仅用于没有 rpmbuild 的本地验证，不用于完整发布。

CI 不使用真实账户、模型 API 或生产数据。测试源码位于 server/native-installer.test.ts、server/supervise.test.ts；实际包验证脚本为 smoke-installed.mjs、smoke-service.mjs、windows/smoke-msi.ps1。所有测试生成的密钥/数据库仅在临时合成目录；上传的测试报告不含密钥值。
