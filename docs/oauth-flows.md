# OAuth 登录流程（v0.2.1-rc4）

> 官方来源核查与未验证边界见 [2026-10-27 审核](oauth-audit-2026-10-27.md)。ChatGPT 和 WorkBuddy 仍是实验性兼容通道，不代表本应用已完成官方第三方 OAuth 集成。

本文件定义 v0.2.1-rc4 起 OAuth 模型链接的 provider、流程与 HTTP 接口约定，供前后端、
部署配置与测试共同遵循。

## Provider 矩阵

| provider | 名称 | 流程 | 默认模型 | 视觉 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `chatgpt` | ChatGPT（Codex OAuth） | `browser` + `device` | `gpt-5.4` | 否 | 使用 OpenAI Codex 公共 PKCE 客户端；浏览器回调（localhost:1455）或设备码；走 ChatGPT Codex Responses API |
| `gemini` | Gemini（Google） | `browser` | `gemini-2.5-flash` | 是 | 需部署方在 Google Cloud 创建 Web application OAuth 客户端，登记精确回调 URL，配置 Client ID/Secret、配额项目和 cloud-platform scope |
| `workbuddy` | WorkBuddy | `browser` + `device` | 兼容默认 workbuddy-chat，可由部署方覆盖，未验证可用性 | 否 | 国内版（默认）/国际版；浏览器登录直接打开授权页，设备码登录显示授权链接（底层同一兼容流程）；服务端轮询换取令牌，走 WorkBuddy 上游 chat SSE |

已移除：`claude`、`qwen`、`qianwen`、`deepseek`（不再出现在 OAuth 界面，也不接受其授权请求；
原有 API Key 方式不受影响）。

## 前端调用的 HTTP 接口（均需要登录态）

### `GET /api/oauth/providers`

```json
{
  "providers": [{
    "id": "chatgpt",
    "name": "ChatGPT（Codex OAuth）",
    "region": "global",
    "mainlandUnavailable": true,
    "configured": true,
    "connected": false,
    "connectedAt": null,
    "description": "……",
    "model": "gpt-5.4",
    "vision": false,
    "envHint": [],
    "flows": ["browser", "device"]
  }],
  "authMode": "api_key",
  "provider": null
}
```

- `flows`：该 provider 支持 `browser`（新标签页打开授权页，服务端轮询完成）与
  `device`（显示设备码/授权页，服务端轮询完成）。WorkBuddy 的两种入口底层是同一套
  兼容 state → 授权页 → 轮询流程，浏览器登录只是直接打开授权页的交互。
- `configured:false` 时 `envHint` 给出需要设置的环境变量名（目前只有 gemini 可能未配置）。

### `POST /api/oauth/:provider/browser/start`

请求体：`{}`；workbuddy 可传 `{ region: "cn" | "global" }`（chatgpt 浏览器流程会占用本机 1455 端口；gemini 使用配置里的回调基址）。

返回：`{ attemptId, mode: "browser", url }`

前端用 `window.open(url, "_blank")`，然后每 1.5–2s 调用 attempt 查询。

### `GET /api/oauth/:provider/attempt/:attemptId`

返回：

```json
{ "status": "pending" }
{ "status": "connected", "provider": "chatgpt", "connectedAt": "…" }
{ "status": "error", "message": "中文错误原因" }
{ "status": "expired", "message": "…" }
```

### `POST /api/oauth/:provider/device/start`

请求体可选：`{ "region": "cn" | "global" }`（workbuddy；默认 `env.OAUTH_WORKBUDDY_REGION` 或 `cn`）。

返回：

```json
{
  "attemptId": "…",
  "mode": "device",
  "verificationUrl": "https://auth.openai.com/codex/device",
  "userCode": "ABCD-EFGH",
  "intervalMs": 5000
}
```

workbuddy 的 `verificationUrl` 是授权页 URL，无 `userCode`。前端展示链接/按钮并轮询 attempt。

### `POST /api/oauth/:provider/disconnect`

返回 `{ ok: true }`，删除该用户该 provider 的连接（不调用上游撤销接口亦可）。

### 兼容接口

保留 `POST /api/oauth/:provider/start`（Gemini 旧流程/测试兼容）：对 gemini 返回
`{ url }` 并跳转浏览器；对 chatgpt 等价于 `browser/start`；对 workbuddy 返回 409，提示改用
`device/start`。`GET /api/oauth/:provider/callback` 仅供 gemini 使用。

## 服务端 provider 模块约定

### `server/oauth-chatgpt.mjs`

- `chatgptMetadata`：`{ id, name, region, mainlandUnavailable, flows, model, vision, description }`
- `chatgptAuthorizeUrl({ state, codeChallenge })` → `string`
- `chatgptRedirectUri()` → `"http://localhost:1455/auth/callback"`
- `chatgptExchangeCode({ code, codeVerifier, fetchImpl })` → token bundle
- `chatgptRefresh({ refreshToken, fetchImpl })` → token bundle
- `chatgptDeviceStart({ fetchImpl })` → `{ deviceAuthId, userCode, intervalMs, verificationUrl }`
- `chatgptDevicePoll({ deviceAuthId, userCode, fetchImpl })` → `{ pending:true }` 或
  `{ pending:false, grant:{ authorizationCode, codeVerifier } }`
- `chatgptDeviceExchange({ grant, fetchImpl })` → token bundle
- `chatgptChat({ accessToken, accountId, model, messages, maxTokens, fetchImpl })` → text
- token bundle：`{ accessToken, refreshToken, tokenType, scope, expiresAt, accountId, email }`

### `server/oauth-workbuddy.mjs`

- `workbuddyMetadata`：`{ id, name, region, mainlandUnavailable, flows, model, vision, description }`
- `workbuddyRegion(env)` → `"cn" | "global"`
- `workbuddyStart({ region, fetchImpl })` → `{ state, authUrl }`
- `workbuddyPoll({ state, region, fetchImpl })` → `{ pending:true }` 或
  `{ pending:false, token:{ accessToken, refreshToken, expiresIn, domain } }`
- `workbuddyAccount({ state, accessToken, region, fetchImpl })` → `{ uid, enterpriseId, nickname }`
- `workbuddyRefresh({ credential, fetchImpl })` → `{ accessToken, refreshToken, expiresIn, domain }`
- `workbuddyChat({ credential, model, messages, fetchImpl })` → text
- credential：`{ accessToken, refreshToken, uid, enterpriseId, domain, region }`

## 存储

`oauth_connections` 新增 `meta_json TEXT NOT NULL DEFAULT '{}'`：保存 provider 附加身份
（chatgpt：`accountId/email`；workbuddy：`uid/enterpriseId/domain/region/nickname`），
访问令牌与刷新令牌仍使用现有 AES-256-GCM 加密列。迁移必须兼容旧库（ALTER TABLE）。

## 安全

- 所有令牌只存服务端加密列；日志/界面不显示 access/refresh token。
- 回调 state 一次性校验；chatgpt 本机回调仅绑定 127.0.0.1:1455，授权完成后立即关闭。
- 尝试（attempt）只属于发起它的用户；查询他人 attempt 返回 404。
- 未配置的 provider 不能发起授权；移除的 provider id 一律 404。
- WorkBuddy/ChatGPT 的浏览器授权链接只允许打开对应官方域名；不跟随用户提供的任意 URL。

## 2026-10-27 接口增补与验证边界

- `DELETE /api/oauth/:provider/attempt/:attemptId`：需要登录，只允许发起用户取消自己的 attempt，关闭后台轮询与回调监听；不存在/他人 attempt 返回 404。取消完成不会撤销已经成功保存的连接。
- `GET /api/oauth/providers` 新增 `verification`（`experimental` / `official-reference`）、`setupHint`、Gemini 的 `redirectUri`。这些字段表示来源与配置条件，不代表真实登录成功；仍不返回客户端 secret 或令牌。
- `PUT /api/settings/provider` 的 `apiKey` 在已有同厂商配置时可省略或为空字符串，保留密文与 IV；换厂商必须提供对应密钥。空白密钥、内部换行和非字符串模型名仍拒绝。可传 `activate:true`，在同一 SQLite 事务中保存配置并切换 `model_auth_mode=api_key`；缺省/false 只保存配置。
- ChatGPT 兼容模型通道使用 `stream:true`、`store:false`；不发送该通道不支持的 `max_output_tokens`，本地仍有 120 秒及 2 MiB 响应上限。必须收到 `response.completed`；中断/不完整响应不能作为成功结果。
- Gemini 默认 scope 包含 `cloud-platform`，同时发送 `x-goog-user-project`。此 scope 属 Google Cloud 广泛权限，须按 Google 同意页审阅。只有身份 scope 的旧连接需要重新授权。403 要检查 scope、项目/API/账单权限，不一概当成登录令牌失效。生产回调必须匹配已登记 HTTPS URL；开发 loopback 保留 HTTP。
- 相同账户的并发模型调用共享一次令牌刷新；暂时网络/429/5xx 不将连接置为失效。刷新后保留未轮换的 refresh token。新的授权登录不继承旧账号的 refresh token；取消/断开期间的迟到回调不得重新写回连接。
- OAuth 请求（包括 SSE）均限制响应大小和从发起到读完正文的总时长。上游错误只返回静态说明、HTTP 状态或数值业务码，不回显可能包含凭证的原文。
