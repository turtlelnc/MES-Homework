import { oauthFetch } from "./oauth-http.mjs";
// ChatGPT（Codex OAuth）provider —— v0.2.1-rc4
//
// 使用 OpenAI Codex 的公共 PKCE 客户端（client_id 为公开常量，无 client_secret）：
//  - 浏览器流程：授权页回调 http://localhost:1455/auth/callback，由核心模块（oauth.mjs）
//    在本机 1455 端口临时监听，拿到 code 后调用本模块的 chatgptExchangeCode 换令牌；
//  - 设备码流程：deviceauth 三步（usercode → 轮询 token → 授权码兑换），无需本机端口；
//  - 模型调用：ChatGPT Codex Responses API（https://chatgpt.com/backend-api/codex/responses）。
//
// 本模块是纯网络/协议封装：不读数据库、不落盘、不记录令牌。所有网络错误都包装成
// 带中文说明的 Error（包含 HTTP 状态，但不回显上游响应体/令牌），fetch 可通过
// fetchImpl 注入，测试不访问真实网络。接口约定见 docs/oauth-flows.md。

export const chatgptMetadata = {
  id: "chatgpt",
  name: "ChatGPT（Codex OAuth）",
  region: "global",
  mainlandUnavailable: true,
  flows: ["browser", "device"],
  model: "gpt-5.4",
  vision: false,
  description:
    "通过 ChatGPT 账号的浏览器授权或设备码登录，使用 Codex 上游模型；无需 API Key。",
};

// 协议常量。Codex 的 client_id 是公开的 PKCE 客户端，不含密钥。
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_DEVICE_USERCODE_URL =
  "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CHATGPT_DEVICE_TOKEN_URL =
  "https://auth.openai.com/api/accounts/deviceauth/token";
export const CHATGPT_DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";
export const CHATGPT_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";
export const CHATGPT_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CHATGPT_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

const REDIRECT_URI = "http://localhost:1455/auth/callback";
const ORIGINATOR = "codex_cli_rs";
const DEFAULT_MODEL = "gpt-5.4";
const AUTH_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 120_000;
const DEFAULT_DEVICE_INTERVAL_MS = 5_000;
const MIN_DEVICE_INTERVAL_MS = 1_000;
// 设备码授权本身约 15 分钟有效；超过该值的 interval 没有意义。
const MAX_DEVICE_INTERVAL_MS = 15 * 60 * 1000;

function taggedError(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

function resolveFetch(fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function")
    throw taggedError("当前运行环境不支持网络请求");
  return (url, options) =>
    oauthFetch(url, options, {
      request: doFetch,
      timeoutMs:
        url === CHATGPT_RESPONSES_URL ? CHAT_TIMEOUT_MS : AUTH_TIMEOUT_MS,
      maxBytes: url === CHATGPT_RESPONSES_URL ? 2 * 1024 * 1024 : 65536,
    });
}

/**
 * 上游错误体里只提取一个安全的错误代码（形如 invalid_grant / rate_limit_exceeded）。
 * 不回显 error_description / message —— 上游响应可能回显请求材料或令牌片段。
 */
function safeUpstreamCode(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    typeof payload.error === "string" ? payload.error : "",
    payload?.error?.code,
    payload?.error?.type,
    payload?.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const code = candidate.trim();
    if (
      [
        "invalid_grant",
        "invalid_client",
        "invalid_request",
        "access_denied",
        "expired_token",
        "authorization_pending",
        "slow_down",
        "rate_limit_exceeded",
        "server_error",
        "temporarily_unavailable",
      ].includes(code)
    )
      return code;
  }
  return "";
}

/** 读取 JSON 响应体；测试里的假 Response 可能只有 json() 或 text()。 */
async function readJsonPayload(response) {
  if (response && typeof response.json === "function") {
    try {
      const value = await response.json();
      if (value && typeof value === "object") return value;
      return null;
    } catch {
      // 继续尝试 text()（部分假响应/SSE 响应只有文本）。
    }
  }
  if (response && typeof response.text === "function") {
    try {
      const text = await response.text();
      if (!text) return null;
      const value = JSON.parse(text);
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 校验并规范化 token 端点返回体 -> 本项目统一 token bundle。 */
function normalizeTokenBundle(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw taggedError("ChatGPT 授权服务返回内容格式无效", {
      code: "exchange_failed",
    });
  const accessToken =
    typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken.trim())
    throw taggedError("ChatGPT 授权服务未返回访问令牌", {
      code: "exchange_failed",
    });

  let expiresIn = payload.expires_in;
  if (typeof expiresIn === "string" && expiresIn.trim())
    expiresIn = Number(expiresIn);
  const jwtExpiry = Number(decodeJwtPayload(accessToken)?.exp);
  const expiresAt =
    typeof expiresIn === "number" &&
    Number.isFinite(expiresIn) &&
    expiresIn >= 0
      ? Date.now() + Math.floor(expiresIn * 1000)
      : Number.isSafeInteger(jwtExpiry * 1000) && jwtExpiry > 0
        ? jwtExpiry * 1000
        : null;

  const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
  // id_token 是身份文档（不验签，只读声明）；部分上游只在 access_token 里带
  // chatgpt_account_id，因此按参考实现的顺序回退。
  const fromIdToken = chatgptDecodeIdToken(idToken);
  const fromAccessToken = chatgptDecodeIdToken(accessToken);
  const accountId = fromIdToken.accountId || fromAccessToken.accountId || null;
  const email = fromIdToken.email || fromAccessToken.email || null;

  return {
    accessToken,
    refreshToken:
      typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : null,
    tokenType:
      typeof payload.token_type === "string" && payload.token_type
        ? payload.token_type
        : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
    expiresAt,
    accountId,
    email,
  };
}

/**
 * 解析 JWT payload（base64url，不验签），返回 ChatGPT 身份声明。
 * 解析失败/缺字段时返回 {accountId:null,email:null}，调用方自行决定是否报错。
 */
export function chatgptDecodeIdToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return { accountId: null, email: null };
  return {
    accountId: extractAccountId(payload),
    email: extractEmail(payload),
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const value = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    return value;
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function extractAccountId(payload) {
  const topLevel = nonEmptyString(payload.chatgpt_account_id);
  if (topLevel) return topLevel;
  const namespace = payload["https://api.openai.com/auth"];
  if (namespace && typeof namespace === "object" && !Array.isArray(namespace)) {
    const namespaced = nonEmptyString(namespace.chatgpt_account_id);
    if (namespaced) return namespaced;
  }
  const organizations = payload.organizations;
  if (Array.isArray(organizations) && organizations[0]) {
    const organizationId = nonEmptyString(organizations[0].id);
    if (organizationId) return organizationId;
  }
  return null;
}

function extractEmail(payload) {
  const direct = nonEmptyString(payload.email);
  if (direct) return direct.toLowerCase();
  const profile = payload["https://api.openai.com/profile"];
  if (profile && typeof profile === "object" && !Array.isArray(profile)) {
    const namespaced = nonEmptyString(profile.email);
    if (namespaced) return namespaced.toLowerCase();
  }
  return null;
}

function tokenEndpointFailure(label, status, payload) {
  const code = safeUpstreamCode(payload);
  return taggedError(
    `${label}（HTTP ${status}${code ? `，错误代码 ${code}` : ""}）`,
    {
      code: "exchange_failed",
      status,
      invalidGrant: code === "invalid_grant",
      retryable: status === 429 || status >= 500,
    },
  );
}

async function postForm(url, fields, fetchImpl, label) {
  const doFetch = resolveFetch(fetchImpl);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "")
      body.set(key, String(value));
  }
  let response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw taggedError("ChatGPT 授权服务连接失败，请稍后重试", {
      code: "exchange_failed",
      retryable: true,
    });
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) throw tokenEndpointFailure(label, response.status, payload);
  return payload;
}

async function postJson(url, payloadBody, fetchImpl, label) {
  const doFetch = resolveFetch(fetchImpl);
  let response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payloadBody),
      redirect: "error",
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw taggedError(`${label}连接失败，请稍后重试`, {
      code: "device_failed",
      retryable: true,
    });
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    const code = safeUpstreamCode(payload);
    throw taggedError(
      `${label}失败（HTTP ${response.status}${code ? `，错误代码 ${code}` : ""}）`,
      {
        code: "device_failed",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
  return payload;
}

/** 浏览器流程授权 URL（PKCE S256，state / challenge 由核心模块生成）。 */
export function chatgptAuthorizeUrl({
  state,
  codeChallenge,
  redirectUri,
} = {}) {
  if (!nonEmptyString(state) || !nonEmptyString(codeChallenge))
    throw taggedError("ChatGPT 授权参数不完整");
  const url = new URL(CHATGPT_AUTH_URL);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", CHATGPT_CLIENT_ID);
  params.set("redirect_uri", nonEmptyString(redirectUri) || REDIRECT_URI);
  params.set("scope", CHATGPT_SCOPE);
  params.set("state", state);
  params.set("code_challenge", codeChallenge);
  params.set("code_challenge_method", "S256");
  // Codex 公共客户端要求的非标准参数（参考实现同此）。
  params.set("codex_cli_simplified_flow", "true");
  params.set("originator", ORIGINATOR);
  params.set("id_token_add_organizations", "true");
  return url.href;
}

/** 本机回调地址；核心模块负责在 127.0.0.1:1455 监听该路径。 */
export function chatgptRedirectUri() {
  return REDIRECT_URI;
}

/** 浏览器回调：authorization_code + PKCE verifier 换 token bundle。 */
export async function chatgptExchangeCode({
  code,
  codeVerifier,
  redirectUri,
  fetchImpl,
} = {}) {
  if (!nonEmptyString(code))
    throw taggedError("缺少 ChatGPT 授权码，请重新发起授权", {
      code: "exchange_failed",
    });
  if (!nonEmptyString(codeVerifier))
    throw taggedError("缺少 ChatGPT 的 PKCE 校验码，请重新发起授权", {
      code: "exchange_failed",
    });
  const payload = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: CHATGPT_CLIENT_ID,
      code,
      code_verifier: codeVerifier,
      redirect_uri: nonEmptyString(redirectUri) || REDIRECT_URI,
    },
    fetchImpl,
    "ChatGPT 授权失败",
  );
  return normalizeTokenBundle(payload);
}

/** 刷新令牌。上游可能轮换 refresh_token，缺省时返回 null 由调用方保留旧值。 */
export async function chatgptRefresh({ refreshToken, fetchImpl } = {}) {
  if (!nonEmptyString(refreshToken))
    throw taggedError("没有可用的刷新令牌，请重新连接 ChatGPT", {
      code: "refresh_failed",
    });
  const payload = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: "refresh_token",
      client_id: CHATGPT_CLIENT_ID,
      refresh_token: refreshToken,
    },
    fetchImpl,
    "ChatGPT 令牌刷新失败",
  );
  return normalizeTokenBundle(payload);
}

function normalizeDeviceIntervalMs(raw) {
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0)
    return DEFAULT_DEVICE_INTERVAL_MS;
  const milliseconds = Math.round(seconds * 1000);
  return Math.min(
    MAX_DEVICE_INTERVAL_MS,
    Math.max(MIN_DEVICE_INTERVAL_MS, milliseconds),
  );
}

/** 设备码第一步：申请用户码。 */
export async function chatgptDeviceStart({ fetchImpl } = {}) {
  const payload = await postJson(
    CHATGPT_DEVICE_USERCODE_URL,
    { client_id: CHATGPT_CLIENT_ID },
    fetchImpl,
    "ChatGPT 设备授权请求",
  );
  if (!payload || typeof payload !== "object")
    throw taggedError("ChatGPT 设备授权响应缺少必要字段", {
      code: "device_failed",
    });
  const deviceAuthId = nonEmptyString(payload.device_auth_id);
  // 上游两种拼写都存在，均接受。
  const userCode = nonEmptyString(payload.user_code || payload.usercode);
  if (!deviceAuthId || !userCode)
    throw taggedError("ChatGPT 设备授权响应缺少必要字段", {
      code: "device_failed",
    });
  return {
    deviceAuthId,
    userCode,
    intervalMs: normalizeDeviceIntervalMs(payload.interval),
    verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
  };
}

/**
 * 设备码轮询（单次）：403/404 表示用户尚未完成授权（pending:true）。
 * 成功返回服务端生成的 authorization_code + code_verifier（设备码流程不由本地生成 verifier）。
 */
export async function chatgptDevicePoll({
  deviceAuthId,
  userCode,
  fetchImpl,
} = {}) {
  if (!nonEmptyString(deviceAuthId) || !nonEmptyString(userCode))
    throw taggedError("ChatGPT 设备码授权参数不完整", {
      code: "device_failed",
    });
  const doFetch = resolveFetch(fetchImpl);
  let response;
  try {
    response = await doFetch(CHATGPT_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch {
    throw taggedError("ChatGPT 设备授权查询连接失败，请稍后重试", {
      code: "device_failed",
      retryable: true,
    });
  }
  // 该端点用 HTTP 状态表示 pending，而非 authorization_pending 错误体。
  if (response.status === 403 || response.status === 404)
    return { pending: true };
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    const code = safeUpstreamCode(payload);
    throw taggedError(
      `ChatGPT 设备授权查询失败（HTTP ${response.status}${code ? `，错误代码 ${code}` : ""}）`,
      {
        code: "device_failed",
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      },
    );
  }
  if (!payload || typeof payload !== "object")
    throw taggedError("ChatGPT 设备授权响应缺少必要字段", {
      code: "device_failed",
    });
  const authorizationCode = nonEmptyString(payload.authorization_code);
  const codeVerifier = nonEmptyString(payload.code_verifier);
  if (!authorizationCode || !codeVerifier)
    throw taggedError("ChatGPT 设备授权响应缺少必要字段", {
      code: "device_failed",
    });
  return {
    pending: false,
    grant: { authorizationCode, codeVerifier },
  };
}

/** 设备码第三步：用轮询得到的授权码 + 服务端 verifier 兑换 token bundle。 */
export async function chatgptDeviceExchange({ grant, fetchImpl } = {}) {
  const authorizationCode = nonEmptyString(grant?.authorizationCode);
  const codeVerifier = nonEmptyString(grant?.codeVerifier);
  if (!authorizationCode || !codeVerifier)
    throw taggedError("ChatGPT 设备码授权凭据不完整，请重新发起授权", {
      code: "exchange_failed",
    });
  const payload = await postForm(
    CHATGPT_TOKEN_URL,
    {
      grant_type: "authorization_code",
      client_id: CHATGPT_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CHATGPT_DEVICE_REDIRECT_URI,
    },
    fetchImpl,
    "ChatGPT 设备授权兑换失败",
  );
  return normalizeTokenBundle(payload);
}

function textPartType(role) {
  return role === "assistant" ? "output_text" : "input_text";
}

/** 把调用方的 OpenAI 风格 messages 规范化为 Responses API 的 input 数组。 */
function normalizeResponsesInput(messages) {
  const list =
    typeof messages === "string"
      ? [{ role: "user", content: messages }]
      : messages;
  if (!Array.isArray(list))
    throw taggedError("模型请求缺少消息内容", { code: "chat_failed" });

  const input = [];
  for (const message of list) {
    if (!message || typeof message !== "object") continue;
    const role = nonEmptyString(message.role) || "user";
    const content = message.content;
    let parts = [];
    if (typeof content === "string") {
      parts = content ? [{ type: textPartType(role), text: content }] : [];
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string" && part) {
          parts.push({ type: textPartType(role), text: part });
          continue;
        }
        if (!part || typeof part !== "object") continue;
        if (typeof part.text === "string" && part.text) {
          parts.push({
            type:
              part.type === "output_text" || part.type === "input_text"
                ? part.type
                : textPartType(role),
            text: part.text,
          });
          continue;
        }
        if (part.type === "image_url") {
          // 该 provider 声明 vision:false；保留结构只为兼容调用方，实际不会用到。
          const url =
            typeof part.image_url === "string"
              ? part.image_url
              : part.image_url?.url;
          if (typeof url === "string" && url)
            parts.push({ type: "input_image", image_url: url });
        }
      }
    }
    if (parts.length) input.push({ role, content: parts });
  }
  if (!input.length)
    throw taggedError("模型请求缺少消息内容", { code: "chat_failed" });
  return input;
}

/** 从非流式 Responses 响应中拼接 message/output_text 文本。 */
function extractResponsesText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    // reasoning 等其它条目没有 output_text；未标 type 的 message 也容忍。
    if (item.type !== undefined && item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    let messageText = "";
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (
        typeof part.text === "string" &&
        (part.type === undefined ||
          part.type === "output_text" ||
          part.type === "text")
      )
        messageText += part.text;
    }
    if (messageText.trim()) chunks.push(messageText);
  }
  if (chunks.length) return chunks.join("\n").trim();
  if (typeof payload.output_text === "string" && payload.output_text.trim())
    return payload.output_text.trim();
  return "";
}

function parseSseEvents(text) {
  const events = [];
  let buffer = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      buffer.push(line.slice(5).replace(/^ /, ""));
      continue;
    }
    if (!line.trim() && buffer.length) {
      events.push(buffer.join("\n"));
      buffer = [];
    }
  }
  if (buffer.length) events.push(buffer.join("\n"));
  return events;
}

/**
 * Codex 兼容通道使用 Responses SSE；必须看到 response.completed 才算成功。
 * 返回 {text}；若事件里带错误则抛中文 Error。
 */
function extractSseText(text) {
  const deltas = [];
  const doneTexts = [];
  let completedText = "";
  let completed = false;
  for (const raw of parseSseEvents(text)) {
    if (!raw || raw === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const type = typeof event.type === "string" ? event.type : "";
    if (
      type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      deltas.push(event.delta);
      continue;
    }
    if (
      type === "response.output_item.done" &&
      event.item?.type === "message"
    ) {
      const itemText = extractResponsesText({ output: [event.item] });
      if (itemText) doneTexts.push(itemText);
      continue;
    }
    if (type === "response.completed" && event.response) {
      completed = true;
      const responseText = extractResponsesText(event.response);
      if (responseText && !completedText) completedText = responseText;
      continue;
    }
    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete"
    ) {
      const code = safeUpstreamCode(
        event.response?.error ? { error: event.response.error } : event,
      );
      throw taggedError(
        `ChatGPT 模型接口返回错误${code ? `（错误代码 ${code}）` : ""}`,
        { code: "chat_failed", retryable: false },
      );
    }
  }
  if (!completed)
    throw taggedError("ChatGPT 模型响应未完整结束，请重试", {
      code: "chat_failed",
    });
  const combined = completedText || deltas.join("") || doneTexts.join("\n");
  return combined.trim();
}

/** 读取 chat 响应：优先按 JSON 解析，失败时回退 SSE 事件流。 */
async function readChatResponse(response) {
  if (typeof response.text === "function") {
    let raw = "";
    try {
      raw = await response.text();
    } catch {
      raw = "";
    }
    if (raw && raw.trim()) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object") return { kind: "json", value };
      } catch {
        return { kind: "sse", text: extractSseText(raw) };
      }
    }
  }
  if (typeof response.json === "function") {
    try {
      const value = await response.json();
      if (value && typeof value === "object") return { kind: "json", value };
    } catch {
      // 忽略，走下面的格式无效错误。
    }
  }
  return { kind: "invalid" };
}

function chatHttpError(status, payload) {
  const code = safeUpstreamCode(payload);
  return taggedError(
    `ChatGPT 模型接口请求失败（HTTP ${status}${code ? `，错误代码 ${code}` : ""}）`,
    {
      code: "chat_failed",
      status,
      retryable: status === 429 || status >= 500,
    },
  );
}

/**
 * 调用 Codex Responses API，返回纯文本。
 * messages 支持 OpenAI 风格 [{role, content}]（content 可为字符串或 text part 数组），
 * 也接受单个字符串（按 user 消息处理）。
 */
export async function chatgptChat({
  accessToken,
  accountId,
  model,
  messages,
  maxTokens,
  fetchImpl,
  signal,
} = {}) {
  if (!nonEmptyString(accessToken))
    throw taggedError("缺少 ChatGPT 访问令牌，请重新连接", {
      code: "OAUTH_INVALID",
      status: 401,
    });
  if (!nonEmptyString(accountId))
    throw taggedError("缺少 ChatGPT 账户标识，请重新登录", {
      code: "OAUTH_INVALID",
      status: 401,
    });
  const input = normalizeResponsesInput(messages);
  const selectedModel = nonEmptyString(model) || DEFAULT_MODEL;
  const body = {
    model: selectedModel,
    input,
    store: false,
    stream: true,
  };
  // Codex uses its Responses transport contract, not the public API's
  // max_output_tokens parameter. Local lifetime/byte bounds still apply.

  const headers = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    originator: ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
  };

  const doFetch = resolveFetch(fetchImpl);
  const signals = [AbortSignal.timeout(CHAT_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  let response;
  try {
    response = await doFetch(CHATGPT_RESPONSES_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch {
    throw taggedError("ChatGPT 模型接口连接失败，请稍后重试", {
      code: "chat_failed",
      retryable: true,
    });
  }

  if (response.status === 401 || response.status === 403)
    throw taggedError("ChatGPT 授权已失效，请重新连接", {
      code: "OAUTH_INVALID",
      status: 401,
    });
  if (!response.ok)
    throw chatHttpError(response.status, await readJsonPayload(response));

  const parsed = await readChatResponse(response);
  if (parsed.kind === "invalid")
    throw taggedError("模型返回内容格式无效", { code: "chat_failed" });
  if (parsed.kind === "sse") {
    if (!parsed.text)
      throw taggedError("模型没有返回内容", { code: "chat_failed" });
    return parsed.text;
  }
  const payload = parsed.value;
  const text = extractResponsesText(payload);
  if (text) return text;
  if (payload?.error) {
    const code = safeUpstreamCode(payload);
    throw taggedError(
      `ChatGPT 模型接口返回错误${code ? `（错误代码 ${code}）` : ""}`,
      { code: "chat_failed", retryable: false },
    );
  }
  throw taggedError("模型没有返回内容", { code: "chat_failed" });
}
