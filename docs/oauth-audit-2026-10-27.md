# 模型设置与 OAuth 官方来源审核

核查日期：2026-10-27（UTC）。基线：主分支 `7b7efb69`。本次对照官方网页、OpenAI 官方源码及腾讯官方文档/发行包；自动化授权测试全部使用隔离数据库、合成令牌与 mock HTTP。环境没有可用于交互授权的真实 Google、ChatGPT 或 WorkBuddy 账号，**没有完成三家的真实“同意授权 → 刷新 → 模型调用”验收**。

## 添加模型为什么难用

| Before | After | Why |
| --- | --- | --- |
| 保存密钥后还要到另一张卡选择通道并再次保存 | 提供“保存并使用 API Key”，同时保存与切换；“仅保存配置”保留原通道 | 保存成功与实际使用的状态一致，避免把保存当成连接验收 |
| 修改模型名也必须重新填写已保存的密钥 | 同厂商留空保留密文；换厂商必须新密钥 | 密钥不回显也能编辑，且不会拿旧厂商密钥调用新厂商 |
| 所有人一开始就看到模型/完整接口覆盖字段，默认值隐藏在服务端 | 显示服务端返回的默认模型和能力，覆盖值放到高级设置 | 正常配置只需厂商、密钥；仍可使用部署方确认的自定义模型 |
| 读取配置失败被当成空列表/未保存，刷新还漏读厂商和凭证配置 | 显式显示失败、锁定保存；刷新重新读取实际配置 | 网络故障不能制造一个“空配置”并诱导覆盖 |
| OAuth 连上后切换通道还要再找下拉框 | 已连接卡提供“使用此连接”，实际生效通道仍显示 | 区分连接存在与当前生效状态 |
| 授权链接在异步请求结束后才打开，容易被拦截；关闭对话框不取消服务端任务 | 点击时预开窗口，失败关闭并保留手工链接；取消会删除自己的 attempt | 符合浏览器用户手势限制，释放轮询/回调端口 |

当前数据库每个账户仍只有一套 API Key 配置、每种 OAuth provider 一条连接；页面明确说明，不伪装成任意多个命名模型配置。保存配置不执行付费模型测试，也不保证所填模型仍在供应商目录中。

## OAuth 比对结论

| 通道 | 官方依据 | 发现与处理 | 验证边界 |
| --- | --- | --- | --- |
| ChatGPT：现有 Codex 兼容入口 | [官方 Codex 登录说明](https://developers.openai.com/codex/auth)、[官方 server.rs](https://github.com/openai/codex/blob/6b56106ed9a31230e7708dce8dad9819cca00e45/codex-rs/login/src/server.rs)、[device_code_auth.rs](https://github.com/openai/codex/blob/6b56106ed9a31230e7708dce8dad9819cca00e45/codex-rs/login/src/device_code_auth.rs)、[客户端 ID](https://github.com/openai/codex/blob/6b56106ed9a31230e7708dce8dad9819cca00e45/codex-rs/login/src/auth/manager.rs) | 公共 Codex client ID、PKCE、scope、设备码申请/轮询/兑换结构相符；403/404 的 pending 处理相符。修正 SSE 请求与完成事件、取消释放端口和暂时失败重试 | 只确认与 Codex 客户端的兼容结构；不是本应用的官方第三方 OAuth 注册。标为实验性兼容连接 |
| ChatGPT：官方第三方 Sign in with ChatGPT | [开源应用注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | 当前实现**不符合此独立协议**，见下表；明确告知用户，避免“Codex 协议相符”被误报成“第三方官方登录正确” | 本次审核未宣称实现此新通道；现有兼容连接继续保持独立 |
| Gemini | [Gemini OAuth 教程](https://ai.google.dev/gemini-api/docs/oauth)、[Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai) | 原默认只有 `openid email profile`，是身份权限，不能据此调用 Gemini。补 `cloud-platform`、配额项目及 `x-goog-user-project`；公开精确回调 URL，要求 Web application Client ID/Secret。token 明确返回不足 scope 时拒绝连接；403 显示项目/权限排查提示 | PKCE、单次 state、回调归属、离线 refresh、图片构造与配额头经过 mock 验证。实际账号同意、项目 IAM/账单、模型可用性待部署验证 |
| WorkBuddy | [腾讯 CodeBuddy 官方快速开始](https://www.codebuddy.cn/docs/cli/quickstart)、[官方发行包](https://www.npmjs.com/package/@tencent-ai/codebuddy-code)（此次读取版本 2.177.0，仅静态读取，未执行） | 官方文档说明国内/国际站登录；现有 WorkBuddy 适配的来源是第三方 DSH 兼容实现。此次读取的官方资料不足以确认其完整的 WorkBuddy 第三方授权协议。移除“官方流程已验证”的表述，显示实验状态；补取消传播、响应边界和错误脱敏 | mock 测试只能验证当前假设内的实现，不能验证 UA/版本头、私有端点及真实账户权限是否仍有效。真实联调未完成 |

### 官方第三方 ChatGPT 流程与当前 Codex 兼容通道的区别

| 项目 | 官方开源应用流程 | 当前兼容实现 |
| --- | --- | --- |
| 客户端 | 首次用 `dynamic_agent_client` 注册，回调接收 issued client ID；同一账号后续复用注册 ID | 复用 Codex 公共 `app_EMoamEEZ73f0CkXaXp7hrann` |
| 主机身份 | 每个运行主机持久化独立 `ext_agent_host_id`，首次发送实际应用名称 | 尚未实现动态注册主机身份 |
| 请求 | `https://auth.openai.com/api/accounts/authorize`，有 `resource=https://api.openai.com/v1`、nonce、PKCE | Codex `/oauth/authorize` 与 Codex scope |
| scope | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` | Codex 身份/connector scope；不能把它们等价为新协议的 plan usage scope |
| 回调 | 明确要求 `127.0.0.1` loopback，不能替换为 `localhost`；兑换使用同一 URI 和 issued client ID | 现有 Codex localhost 回调，端口在应用服务器本机 |
| 身份验证 | 按官方 JWKS 验签，校验 issuer、audience、expiry、nonce 和返回身份 | 现有实现只解码 JWT 读取 Codex 账户标识，不是这个协议所需的 OIDC 验证 |
| 推理 | 公共 `https://api.openai.com/v1/responses`，`stream:true`、`store:false`；官方明确不使用 `backend-api` | `chatgpt.com/backend-api/codex/responses`，本次改为有界 SSE，仍属于 Codex 兼容通道 |
| 模型目录 | 按当前账号请求 `/v1/models`，展示 `visibility:list` 的模型并使用 slug | 部署方配置或历史默认，未宣称目录已验证 |

官方商业伙伴 client ID 申请是[另一条接入路径](https://developers.openai.com/siwc/request-client-id)。网站身份登录、开源应用 plan usage、Codex 自身登录具有不同注册和权限契约，不能混用 client ID 或令牌。升级为正式第三方集成需要独立实现动态注册/身份验证/注册信息持久化/账号模型目录及新旧凭证迁移，不能只替换一个 API URL。

### Gemini 部署核对

1. 使用部署方自己的 Google Cloud OAuth **Web application** 客户端；在授权重定向 URI 中登记页面显示的完整 `/api/oauth/gemini/callback`。公网为 HTTPS，本机开发可使用 Google 允许的 loopback HTTP。
2. 配置 `OAUTH_GEMINI_CLIENT_ID`、`OAUTH_GEMINI_CLIENT_SECRET`、`OAUTH_GEMINI_PROJECT_ID`；启用 Generative Language API，确认配额/账单项目权限，并正确配置 consent screen/test users。
3. 默认请求 `openid email profile https://www.googleapis.com/auth/cloud-platform`。`cloud-platform` 是广泛的 Google Cloud scope，应按 Google 同意页审阅；原先仅授权身份 scope 的连接需要重新授权。
4. 本次仍使用 Gemini 官方 OpenAI 兼容协议，访问令牌在 Authorization，配额项目在 `x-goog-user-project`。OAuth 不是免费模型额度或 Gemini CLI 订阅凭证的替代证明。
5. 区分 401（令牌问题）与 403（scope、项目/API/账单权限等）。不能通过清空连接反复登录来掩盖项目配置问题。

## 其他 API Key 厂商的官方资料

“控制台能用第三方账户登录”与“允许本应用拿 OAuth 令牌调用模型”是两回事。本次未给 API Key 目录中的其他厂商补造 OAuth 客户端，也不根据一篇 API Key 文档推断其整个生态不存在 OAuth。

| 厂商 | 本次核对的官方材料 | 对本项目的结论 |
| --- | --- | --- |
| DeepSeek | [Quick Start](https://api-docs.deepseek.com/quick_start) | 本项目 API Key + Bearer；该材料没有给出本应用可用的通用第三方模型 OAuth 契约 |
| OpenAI API | [API Authentication](https://developers.openai.com/api/reference/overview) | API Key/工作负载身份与 SIWC 是不同路径；不能用普通身份登录 token 替代 API 鉴权 |
| 通义千问 | [百炼 API Key](https://help.aliyun.com/zh/model-studio/get-api-key) | 继续使用百炼模型凭证；控制台登录或阿里云其他 OAuth 产品不是本项目模型授权依据 |
| 豆包/火山方舟 | [官方 Quick Start](https://docs.volcengine.com/docs/ark/quick-start?lang=zh) | 页面可读取但主要内容依赖动态渲染，本次静态获取不足以确认 OAuth；保留 API Key，不宣称完成 OAuth 核验 |
| 智谱 | [API 快速开始/身份验证](https://docs.bigmodel.cn/cn/api/introduction) | 文档明确 HTTP Bearer API Key；MCP OAuth 等其他功能不能当作模型登录协议 |
| Kimi | [Chat API](https://platform.moonshot.cn/docs/api/chat) | 文档请求使用 API Key/Bearer，未发现本项目可直接采用的第三方 OAuth 契约 |
| 硅基流动 | [Chat Completions](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions) | 官方鉴权字段为账户 API Key |
| MiniMax | [文本 Chat API](https://platform.minimaxi.com/docs/api-reference/text-chat) | 官方 Bearer API key；不能把其他登录/订阅凭证当作该 API 的授权 |
| Gemini API Key | [OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai) | API Key 方式独立保留；Google OAuth 配置要求见上文 |
| Anthropic | [官方 API Overview](https://platform.claude.com/docs/en/api/overview) | 当前环境读取返回 403，OAuth 资料未在本次成功验证；保留现有 API Key 原生 Messages 协议，不据此添加 Claude 订阅 OAuth |

## 代码与验证

- 无数据库 schema 变更。API Key 保留操作沿用已有密文/IV；保存与切换在事务中完成。重新 OAuth 登录不继承旧账户 refresh token；刷新响应未轮换时仍保留原 token。
- 相同连接并发刷新合并；临时网络/429/5xx 返回可重试错误，保持连接 active；用户断开或切换账号期间的刷新结果不得覆盖新连接。
- OAuth JSON 默认 64 KiB/30 秒；ChatGPT 兼容 SSE 2 MiB/120 秒；WorkBuddy 模型响应 2 MiB/30 秒。总超时覆盖响应正文读取，调用方取消信号继续传播。这些是本地保护策略，不是供应商性能承诺。
- HTTP/业务错误只回传静态说明或白名单代码；不反射上游原文。取消接口检查用户与 provider 归属，关闭回调监听和后台 timer；迟到授权不得复活已取消连接。
- 测试覆盖 PKCE/state/归属/到期/拒绝、设备 pending、令牌保留和并发刷新、瞬时失败、取消重试端口、正文超时/超限、保存/激活与真实浏览器表单行为。真实凭证与用户数据未加入测试或文档。
- 本地浏览器成功截图由测试写入 `test-results/deepseek-provider-settings.png`、`test-results/model-key-reuse.png`，CI 随 `browser-evidence` 上传，内容为合成账户。
- 最终串行 Vitest：51 文件、528 测试全部通过；Chromium：20 条流程全部通过；TypeScript/Vite 生产构建通过。并行全量运行曾在原有压力准入上传测试出现一次 `write EPIPE`（服务提前拒绝上传时的连接竞态），本次未放宽该测试或改变准入逻辑；串行全量覆盖该用例并通过。
- ChatGPT token 到期时间优先取上游 `expires_in`，缺失时读取 access token 的 `exp`，两者均无则记为未知；不再猜测为一小时。解码 `exp` 仅用于刷新时机，不等于新 SIWC 所需的 OIDC 身份验证。

**判定：目前不能称“三家 OAuth 都正确并已验证”。Gemini 有确定的权限/项目配置错误，已修正并离线验证；ChatGPT 现有实现是 Codex 兼容协议，不符合最新官方第三方 SIWC 注册协议；WorkBuddy 缺少足够官方协议证据及真实联调。**
