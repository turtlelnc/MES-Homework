// WorkBuddy provider —— v0.2.1-rc4
// 浏览器授权 + 服务端轮询（自定义设备码流程）；接口约定见 docs/oauth-flows.md。
//
// 协议按 WorkBuddy DSH 插件的实测行为重写：登录三步（state → token → account）
// 都走 loginBase，刷新与 chat 走 chatBase；国内版与国际版是两套独立端点。
// 所有函数都接受 fetchImpl 注入，测试不访问网络；错误信息一律中文，且绝不把
// access/refresh token 写进错误信息或日志。

import { randomUUID } from "node:crypto";

export const workbuddyMetadata = {
  id: "workbuddy",
  name: "WorkBuddy",
  region: "cn",
  mainlandUnavailable: false,
  flows: ["browser", "device"],
  model: "workbuddy-chat",
  vision: false,
  description:
    "WorkBuddy 国内版/国际版：点击浏览器授权后由服务端轮询完成登录，无需 API Key。",
};

const CN = "cn";
const GLOBAL = "global";

// 登录端点要求的客户端身份；不要替换成插件自己的 User-Agent。
const LOGIN_USER_AGENT = "CLI/2.63.2 CodeBuddy/2.63.2";
const AUTH_PLATFORM = "workbuddy";
const DEFAULT_MODEL = workbuddyMetadata.model;
const REQUEST_TIMEOUT_MS = 30_000;

const JSON_ACCEPT = "application/json, text/plain, */*";

// 区域端点表。国内版的登录页、网页 Origin 与 API 主机是三个不同域名，
// 上游会校验 Origin，不能“整理”成同一个值。
const REGION_ENDPOINTS = {
  cn: {
    loginBase: "https://www.workbuddy.cn",
    origin: "https://www.codebuddy.cn",
    chatBase: "https://copilot.tencent.com",
    chatUserAgent: "WorkBuddy/5.5.6 WorkBuddy/5.5.6",
    ideVersion: "5.5.6",
    authHosts: ["workbuddy.cn", "codebuddy.cn"],
  },
  global: {
    loginBase: "https://www.workbuddy.ai",
    origin: "https://www.workbuddy.ai",
    chatBase: "https://www.workbuddy.ai",
    chatUserAgent: "WorkBuddy/5.5.2 WorkBuddy/5.5.2",
    ideVersion: "5.5.2",
    authHosts: ["workbuddy.ai"],
  },
};

/** 环境变量开关：OAUTH_WORKBUDDY_REGION=global 时用国际版，默认国内版。 */
export function workbuddyRegion(env = process.env) {
  return env?.OAUTH_WORKBUDDY_REGION === "global" ? GLOBAL : CN;
}

function normalizeRegion(region) {
  return region === GLOBAL ? GLOBAL : CN;
}

function endpointsFor(region) {
  return REGION_ENDPOINTS[normalizeRegion(region)];
}

/** 凭据的 region 优先；旧记录没有 region 时按 domain 后缀推断。 */
function regionOfCredential(credential) {
  if (credential?.region === GLOBAL || credential?.region === CN) {
    return credential.region;
  }
  const domain =
    typeof credential?.domain === "string"
      ? credential.domain.trim().toLowerCase()
      : "";
  return domain === "workbuddy.ai" || domain.endsWith(".workbuddy.ai")
    ? GLOBAL
    : CN;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 上游 `{code,msg,data}` 的业务码；缺省或非数字时返回 null。 */
function businessCode(payload) {
  if (!isRecord(payload)) return null;
  const raw = payload.code;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 提取上游可读的错误说明（优先中文 displayMsg），不包含任何令牌。 */
function upstreamMessage(payload) {
  if (!isRecord(payload)) return "";
  const display = payload.displayMsg;
  if (isRecord(display)) {
    for (const key of ["zh", "en"]) {
      const value = display[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
  }
  for (const key of ["msg", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  const error = payload.error;
  if (isRecord(error)) {
    for (const key of ["message", "msg"]) {
      const value = error[key];
      if (typeof value === "string" && value.trim() !== "") {
        return value.trim();
      }
    }
  }
  return "";
}

function failureMessage(action, response, payload) {
  const detail = upstreamMessage(payload);
  if (detail) return `${action}失败：${detail}`;
  return `${action}失败（HTTP ${response?.status ?? 0}）`;
}

function authorizationError(status) {
  return Object.assign(new Error("WorkBuddy 授权已失效，请重新授权"), {
    code: "OAUTH_INVALID",
    status,
  });
}

/** HTTP 或业务码失败时抛中文错误；成功时返回业务码。 */
function ensureSuccess(action, response, payload) {
  const code = businessCode(payload);
  if (!response.ok || (code !== null && code !== 0)) {
    if (response.status === 401 || response.status === 403) {
      throw authorizationError(response.status);
    }
    throw new Error(failureMessage(action, response, payload));
  }
  return code;
}

function envelopeData(payload) {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null;
}

/** 刷新响应可能带一层 `data.data`；只在第一层没有 accessToken 时下钻。 */
function tokenPayloadData(payload) {
  const data = envelopeData(payload);
  if (!data) {
    return isRecord(payload) && typeof payload.accessToken === "string"
      ? payload
      : null;
  }
  if (!("accessToken" in data) && isRecord(data.data)) return data.data;
  return data;
}

async function readResponse(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  return { text, payload: parseJson(text) };
}

function resolveFetch(fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("当前运行环境不支持 fetch，无法连接 WorkBuddy");
  }
  return doFetch;
}

function requestInit(method, headers, body) {
  const init = {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) init.body = body;
  return init;
}

function networkError(message) {
  return Object.assign(new Error(message), { retryable: true });
}

/** 登录/账号端点共用请求头（token 只在 account 调用时传入）。 */
function loginHeaders(origin, token) {
  const headers = {
    "Content-Type": "application/json",
    Accept: JSON_ACCEPT,
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": LOGIN_USER_AGENT,
  };
  if (typeof token === "string" && token !== "") {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * 校验授权页 URL 并补 `loginSessionId`。
 *
 * 上游 state 端点只回传自己的 state；桌面端会在客户端再追加一个随机的
 * loginSessionId，手机号登录（OneID）要靠它把授权页与发起端关联起来。缺了就补，
 * 已有则保留上游的值。只允许 HTTPS 与当地区域的官方域名，避免把浏览器导向
 * 任意主机。
 */
function authUrlWithSession(rawUrl, region) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("WorkBuddy 授权服务返回的登录地址无效");
  }
  const endpoints = endpointsFor(region);
  const host = url.hostname.toLowerCase();
  const official = endpoints.authHosts.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  if (url.protocol !== "https:" || url.username || url.password || !official) {
    throw new Error(
      "WorkBuddy 授权服务返回的登录地址不在官方域名内，已拒绝打开",
    );
  }
  if (!url.searchParams.has("loginSessionId")) {
    url.searchParams.set("loginSessionId", randomUUID());
  }
  return url.href;
}

/** 第一步：向上游申请 state 与浏览器授权页。 */
export async function workbuddyStart({ region, fetchImpl } = {}) {
  const resolvedRegion = normalizeRegion(region);
  const endpoints = endpointsFor(resolvedRegion);
  const doFetch = resolveFetch(fetchImpl);
  const url = `${endpoints.loginBase}/v2/plugin/auth/state?platform=${AUTH_PLATFORM}`;

  let response;
  try {
    response = await doFetch(
      url,
      requestInit("GET", loginHeaders(endpoints.origin)),
    );
  } catch {
    throw networkError("WorkBuddy 登录服务连接失败，请稍后重试");
  }
  const { payload } = await readResponse(response);
  ensureSuccess("WorkBuddy 登录服务", response, payload);

  const data = envelopeData(payload);
  const state = data ? stringValue(data.state).trim() : "";
  const authUrl = data ? stringValue(data.authUrl).trim() : "";
  if (!state) throw new Error("WorkBuddy 登录服务未返回授权状态，请稍后重试");
  if (!authUrl) throw new Error("WorkBuddy 登录服务未返回授权地址，请稍后重试");

  return { state, authUrl: authUrlWithSession(authUrl, resolvedRegion) };
}

/**
 * 第二步：轮询 token 端点。
 *
 * 未完成授权时上游返回业务码非 0（如 11217 “login ing”）或 4xx；这属于
 * “等待用户”，返回 `{pending:true}` 而不是终端错误。只有业务码为 0 却缺
 * accessToken 才算真正的失败。
 */
export async function workbuddyPoll({ state, region, fetchImpl } = {}) {
  const loginState = typeof state === "string" ? state.trim() : "";
  if (!loginState) throw new Error("WorkBuddy 登录状态无效，请重新发起授权");
  const endpoints = endpointsFor(region);
  const doFetch = resolveFetch(fetchImpl);
  const url = `${endpoints.loginBase}/v2/plugin/auth/token?state=${encodeURIComponent(
    loginState,
  )}`;

  let response;
  try {
    response = await doFetch(
      url,
      requestInit("GET", loginHeaders(endpoints.origin)),
    );
  } catch {
    throw networkError("WorkBuddy 登录服务连接失败，请稍后重试");
  }
  const { payload } = await readResponse(response);
  const code = businessCode(payload);
  if (code !== null && code !== 0) return { pending: true };
  if (response.status >= 400 && response.status < 500) return { pending: true };
  ensureSuccess("WorkBuddy 登录服务", response, payload);

  const data = envelopeData(payload);
  const accessToken = data ? stringValue(data.accessToken) : "";
  if (!accessToken.trim()) {
    throw new Error("WorkBuddy 授权服务未返回访问令牌，请重新授权");
  }
  const expiresIn = Number(data.expiresIn);
  return {
    pending: false,
    token: {
      accessToken,
      refreshToken: stringValue(data.refreshToken),
      expiresIn:
        Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 0,
      domain: stringValue(data.domain),
    },
  };
}

/** 第三步：读取本次授权绑定的账号身份。 */
export async function workbuddyAccount({
  state,
  accessToken,
  region,
  fetchImpl,
} = {}) {
  const loginState = typeof state === "string" ? state.trim() : "";
  const token = typeof accessToken === "string" ? accessToken : "";
  if (!loginState) throw new Error("WorkBuddy 登录状态无效，请重新发起授权");
  if (!token.trim()) {
    throw Object.assign(new Error("缺少 WorkBuddy 访问令牌，请重新授权"), {
      code: "OAUTH_INVALID",
    });
  }
  const endpoints = endpointsFor(region);
  const doFetch = resolveFetch(fetchImpl);
  const url = `${endpoints.loginBase}/v2/plugin/login/account?state=${encodeURIComponent(
    loginState,
  )}`;

  let response;
  try {
    response = await doFetch(
      url,
      requestInit("GET", loginHeaders(endpoints.origin, token)),
    );
  } catch {
    throw networkError("WorkBuddy 账号服务连接失败，请稍后重试");
  }
  const { payload } = await readResponse(response);
  ensureSuccess("WorkBuddy 账号信息获取", response, payload);

  const data = envelopeData(payload);
  if (!data) throw new Error("WorkBuddy 账号服务返回内容无效");
  // 空 uid 由调用方判定是否可用；这里只做字段归一化，不臆造身份。
  return {
    uid: stringValue(data.uid),
    enterpriseId: stringValue(data.enterpriseId),
    nickname: stringValue(data.nickname),
  };
}

/**
 * 刷新令牌：POST 刷新端点，从 `data` 读取轮换后的令牌。
 *
 * 上游可能不轮换 refreshToken；此时沿用凭据里的旧值，避免把有效凭据覆盖成空。
 */
export async function workbuddyRefresh({ credential, fetchImpl } = {}) {
  if (!isRecord(credential)) {
    throw new Error("WorkBuddy 登录凭据无效，请重新授权");
  }
  const refreshToken = stringValue(credential.refreshToken);
  if (!refreshToken.trim()) {
    throw new Error("没有可用的 WorkBuddy 刷新令牌，请重新授权");
  }
  const region = regionOfCredential(credential);
  const endpoints = endpointsFor(region);
  const doFetch = resolveFetch(fetchImpl);
  const headers = {
    "Content-Type": "application/json",
    Accept: JSON_ACCEPT,
    "X-Requested-With": "XMLHttpRequest",
    Origin: endpoints.origin,
    Referer: `${endpoints.origin}/`,
    "User-Agent": LOGIN_USER_AGENT,
    "X-Refresh-Token": refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  const enterpriseId = stringValue(credential.enterpriseId);
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;

  let response;
  try {
    response = await doFetch(
      `${endpoints.chatBase}/v2/plugin/auth/token/refresh`,
      requestInit("POST", headers, "{}"),
    );
  } catch {
    throw networkError("WorkBuddy 令牌刷新服务连接失败，请稍后重试");
  }
  const { payload } = await readResponse(response);
  ensureSuccess("WorkBuddy 令牌刷新", response, payload);

  const data = tokenPayloadData(payload);
  const accessToken = data ? stringValue(data.accessToken) : "";
  if (!accessToken.trim()) {
    throw new Error("WorkBuddy 令牌刷新未返回访问令牌，请重新授权");
  }
  const expiresIn = Number(data.expiresIn);
  const rotatedRefresh = data ? stringValue(data.refreshToken) : "";
  const domain = data ? stringValue(data.domain) : "";
  return {
    accessToken,
    refreshToken: rotatedRefresh || refreshToken,
    expiresIn:
      Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 0,
    domain: domain || stringValue(credential.domain),
  };
}

/** chat 请求头；Authorization 只放 access token，绝不携带 refresh token。 */
function chatHeaders(credential, endpoints) {
  const uid = stringValue(credential.uid);
  const enterpriseId = stringValue(credential.enterpriseId);
  const domain = stringValue(credential.domain);
  const headers = {
    Authorization: `Bearer ${stringValue(credential.accessToken)}`,
    "Content-Type": "application/json",
    Accept: JSON_ACCEPT,
    Origin: endpoints.origin,
    Referer: `${endpoints.origin}/`,
    "User-Agent": endpoints.chatUserAgent,
    "X-Requested-With": "XMLHttpRequest",
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": endpoints.ideVersion,
    "X-Product": "SaaS",
  };
  if (uid) headers["X-User-Id"] = uid;
  else headers["X-No-User-Id"] = "1";
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  else headers["X-No-Enterprise-Id"] = "1";
  if (domain) headers["X-Domain"] = domain;
  else headers["X-No-Department-Info"] = "1";
  return headers;
}

/** 流式分片：取 choices[0].delta.content；同时兼容 message.content。 */
function chatChunkText(chunk) {
  if (!isRecord(chunk)) return { text: "", fallback: "" };
  const code = businessCode(chunk);
  if (code !== null && code !== 0) {
    throw new Error(
      `WorkBuddy 模型接口返回错误：${upstreamMessage(chunk) || `业务码 ${code}`}`,
    );
  }
  if (isRecord(chunk.error)) {
    const detail =
      upstreamMessage(chunk.error) ||
      upstreamMessage(chunk) ||
      "上游返回未说明的错误";
    throw new Error(`WorkBuddy 模型接口返回错误：${detail}`);
  }
  if (isRecord(chunk.data) && !Array.isArray(chunk.choices)) {
    return chatChunkText(chunk.data);
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!isRecord(choice)) return { text: "", fallback: "" };
  const delta = isRecord(choice.delta) ? choice.delta.content : undefined;
  const message = isRecord(choice.message) ? choice.message.content : undefined;
  const plain = choice.text;
  return {
    text: typeof delta === "string" ? delta : "",
    fallback:
      typeof message === "string"
        ? message
        : typeof plain === "string"
          ? plain
          : "",
  };
}

/** 解析 SSE：逐行 `data:` JSON，拼接 delta.content，[DONE] 结束。 */
function parseSseAnswer(text) {
  const parts = [];
  let fallback = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith("data:")) continue;
    const payloadText = line.slice(5).trim();
    if (!payloadText) continue;
    if (payloadText === "[DONE]") break;
    const chunk = parseJson(payloadText);
    if (!isRecord(chunk)) continue;
    const result = chatChunkText(chunk);
    if (result.text) parts.push(result.text);
    if (result.fallback) fallback += result.fallback;
  }
  return parts.join("") || fallback;
}

/** 非流式 JSON 响应（含 `{code,msg,data}` 包装）的兜底解析。 */
function parseJsonChatAnswer(payload) {
  if (!isRecord(payload)) {
    throw new Error("WorkBuddy 模型返回内容格式无效");
  }
  const code = businessCode(payload);
  if (code !== null && code !== 0) {
    throw new Error(
      `WorkBuddy 模型接口返回错误：${upstreamMessage(payload) || `业务码 ${code}`}`,
    );
  }
  const result = chatChunkText(payload);
  return result.text || result.fallback;
}

function chatFailure(response, payload) {
  if (response.status === 401 || response.status === 403) {
    return authorizationError(response.status);
  }
  const detail = upstreamMessage(payload);
  const message = detail
    ? `WorkBuddy 模型接口请求失败（HTTP ${response.status}）：${detail}`
    : `WorkBuddy 模型接口请求失败（HTTP ${response.status}）`;
  return Object.assign(new Error(message), {
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
  });
}

/**
 * 调用 WorkBuddy chat（SSE），返回拼接后的文本。
 *
 * 请求体是 OpenAI messages，并强制 stream:true；上游不接受 developer 角色，
 * 统一改写为 system。响应可能是 SSE，也可能是 `{code,msg,data}` JSON。
 */
export async function workbuddyChat({
  credential,
  model,
  messages,
  fetchImpl,
} = {}) {
  if (!isRecord(credential)) {
    throw new Error("WorkBuddy 登录凭据无效，请重新授权");
  }
  const accessToken = stringValue(credential.accessToken);
  if (!accessToken) throw authorizationError(401);
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) throw new Error("WorkBuddy 对话消息不能为空");

  const region = regionOfCredential(credential);
  const endpoints = endpointsFor(region);
  const doFetch = resolveFetch(fetchImpl);
  const selectedModel = stringValue(model).trim() || DEFAULT_MODEL;
  const normalizedMessages = list.map((message) =>
    isRecord(message) && message.role === "developer"
      ? { ...message, role: "system" }
      : message,
  );
  const body = JSON.stringify({
    model: selectedModel,
    messages: normalizedMessages,
    stream: true,
  });

  let response;
  try {
    response = await doFetch(
      `${endpoints.chatBase}/v2/chat/completions`,
      requestInit("POST", chatHeaders(credential, endpoints), body),
    );
  } catch {
    throw networkError("WorkBuddy 模型接口连接失败，请稍后重试");
  }
  const { text, payload } = await readResponse(response);
  if (!response.ok) throw chatFailure(response, payload);
  if (!text.trim()) throw new Error("WorkBuddy 模型没有返回内容");

  // 业务错误即使以 HTTP 200 返回，也要转成中文错误而不是空答案。
  const code = businessCode(payload);
  if (code !== null && code !== 0) {
    throw new Error(
      `WorkBuddy 模型接口返回错误：${upstreamMessage(payload) || `业务码 ${code}`}`,
    );
  }

  const answer = /^[ \t]*data:/m.test(text)
    ? parseSseAnswer(text)
    : parseJsonChatAnswer(payload);
  if (!answer || !answer.trim()) {
    throw new Error("WorkBuddy 模型没有返回内容");
  }
  return answer;
}
