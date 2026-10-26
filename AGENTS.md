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
  - 有界并发批改：`recognition-queue.mjs` 默认 4 并发，同一教师可并行处理不同答卷，完成即补位；`model-budget.mjs` 保留全局/学校/账户额度，学生最多 1 个在途；`model-images.mjs` 对 API Key/OAuth 内联图片预留共享 Base64 预算（默认 96 MiB）。API Key 请求显式非流式，OAuth 的 SSE/Responses 协议仍由 provider 模块处理。配置与压测方法见 `CONCURRENT_GRADING.md` / `LOAD_TESTING.md`。
  - 文档解析：`document.mjs` / `word.mjs`；备份/运维：`tools/ops/`、`server/backup*.mjs`。
- **桌面版一键部署器（C++17）**：`tools/deployer/`。
  - `src/core/` 纯逻辑（SHA-256、ZIP 解压、manifest、安装状态、服务文本、部署引擎、自检）；`src/platform/` 是唯一允许直接调用 OS API 的层；`src/ui/` 为 ImGui 自绘界面；`src/app.cpp` 状态机；`src/main.cpp` 入口/窗口。
  - `tests/core_test.cpp`（CTest）；`packaging/` 生成应用运行时 zip/manifest；`README.md` 有详细构建/平台/发布说明。
  - 旧版控制台部署器已删除，不要再恢复 `campus-deploy` 相关文件。
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
- **桌面部署器**：
  - Windows：`powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1`（产物 `dist-deployer/mes-deployer.exe`）。
  - 通用：`cmake -S tools/deployer -B tools/deployer/build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build tools/deployer/build`；离线构建可用 `-DMES_DEPLOYER_DEPS_DIR=<glfw,imgui,miniz 源码目录>`。
  - 测试：`ctest --test-dir tools/deployer/build --output-on-failure`、`mes-deployer --self-test`、`mes-deployer-test`。
  - 发布：`.github/workflows/deployer-release.yml`（push 分支构建产物；tag 发布 Release）；不要手工提交 `dist-deployer/`、`tools/deployer/build*/`。
- **版本更新清单**（发布前逐项同步）：`package.json`、`package-lock.json`、`server/version.mjs`、`src/version.ts`、`server/version.test.ts`、README/README.EN 版本行与徽章、`tools/deployer/CMakeLists.txt` 的 `MES_VERSION_STRING`/`MES_BUILD_STRING`、部署器 README/打包脚本默认值、`docs/releases/<版本>.md`、`.github/workflows/deployer-release.yml` 的版本/构建号与 notes 路径。
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
- 部署器 UI 沿用 Apple 风格浅色玻璃（自绘组件、系统 CJK 字体），不要退回默认 ImGui 灰色皮肤。

## Testing Guidelines

- Vitest 测试放在被测模块旁，命名 `*.test.ts`（如 `server/oauth.test.ts`、`server/model-access.test.ts`）。覆盖授权边界、SQLite 迁移、文件解析、provider 行为与 OAuth 流程。
- OAuth/模型相关测试一律 mock `fetch`/provider 模块，不调用付费模型、不进行真实 OAuth 登录、不触真实上游网络。
- 浏览器流程用 `tests/browser/*.pw.mjs` + Playwright；涉及 UI 的改动建议补充或更新截图（`docs/screenshots-v0.2.1/`），CI 会运行 Chromium。
- 部署器：`ctest` + `mes-deployer --self-test`（GUI 子系统，Windows 下 CI 用 `Start-Process -Wait` 检查退出码）；UI 截图/桌面交互无法在 CI 完整覆盖时需在目标 OS 手工验收并记录。
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

- 应用发布：版本更新清单见上；桌面部署器由 GitHub Actions 构建 Windows x64/x86/arm64、Linux x64/x86/arm64、macOS arm64 单文件与 5 个应用运行时包，并上传到 Draft Release；发布前检查 `SHA256SUMS.txt` 与 `mes-homework-app-manifest.json`。
- 部署器两个版本：本地版（127.0.0.1，自动开浏览器）与服务器版（局域网、可选开机自启/防火墙）；平台限制：官方 Node.js 24 无 32 位运行时（x86 系统仅可运行部署器，应用需 64 位），Linux glibc ≥ 2.31，macOS 仅 Apple Silicon。
- OAuth 真实可用性：ChatGPT Codex OAuth/WorkBuddy 上游未在仓库内用真实账号验证；Gemini 需要部署方在 Google Cloud 创建 OAuth 客户端并配置 `OAUTH_GEMINI_CLIENT_ID/SECRET`；中国大陆境内无法使用 ChatGPT/Gemini。
- 部署与运维细节见 `README.md`、`tools/deployer/README.md`、`docs/oauth-flows.md`、`OPERATIONS.md`、`SECURITY_REVIEW.md`。
