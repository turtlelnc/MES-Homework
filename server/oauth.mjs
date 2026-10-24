// v0.2.1: OAuth model connections (Authorization Code + PKCE S256).
//
// Seven providers are catalogued below. Deployments enable a provider through
// environment variables (OAUTH_<ID>_*). Tokens are AES-256-GCM encrypted with
// the shared ctx.encrypt / ctx.decrypt helpers from server/index.mjs; this
// module never returns token material to HTTP clients and never logs it.
//
// Tests inject `fetchImpl` (or set ctx.fetchImpl) so no network is touched.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { assertPublicProviderEndpoint } from "./security.mjs";
import {
  canConfigureOwnModel,
  modelConfigDeniedMessage,
} from "./model-access.mjs";

const GLOBAL = "global";
const CN = "cn";
const TEN_MINUTES = 10 * 60 * 1000;

// Provider catalogue. `authorizeUrl` / `tokenUrl` / `apiEndpoint` are defaults
// that a deployment may override per provider through environment variables.
export const OAUTH_PROVIDERS = [
  {
    id: "chatgpt",
    name: "ChatGPT（OpenAI）",
    description:
      "使用 OpenAI 账号授权后调用 ChatGPT 文本模型，适合已有 ChatGPT 订阅的教师。",
    region: GLOBAL,
    mainlandUnavailable: true,
    vision: true,
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    apiEndpoint: "https://api.openai.com/v1/chat/completions",
    scopes: "openid profile email offline_access",
    model: "gpt-4.1-mini",
    apiStyle: "openai",
    tokenAuth: "post",
  },
  {
    id: "claude",
    name: "Claude（Anthropic）",
    description:
      "使用 Claude 账号授权后调用 Anthropic 文本模型，适合已有 Claude 订阅的教师。",
    region: GLOBAL,
    mainlandUnavailable: true,
    vision: false,
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    apiEndpoint: "https://api.anthropic.com/v1/messages",
    scopes: "user:inference user:profile",
    model: "claude-sonnet-4-5",
    apiStyle: "anthropic",
    tokenAuth: "post",
  },
  {
    id: "gemini",
    name: "Gemini（Google）",
    description:
      "使用 Google 账号授权后调用 Gemini 文本模型，适合已有 Gemini 订阅的教师。",
    region: GLOBAL,
    mainlandUnavailable: true,
    vision: true,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    apiEndpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    scopes: "openid email profile",
    model: "gemini-2.5-flash",
    apiStyle: "openai",
    tokenAuth: "post",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    description: "国内 WorkBuddy 开放平台，授权与接口地址由学校部署方提供。",
    region: CN,
    mainlandUnavailable: false,
    vision: false,
    authorizeUrl: "",
    tokenUrl: "",
    apiEndpoint: "",
    scopes: "",
    model: "workbuddy-chat",
    apiStyle: "openai",
    tokenAuth: "post",
  },
  {
    id: "qwen",
    name: "Qwen（国际版）",
    description: "通义千问国际版开放平台，授权与接口地址由学校部署方提供。",
    region: CN,
    mainlandUnavailable: false,
    vision: true,
    authorizeUrl: "",
    tokenUrl: "",
    apiEndpoint: "",
    scopes: "",
    model: "qwen-vl-max",
    apiStyle: "openai",
    tokenAuth: "post",
  },
  {
    id: "qianwen",
    name: "千问（国内版）",
    description: "通义千问国内版开放平台，授权与接口地址由学校部署方提供。",
    region: CN,
    mainlandUnavailable: false,
    vision: true,
    authorizeUrl: "",
    tokenUrl: "",
    apiEndpoint: "",
    scopes: "",
    model: "qwen-vl-max",
    apiStyle: "openai",
    tokenAuth: "post",
  },
  {
    id: "deepseek",
    name: "DeepSeek（Platform）",
    description:
      "使用 DeepSeek 开放平台账号授权，国内网络可直接访问，接口默认 https://api.deepseek.com。",
    region: CN,
    mainlandUnavailable: false,
    vision: false,
    authorizeUrl: "",
    tokenUrl: "",
    apiEndpoint: "https://api.deepseek.com/chat/completions",
    scopes: "",
    model: "deepseek-chat",
    apiStyle: "openai",
    tokenAuth: "post",
  },
];

const PROVIDER_IDS = new Set(OAUTH_PROVIDERS.map((provider) => provider.id));

export function oauthProvider(id) {
  if (typeof id !== "string" || !PROVIDER_IDS.has(id)) return null;
  return OAUTH_PROVIDERS.find((provider) => provider.id === id) || null;
}

function envValue(env, id, suffix) {
  const value = env?.[`OAUTH_${id.toUpperCase()}_${suffix}`];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function envName(id, suffix) {
  return `OAUTH_${id.toUpperCase()}_${suffix}`;
}

export function oauthRedirectBase(env = process.env) {
  const configured =
    (typeof env.OAUTH_REDIRECT_BASE === "string" &&
      env.OAUTH_REDIRECT_BASE.trim()) ||
    (typeof env.APP_ORIGIN === "string" && env.APP_ORIGIN.trim()) ||
    "";
  const base =
    configured || `http://127.0.0.1:${env.PORT || process.env.PORT || 8787}`;
  return String(base).replace(/\/+$/, "");
}

export function oauthRedirectUri(id, env = process.env) {
  return `${oauthRedirectBase(env)}/api/oauth/${encodeURIComponent(id)}/callback`;
}

/**
 * Resolve a provider's runtime configuration from environment variables.
 * Returns `{configured:false, envHint:[...]}` when the deployment has not
 * enabled it; never throws for unknown/unconfigured ids so routes can answer
 * with an actionable message.
 */
export function configuredProvider(id, env = process.env) {
  const provider = oauthProvider(id);
  if (!provider) {
    return {
      id: typeof id === "string" ? id : "",
      provider: null,
      configured: false,
      envHint: [],
      error: "OAuth 提供方无效",
    };
  }
  const clientId = envValue(env, id, "CLIENT_ID");
  const clientSecret = envValue(env, id, "CLIENT_SECRET");
  const authorizeUrl =
    envValue(env, id, "AUTHORIZE_URL") || provider.authorizeUrl;
  const tokenUrl = envValue(env, id, "TOKEN_URL") || provider.tokenUrl;
  const apiEndpoint = envValue(env, id, "API_ENDPOINT") || provider.apiEndpoint;
  const scopes = envValue(env, id, "SCOPES") || provider.scopes;
  const model = envValue(env, id, "MODEL") || provider.model;
  const tokenAuth = (
    envValue(env, id, "TOKEN_AUTH") ||
    provider.tokenAuth ||
    "post"
  ).toLowerCase();

  const envHint = [];
  if (!clientId) envHint.push(envName(id, "CLIENT_ID"));
  if (!isHttpsUrl(authorizeUrl)) envHint.push(envName(id, "AUTHORIZE_URL"));
  if (!isHttpsUrl(tokenUrl)) envHint.push(envName(id, "TOKEN_URL"));
  if (!isHttpsUrl(apiEndpoint)) envHint.push(envName(id, "API_ENDPOINT"));

  return {
    id: provider.id,
    provider,
    configured: envHint.length === 0,
    clientId,
    clientSecret,
    authorizeUrl: isHttpsUrl(authorizeUrl) ? authorizeUrl : "",
    tokenUrl: isHttpsUrl(tokenUrl) ? tokenUrl : "",
    apiEndpoint: isHttpsUrl(apiEndpoint) ? apiEndpoint : "",
    scopes,
    model,
    tokenAuth: tokenAuth === "basic" ? "basic" : "post",
    apiStyle: provider.apiStyle,
    vision: provider.vision,
    region: provider.region,
    mainlandUnavailable: provider.mainlandUnavailable,
    envHint,
    redirectBase: oauthRedirectBase(env),
    redirectUri: oauthRedirectUri(provider.id, env),
  };
}

function tokenRowsByProvider(db, userId) {
  const rows = db
    .prepare(
      `SELECT provider, status, created_at, updated_at FROM oauth_connections
       WHERE user_id=?`,
    )
    .all(userId);
  return new Map(rows.map((row) => [row.provider, row]));
}

/** Safe provider directory for the front end (no secrets, no tokens). */
export function publicOAuthProviders(db, userId) {
  const connected = tokenRowsByProvider(db, userId);
  return OAUTH_PROVIDERS.map((provider) => {
    const config = configuredProvider(provider.id);
    const row = connected.get(provider.id);
    const isConnected = Boolean(row && row.status === "active");
    return {
      id: provider.id,
      name: provider.name,
      region: provider.region,
      mainlandUnavailable: provider.mainlandUnavailable,
      configured: config.configured,
      connected: isConnected,
      connectedAt: isConnected ? row.updated_at : null,
      description: provider.description,
      model: config.model || provider.model,
      vision: provider.vision,
      envHint: config.configured ? [] : config.envHint,
    };
  });
}

export function oauthEndpoint(id, env = process.env) {
  const provider = oauthProvider(id);
  if (!provider) throw new Error("OAuth 提供方无效");
  const url = envValue(env, id, "API_ENDPOINT") || provider.apiEndpoint || "";
  if (!isHttpsUrl(url))
    throw new Error("该 OAuth 模型的 API 地址尚未配置或不是 HTTPS");
  return new URL(url).href;
}

function oauthModel(provider, env = process.env) {
  const model = envValue(env, provider.id, "MODEL") || provider.model || "";
  if (!model) throw new Error("该 OAuth 提供方尚未配置默认模型");
  return model;
}

export function codeChallenge(verifier) {
  return createHash("sha256").update(String(verifier)).digest("base64url");
}

/** PKCE S256 pair: a 43–128 char base64url verifier and its SHA-256 challenge. */
export function createPkcePair() {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: codeChallenge(verifier) };
}

export function createState() {
  return randomBytes(32).toString("hex");
}

/** Pure: build the provider authorization URL (never contains client_secret). */
export function buildAuthorizeUrl({
  provider,
  config,
  state,
  challenge,
  redirectUri,
}) {
  const preset =
    typeof provider === "string" ? oauthProvider(provider) : provider;
  if (!preset) throw new Error("OAuth 提供方无效");
  if (!config || !config.configured || !config.authorizeUrl || !config.clientId)
    throw new Error("OAuth 提供方尚未配置");
  if (!state || !challenge || !redirectUri)
    throw new Error("OAuth 授权参数不完整");
  const url = new URL(config.authorizeUrl);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", config.clientId);
  params.set("redirect_uri", redirectUri);
  params.set("state", state);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  if (config.scopes) params.set("scope", config.scopes);
  // Google only returns a refresh token when these are requested explicitly.
  if (preset.id === "gemini") {
    if (!params.has("access_type")) params.set("access_type", "offline");
    if (!params.has("prompt")) params.set("prompt", "consent");
  }
  return url.href;
}

function tokenRequest(config, fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null && value !== "")
      body.set(key, String(value));
  }
  body.set("client_id", config.clientId);
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.clientSecret) {
    if (config.tokenAuth === "basic") {
      headers.authorization = `Basic ${Buffer.from(
        `${config.clientId}:${config.clientSecret}`,
      ).toString("base64")}`;
    } else {
      body.set("client_secret", config.clientSecret);
    }
  }
  return { body: body.toString(), headers };
}

function normalizeTokenPayload(payload) {
  const accessToken =
    payload && typeof payload.access_token === "string"
      ? payload.access_token
      : "";
  if (!accessToken)
    throw Object.assign(new Error("OAuth 提供方未返回访问令牌"), {
      code: "exchange_failed",
    });
  const expiresIn = Number(payload.expires_in);
  const expires = Number.isFinite(expiresIn) && expiresIn > 0;
  return {
    access_token: accessToken,
    refresh_token:
      typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : null,
    token_type:
      typeof payload.token_type === "string" && payload.token_type
        ? payload.token_type
        : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
    expires_in: expires ? Math.floor(expiresIn) : null,
    expiresAt: expires ? Date.now() + Math.floor(expiresIn) * 1000 : null,
  };
}

async function requestToken(config, fields, fetchImpl) {
  if (!config || !config.tokenUrl)
    throw Object.assign(new Error("OAuth 令牌端点尚未配置"), {
      code: "provider_unconfigured",
    });
  if (!isHttpsUrl(config.tokenUrl))
    throw Object.assign(new Error("OAuth 令牌端点必须使用 HTTPS"), {
      code: "exchange_failed",
    });
  const doFetch = fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    try {
      await assertPublicProviderEndpoint(config.tokenUrl);
    } catch {
      throw Object.assign(
        new Error("OAuth 令牌端点不安全，出于安全考虑已拒绝访问"),
        { code: "exchange_failed" },
      );
    }
  }
  const { body, headers } = tokenRequest(config, fields);
  let response;
  try {
    response = await doFetch(config.tokenUrl, {
      method: "POST",
      headers,
      body,
      redirect: "error",
    });
  } catch {
    throw Object.assign(new Error("OAuth 授权服务连接失败，请稍后重试"), {
      code: "exchange_failed",
      retryable: true,
    });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("OAuth 授权失败，请重新授权"), {
      code: "exchange_failed",
      status: response.status,
    });
  return normalizeTokenPayload(payload);
}

/**
 * Exchange an authorization code for tokens (pure network wrapper: the caller
 * stores the result). `fetchImpl` is injected by tests; production uses fetch.
 */
export async function exchangeCode({
  provider,
  config,
  code,
  verifier,
  redirectUri,
  fetchImpl,
}) {
  const preset =
    typeof provider === "string" ? oauthProvider(provider) : provider;
  if (!preset) throw new Error("OAuth 提供方无效");
  if (!code)
    throw Object.assign(new Error("缺少 OAuth 授权码"), {
      code: "exchange_failed",
    });
  return requestToken(
    config,
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    },
    fetchImpl,
  );
}

export async function refreshToken({
  provider,
  config,
  refreshToken: token,
  fetchImpl,
}) {
  const preset =
    typeof provider === "string" ? oauthProvider(provider) : provider;
  if (!preset) throw new Error("OAuth 提供方无效");
  if (!token)
    throw Object.assign(new Error("没有可用的刷新令牌，请重新连接 OAuth"), {
      code: "exchange_failed",
    });
  return requestToken(
    config,
    { grant_type: "refresh_token", refresh_token: token },
    fetchImpl,
  );
}

// The schema has a single `iv` column, so the refresh token's IV travels
// packed with its ciphertext in `encrypted_refresh` ("<base64>.<ivBase64>").
export function packEncrypted(parts) {
  if (!Array.isArray(parts) || parts.length !== 2)
    throw new Error("加密数据格式无效");
  return `${parts[0]}.${parts[1]}`;
}

export function unpackEncrypted(packed) {
  const text = String(packed || "");
  const index = text.indexOf(".");
  if (index < 1 || index === text.length - 1)
    throw new Error("加密数据格式无效");
  return { body: text.slice(0, index), iv: text.slice(index + 1) };
}

/** Decrypt a connection row's tokens. Never exported through HTTP. */
export function readOAuthTokens(connection, decrypt) {
  if (!connection)
    return { accessToken: null, refreshToken: null, expiresAt: null };
  const accessToken = decrypt(connection.encrypted_access, connection.iv);
  let refreshTokenValue = null;
  const storedRefresh = connection.encrypted_refresh;
  if (storedRefresh) {
    if (String(storedRefresh).includes(".")) {
      const packed = unpackEncrypted(storedRefresh);
      refreshTokenValue = decrypt(packed.body, packed.iv);
    } else {
      refreshTokenValue = decrypt(storedRefresh, connection.iv);
    }
  }
  return {
    accessToken,
    refreshToken: refreshTokenValue,
    expiresAt: connection.expires_at ? Number(connection.expires_at) : null,
  };
}

export function getOAuthConnection(db, userId, provider) {
  if (!db || !userId || !provider) return null;
  return (
    db
      .prepare("SELECT * FROM oauth_connections WHERE user_id=? AND provider=?")
      .get(userId, provider) || null
  );
}

// Spec §4.2 names this `getConnection`; the Lead wires `getOAuthConnection`.
export const getConnection = getOAuthConnection;

function storeConnection(ctx, userId, preset, tokens) {
  const [accessBody, accessIv] = ctx.encrypt(tokens.access_token);
  const refreshPacked = tokens.refresh_token
    ? packEncrypted(ctx.encrypt(tokens.refresh_token))
    : null;
  const updatedAt = new Date().toISOString();
  ctx.db
    .prepare(
      `INSERT INTO oauth_connections(
         id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,
         token_type,scope,expires_at,status,created_at,updated_at)
       VALUES(?,?,?,'',?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(user_id,provider) DO UPDATE SET
         encrypted_access=excluded.encrypted_access,
         encrypted_refresh=COALESCE(excluded.encrypted_refresh,oauth_connections.encrypted_refresh),
         iv=excluded.iv,
         token_type=excluded.token_type,
         scope=excluded.scope,
         expires_at=excluded.expires_at,
         status='active',
         updated_at=excluded.updated_at`,
    )
    .run(
      randomUUID(),
      userId,
      preset.id,
      accessBody,
      refreshPacked,
      accessIv,
      tokens.token_type || "Bearer",
      tokens.scope || "",
      tokens.expiresAt ?? null,
      updatedAt,
      updatedAt,
    );
}

function persistenceKeyError() {
  return Object.assign(new Error("OAuth 授权已失效，请重新连接"), {
    code: "OAUTH_INVALID",
    status: 401,
  });
}

/**
 * Call an OAuth-backed text model. `provider` is a catalogue row (or id),
 * `connection` a row from getOAuthConnection, `decrypt` the ctx.decrypt helper.
 * Returns the raw model text; the caller (index.mjs) parses the JSON.
 *
 * Expired access tokens are refreshed in memory. When `db` + `encrypt` are
 * supplied the refreshed token is also persisted for later calls.
 */
export async function oauthChatText({
  user,
  provider,
  connection,
  model,
  prompt,
  images = [],
  signal = null,
  decrypt,
  encrypt = null,
  db = null,
  fetchImpl = null,
  now = Date.now(),
}) {
  const preset =
    typeof provider === "string" ? oauthProvider(provider) : provider;
  if (!preset) throw new Error("OAuth 提供方无效");
  if (!connection) throw persistenceKeyError();
  if (typeof decrypt !== "function")
    throw Object.assign(new Error("OAuth 凭证读取失败"), {
      code: "OAUTH_INVALID",
      status: 401,
    });

  let storedTokens;
  try {
    storedTokens = readOAuthTokens(connection, decrypt);
  } catch {
    throw persistenceKeyError();
  }
  let accessToken = storedTokens.accessToken;
  const refreshValue = storedTokens.refreshToken;
  const expiresAt = storedTokens.expiresAt;
  if (!accessToken) throw persistenceKeyError();

  if (expiresAt && expiresAt <= now + 30_000) {
    if (!refreshValue) throw persistenceKeyError();
    const config = configuredProvider(preset.id);
    if (!config.configured) throw persistenceKeyError();
    let refreshed;
    try {
      refreshed = await refreshToken({
        provider: preset,
        config,
        refreshToken: refreshValue,
        fetchImpl,
      });
    } catch {
      throw persistenceKeyError();
    }
    accessToken = refreshed.access_token;
    if (db && typeof encrypt === "function" && user?.id) {
      try {
        const [accessBody, accessIv] = encrypt(accessToken);
        const refreshPacked = refreshed.refresh_token
          ? packEncrypted(encrypt(refreshed.refresh_token))
          : connection.encrypted_refresh;
        db.prepare(
          `UPDATE oauth_connections SET
             encrypted_access=?, encrypted_refresh=?, iv=?, expires_at=?, updated_at=?
           WHERE user_id=? AND provider=?`,
        ).run(
          accessBody,
          refreshPacked,
          accessIv,
          refreshed.expiresAt ?? null,
          new Date(now).toISOString(),
          user.id,
          preset.id,
        );
      } catch {
        // In-memory refresh still allows this call; the next call refreshes again.
      }
    }
  }

  const endpoint = oauthEndpoint(preset.id);
  const doFetch = fetchImpl || globalThis.fetch;
  if (!fetchImpl) await assertPublicProviderEndpoint(endpoint);

  const headers = { "content-type": "application/json" };
  const imageList = Array.isArray(images) ? images : [];
  const promptText = String(prompt ?? "");
  const selectedModel = model || oauthModel(preset);
  let body;
  if (preset.apiStyle === "anthropic") {
    if (imageList.length) throw new Error("该 OAuth 模型暂不支持图片识别");
    headers.authorization = `Bearer ${accessToken}`;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] = "oauth-2025-04-20";
    body = {
      model: selectedModel,
      max_tokens: 4096,
      temperature: 0,
      messages: [
        { role: "user", content: [{ type: "text", text: promptText }] },
      ],
    };
  } else {
    headers.authorization = `Bearer ${accessToken}`;
    const content = [{ type: "text", text: promptText }];
    imageList.forEach((image, index) => {
      content.push({ type: "text", text: `第 ${index + 1} 页：` });
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.base64}`,
          detail: "high",
        },
      });
    });
    body = {
      model: selectedModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "user", content: imageList.length ? content : promptText },
      ],
    };
  }

  let response;
  try {
    const signals = [AbortSignal.timeout(60000)];
    if (signal) signals.push(signal);
    response = await doFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
  } catch {
    throw Object.assign(new Error("OAuth 模型接口连接失败，请稍后重试"), {
      retryable: true,
    });
  }
  if (response.status === 401 || response.status === 403)
    throw persistenceKeyError();
  if (!response.ok)
    throw Object.assign(new Error(`模型接口请求失败 (${response.status})`), {
      retryable: response.status === 429 || response.status >= 500,
    });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("模型返回内容格式无效");
  }
  const text =
    preset.apiStyle === "anthropic"
      ? Array.isArray(payload?.content)
        ? payload.content
            .filter((part) => part && part.type === "text")
            .map((part) => String(part.text || ""))
            .join("\n")
            .trim()
        : ""
      : typeof payload?.choices?.[0]?.message?.content === "string"
        ? payload.choices[0].message.content
        : "";
  if (!text) throw new Error("模型没有返回识别内容");
  return text;
}

export const oauthChat = oauthChatText;

function oauthRedirect(res, providerId, status, reason) {
  const params = new URLSearchParams();
  if (providerId) params.set("oauth_provider", providerId);
  params.set("oauth_status", status);
  if (reason) params.set("oauth_reason", reason);
  // Always a same-origin relative Location: user input never becomes a target.
  res.redirect(302, `/?${params.toString()}`);
}

function allowedFetch(ctx) {
  return typeof ctx?.fetchImpl === "function" ? ctx.fetchImpl : null;
}

export function registerOAuthRoutes(app, ctx) {
  const { db, auth } = ctx;
  const fetchImpl = allowedFetch(ctx);

  app.get("/api/oauth/providers", auth, (req, res) => {
    res.json({
      providers: publicOAuthProviders(db, req.user.id),
      authMode: req.user.model_auth_mode === "oauth" ? "oauth" : "api_key",
      provider: req.user.oauth_provider || null,
    });
  });

  app.post("/api/oauth/:provider/start", auth, (req, res) => {
    const provider = oauthProvider(req.params.provider);
    if (!provider) return res.status(400).json({ error: "OAuth 提供方无效" });
    const config = configuredProvider(provider.id);
    if (!config.configured)
      return res.status(400).json({
        error: `${provider.name} 尚未配置，请联系部署管理员设置环境变量：${config.envHint.join("、")}`,
      });
    if (!canConfigureOwnModel(db, req.user))
      return res
        .status(403)
        .json({ error: modelConfigDeniedMessage(db, req.user) });
    db.prepare("DELETE FROM oauth_states WHERE created_at<=?").run(
      Date.now() - TEN_MINUTES,
    );
    const state = createState();
    const { verifier, challenge } = createPkcePair();
    db.prepare(
      `INSERT INTO oauth_states(state,user_id,provider,verifier,redirect,created_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(state, req.user.id, provider.id, verifier, "/", Date.now());
    res.json({
      authorizeUrl: buildAuthorizeUrl({
        provider,
        config,
        state,
        challenge,
        redirectUri: oauthRedirectUri(provider.id),
      }),
    });
  });

  app.get("/api/oauth/:provider/callback", auth, async (req, res) => {
    const provider = oauthProvider(req.params.provider);
    if (!provider)
      return oauthRedirect(res, "", "error", "provider_unconfigured");
    const config = configuredProvider(provider.id);
    if (!config.configured)
      return oauthRedirect(res, provider.id, "error", "provider_unconfigured");

    const state = typeof req.query.state === "string" ? req.query.state : "";
    const row = state
      ? db.prepare("SELECT * FROM oauth_states WHERE state=?").get(state)
      : null;
    const valid =
      row &&
      row.user_id === req.user.id &&
      row.provider === provider.id &&
      Date.now() - Number(row.created_at) <= TEN_MINUTES;
    if (!valid)
      return oauthRedirect(res, provider.id, "error", "state_invalid");
    db.prepare("DELETE FROM oauth_states WHERE state=? AND user_id=?").run(
      state,
      req.user.id,
    );
    if (!canConfigureOwnModel(db, req.user))
      return oauthRedirect(res, provider.id, "error", "state_invalid");
    if (req.query.error) return oauthRedirect(res, provider.id, "denied");
    if (typeof req.query.code !== "string" || !req.query.code)
      return oauthRedirect(res, provider.id, "error", "exchange_failed");

    try {
      if (!isHttpsUrl(config.tokenUrl)) throw new Error("insecure token url");
      if (!fetchImpl) await assertPublicProviderEndpoint(config.tokenUrl);
    } catch {
      return oauthRedirect(res, provider.id, "error", "exchange_failed");
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        provider,
        config,
        code: req.query.code,
        verifier: row.verifier,
        redirectUri: oauthRedirectUri(provider.id),
        fetchImpl: fetchImpl || undefined,
      });
    } catch {
      return oauthRedirect(res, provider.id, "error", "exchange_failed");
    }
    try {
      storeConnection(ctx, req.user.id, provider, tokens);
    } catch {
      return oauthRedirect(res, provider.id, "error", "store_failed");
    }
    return oauthRedirect(res, provider.id, "connected");
  });

  app.post("/api/oauth/:provider/disconnect", auth, (req, res) => {
    const provider = oauthProvider(req.params.provider);
    if (!provider) return res.status(400).json({ error: "OAuth 提供方无效" });
    db.prepare(
      "DELETE FROM oauth_connections WHERE user_id=? AND provider=?",
    ).run(req.user.id, provider.id);
    db.prepare(
      `UPDATE users SET model_auth_mode='api_key', oauth_provider=NULL
       WHERE id=? AND model_auth_mode='oauth' AND oauth_provider=?`,
    ).run(req.user.id, provider.id);
    res.json({ ok: true });
  });

  app.put("/api/model/auth-mode", auth, (req, res) => {
    const mode = req.body?.mode;
    if (mode !== "api_key" && mode !== "oauth")
      return res
        .status(400)
        .json({ error: "请选择 API Key 或 OAuth 使用方式" });
    if (!canConfigureOwnModel(db, req.user))
      return res
        .status(403)
        .json({ error: modelConfigDeniedMessage(db, req.user) });
    let providerId = null;
    if (mode === "oauth") {
      providerId =
        typeof req.body?.provider === "string" ? req.body.provider : "";
      const provider = oauthProvider(providerId);
      if (!provider) return res.status(400).json({ error: "OAuth 提供方无效" });
      const connection = getOAuthConnection(db, req.user.id, provider.id);
      if (!connection || connection.status !== "active")
        return res.status(400).json({ error: "请先完成 OAuth 授权" });
      providerId = provider.id;
    }
    db.prepare(
      "UPDATE users SET model_auth_mode=?, oauth_provider=? WHERE id=?",
    ).run(mode, providerId, req.user.id);
    res.json({ ok: true, mode, provider: providerId });
  });
}
