# Repository Guidelines

本文件面向在此仓库中工作的自动化代理/贡献者。当前产品版本：**v0.2.1-rc4（build 26102501）**。
新增或修改功能后请同步更新本文件。

## Project Structure & Module Organization

- **前端（React 19 + TypeScript + Vite）**：`src/`。
  - `src/main.tsx` 是应用外壳/路由与各业务工作流；`src/api.ts` 封装 API 请求；`src/styles.css` 是共享样式。
  - 账号/登录：`src/AuthPage.tsx`；家长端：`src/ParentDashboard.tsx`；学校模型模式：`src/SchoolModelPanel.tsx`。
  - 模型凭证与 OAuth：`src/ProviderSettings.tsx`、`src/OAuthLoginDialog.tsx`、`src/oauth-flows.ts`。
  - 学生引导式错题本：`src/StudentMistakes.tsx`；可复用 UI 在 `src/components/`。
  - 版本标识：`src/version.ts`（与服务端 `server/version.mjs` 同步）。
- **后端（Express 5 + `node:sqlite`）**：`server/`。
  - `index.mjs` 负责路由装配、模型调用编排、识别/复核流程；`schema.sql` 定义新库；`migrations.mjs` 启动时原地迁移旧库。
  - 账号/注册/登录：`accounts.mjs`、`security.mjs`；家长端：`parent.mjs`；学情分析：`analysis.mjs` 等。
  - 复核与批改：`review.mjs`（全部/仅存疑/不复核+存疑判定）、`grading.mjs`、`direct-grading.mjs`（无原题直批）、`mistakes-guide.mjs`（引导式错题本）。
  - OAuth 模型链接：`oauth.mjs`（provider 注册、attempt 路由、存储与模型调度），provider 协议模块 `oauth-chatgpt.mjs`（Codex OAuth 浏览器回调 + 设备码 + Responses API）与 `oauth-workbuddy.mjs`（浏览器/设备码轮询 + chat SSE）。
  - 模型调用模式/凭证路由：`model-access.mjs`；API Key 厂商预设：`providers.mjs`。
  - 有界并发批改：`recognition-queue.mjs` 按 `runtime-profile.mjs` 探测的实际 CPU/cgroup/内存预算计算并发，同一教师可并行处理不同答卷，完成即补位；`model-budget.mjs` 保留全局/学校/账户额度，学生最多 1 个在途；`model-images.mjs` 对 API Key/OAuth 内联图片预留共享 Base64 预算（默认有效内存的 1/32，受堆预算约束）。API Key 请求显式非流式，OAuth 的 SSE/Responses 协议仍由 provider 模块处理。配置与压测方法见 `CONCURRENT_GRADING.md` / `LOAD_TESTING.md`。
  - 文档解析：`document.mjs` / `word.mjs`；备份/运维：`tools/ops/`、`server/backup*.mjs`。
- **原生安装包**：`tools/installer/`。Windows 使用标准 MSI（WiX 5.0.2），Linux DEB/RPM，macOS PKG；应用/服务启动不使用旧自绘 GUI。
  - `build.mjs`/`assemble.mjs` 组装实际平台运行时；`targets.json` 是支持矩阵；`runtime/` 管理私有配置、实例锁、IPC、启动/停止；`windows/` 是 Win32 启动/服务宿主（CMake + 静态 CRT），不绘制安装 UI。
  - `smoke-installed.mjs`/`smoke-service.mjs`/`windows/smoke-msi.ps1` 验证实际包，说明见 `tools/installer/README.md`。
  - `tools/deployer/` 仅保留历史源码/兼容组装工具；不重新启用旧 GUI 发布，也不恢复 campus-deploy。
- **文档/截图/发布**：`README.md` / `README.EN.md`（顶部徽章）、`docs/oauth-flows.md`（OAuth 接口契约）、`docs/releases/v0.2.1-rc4.md`、`docs/screenshots-v0.2.1/`、`SECURITY_REVIEW.md`、`SAFETY*.md`。
- **静态资源/构建产物**：`public/`、`dist/`；运行数据在 `data/`（禁止提交）。
- **Cloudflare**：`cloudflare-worker.mjs`、`wrangler.jsonc`。

## Build, Test, and Development Commands

- `npm install` 安装锁定依赖；`npm ci` 用于 CI。
- `npm run dev`：Vite 开发服务器（127.0.0.1:5173）。
- `npm run dev:server`：监听式 API 服务（8787）。
- `npm run build`：严格 TypeScript 检查 + Vite 生产构建（`dist/`）。
- `npm test`：Vitest 全量测试（含 e2e）。
- `npm start`：生产 API + 已构建前端（默认 127.0.0.1:8787）。
- `npm run verify:teaching`：真实服务 + mock 模型的 AI 教学分析 API 校验。
- `npm run test:browser`：Playwright 真实浏览器流程（CI 会安装 Chromium；本机可设 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指向系统 Chrome）。
- 本地运行：复制 `.env.example` 为 `.env`（仅本地，已被 gitignore），至少设置 `APP_SECRET`（≥32 字符）和 `DATA_DIR`，然后 `node --env-file=.env server/index.mjs`。
- **OAuth 专项测试**：`npx vitest run server/oauth.test.ts server/oauth-chatgpt.test.ts server/oauth-workbuddy.test.ts server/migrations.test.ts`（全部 mock fetch，禁止真实登录/真实网络）。
- **原生安装包**：按 `tools/installer/README.md` 准备独立的生产依赖目录后运行 `node tools/installer/build.mjs --modules <目录> --out release-native`；不要 prune 正在供 WebGUI 开发使用的 node_modules。
  - Windows：CMake 构建 `tools/installer/windows` 并运行 CTest，给打包器传 `--launcher` 与 `--wix`。Linux 需 dpkg-dev/rpm；macOS 使用 pkgbuild。
  - `.github/workflows/native-installers.yml` 在各目标平台构建并实际安装/卸载验证，聚合通过后提供原生资产。不要提交 release-native/、构建目录、私有配置或真实用户数据。
- **版本更新清单**（发布前逐项同步）：`package.json`、`package-lock.json`、`server/version.mjs`、`src/version.ts`、`server/version.test.ts`、README/README.EN 版本行与徽章、`tools/deployer/CMakeLists.txt` 读取的版本来源、部署器 README/打包脚本默认值、`docs/releases/<版本>.md`、`.github/workflows/native-installers.yml` 的版本/构建号与 notes 路径。
- 已知本机（Windows）全量 `npm test` 会有一部分历史遗留环境限制失败（backup fsync EPERM、`/proc` cgroup、Linux admission 等），属于上游/平台差异，Ubuntu CI 会覆盖；不要把这类失败归因于本次功能改动。

## Coding Style & Naming Conventions

- JS/TS：2 空格缩进；`npx prettier --write src server`；前端优先 TypeScript，服务端用 ESM `.mjs`；组件/类型 `PascalCase`，函数/变量 `camelCase`，路由用描述性命名（如 `/api/mistakes/:id/practice/submit`）。
- 数据库访问必须参数化，并按学校/用户身份限定范围；不要拼接 SQL。
- OAuth 相关代码：
  - 仅保留 3 个 provider：`chatgpt`、`gemini`、`workbuddy`。已移除 `claude`、`qwen`、`qianwen`、`deepseek`，所有授权/回调/断开路由对它们必须返回 404；API Key 厂商预设不受影响。
  - 每个 provider 的授权参数/端点/请求头/响应解析放在对应 `server/oauth-*.mjs` 模块，不要在 `oauth.mjs` 里混入协议细节。
  - 令牌只在服务端加密存储；`meta_json` 保存 provider 身份（chatgpt: accountId/email；workbuddy: uid/enterpriseId/domain/region/nickname；gemini: 空）。
  - 不得在日志、错误信息、API 响应、截图中出现 access/refresh token、client secret、用户密码。
- C++ 部署器：C++17；不要新增第三方库（GLFW/Dear ImGui/miniz 已由 CMake FetchContent 引入）；平台 API 只能出现在 `src/platform/`；保持 MSVC 与 MinGW-w64 可编译；中文界面/错误文案用 UTF-8；日志与 UI 不显示 `APP_SECRET`/API Key/OAuth token。
- 安装 UI 使用系统原生 MSI/PKG/包管理器，不恢复旧 ImGui 界面；WebGUI 由用户/Claude 单独修改，安装器改动避免触碰 src/ 和页面样式。

## Testing Guidelines

- Vitest 测试放在被测模块旁，命名 `*.test.ts`（如 `server/oauth.test.ts`、`server/model-access.test.ts`）。覆盖授权边界、SQLite 迁移、文件解析、provider 行为与 OAuth 流程。
- OAuth/模型相关测试一律 mock `fetch`/provider 模块，不调用付费模型、不进行真实 OAuth 登录、不触真实上游网络。
- 浏览器流程用 `tests/browser/*.pw.mjs` + Playwright；涉及 UI 的改动建议补充或更新截图（`docs/screenshots-v0.2.1/`），CI 会运行 Chromium。
- 原生包：Windows launcher CTest + MSI 实际安装/修复/卸载；Linux DEB 实装/systemd/卸载及 RPM 检查；Mac PKG 实装/.app 启动/保留数据。安装器可视界面和签名/公证未验证时需明确记录。
- 提交前至少运行：`npm test`（或相关子集）、`npm run build`、相关 OAuth/迁移测试；改动部署器时再构建并运行 CTest/自检。

## Commit & Pull Request Guidelines

- 使用 Conventional Commit，例如 `feat(oauth): ...`、`fix(deployer-ci): ...`、`docs: ...`。
- PR 必须说明：用户可见行为、数据库迁移影响、安全/隐私影响、验证方式；UI 变化附截图；新增环境变量/部署步骤明确列出。
- 只提交源码/文档/测试与必要资源；不要提交 `node_modules` 平台差异、`dist/`、`data/`、`.env`、临时构建目录、OAuth/API 凭证或真实学生数据。仓库历史中 `node_modules` 仍被跟踪，务必用具体路径 `git add`，避免把本机依赖变动带入提交。
- 版本号变更 PR 请同步更新本文件顶部的版本说明。

## Security & Data Handling

- 不提交 API Key、`.env`、SQLite 数据库、上传的学生作业/答卷、生成的临时文件或截图中的真实账号信息。
- OAuth：授权码 + PKCE（ChatGPT 另支持设备码/Codex OAuth；WorkBuddy 使用官方浏览器/设备码轮询），一次性 state、AES-256-GCM 加密令牌、自动刷新/断开；ChatGPT 本机回调仅监听 `127.0.0.1:1455`，授权链接只允许官方域名。
- 上传文件必须校验 MIME/大小；AI 批改结果保留教师复核流程（按学校所选复核模式）；直接批改模式的题目快照不参与班级 AI 教学分析。
- 服务器版部署器安装服务/放行防火墙必须显式提权（UAC/pkexec/osascript），不得静默提权；生产环境需要 HTTPS 反向代理（Secure Cookie）。
- 外部 OAuth/模型上游协议（Codex OAuth、WorkBuddy 非公开接口）存在变更风险；修改相关端点/请求头后必须更新测试与文档，并说明真实联调状态。

## Release & Deployment

- 应用发布：Native installers 矩阵为 Windows x64/ARM64 MSI、Linux x64/ARM64 DEB/RPM、macOS ARM64 PKG；聚合校验七个资产及 SHA256SUMS/mes-homework-installers.json，tag 只生成 Draft Pre-release。不发布旧自绘部署器，也不改写历史 Release。
- 部署器两个版本：本地版（127.0.0.1，自动开浏览器）与服务器版（局域网、可选开机自启/防火墙）；平台限制：官方 Node.js 24 无 32 位运行时（x86 系统仅可运行部署器，应用需 64 位），Linux glibc ≥ 2.31，macOS 仅 Apple Silicon。
- OAuth 真实可用性：ChatGPT Codex OAuth/WorkBuddy 上游未在仓库内用真实账号验证；Gemini 需要部署方在 Google Cloud 创建 OAuth 客户端并配置 `OAUTH_GEMINI_CLIENT_ID/SECRET`；中国大陆境内无法使用 ChatGPT/Gemini。
- 部署与运维细节见 `README.md`、`tools/deployer/README.md`、`docs/oauth-flows.md`、`OPERATIONS.md`、`SECURITY_REVIEW.md`。

## 发布前审核维护约定

- 环境容量统一由 `runtime-profile.mjs`、`storage-profile.mjs` 探测；不能把压测机器配置或供应商报价当成程序默认事实。分配比例、超时、业务配额属于显式策略，见 `RUNTIME_CONFIGURATION.md`。
- `/api/capabilities` 从数据库约束和部署配置提供学段、注册策略；前端不得另猜默认值。作业详情、复核历史、已存试卷均有真实 API 入口。
- 数据库启动迁移必须整体事务回滚，并对比新库的字段、默认值、外键、CHECK、索引；不允许忽略迁移错误后继续服务。
- 运行时包包含 `shared` 和 `tools/ops`；部署器优先启动监督器，加载 `.env`，升级保留额外配置。CMake/打包版本从 `server/version.mjs` 读取。
- 金额预算启用时，任何视觉模型都必须显式配置保守 `imageTokens`；不得猜测 DeepSeek 图像计费参数。Anthropic 使用原生 Messages 协议。
- `node tools/ops/audit-contracts.mjs <报告路径>` 输出路由/前端引用和常量清单；静态引用覆盖不能替代授权与浏览器测试。见 `PRE_RELEASE_AUDIT.md`。

- 打包前 `verify-app-runtime.mjs` 必须用组装目录实际启动临时服务，验证 health/版本和环境配置，避免源码测试掩盖漏装 shared 等运行依赖。

## 登录与会话维护

- `/me` 的 401 才表示未登录；网络/503 必须保留当前用户并提供重试。退出失败不能伪装为已退出，旧会话读取响应不能覆盖较新的退出状态。
- 邮箱登录使用 NOCASE 查询与 idx_users_email_login 索引；旧库若有大小写歧义不得任选账号，新建账号也要拒绝大小写冲突。用户名规范化/旧邮箱登录仍兼容。
- 未知账号也经过同一个有界密码派生队列，统一凭据错误；认证繁忙返回 503。勿用固定 dummy salt 存储真实用户密码。详见 LOGIN_REVIEW.md。

## 原生安装器安全边界

- 密钥在首次启动生成，安装文件及命令行不含固定 APP_SECRET。升级/修复/卸载保留配置及独立数据目录，不扫描或自动搬动旧用户目录。
- Linux 服务低权限专用账户、Windows 可选服务 LocalService、Mac 用户 LaunchAgent；不得把 Web 服务作为 root/System 运行。服务启用须显式选择/管理，默认 loopback，不自动放行防火墙。
- 正常停止通过私有 IPC，API/监督器监听 IPC 停机；保留超时终止和父进程断开回收。实例互斥由 SQLite 事务持有，不能用不可靠 PID 文件替代。
- 打包检查实际 Node/PE 架构、生产依赖、OS/CPU/libc 声明与实际文件摘要；版本映射遵循 versions.mjs，不猜测包大小和系统依赖。
