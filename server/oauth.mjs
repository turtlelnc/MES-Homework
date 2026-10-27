// v0.2.1-rc4: OAuth model connections.
//
// Three providers are catalogued here (see docs/oauth-flows.md):
//   chatgpt   Codex public PKCE client, browser (local 127.0.0.1:1455 callback)
//             and device-code flows; token/chat protocol lives in
//             server/oauth-chatgpt.mjs.
//   gemini    Browser flow only; the deployment supplies Client ID/Secret via
//             OAUTH_GEMINI_* environment variables. Tokens are exchanged by the
//             generic Authorization Code + PKCE helpers below.
//   workbuddy Device-code flow only; polled in the background and served by
//             server/oauth-workbuddy.mjs.
//
// In-flight authorizations live in an in-memory attempt store: an attempt is
// owned by the user that started it, carries its own state/verifier, expires on
// a TTL and is removed once it connected (or after a grace period when it
// failed). Tokens are AES-256-GCM encrypted with ctx.encrypt/ctx.decrypt and are
// never returned to HTTP clients nor logged.
//
// Tests inject `fetchImpl` (ctx.fetchImpl) and mock the provider modules so no
// network is touched and no fixed port is required.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { oauthFetch } from "./oauth-http.mjs";
import {
  providerHttpError,
  assertProviderCompletion,
  modelResponseLimits,
} from "./provider-protocol.mjs";
import { assertPublicProviderEndpoint } from "./security.mjs";
import {
  canConfigureOwnModel,
  modelConfigDeniedMessage,
} from "./model-access.mjs";
import {
  chatgptAuthorizeUrl,
  chatgptChat,
  chatgptDeviceExchange,
  chatgptDevicePoll,
  chatgptDeviceStart,
  chatgptExchangeCode,
  chatgptMetadata,
  chatgptRedirectUri,
  chatgptRefresh,
} from "./oauth-chatgpt.mjs";
import {
  workbuddyAccount,
  workbuddyChat,
  workbuddyMetadata,
  workbuddyPoll,
  workbuddyRefresh,
  workbuddyRegion,
  workbuddyStart,
} from "./oauth-workbuddy.mjs";

const GLOBAL = "global";
const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const DEFAULT_CHATGPT_CALLBACK_PORT = 1455;

// Provider catalogue. chatgpt/workbuddy ship with built-in public clients, so
// they are always usable unless an operator explicitly disables them; gemini
// still needs OAUTH_GEMINI_* environment variables from the deployment.
export const OAUTH_PROVIDERS = Object.freeze([
  Object.freeze({
    ...chatgptMetadata,
    kind: "chatgpt",
    flows: [...(chatgptMetadata.flows || ["browser", "device"])],
    apiStyle: "openai",
    tokenAuth: "post",
  }),
  Object.freeze({
    id: "gemini",
    name: "Gemini（Google）",
    description:
      "使用 Google 账号授权后调用 Gemini 文本模型；需部署方配置 Google Cloud OAuth 客户端。",
    region: GLOBAL,
    mainlandUnavailable: true,
    vision: true,
    flows: ["browser"],
    kind: "gemini",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    apiEndpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    scopes:
      "openid email profile https://www.googleapis.com/auth/cloud-platform",
    model: "gemini-2.5-flash",
    apiStyle: "openai",
    tokenAuth: "post",
  }),
  Object.freeze({
    ...workbuddyMetadata,
    kind: "workbuddy",
    flows: [...(workbuddyMetadata.flows || ["device"])],
    apiStyle: "openai",
    tokenAuth: "post",
  }),
]);

const PROVIDER_IDS = new Set(OAUTH_PROVIDERS.map((provider) => provider.id));

export function oauthProvider(id) {
  if (typeof id !== "string" || !PROVIDER_IDS.has(id)) return null;
  return OAUTH_PROVIDERS.find((provider) => provider.id === id) || null;
}

function envName(id, suffix) {
  return `OAUTH_${id.toUpperCase()}_${suffix}`;
}

function envValue(env, id, suffix) {
  const value = env?.[envName(id, suffix)];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function envFlag(env, id, suffix) {
  const value = envValue(env, id, suffix).toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function expiresAtFromSeconds(expiresIn, now = Date.now()) {
  const seconds = Number(expiresIn);
  return Number.isFinite(seconds) && seconds > 0
    ? now + Math.floor(seconds) * 1000
    : null;
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
 * Resolve a provider's runtime configuration.
 *
 * chatgpt/workbuddy need no deployment configuration (public clients); gemini
 * reports `configured:false` plus the environment variables still missing.
 * Never throws for unknown/unconfigured ids so routes can answer with an
 * actionable message.
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

  if (provider.kind === "chatgpt" || provider.kind === "workbuddy") {
    const disabled = envFlag(env, provider.id, "DISABLED");
    const model = envValue(env, provider.id, "MODEL") || provider.model || "";
    return {
      id: provider.id,
      provider,
      kind: provider.kind,
      configured: !disabled,
      disabled,
      envHint: [],
      model,
      region:
        provider.kind === "workbuddy" ? workbuddyRegion(env) : provider.region,
      vision: provider.vision,
      flows: provider.flows,
      redirectUri: provider.kind === "chatgpt" ? chatgptRedirectUri() : "",
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
  if (!clientSecret) envHint.push(envName(id, "CLIENT_SECRET"));
  const projectId = envValue(env, id, "PROJECT_ID");
  if (!projectId) envHint.push(envName(id, "PROJECT_ID"));
  if (
    !scopes
      .split(/\s+/)
      .includes("https://www.googleapis.com/auth/cloud-platform")
  )
    envHint.push(envName(id, "SCOPES"));
  if (!isHttpsUrl(authorizeUrl)) envHint.push(envName(id, "AUTHORIZE_URL"));
  if (!isHttpsUrl(tokenUrl)) envHint.push(envName(id, "TOKEN_URL"));
  if (!isHttpsUrl(apiEndpoint)) envHint.push(envName(id, "API_ENDPOINT"));

  return {
    id: provider.id,
    provider,
    kind: provider.kind,
    configured: envHint.length === 0,
    disabled: false,
    clientId,
    clientSecret,
    projectId,
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
    flows: provider.flows,
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
export function publicOAuthProviders(db, userId, env = process.env) {
  const connected = tokenRowsByProvider(db, userId);
  return OAUTH_PROVIDERS.map((provider) => {
    const config = configuredProvider(provider.id, env);
    const row = connected.get(provider.id);
    const isConnected = Boolean(row && row.status === "active");
    return {
      id: provider.id,
      name: provider.name,
      region: config.region || provider.region,
      mainlandUnavailable: provider.mainlandUnavailable,
      configured: config.configured,
      connected: isConnected,
      connectedAt: isConnected ? row.updated_at : null,
      description: provider.description,
      model: config.model || provider.model,
      vision: provider.vision,
      envHint: config.configured ? [] : config.envHint,
      flows: provider.flows,
      verification:
        provider.id === "gemini" ? "official-reference" : "experimental",
      setupHint:
        provider.id === "chatgpt"
          ? "Codex 兼容入口：复用 Codex 客户端，尚未实现本应用的官方 Sign in with ChatGPT 注册流程。浏览器登录要求与服务器同机；远程使用设备码，需有 Codex 权益。"
          : provider.id === "gemini"
            ? "部署方须配置 Google Web application OAuth 客户端、完整回调地址、配额项目，并启用 Gemini API；Google 登录不等于免费模型额度。"
            : "兼容连接：尚未找到官方公开的第三方授权协议，未完成真实账户端到端验证。",
      redirectUri:
        provider.id === "gemini"
          ? oauthRedirectUri(provider.id, env)
          : undefined,
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

export function oauthModel(provider, env = process.env) {
  const preset =
    typeof provider === "string" ? oauthProvider(provider) : provider;
  if (!preset) throw new Error("OAuth 提供方无效");
  const model = envValue(env, preset.id, "MODEL") || preset.model || "";
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

/** Pure: build a provider authorization URL (never contains client_secret). */
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
  if (preset.kind === "gemini") {
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
    response = await oauthFetch(
      config.tokenUrl,
      {
        method: "POST",
        headers,
        body,
        redirect: "error",
      },
      { request: doFetch },
    );
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
      invalidGrant: payload?.error === "invalid_grant",
      retryable: response.status === 429 || response.status >= 500,
    });
  return normalizeTokenPayload(payload);
}

/**
 * Exchange an authorization code for tokens (gemini/generic helper; the caller
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
  const tokens = await requestToken(
    config,
    {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    },
    fetchImpl,
  );
  if (
    preset.kind === "gemini" &&
    tokens.scope &&
    !tokens.scope
      .split(/\s+/)
      .includes("https://www.googleapis.com/auth/cloud-platform")
  )
    throw Object.assign(new Error("Google 未授予模型访问权限，请重新授权"), {
      code: "scope_missing",
    });
  return tokens;
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

// ---------------------------------------------------------------------------
// Encrypted connection storage
//
// The schema has a single `iv` column, so the refresh token's IV travels packed
// with its ciphertext in `encrypted_refresh` ("<base64>.<ivBase64>").
// ---------------------------------------------------------------------------

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

/** Parse the provider identity stored in `meta_json` (never throws). */
export function oauthConnectionMeta(connection) {
  if (!connection) return {};
  const raw = connection.meta_json;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
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

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function accountLabel(providerId, meta) {
  const identity = meta && typeof meta === "object" ? meta : {};
  if (providerId === "chatgpt")
    return cleanText(identity.email) || cleanText(identity.accountId);
  if (providerId === "workbuddy")
    return cleanText(identity.nickname) || cleanText(identity.uid);
  return "";
}

function writeConnectionMeta(meta) {
  const identity = meta && typeof meta === "object" ? { ...meta } : {};
  for (const key of Object.keys(identity))
    if (identity[key] === undefined) delete identity[key];
  return JSON.stringify(identity);
}

/**
 * Insert/replace the encrypted connection for (user, provider). `tokens` uses
 * the normalised camelCase shape; `meta` is the provider identity object that
 * lands in `meta_json` (never contains tokens).
 */
function writeOAuthConnection({
  db,
  encrypt,
  userId,
  providerId,
  tokens,
  meta = {},
  now = Date.now(),
}) {
  if (!db || typeof encrypt !== "function" || !userId)
    throw new Error("OAuth 存储不可用");
  if (!tokens || typeof tokens.accessToken !== "string" || !tokens.accessToken)
    throw new Error("OAuth 令牌无效");
  const [accessBody, accessIv] = encrypt(tokens.accessToken);
  const refreshPacked = tokens.refreshToken
    ? packEncrypted(encrypt(tokens.refreshToken))
    : null;
  const updatedAt = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO oauth_connections(
       id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,
       token_type,scope,expires_at,status,created_at,updated_at,meta_json)
     VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
     ON CONFLICT(user_id,provider) DO UPDATE SET
       account_label=excluded.account_label,
       encrypted_access=excluded.encrypted_access,
       encrypted_refresh=excluded.encrypted_refresh,
       iv=excluded.iv,
       token_type=excluded.token_type,
       scope=excluded.scope,
       expires_at=excluded.expires_at,
       status='active',
       updated_at=excluded.updated_at,
       meta_json=excluded.meta_json`,
  ).run(
    randomUUID(),
    userId,
    providerId,
    accountLabel(providerId, meta),
    accessBody,
    refreshPacked,
    accessIv,
    tokens.tokenType || "Bearer",
    tokens.scope || "",
    tokens.expiresAt ?? null,
    updatedAt,
    updatedAt,
    writeConnectionMeta(meta),
  );
}

function persistRefreshedTokens({
  db,
  encrypt,
  userId,
  providerId,
  accessToken,
  refreshToken,
  expiresAt,
  meta,
  metaPatch,
  now,
}) {
  if (!db || typeof encrypt !== "function" || !userId) return;
  try {
    const [accessBody, accessIv] = encrypt(accessToken);
    const refreshPacked = refreshToken
      ? packEncrypted(encrypt(refreshToken))
      : null;
    const nextMeta = { ...(meta || {}) };
    for (const [key, value] of Object.entries(metaPatch || {}))
      if (value !== undefined && value !== null) nextMeta[key] = value;
    db.prepare(
      `UPDATE oauth_connections SET
         encrypted_access=?, encrypted_refresh=COALESCE(?,encrypted_refresh),
         iv=?, expires_at=?, status='active', meta_json=?, updated_at=?
       WHERE user_id=? AND provider=?`,
    ).run(
      accessBody,
      refreshPacked,
      accessIv,
      expiresAt ?? null,
      writeConnectionMeta(nextMeta),
      new Date(now).toISOString(),
      userId,
      providerId,
    );
  } catch {
    // In-memory refresh still allows this call; the next call refreshes again.
  }
}

function markConnectionInvalid(db, userId, providerId, now = Date.now()) {
  if (!db || !userId) return;
  try {
    db.prepare(
      "UPDATE oauth_connections SET status='invalid', updated_at=? WHERE user_id=? AND provider=?",
    ).run(new Date(now).toISOString(), userId, providerId);
  } catch {
    // Best effort only; the user-facing error below still tells the user to reconnect.
  }
}

function oauthInvalidError() {
  return Object.assign(new Error("OAuth 授权已失效，请重新连接"), {
    code: "OAUTH_INVALID",
    status: 401,
  });
}

// ---------------------------------------------------------------------------
// In-memory attempt manager
// ---------------------------------------------------------------------------

const DEFAULT_OAUTH_TIMING = Object.freeze({
  geminiTtlMs: TEN_MINUTES,
  chatgptBrowserTtlMs: TEN_MINUTES,
  chatgptDeviceTtlMs: FIFTEEN_MINUTES,
  workbuddyTtlMs: TEN_MINUTES,
  // 0 means "use the interval advertised by the provider".
  chatgptPollIntervalMs: 0,
  workbuddyPollIntervalMs: 3000,
  chatgptCallbackPort: DEFAULT_CHATGPT_CALLBACK_PORT,
  chatgptCallbackHost: "127.0.0.1",
  expiredRetentionMs: 60 * 1000,
});

// Attempt stores created by registerOAuthRoutes; exported cleanup helper lets
// tests (and graceful shutdown) dispose timers and callback servers.
const activeStores = new Set();

export function clearOAuthAttempts() {
  for (const store of activeStores) {
    try {
      store.dispose();
    } catch {
      // Nothing actionable during teardown.
    }
  }
  activeStores.clear();
}

function createAttemptStore(timing) {
  const attempts = new Map();
  const byState = new Map();

  function clearTimer(attempt, key) {
    if (attempt[key]) {
      clearTimeout(attempt[key]);
      attempt[key] = null;
    }
  }

  function closeTransport(attempt) {
    clearTimer(attempt, "pollTimer");
    const server = attempt.httpServer;
    attempt.httpServer = null;
    if (server) {
      try {
        server.close(() => server.closeIdleConnections?.());
      } catch {
        // Already closed.
      }
    }
  }

  function removeAttempt(attempt) {
    if (!attempt || attempt.disposed) return;
    closeTransport(attempt);
    clearTimer(attempt, "expiryTimer");
    clearTimer(attempt, "removeTimer");
    attempt.disposed = true;
    if (attempt.state) byState.delete(attempt.state);
    attempts.delete(attempt.id);
  }

  function handleExpiry(attempt) {
    if (!attempt || attempt.disposed) return;
    attempt.expiryTimer = null;
    if (attempt.status === "pending") {
      attempt.status = "expired";
      attempt.message = "授权已超时，请重新发起";
      closeTransport(attempt);
      attempt.removeTimer = setTimeout(
        () => removeAttempt(attempt),
        positiveNumber(timing.expiredRetentionMs, 60 * 1000),
      );
      attempt.removeTimer.unref?.();
      return;
    }
    removeAttempt(attempt);
  }

  function create({ userId, provider, flow, ttlMs }) {
    const now = Date.now();
    const { verifier, challenge } = createPkcePair();
    const attempt = {
      id: randomBytes(18).toString("base64url"),
      userId,
      provider,
      flow,
      status: "pending",
      message: "",
      createdAt: now,
      expiresAt: now + positiveNumber(ttlMs, TEN_MINUTES),
      connectedAt: null,
      state: createState(),
      verifier,
      challenge,
      redirectUri: "",
      // chatgpt browser callback server
      httpServer: null,
      callbackPort: 0,
      callbackHandled: false,
      // device flow state
      deviceAuthId: "",
      deviceState: "",
      userCode: "",
      verificationUrl: "",
      region: "",
      intervalMs: 0,
      // timers
      expiryTimer: null,
      pollTimer: null,
      removeTimer: null,
      disposed: false,
    };
    attempts.set(attempt.id, attempt);
    byState.set(attempt.state, attempt.id);
    attempt.expiryTimer = setTimeout(
      () => handleExpiry(attempt),
      attempt.expiresAt - now,
    );
    attempt.expiryTimer.unref?.();
    return attempt;
  }

  function get(userId, provider, attemptId) {
    const attempt = attempts.get(String(attemptId || ""));
    if (!attempt || attempt.disposed) return null;
    if (attempt.userId !== userId || attempt.provider !== provider) return null;
    return attempt;
  }

  function findByState(state) {
    const id = byState.get(String(state || ""));
    if (!id) return null;
    const attempt = attempts.get(id);
    return attempt && !attempt.disposed ? attempt : null;
  }

  function consumeState(attempt) {
    if (!attempt) return;
    byState.delete(attempt.state);
  }

  function attach(attempt, fields) {
    if (!attempt || !fields) return;
    Object.assign(attempt, fields);
  }

  function markConnected(attempt, at = Date.now()) {
    if (!attempt || attempt.disposed) return;
    attempt.status = "connected";
    attempt.message = "";
    attempt.connectedAt = new Date(at).toISOString();
    closeTransport(attempt);
  }

  function markError(attempt, message) {
    if (!attempt || attempt.disposed) return;
    attempt.status = "error";
    attempt.message = message || "授权失败，请重试";
    closeTransport(attempt);
  }

  function removeForUser(userId, provider) {
    for (const attempt of [...attempts.values()])
      if (attempt.userId === userId && attempt.provider === provider)
        removeAttempt(attempt);
  }

  function dispose() {
    for (const attempt of [...attempts.values()]) removeAttempt(attempt);
    attempts.clear();
    byState.clear();
  }

  return {
    create,
    get,
    findByState,
    consumeState,
    attach,
    markConnected,
    markError,
    removeAttempt,
    removeForUser,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Provider token bundle normalisation
// ---------------------------------------------------------------------------

function tokenBundleFromChatgpt(bundle) {
  if (!bundle || typeof bundle.accessToken !== "string" || !bundle.accessToken)
    throw new Error("ChatGPT 授权未返回访问令牌");
  return {
    accessToken: bundle.accessToken,
    refreshToken:
      typeof bundle.refreshToken === "string" && bundle.refreshToken
        ? bundle.refreshToken
        : null,
    tokenType:
      typeof bundle.tokenType === "string" && bundle.tokenType
        ? bundle.tokenType
        : "Bearer",
    scope: typeof bundle.scope === "string" ? bundle.scope : "",
    expiresAt: positiveNumber(bundle.expiresAt, null),
    accountId: cleanText(bundle.accountId) || null,
    email: cleanText(bundle.email) || null,
  };
}

function tokenBundleFromGemini(payload) {
  if (
    !payload ||
    typeof payload.access_token !== "string" ||
    !payload.access_token
  )
    throw new Error("Gemini 授权未返回访问令牌");
  return {
    accessToken: payload.access_token,
    refreshToken:
      typeof payload.refresh_token === "string" && payload.refresh_token
        ? payload.refresh_token
        : null,
    tokenType:
      typeof payload.token_type === "string" && payload.token_type
        ? payload.token_type
        : "Bearer",
    scope: typeof payload.scope === "string" ? payload.scope : "",
    expiresAt: positiveNumber(payload.expiresAt, null),
  };
}

function authorizeUrlIsSafe(raw, allowedHosts = null) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (allowedHosts) {
      const host = url.hostname.toLowerCase();
      const allowed = allowedHosts.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      );
      if (!allowed) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function chineseErrorText(error, fallback) {
  const message =
    error && typeof error.message === "string" ? error.message.trim() : "";
  return /[\u4e00-\u9fa5]/.test(message) ? message : fallback;
}

function wrapProviderError(error) {
  if (
    error?.code === "OAUTH_INVALID" ||
    error?.status === 401 ||
    error?.status === 403
  )
    return oauthInvalidError();
  const wrapped = Object.assign(
    new Error(chineseErrorText(error, "OAuth 模型调用失败，请稍后重试")),
    { retryable: Boolean(error?.retryable) },
  );
  return wrapped;
}

// ---------------------------------------------------------------------------
// Model dispatch: oauthChatText keeps the signature index.mjs already uses.
// ---------------------------------------------------------------------------

/**
 * Call an OAuth-backed text model. `provider` is a catalogue row (or id),
 * `connection` a row from getOAuthConnection, `decrypt`/`encrypt` the ctx
 * helpers. Returns the raw model text; the caller parses it.
 *
 * Expired access tokens are refreshed per provider; when `db` + `encrypt` are
 * supplied the refreshed token and identity metadata are persisted.
 */
const pendingRefreshes = new WeakMap();
async function sharedRefresh(db, key, action) {
  if (!db) return action();
  let jobs = pendingRefreshes.get(db);
  if (!jobs) {
    jobs = new Map();
    pendingRefreshes.set(db, jobs);
  }
  if (jobs.has(key)) return jobs.get(key);
  const job = action();
  jobs.set(key, job);
  try {
    return await job;
  } finally {
    if (jobs.get(key) === job) jobs.delete(key);
  }
}

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
  if (!connection) throw oauthInvalidError();
  if (typeof decrypt !== "function") throw oauthInvalidError();

  if (db && user?.id) {
    connection = getOAuthConnection(db, user.id, preset.id);
    if (!connection || connection.status !== "active")
      throw oauthInvalidError();
  }
  let storedTokens;
  try {
    storedTokens = readOAuthTokens(connection, decrypt);
  } catch {
    throw oauthInvalidError();
  }
  let accessToken = storedTokens.accessToken;
  let refreshValue = storedTokens.refreshToken;
  let expiresAt = storedTokens.expiresAt;
  let meta = oauthConnectionMeta(connection);
  const imageList = Array.isArray(images) ? images : [];
  if (!accessToken) throw oauthInvalidError();

  if (expiresAt && expiresAt <= now + 30_000) {
    if (!refreshValue) {
      markConnectionInvalid(db, user?.id, preset.id, now);
      throw oauthInvalidError();
    }
    let refreshed;
    try {
      refreshed = await sharedRefresh(
        db,
        `${user?.id}:${preset.id}`,
        async () => {
          const result = await refreshConnectionTokens({
            preset,
            meta,
            accessToken,
            refreshValue,
            fetchImpl,
            now,
          });
          // Disconnect/reconnect while the refresh was pending must not resurrect
          // or replace the newly selected account's credentials.
          if (db && user?.id) {
            const current = getOAuthConnection(db, user.id, preset.id);
            if (
              !current ||
              current.encrypted_access !== connection.encrypted_access
            )
              throw oauthInvalidError();
          }
          persistRefreshedTokens({
            db,
            encrypt,
            userId: user?.id,
            providerId: preset.id,
            accessToken: result.tokens.accessToken,
            refreshToken: result.tokens.refreshToken,
            expiresAt: result.tokens.expiresAt,
            meta,
            metaPatch: result.metaPatch,
            now,
          });
          return result;
        },
      );
    } catch (error) {
      if (error?.retryable)
        throw Object.assign(new Error("OAuth 令牌刷新暂时失败，请稍后重试"), {
          status: 503,
          retryable: true,
        });
      if (db && user?.id) {
        const current = getOAuthConnection(db, user.id, preset.id);
        if (
          !current ||
          current.encrypted_access !== connection.encrypted_access
        )
          throw Object.assign(new Error("OAuth 连接已更改，请重试"), {
            status: 409,
          });
      }
      if (error?.invalidGrant || error?.code === "OAUTH_INVALID") {
        markConnectionInvalid(db, user?.id, preset.id, now);
        throw oauthInvalidError();
      }
      throw Object.assign(
        new Error("OAuth 令牌刷新失败，请检查部署配置或重新授权"),
        { status: 502, retryable: false },
      );
    }
    accessToken = refreshed.tokens.accessToken;
    refreshValue = refreshed.tokens.refreshToken || refreshValue;
    expiresAt = refreshed.tokens.expiresAt;
    meta = {
      ...meta,
      ...Object.fromEntries(
        Object.entries(refreshed.metaPatch || {}).filter(
          ([, value]) => value != null,
        ),
      ),
    };
  }

  const promptText = String(prompt ?? "");
  if (imageList.length && !preset.vision)
    throw new Error("该 OAuth 模型暂不支持图片识别");

  if (preset.kind === "gemini")
    return callGeminiChat({
      preset,
      accessToken,
      promptText,
      imageList,
      model,
      signal,
      fetchImpl,
    });

  const messages = [{ role: "user", content: promptText }];
  try {
    if (preset.kind === "chatgpt") {
      const text = await chatgptChat({
        accessToken,
        accountId: cleanText(meta.accountId) || null,
        model: model || oauthModel(preset),
        messages,
        maxTokens: 4096,
        fetchImpl: fetchImpl || undefined,
        signal: signal || undefined,
      });
      return requireChatText(text);
    }
    if (preset.kind === "workbuddy") {
      const text = await workbuddyChat({
        credential: {
          accessToken,
          refreshToken: refreshValue,
          uid: cleanText(meta.uid) || null,
          enterpriseId: cleanText(meta.enterpriseId) || null,
          domain: cleanText(meta.domain) || null,
          region: cleanText(meta.region) || workbuddyRegion(process.env),
        },
        model: model || oauthModel(preset),
        messages,
        fetchImpl: fetchImpl || undefined,
        signal,
      });
      return requireChatText(text);
    }
  } catch (error) {
    throw wrapProviderError(error);
  }
  throw new Error("该 OAuth 提供方暂不支持文本模型调用");
}

export const oauthChat = oauthChatText;

async function refreshConnectionTokens({
  preset,
  meta,
  accessToken,
  refreshValue,
  fetchImpl,
  now,
}) {
  if (preset.kind === "chatgpt") {
    const bundle = tokenBundleFromChatgpt(
      await chatgptRefresh({
        refreshToken: refreshValue,
        fetchImpl: fetchImpl || undefined,
      }),
    );
    return {
      tokens: bundle,
      metaPatch: { accountId: bundle.accountId, email: bundle.email },
    };
  }
  if (preset.kind === "workbuddy") {
    const refreshed = await workbuddyRefresh({
      credential: {
        accessToken,
        refreshToken: refreshValue,
        uid: cleanText(meta.uid) || null,
        enterpriseId: cleanText(meta.enterpriseId) || null,
        domain: cleanText(meta.domain) || null,
        region: cleanText(meta.region) || workbuddyRegion(process.env),
      },
      fetchImpl: fetchImpl || undefined,
    });
    const access = cleanText(refreshed?.accessToken);
    if (!access) throw new Error("WorkBuddy 刷新令牌失败");
    return {
      tokens: {
        accessToken: access,
        refreshToken: cleanText(refreshed.refreshToken) || refreshValue,
        tokenType: "Bearer",
        scope: "",
        expiresAt: expiresAtFromSeconds(refreshed.expiresIn, now),
      },
      metaPatch: { domain: cleanText(refreshed.domain) || undefined },
    };
  }
  const config = configuredProvider("gemini");
  if (!config.configured) throw new Error("Gemini 尚未配置");
  const payload = await refreshToken({
    provider: preset,
    config,
    refreshToken: refreshValue,
    fetchImpl,
  });
  return { tokens: tokenBundleFromGemini(payload), metaPatch: {} };
}

function requireChatText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error("模型没有返回识别内容");
  return text;
}

async function callGeminiChat({
  preset,
  accessToken,
  promptText,
  imageList,
  model,
  signal,
  fetchImpl,
}) {
  const endpoint = oauthEndpoint(preset.id);
  const config = configuredProvider(preset.id);
  if (!config.configured)
    throw new Error("Gemini OAuth 尚未配置完整，请联系部署管理员");
  const doFetch = fetchImpl || globalThis.fetch;
  if (!fetchImpl) {
    try {
      await assertPublicProviderEndpoint(endpoint);
    } catch {
      throw new Error("模型接口不得指向内网或保留地址");
    }
  }
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
  const body = {
    model: model || oauthModel(preset),
    temperature: 0,
    response_format: { type: "json_object" },
    stream: false,
    max_tokens: Math.min(
      Number(process.env.MODEL_MAX_OUTPUT_TOKENS) || 8192,
      32768,
    ),
    messages: [
      { role: "user", content: imageList.length ? content : promptText },
    ],
  };
  let response;
  try {
    const signals = [AbortSignal.timeout(60000)];
    if (signal) signals.push(signal);
    response = await oauthFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          "x-goog-user-project": config.projectId,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.any(signals),
      },
      { request: doFetch, ...modelResponseLimits() },
    );
  } catch {
    throw Object.assign(new Error("OAuth 模型接口连接失败，请稍后重试"), {
      retryable: true,
    });
  }
  if (response.status === 401) throw oauthInvalidError();
  if (response.status === 403)
    throw new Error(
      "Gemini 权限不足：请重新授权模型访问 scope，并检查配额项目、Gemini API 启用状态和账单权限",
    );
  if (!response.ok) throw providerHttpError(response.status, null);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("模型返回内容格式无效");
  }
  assertProviderCompletion({ provider: "gemini" }, payload);
  const text =
    typeof payload?.choices?.[0]?.message?.content === "string"
      ? payload.choices[0].message.content
      : "";
  if (!text) throw new Error("模型没有返回识别内容");
  return text;
}

// ---------------------------------------------------------------------------
// Browser callback helpers (chatgpt: temporary 127.0.0.1:1455 server)
// ---------------------------------------------------------------------------

function htmlPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f1117;color:#f5f6fa;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><main style="max-width:520px;padding:32px;text-align:center"><h2 style="font-size:20px;margin:0 0 12px">${title}</h2><p style="font-size:14px;line-height:1.7;color:#aab1c3;margin:0">${detail}</p></main></body></html>`;
}

function respondHtml(res, status, title, detail) {
  const body = htmlPage(title, detail);
  try {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  } catch {
    // The browser may already have gone away.
  }
}

function chatgptCallbackRedirectUri(port) {
  return `http://localhost:${port}/auth/callback`;
}

async function startChatgptCallbackServer({ attempt, timing }) {
  const port = positiveNumber(
    timing.chatgptCallbackPort,
    DEFAULT_CHATGPT_CALLBACK_PORT,
  );
  const host = timing.chatgptCallbackHost || "127.0.0.1";
  attempt.redirectUri = chatgptCallbackRedirectUri(port);
  const server = http.createServer((req, res) => {
    void handleChatgptCallback({ attempt, req, res });
  });
  attempt.httpServer = server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      attempt.callbackPort =
        address && typeof address === "object" ? address.port : port;
      resolve();
    });
  });
  return attempt.callbackPort;
}

async function handleChatgptCallback({ attempt, req, res }) {
  let url;
  try {
    url = new URL(String(req.url || "/"), "http://localhost");
  } catch {
    return respondHtml(res, 400, "请求无效", "无法识别授权回调。");
  }
  if (req.method !== "GET" || url.pathname !== "/auth/callback")
    return respondHtml(res, 404, "页面不存在", "该地址不是 ChatGPT 授权回调。");
  if (attempt.status !== "pending") {
    return respondHtml(
      res,
      409,
      "授权请求已处理",
      "该授权请求已完成或已失效，请回到应用查看连接状态。",
    );
  }
  const state = url.searchParams.get("state") || "";
  if (!attempt.state || state !== attempt.state) {
    return respondHtml(
      res,
      400,
      "授权校验失败",
      "state 校验未通过，请回到应用重新发起 ChatGPT 授权。",
    );
  }
  if (attempt.callbackHandled) {
    return respondHtml(
      res,
      409,
      "授权请求已处理",
      "该授权回调已经处理过，请回到应用查看连接状态。",
    );
  }
  attempt.callbackHandled = true;
  if (url.searchParams.get("error")) {
    attempt.services?.store?.markError(attempt, "已取消 ChatGPT 授权");
    return respondHtml(
      res,
      200,
      "已取消授权",
      "未完成 ChatGPT 授权，可关闭此页面回到应用重试。",
    );
  }
  const code = url.searchParams.get("code") || "";
  if (!code) {
    attempt.services?.store?.markError(attempt, "授权回调缺少授权码");
    return respondHtml(
      res,
      400,
      "授权未完成",
      "授权回调缺少授权码，请回到应用重新发起。",
    );
  }
  try {
    const started = tokenBundleFromChatgpt(
      await chatgptExchangeCode({
        code,
        codeVerifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
        fetchImpl: attempt.fetchImpl || undefined,
      }),
    );
    if (attempt.disposed || attempt.status !== "pending")
      return respondHtml(res, 409, "授权已取消", "请回到应用重新发起授权。");
    writeOAuthConnection({
      db: attempt.services.db,
      encrypt: attempt.services.encrypt,
      userId: attempt.userId,
      providerId: "chatgpt",
      tokens: started,
      meta: {
        accountId: started.accountId || null,
        email: started.email || null,
        flow: "browser",
      },
      now: Date.now(),
    });
    attempt.services.store.markConnected(attempt);
    return respondHtml(
      res,
      200,
      "ChatGPT 授权完成",
      "授权已完成，可以关闭此页面回到应用查看连接状态。",
    );
  } catch {
    attempt.services.store.markError(
      attempt,
      "ChatGPT 授权失败，请重新发起或改用设备码登录",
    );
    return respondHtml(
      res,
      400,
      "授权未完成",
      "授权交换失败，请关闭此页面回到应用重试。",
    );
  }
}

// ---------------------------------------------------------------------------
// Background device polling
// ---------------------------------------------------------------------------

function startChatgptDevicePolling({ attempt, services }) {
  const schedule = () => {
    if (attempt.status !== "pending" || attempt.disposed) return;
    attempt.pollTimer = setTimeout(() => {
      void run();
    }, attempt.intervalMs);
    attempt.pollTimer.unref?.();
  };
  const run = async () => {
    attempt.pollTimer = null;
    if (attempt.status !== "pending" || attempt.disposed) return;
    try {
      const result = await chatgptDevicePoll({
        deviceAuthId: attempt.deviceAuthId,
        userCode: attempt.userCode,
        fetchImpl: services.fetchImpl || undefined,
      });
      if (attempt.status !== "pending" || attempt.disposed) return;
      if (result && result.pending) {
        schedule();
        return;
      }
      const grant = result?.grant;
      if (!grant) throw new Error("设备码授权返回数据无效");
      const bundle = tokenBundleFromChatgpt(
        await chatgptDeviceExchange({
          grant,
          fetchImpl: services.fetchImpl || undefined,
        }),
      );
      if (attempt.status !== "pending" || attempt.disposed) return;
      writeOAuthConnection({
        db: services.db,
        encrypt: services.encrypt,
        userId: attempt.userId,
        providerId: "chatgpt",
        tokens: bundle,
        meta: {
          accountId: bundle.accountId || null,
          email: bundle.email || null,
          flow: attempt.flow || "device",
        },
        now: Date.now(),
      });
      services.store.markConnected(attempt);
    } catch (error) {
      if (
        error?.retryable &&
        attempt.status === "pending" &&
        !attempt.disposed
      ) {
        schedule();
        return;
      }
      services.store.markError(
        attempt,
        "ChatGPT 设备码登录失败，请重新发起或改用浏览器授权",
      );
    }
  };
  schedule();
}

function startWorkbuddyDevicePolling({ attempt, services, timing }) {
  const intervalMs = positiveNumber(timing.workbuddyPollIntervalMs, 3000);
  const schedule = () => {
    if (attempt.status !== "pending" || attempt.disposed) return;
    attempt.pollTimer = setTimeout(() => {
      void run();
    }, intervalMs);
    attempt.pollTimer.unref?.();
  };
  const run = async () => {
    attempt.pollTimer = null;
    if (attempt.status !== "pending" || attempt.disposed) return;
    try {
      const result = await workbuddyPoll({
        state: attempt.deviceState,
        region: attempt.region,
        fetchImpl: services.fetchImpl || undefined,
      });
      if (attempt.status !== "pending" || attempt.disposed) return;
      if (result && result.pending) {
        schedule();
        return;
      }
      const token = result?.token;
      if (!token || !cleanText(token.accessToken))
        throw new Error("WorkBuddy 授权返回数据无效");
      const account = await workbuddyAccount({
        state: attempt.deviceState,
        accessToken: token.accessToken,
        region: attempt.region,
        fetchImpl: services.fetchImpl || undefined,
      });
      if (attempt.status !== "pending" || attempt.disposed) return;
      writeOAuthConnection({
        db: services.db,
        encrypt: services.encrypt,
        userId: attempt.userId,
        providerId: "workbuddy",
        tokens: {
          accessToken: token.accessToken,
          refreshToken: cleanText(token.refreshToken) || null,
          tokenType: "Bearer",
          scope: "",
          expiresAt: expiresAtFromSeconds(token.expiresIn, Date.now()),
        },
        meta: {
          uid: cleanText(account?.uid) || null,
          enterpriseId: cleanText(account?.enterpriseId) || null,
          domain: cleanText(token.domain) || null,
          region: attempt.region,
          nickname: cleanText(account?.nickname) || null,
          flow: attempt.flow || "device",
        },
        now: Date.now(),
      });
      services.store.markConnected(attempt);
    } catch {
      services.store.markError(attempt, "WorkBuddy 登录失败，请重新发起授权");
    }
  };
  schedule();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function oauthRedirect(res, providerId, status, reason) {
  const params = new URLSearchParams();
  if (providerId) params.set("oauth_provider", providerId);
  params.set("oauth_status", status);
  if (reason) params.set("oauth_reason", reason);
  // Always a same-origin relative Location: user input never becomes a target.
  res.redirect(302, `/?${params.toString()}`);
}

function attemptPayload(attempt) {
  const payload = { status: attempt.status, provider: attempt.provider };
  if (attempt.status === "connected" && attempt.connectedAt)
    payload.connectedAt = attempt.connectedAt;
  if (attempt.status === "error" || attempt.status === "expired")
    payload.message = attempt.message || "授权未完成，请重新发起";
  return payload;
}

function chatgptPortBusyMessage(port) {
  return `ChatGPT 浏览器授权需要占用本机 ${port} 端口，但该端口已被占用。请关闭占用该端口的程序后重试，或改用设备码授权。`;
}

function normalizeWorkbuddyRegion(value) {
  return value === "cn" || value === "global" ? value : null;
}

export function registerOAuthRoutes(app, ctx) {
  const { db, auth, encrypt } = ctx;
  const fetchImpl = typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : null;
  const timing = { ...DEFAULT_OAUTH_TIMING, ...(ctx.oauthTiming || {}) };
  const store = createAttemptStore(timing);
  activeStores.add(store);
  const services = { db, encrypt, fetchImpl, store, timing };

  function fail(res, status, message) {
    return res.status(status).json({ error: message });
  }

  function resolvePreset(req, res) {
    const preset = oauthProvider(req.params.provider);
    if (!preset) {
      fail(res, 404, "OAuth 提供方无效或已移除");
      return null;
    }
    return preset;
  }

  function guardPermission(req, res) {
    if (canConfigureOwnModel(db, req.user)) return true;
    fail(res, 403, modelConfigDeniedMessage(db, req.user));
    return false;
  }

  function resolveConfiguredConfig(res, preset) {
    const config = configuredProvider(preset.id);
    if (config.configured) return config;
    const hint = config.envHint.length
      ? `请联系部署管理员设置环境变量：${config.envHint.join("、")}`
      : "请联系部署管理员检查该 OAuth 提供方的配置";
    fail(res, 400, `${preset.name} 尚未配置，${hint}`);
    return null;
  }

  function startGeminiBrowser(req, preset, config) {
    const attempt = store.create({
      userId: req.user.id,
      provider: "gemini",
      flow: "browser",
      ttlMs: timing.geminiTtlMs,
    });
    attempt.redirectUri = oauthRedirectUri("gemini");
    try {
      const url = buildAuthorizeUrl({
        provider: preset,
        config,
        state: attempt.state,
        challenge: attempt.challenge,
        redirectUri: attempt.redirectUri,
      });
      return { attempt, url };
    } catch (error) {
      store.removeAttempt(attempt);
      throw error;
    }
  }

  async function startChatgptBrowser(req, res) {
    store.removeForUser(req.user.id, "chatgpt");
    const attempt = store.create({
      userId: req.user.id,
      provider: "chatgpt",
      flow: "browser",
      ttlMs: timing.chatgptBrowserTtlMs,
    });
    attempt.fetchImpl = fetchImpl;
    attempt.services = services;
    try {
      await startChatgptCallbackServer({ attempt, timing });
    } catch {
      store.removeAttempt(attempt);
      fail(res, 409, chatgptPortBusyMessage(timing.chatgptCallbackPort));
      return null;
    }
    let url;
    try {
      const raw = await chatgptAuthorizeUrl({
        state: attempt.state,
        codeChallenge: attempt.challenge,
        redirectUri: attempt.redirectUri,
      });
      if (
        !authorizeUrlIsSafe(raw, ["openai.com", "chatgpt.com", "oaistatic.com"])
      )
        throw new Error("授权链接域名不在允许范围内");
      url = String(raw);
    } catch {
      store.removeAttempt(attempt);
      fail(res, 502, "ChatGPT 授权链接生成失败，请稍后重试或改用设备码授权");
      return null;
    }
    return { attempt, url };
  }

  app.get("/api/oauth/providers", auth, (req, res) => {
    res.json({
      providers: publicOAuthProviders(db, req.user.id),
      authMode: req.user.model_auth_mode === "oauth" ? "oauth" : "api_key",
      provider: req.user.oauth_provider || null,
    });
  });

  app.post("/api/oauth/:provider/browser/start", auth, async (req, res) => {
    try {
      const preset = resolvePreset(req, res);
      if (!preset) return undefined;
      if (!guardPermission(req, res)) return undefined;
      if (preset.kind === "workbuddy") {
        // WorkBuddy 的「浏览器登录」与「设备码登录」走同一套官方
        // state -> 授权页 -> 轮询换取令牌流程；浏览器登录直接打开授权页，
        // 服务端在后台轮询，完成后写连接。
        const region =
          normalizeWorkbuddyRegion(req.body?.region) ||
          workbuddyRegion(process.env);
        let started;
        try {
          started = await workbuddyStart({
            region,
            fetchImpl: fetchImpl || undefined,
          });
        } catch {
          return fail(res, 502, "WorkBuddy 授权发起失败，请稍后重试");
        }
        const deviceState = cleanText(started?.state);
        const verificationUrl = cleanText(started?.authUrl);
        if (!deviceState || !verificationUrl)
          return fail(res, 502, "WorkBuddy 授权返回数据不完整，请稍后重试");
        if (!authorizeUrlIsSafe(verificationUrl))
          return fail(res, 502, "WorkBuddy 授权链接无效，请稍后重试");
        const attempt = store.create({
          userId: req.user.id,
          provider: "workbuddy",
          flow: "browser",
          ttlMs: timing.workbuddyTtlMs,
        });
        store.attach(attempt, {
          deviceState,
          region,
          verificationUrl,
          intervalMs: positiveNumber(timing.workbuddyPollIntervalMs, 3000),
        });
        attempt.fetchImpl = fetchImpl;
        attempt.services = services;
        startWorkbuddyDevicePolling({ attempt, services, timing });
        return res.json({
          attemptId: attempt.id,
          mode: "browser",
          url: verificationUrl,
          verificationUrl,
          region,
        });
      }
      const config = resolveConfiguredConfig(res, preset);
      if (!config) return undefined;
      if (preset.kind === "gemini") {
        let started;
        try {
          started = startGeminiBrowser(req, preset, config);
        } catch {
          return fail(
            res,
            400,
            "Gemini 授权链接生成失败，请检查 OAUTH_GEMINI_* 环境变量配置",
          );
        }
        return res.json({
          attemptId: started.attempt.id,
          mode: "browser",
          url: started.url,
        });
      }
      const started = await startChatgptBrowser(req, res);
      if (!started) return undefined;
      return res.json({
        attemptId: started.attempt.id,
        mode: "browser",
        url: started.url,
      });
    } catch {
      return fail(res, 500, "OAuth 授权发起失败，请稍后重试");
    }
  });

  app.post("/api/oauth/:provider/device/start", auth, async (req, res) => {
    try {
      const preset = resolvePreset(req, res);
      if (!preset) return undefined;
      if (!guardPermission(req, res)) return undefined;
      if (preset.kind === "gemini")
        return fail(res, 400, "Gemini 仅支持浏览器授权，请使用浏览器授权连接");
      const config = resolveConfiguredConfig(res, preset);
      if (!config) return undefined;

      if (preset.kind === "chatgpt") {
        let started;
        try {
          started = await chatgptDeviceStart({
            fetchImpl: fetchImpl || undefined,
          });
        } catch {
          return fail(
            res,
            502,
            "ChatGPT 设备码授权发起失败，请稍后重试，或改用浏览器授权",
          );
        }
        const deviceAuthId = cleanText(started?.deviceAuthId);
        const userCode = cleanText(started?.userCode);
        const verificationUrl = cleanText(started?.verificationUrl);
        const intervalMs = positiveNumber(
          timing.chatgptPollIntervalMs,
          positiveNumber(started?.intervalMs, 5000),
        );
        if (!deviceAuthId || !userCode || !verificationUrl)
          return fail(res, 502, "ChatGPT 设备码授权返回数据不完整，请稍后重试");
        if (!authorizeUrlIsSafe(verificationUrl, ["openai.com", "chatgpt.com"]))
          return fail(res, 502, "ChatGPT 设备码授权链接无效，请稍后重试");
        const attempt = store.create({
          userId: req.user.id,
          provider: "chatgpt",
          flow: "device",
          ttlMs: timing.chatgptDeviceTtlMs,
        });
        store.attach(attempt, {
          deviceAuthId,
          userCode,
          verificationUrl,
          intervalMs,
          region: "global",
        });
        continueChatgptDevicePolling(attempt);
        return res.json({
          attemptId: attempt.id,
          mode: "device",
          verificationUrl,
          userCode,
          intervalMs,
        });
      }

      const region =
        normalizeWorkbuddyRegion(req.body?.region) ||
        workbuddyRegion(process.env);
      let started;
      try {
        started = await workbuddyStart({
          region,
          fetchImpl: fetchImpl || undefined,
        });
      } catch {
        return fail(res, 502, "WorkBuddy 授权发起失败，请稍后重试");
      }
      const deviceState = cleanText(started?.state);
      const verificationUrl = cleanText(started?.authUrl);
      if (!deviceState || !verificationUrl)
        return fail(res, 502, "WorkBuddy 授权返回数据不完整，请稍后重试");
      if (!authorizeUrlIsSafe(verificationUrl))
        return fail(res, 502, "WorkBuddy 授权链接无效，请稍后重试");
      const attempt = store.create({
        userId: req.user.id,
        provider: "workbuddy",
        flow: "device",
        ttlMs: timing.workbuddyTtlMs,
      });
      store.attach(attempt, {
        deviceState,
        region,
        verificationUrl,
        intervalMs: positiveNumber(timing.workbuddyPollIntervalMs, 3000),
      });
      continueWorkbuddyDevicePolling(attempt);
      return res.json({
        attemptId: attempt.id,
        mode: "device",
        verificationUrl,
        region,
      });
    } catch {
      return fail(res, 500, "OAuth 授权发起失败，请稍后重试");
    }

    function continueChatgptDevicePolling(attempt) {
      attempt.fetchImpl = fetchImpl;
      attempt.services = services;
      startChatgptDevicePolling({ attempt, services });
    }

    function continueWorkbuddyDevicePolling(attempt) {
      attempt.fetchImpl = fetchImpl;
      attempt.services = services;
      startWorkbuddyDevicePolling({ attempt, services, timing });
    }
  });

  app.get("/api/oauth/:provider/attempt/:attemptId", auth, (req, res) => {
    const preset = resolvePreset(req, res);
    if (!preset) return undefined;
    const attempt = store.get(
      req.user.id,
      preset.id,
      String(req.params.attemptId || ""),
    );
    if (!attempt)
      return fail(res, 404, "OAuth 授权请求不存在或已过期，请重新发起");
    return res.json(attemptPayload(attempt));
  });

  app.delete("/api/oauth/:provider/attempt/:attemptId", auth, (req, res) => {
    const preset = resolvePreset(req, res);
    if (!preset) return;
    const attempt = store.get(req.user.id, preset.id, req.params.attemptId);
    if (!attempt) return fail(res, 404, "OAuth 授权请求不存在或已过期");
    store.removeAttempt(attempt);
    res.json({ ok: true });
  });

  app.post("/api/oauth/:provider/disconnect", auth, (req, res) => {
    const preset = resolvePreset(req, res);
    if (!preset) return undefined;
    db.prepare(
      "DELETE FROM oauth_connections WHERE user_id=? AND provider=?",
    ).run(req.user.id, preset.id);
    db.prepare(
      `UPDATE users SET model_auth_mode='api_key', oauth_provider=NULL
       WHERE id=? AND model_auth_mode='oauth' AND oauth_provider=?`,
    ).run(req.user.id, preset.id);
    store.removeForUser(req.user.id, preset.id);
    res.json({ ok: true });
  });

  // Compatibility: the legacy start/callback pair. Gemini keeps returning a
  // browser URL (plus the old `authorizeUrl` alias for updates in flight);
  // chatgpt maps to browser/start; workbuddy must use device/start.
  app.post("/api/oauth/:provider/start", auth, async (req, res) => {
    try {
      const preset = resolvePreset(req, res);
      if (!preset) return undefined;
      if (preset.kind === "workbuddy")
        return fail(
          res,
          409,
          "WorkBuddy 仅支持设备码授权，请使用 device/start",
        );
      if (!guardPermission(req, res)) return undefined;
      const config = resolveConfiguredConfig(res, preset);
      if (!config) return undefined;
      if (preset.kind === "gemini") {
        let started;
        try {
          started = startGeminiBrowser(req, preset, config);
        } catch {
          return fail(
            res,
            400,
            "Gemini 授权链接生成失败，请检查 OAUTH_GEMINI_* 环境变量配置",
          );
        }
        return res.json({
          url: started.url,
          authorizeUrl: started.url,
        });
      }
      const started = await startChatgptBrowser(req, res);
      if (!started) return undefined;
      return res.json({
        url: started.url,
        authorizeUrl: started.url,
        attemptId: started.attempt.id,
        mode: "browser",
      });
    } catch {
      return fail(res, 500, "OAuth 授权发起失败，请稍后重试");
    }
  });

  app.get("/api/oauth/:provider/callback", auth, async (req, res) => {
    const preset = oauthProvider(req.params.provider);
    if (!preset || preset.kind !== "gemini")
      return fail(res, 404, "OAuth 提供方无效或已移除");
    if (!canConfigureOwnModel(db, req.user))
      return oauthRedirect(res, "gemini", "error", "state_invalid");
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const attempt = state ? store.findByState(state) : null;
    const valid =
      attempt &&
      attempt.provider === "gemini" &&
      attempt.userId === req.user.id &&
      attempt.status === "pending" &&
      Date.now() < attempt.expiresAt;
    if (!valid) return oauthRedirect(res, "gemini", "error", "state_invalid");
    store.consumeState(attempt);
    if (req.query.error) {
      store.markError(attempt, "已取消 Gemini 授权");
      return oauthRedirect(res, "gemini", "denied");
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) {
      store.markError(attempt, "授权回调缺少授权码");
      return oauthRedirect(res, "gemini", "error", "exchange_failed");
    }
    const config = configuredProvider("gemini");
    if (!config.configured) {
      store.markError(attempt, "Gemini 尚未配置");
      return oauthRedirect(res, "gemini", "error", "provider_unconfigured");
    }
    try {
      const payload = await exchangeCode({
        provider: preset,
        config,
        code,
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
        fetchImpl: fetchImpl || undefined,
      });
      if (attempt.disposed || attempt.status !== "pending")
        return oauthRedirect(res, "gemini", "error", "state_invalid");
      writeOAuthConnection({
        db,
        encrypt,
        userId: req.user.id,
        providerId: "gemini",
        tokens: tokenBundleFromGemini(payload),
        meta: {},
        now: Date.now(),
      });
      store.markConnected(attempt);
      return oauthRedirect(res, "gemini", "connected");
    } catch {
      store.markError(attempt, "Gemini 授权失败，请重新发起");
      return oauthRedirect(res, "gemini", "error", "exchange_failed");
    }
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

  return store;
}
