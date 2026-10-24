import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { once } from "node:events";
import fs from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import {
  OAUTH_PROVIDERS,
  buildAuthorizeUrl,
  codeChallenge,
  configuredProvider,
  createPkcePair,
  exchangeCode,
  getOAuthConnection,
  oauthChat,
  oauthChatText,
  oauthEndpoint,
  oauthProvider,
  oauthRedirectUri,
  packEncrypted,
  publicOAuthProviders,
  readOAuthTokens,
  refreshToken,
  registerOAuthRoutes,
  unpackEncrypted,
} from "./oauth.mjs";

const SCHEMA = fs.readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-10-24T00:00:00.000Z";
const ENCRYPT_SECRET = createHash("sha256")
  .update("oauth-test-only-secret")
  .digest();

function encrypt(text) {
  const iv = Buffer.from("0123456789ab", "utf8");
  const cipher = createCipheriv("aes-256-gcm", ENCRYPT_SECRET, iv);
  const body = Buffer.concat([
    cipher.update(String(text)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [body.toString("base64"), iv.toString("base64")];
}

function decrypt(body, iv) {
  const buffer = Buffer.from(body, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    ENCRYPT_SECRET,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(buffer.subarray(-16));
  return Buffer.concat([
    decipher.update(buffer.subarray(0, -16)),
    decipher.final(),
  ]).toString();
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function insertUser(db, user) {
  db.prepare(
    `INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin,review_mode,model_auth_mode,oauth_provider)
     VALUES(?,?,?,?,NULL,NULL,'hash','salt','初中',NULL,?,?,?, 'all',?,?)`,
  ).run(
    user.id,
    user.schoolId || "s1",
    user.role,
    user.name,
    user.className || null,
    NOW,
    user.isSchoolAdmin ? 1 : 0,
    user.authMode || "api_key",
    user.oauthProvider || null,
  );
}

function seedUsers(db) {
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run("s1", "示例中学", NOW);
  insertUser(db, {
    id: "admin1",
    role: "teacher",
    name: "学校管理员",
    isSchoolAdmin: true,
  });
  insertUser(db, { id: "t1", role: "teacher", name: "张老师" });
  insertUser(db, { id: "t2", role: "teacher", name: "李老师" });
  insertUser(db, {
    id: "st1",
    role: "student",
    name: "学生甲",
    className: "初一(1)班",
  });
}

function setSchoolMode(db, mode) {
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES('s1',?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode",
  ).run(mode, NOW);
}

function user(db, id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

function insertConnection(
  db,
  userId,
  provider,
  { access = "access-token", refresh = null, expiresAt = null } = {},
) {
  const [accessBody, accessIv] = encrypt(access);
  const refreshPacked = refresh ? packEncrypted(encrypt(refresh)) : null;
  db.prepare(
    `INSERT INTO oauth_connections(id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,token_type,scope,expires_at,status,created_at,updated_at)
     VALUES(?,?,?,'',?,?,?,'Bearer','',?,'active',?,?)
     ON CONFLICT(user_id,provider) DO UPDATE SET
       encrypted_access=excluded.encrypted_access, encrypted_refresh=excluded.encrypted_refresh,
       iv=excluded.iv, expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
  ).run(
    randomUUID(),
    userId,
    provider,
    accessBody,
    refreshPacked,
    accessIv,
    expiresAt,
    NOW,
    NOW,
  );
}

// Baseline deployment configuration used by most tests. The explicit-env tests
// below pass their own env object so they do not depend on this.
const ENV_NAMES = [
  "OAUTH_CHATGPT_CLIENT_ID",
  "OAUTH_CHATGPT_CLIENT_SECRET",
  "OAUTH_DEEPSEEK_CLIENT_ID",
  "OAUTH_DEEPSEEK_AUTHORIZE_URL",
  "OAUTH_DEEPSEEK_TOKEN_URL",
  "OAUTH_REDIRECT_BASE",
];
const savedEnv = {};
beforeEach(() => {
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  process.env.OAUTH_CHATGPT_CLIENT_ID = "chatgpt-client-id";
  process.env.OAUTH_CHATGPT_CLIENT_SECRET = "chatgpt-client-secret";
  process.env.OAUTH_DEEPSEEK_CLIENT_ID = "deepseek-client-id";
  process.env.OAUTH_DEEPSEEK_AUTHORIZE_URL =
    "https://auth.deepseek.test/authorize";
  process.env.OAUTH_DEEPSEEK_TOKEN_URL = "https://auth.deepseek.test/token";
  delete process.env.OAUTH_REDIRECT_BASE;
});
afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("OAuth provider catalogue", () => {
  it("contains the seven documented providers and regions", () => {
    expect(OAUTH_PROVIDERS.map((provider) => provider.id)).toEqual([
      "chatgpt",
      "claude",
      "gemini",
      "workbuddy",
      "qwen",
      "qianwen",
      "deepseek",
    ]);
    const mainlandUnavailable = OAUTH_PROVIDERS.filter(
      (provider) => provider.mainlandUnavailable,
    ).map((provider) => provider.id);
    expect(mainlandUnavailable).toEqual(["chatgpt", "claude", "gemini"]);
    expect(oauthProvider("claude").apiStyle).toBe("anthropic");
    expect(oauthProvider("chatgpt").region).toBe("global");
    expect(oauthProvider("deepseek").region).toBe("cn");
    expect(oauthProvider("unknown")).toBeNull();
  });

  it("derives configuration from OAUTH_<ID>_* environment variables", () => {
    const unconfigured = configuredProvider("chatgpt", {});
    expect(unconfigured.configured).toBe(false);
    expect(unconfigured.envHint).toEqual(["OAUTH_CHATGPT_CLIENT_ID"]);

    const chatgpt = configuredProvider("chatgpt", {
      OAUTH_CHATGPT_CLIENT_ID: "client",
      OAUTH_CHATGPT_CLIENT_SECRET: "secret",
      OAUTH_CHATGPT_MODEL: "gpt-test",
      OAUTH_CHATGPT_SCOPES: "a b",
    });
    expect(chatgpt).toMatchObject({
      configured: true,
      clientId: "client",
      clientSecret: "secret",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      apiEndpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-test",
      scopes: "a b",
    });

    const workbuddy = configuredProvider("workbuddy", {});
    expect(workbuddy.configured).toBe(false);
    expect(workbuddy.envHint).toEqual([
      "OAUTH_WORKBUDDY_CLIENT_ID",
      "OAUTH_WORKBUDDY_AUTHORIZE_URL",
      "OAUTH_WORKBUDDY_TOKEN_URL",
      "OAUTH_WORKBUDDY_API_ENDPOINT",
    ]);
    const workbuddyConfigured = configuredProvider("workbuddy", {
      OAUTH_WORKBUDDY_CLIENT_ID: "id",
      OAUTH_WORKBUDDY_AUTHORIZE_URL: "https://wb.test/authorize",
      OAUTH_WORKBUDDY_TOKEN_URL: "https://wb.test/token",
      OAUTH_WORKBUDDY_API_ENDPOINT: "https://wb.test/v1/chat",
    });
    expect(workbuddyConfigured.configured).toBe(true);

    const insecure = configuredProvider("chatgpt", {
      OAUTH_CHATGPT_CLIENT_ID: "client",
      OAUTH_CHATGPT_TOKEN_URL: "http://evil.test/token",
    });
    expect(insecure.configured).toBe(false);
    expect(insecure.envHint).toContain("OAUTH_CHATGPT_TOKEN_URL");
  });

  it("resolves API endpoints and HTTPS-only redirects", () => {
    expect(oauthEndpoint("deepseek", {})).toBe(
      "https://api.deepseek.com/chat/completions",
    );
    expect(
      oauthEndpoint("deepseek", {
        OAUTH_DEEPSEEK_API_ENDPOINT: "https://gateway.school.test/v1/chat",
      }),
    ).toBe("https://gateway.school.test/v1/chat");
    expect(() => oauthEndpoint("qwen", {})).toThrow("尚未配置");
    expect(() =>
      oauthEndpoint("deepseek", {
        OAUTH_DEEPSEEK_API_ENDPOINT: "http://127.0.0.1/chat",
      }),
    ).toThrow("HTTPS");
    expect(
      oauthRedirectUri("chatgpt", {
        OAUTH_REDIRECT_BASE: "https://school.example/",
      }),
    ).toBe("https://school.example/api/oauth/chatgpt/callback");
    expect(
      oauthRedirectUri("chatgpt", { APP_ORIGIN: "https://app.example" }),
    ).toBe("https://app.example/api/oauth/chatgpt/callback");
  });
});

describe("PKCE and authorization URL", () => {
  it("creates S256 verifier/challenge pairs", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(codeChallenge("abc")).toBe(
      createHash("sha256").update("abc").digest("base64url"),
    );
  });

  it("builds a URL with state and PKCE but without the client secret", () => {
    const config = configuredProvider("chatgpt", {
      OAUTH_CHATGPT_CLIENT_ID: "client-id",
      OAUTH_CHATGPT_CLIENT_SECRET: "super-secret",
    });
    const url = new URL(
      buildAuthorizeUrl({
        provider: oauthProvider("chatgpt"),
        config,
        state: "state-1",
        challenge: "challenge-1",
        redirectUri: "https://school.example/api/oauth/chatgpt/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://auth.openai.com/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://school.example/api/oauth/chatgpt/callback",
    );
    expect(url.href).not.toContain("super-secret");
  });

  it("asks Google for a refresh token", () => {
    const config = configuredProvider("gemini", {
      OAUTH_GEMINI_CLIENT_ID: "google-client",
    });
    const url = new URL(
      buildAuthorizeUrl({
        provider: oauthProvider("gemini"),
        config,
        state: "state",
        challenge: "challenge",
        redirectUri: "https://school.example/callback",
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("refuses to build an authorization URL for an unconfigured provider", () => {
    const config = configuredProvider("qwen", {});
    expect(() =>
      buildAuthorizeUrl({
        provider: oauthProvider("qwen"),
        config,
        state: "s",
        challenge: "c",
        redirectUri: "https://school.example/callback",
      }),
    ).toThrow("尚未配置");
  });
});

describe("token exchange and refresh", () => {
  const tokenConfig = () =>
    configuredProvider("chatgpt", {
      OAUTH_CHATGPT_CLIENT_ID: "client-id",
      OAUTH_CHATGPT_CLIENT_SECRET: "client-secret",
    });

  it("exchanges an authorization code with PKCE and form credentials", async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        access_token: "at-1",
        refresh_token: "rt-1",
        token_type: "Bearer",
        scope: "openid",
        expires_in: 3600,
      });
    };
    const tokens = await exchangeCode({
      provider: oauthProvider("chatgpt"),
      config: tokenConfig(),
      code: "auth-code",
      verifier: "verifier-1",
      redirectUri: "https://school.example/api/oauth/chatgpt/callback",
      fetchImpl,
    });
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.refresh_token).toBe("rt-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://auth.openai.com/oauth/token");
    expect(calls[0].options.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0].options.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe("client-id");
    expect(body.get("client_secret")).toBe("client-secret");
    expect(body.get("redirect_uri")).toBe(
      "https://school.example/api/oauth/chatgpt/callback",
    );
  });

  it("supports HTTP Basic client authentication", async () => {
    const config = configuredProvider("chatgpt", {
      OAUTH_CHATGPT_CLIENT_ID: "client-id",
      OAUTH_CHATGPT_CLIENT_SECRET: "client-secret",
      OAUTH_CHATGPT_TOKEN_AUTH: "basic",
    });
    let captured;
    const fetchImpl = async (_url, options) => {
      captured = options;
      return Response.json({ access_token: "at-basic" });
    };
    await exchangeCode({
      provider: oauthProvider("chatgpt"),
      config,
      code: "code",
      verifier: "verifier",
      redirectUri: "https://school.example/callback",
      fetchImpl,
    });
    expect(captured.headers.authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    const body = new URLSearchParams(String(captured.body));
    expect(body.has("client_secret")).toBe(false);
  });

  it("never surfaces the provider error body", async () => {
    const fetchImpl = async () =>
      Response.json(
        { error: "invalid_grant", secret: "leak-me" },
        {
          status: 400,
        },
      );
    await expect(
      exchangeCode({
        provider: oauthProvider("chatgpt"),
        config: tokenConfig(),
        code: "code",
        verifier: "verifier",
        redirectUri: "https://school.example/callback",
        fetchImpl,
      }),
    ).rejects.toSatisfy((error) => {
      expect(error.message).toContain("OAuth 授权失败");
      expect(error.message).not.toContain("leak-me");
      expect(JSON.stringify(error)).not.toContain("leak-me");
      return true;
    });
  });

  it("rejects a non-HTTPS token endpoint before any fetch", async () => {
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return Response.json({ access_token: "at" });
    };
    await expect(
      exchangeCode({
        provider: oauthProvider("chatgpt"),
        config: { ...tokenConfig(), tokenUrl: "http://evil.test/token" },
        code: "code",
        verifier: "verifier",
        redirectUri: "https://school.example/callback",
        fetchImpl,
      }),
    ).rejects.toThrow("HTTPS");
    expect(called).toBe(0);
  });

  it("rejects a token response without an access token", async () => {
    const fetchImpl = async () =>
      Response.json({ token_type: "Bearer", expires_in: 60 });
    await expect(
      exchangeCode({
        provider: oauthProvider("chatgpt"),
        config: tokenConfig(),
        code: "code",
        verifier: "verifier",
        redirectUri: "https://school.example/callback",
        fetchImpl,
      }),
    ).rejects.toThrow("未返回访问令牌");
  });

  it("refreshes tokens with grant_type=refresh_token", async () => {
    let captured;
    const fetchImpl = async (_url, options) => {
      captured = options;
      return Response.json({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_in: 1800,
      });
    };
    const tokens = await refreshToken({
      provider: oauthProvider("chatgpt"),
      config: tokenConfig(),
      refreshToken: "rt-1",
      fetchImpl,
    });
    expect(tokens.access_token).toBe("at-2");
    expect(tokens.refresh_token).toBe("rt-2");
    const body = new URLSearchParams(String(captured.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    await expect(
      refreshToken({
        provider: oauthProvider("chatgpt"),
        config: tokenConfig(),
        refreshToken: "",
        fetchImpl,
      }),
    ).rejects.toThrow("刷新令牌");
  });
});

describe("provider directory", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seedUsers(db);
  });
  afterEach(() => db.close());

  it("hides secrets and reports connection state", () => {
    const before = publicOAuthProviders(db, "t1");
    expect(before).toHaveLength(7);
    const chatgpt = before.find((provider) => provider.id === "chatgpt");
    expect(chatgpt).toMatchObject({
      name: "ChatGPT（OpenAI）",
      region: "global",
      mainlandUnavailable: true,
      configured: true,
      connected: false,
      connectedAt: null,
      envHint: [],
    });
    expect(chatgpt.description.length).toBeGreaterThan(8);
    expect(chatgpt.model.length).toBeGreaterThan(0);
    expect(typeof chatgpt.vision).toBe("boolean");
    const qwen = before.find((provider) => provider.id === "qwen");
    expect(qwen.configured).toBe(false);
    expect(qwen.envHint).toContain("OAUTH_QWEN_CLIENT_ID");

    insertConnection(db, "t1", "chatgpt", {
      access: "plain-access-token",
      refresh: "plain-refresh-token",
    });
    const after = publicOAuthProviders(db, "t1");
    const connected = after.find((provider) => provider.id === "chatgpt");
    expect(connected.connected).toBe(true);
    expect(connected.connectedAt).toBe(NOW);
    expect(JSON.stringify(after)).not.toContain("plain-access-token");
    expect(JSON.stringify(after)).not.toContain("plain-refresh-token");
  });
});

describe("oauthChatText", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seedUsers(db);
  });
  afterEach(() => db.close());

  it("calls an OpenAI-style endpoint and returns the raw text", async () => {
    insertConnection(db, "admin1", "deepseek", { access: "at-deepseek" });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        choices: [{ message: { content: '{"items":[]}' } }],
      });
    };
    const text = await oauthChatText({
      user: user(db, "admin1"),
      provider: oauthProvider("deepseek"),
      connection: getOAuthConnection(db, "admin1", "deepseek"),
      prompt: "请批改",
      decrypt,
      fetchImpl,
    });
    expect(text).toBe('{"items":[]}');
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(calls[0].options.headers.authorization).toBe("Bearer at-deepseek");
    const body = JSON.parse(String(calls[0].options.body));
    expect(body.model).toBe("deepseek-chat");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toBe("请批改");
    expect(oauthChat).toBe(oauthChatText);
  });

  it("supports images through the OpenAI content array", async () => {
    insertConnection(db, "admin1", "chatgpt", { access: "at" });
    let body;
    const fetchImpl = async (_url, options) => {
      body = JSON.parse(String(options.body));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    await oauthChatText({
      user: user(db, "admin1"),
      provider: oauthProvider("chatgpt"),
      connection: getOAuthConnection(db, "admin1", "chatgpt"),
      prompt: "识别图片",
      images: [{ mimeType: "image/png", base64: "aGVsbG8=" }],
      decrypt,
      fetchImpl,
    });
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[2].type).toBe("image_url");
    expect(body.messages[0].content[2].image_url.url).toBe(
      "data:image/png;base64,aGVsbG8=",
    );
  });

  it("calls an Anthropic-style endpoint with OAuth headers", async () => {
    insertConnection(db, "admin1", "claude", { access: "at-claude" });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      });
    };
    const text = await oauthChatText({
      user: user(db, "admin1"),
      provider: oauthProvider("claude"),
      connection: getOAuthConnection(db, "admin1", "claude"),
      prompt: "分析",
      decrypt,
      fetchImpl,
    });
    expect(text).toBe("第一段\n第二段");
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].options.headers.authorization).toBe("Bearer at-claude");
    expect(calls[0].options.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].options.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    const body = JSON.parse(String(calls[0].options.body));
    expect(body.messages[0].content[0]).toEqual({
      type: "text",
      text: "分析",
    });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("rejects images for Anthropic-style OAuth models", async () => {
    insertConnection(db, "admin1", "claude", { access: "at-claude" });
    await expect(
      oauthChatText({
        user: user(db, "admin1"),
        provider: oauthProvider("claude"),
        connection: getOAuthConnection(db, "admin1", "claude"),
        prompt: "看图",
        images: [{ mimeType: "image/png", base64: "x" }],
        decrypt,
        fetchImpl: async () => Response.json({}),
      }),
    ).rejects.toThrow("暂不支持图片识别");
  });

  it("maps 401/403 to a reconnect message", async () => {
    insertConnection(db, "admin1", "deepseek", { access: "at" });
    await expect(
      oauthChatText({
        user: user(db, "admin1"),
        provider: oauthProvider("deepseek"),
        connection: getOAuthConnection(db, "admin1", "deepseek"),
        prompt: "x",
        decrypt,
        fetchImpl: async () => Response.json({}, { status: 401 }),
      }),
    ).rejects.toThrow("OAuth 授权已失效，请重新连接");
  });

  it("refreshes an expired access token and persists the new one", async () => {
    insertConnection(db, "admin1", "deepseek", {
      access: "expired-at",
      refresh: "refresh-token-1",
      expiresAt: Date.now() - 60_000,
    });
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url === "https://auth.deepseek.test/token")
        return Response.json({
          access_token: "fresh-at",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
        });
      return Response.json({ choices: [{ message: { content: "done" } }] });
    };
    const text = await oauthChatText({
      user: user(db, "admin1"),
      provider: oauthProvider("deepseek"),
      connection: getOAuthConnection(db, "admin1", "deepseek"),
      prompt: "x",
      decrypt,
      encrypt,
      db,
      fetchImpl,
    });
    expect(text).toBe("done");
    expect(calls.map((call) => call.url)).toEqual([
      "https://auth.deepseek.test/token",
      "https://api.deepseek.com/chat/completions",
    ]);
    expect(calls[1].options.headers.authorization).toBe("Bearer fresh-at");
    const row = getOAuthConnection(db, "admin1", "deepseek");
    expect(decrypt(row.encrypted_access, row.iv)).toBe("fresh-at");
    expect(readOAuthTokens(row, decrypt)).toMatchObject({
      accessToken: "fresh-at",
      refreshToken: "refresh-token-2",
    });
    expect(row.expires_at).toBeGreaterThan(Date.now());
  });

  it("requires reconnection when the expired token cannot be refreshed", async () => {
    insertConnection(db, "admin1", "deepseek", {
      access: "expired-at",
      expiresAt: Date.now() - 60_000,
    });
    await expect(
      oauthChatText({
        user: user(db, "admin1"),
        provider: oauthProvider("deepseek"),
        connection: getOAuthConnection(db, "admin1", "deepseek"),
        prompt: "x",
        decrypt,
        fetchImpl: async () => Response.json({}),
      }),
    ).rejects.toThrow("OAuth 授权已失效");
  });

  it("rejects a connection that cannot be decrypted", async () => {
    insertConnection(db, "admin1", "deepseek", { access: "at" });
    await expect(
      oauthChatText({
        user: user(db, "admin1"),
        provider: oauthProvider("deepseek"),
        connection: getOAuthConnection(db, "admin1", "deepseek"),
        prompt: "x",
        decrypt: () => {
          throw new Error("bad tag");
        },
        fetchImpl: async () => Response.json({}),
      }),
    ).rejects.toThrow("OAuth 授权已失效");
  });
});

describe("OAuth routes", () => {
  let db, server, base, stubFetch;
  const fetchWrapper = (url, options) => stubFetch(url, options);

  beforeAll(async () => {
    db = openDb();
    seedUsers(db);
    const app = express();
    app.use(express.json());
    const ctx = {
      db,
      encrypt,
      decrypt,
      fetchImpl: fetchWrapper,
      auth: (req, res, next) => {
        const id = req.get("x-test-user");
        const found = id
          ? db.prepare("SELECT * FROM users WHERE id=?").get(id)
          : null;
        if (!found) return res.status(401).json({ error: "请先登录" });
        req.user = found;
        next();
      },
    };
    registerOAuthRoutes(app, ctx);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        db.close();
      }),
  );

  async function request(path, userId, method = "GET") {
    const response = await fetch(base + path, {
      method,
      headers: userId ? { "x-test-user": userId } : {},
      redirect: "manual",
    });
    const payload = await response.json().catch(() => null);
    return {
      status: response.status,
      body: payload,
      location: response.headers.get("location") || "",
    };
  }

  function validState(userId, provider = "deepseek", ageMs = 0) {
    const verifier = "verifier-" + randomUUID();
    const state = "state-" + randomUUID();
    db.prepare(
      "INSERT INTO oauth_states(state,user_id,provider,verifier,redirect,created_at) VALUES(?,?,?,?,?,?)",
    ).run(state, userId, provider, verifier, "/", Date.now() - ageMs);
    return db.prepare("SELECT * FROM oauth_states WHERE state=?").get(state);
  }

  it("lists providers with the current auth mode", async () => {
    const response = await request("/api/oauth/providers", "t1");
    expect(response.status).toBe(200);
    expect(response.body.providers).toHaveLength(7);
    expect(response.body.authMode).toBe("api_key");
    expect(response.body.provider).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("chatgpt-secret");
  });

  it("returns an actionable error for an unconfigured provider", async () => {
    const response = await request("/api/oauth/qwen/start", "admin1", "POST");
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("尚未配置");
    expect(response.body.error).toContain("OAUTH_QWEN_CLIENT_ID");
  });

  it("refuses to start OAuth when the mode forbids own credentials", async () => {
    setSchoolMode(db, "school");
    const teacher = await request("/api/oauth/deepseek/start", "t1", "POST");
    expect(teacher.status).toBe(403);
    expect(teacher.body.error).toContain("全校统一模式");
    const student = await request("/api/oauth/deepseek/start", "st1", "POST");
    expect(student.status).toBe(403);
    expect(student.body.error).toContain("学生");
  });

  it("starts the flow with a stored PKCE verifier and S256 challenge", async () => {
    setSchoolMode(db, "teacher_class");
    const response = await request("/api/oauth/deepseek/start", "t1", "POST");
    expect(response.status).toBe(200);
    const url = new URL(response.body.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state");
    const challenge = url.searchParams.get("code_challenge");
    const row = db
      .prepare("SELECT * FROM oauth_states WHERE state=?")
      .get(state);
    expect(row.user_id).toBe("t1");
    expect(row.provider).toBe("deepseek");
    expect(codeChallenge(row.verifier)).toBe(challenge);
    expect(url.searchParams.get("client_id")).toBe("deepseek-client-id");
  });

  it("completes the callback, encrypts tokens and consumes the state", async () => {
    setSchoolMode(db, "teacher_class");
    const stateRow = validState("t1");
    stubFetch = async () =>
      Response.json({
        access_token: "callback-at",
        refresh_token: "callback-rt",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      });
    const response = await request(
      `/api/oauth/deepseek/callback?code=code-1&state=${stateRow.state}`,
      "t1",
    );
    expect(response.status).toBe(302);
    expect(response.location).toBe(
      "/?oauth_provider=deepseek&oauth_status=connected",
    );
    expect(
      db
        .prepare("SELECT * FROM oauth_states WHERE state=?")
        .get(stateRow.state),
    ).toBeUndefined();
    const connection = getOAuthConnection(db, "t1", "deepseek");
    expect(connection).toBeTruthy();
    expect(connection.status).toBe("active");
    expect(decrypt(connection.encrypted_access, connection.iv)).toBe(
      "callback-at",
    );
    expect(readOAuthTokens(connection, decrypt).refreshToken).toBe(
      "callback-rt",
    );
    expect(JSON.stringify(connection)).not.toContain("callback-at");

    // The state is one-time: replaying the callback cannot reconnect.
    const replay = await request(
      `/api/oauth/deepseek/callback?code=code-1&state=${stateRow.state}`,
      "t1",
    );
    expect(replay.location).toBe(
      "/?oauth_provider=deepseek&oauth_status=error&oauth_reason=state_invalid",
    );
  });

  it("rejects callbacks with another user's or an expired state", async () => {
    setSchoolMode(db, "teacher_class");
    const foreign = validState("admin1");
    stubFetch = async () => Response.json({ access_token: "at" });
    const crossUser = await request(
      `/api/oauth/deepseek/callback?code=c&state=${foreign.state}`,
      "t1",
    );
    expect(crossUser.location).toContain("oauth_reason=state_invalid");

    const expired = validState("t1", "deepseek", 11 * 60 * 1000);
    const expiredResponse = await request(
      `/api/oauth/deepseek/callback?code=c&state=${expired.state}`,
      "t1",
    );
    expect(expiredResponse.location).toContain("oauth_reason=state_invalid");
  });

  it("treats a denied authorization as a cancellation", async () => {
    setSchoolMode(db, "teacher_class");
    const stateRow = validState("t1");
    const response = await request(
      `/api/oauth/deepseek/callback?error=access_denied&state=${stateRow.state}`,
      "t1",
    );
    expect(response.status).toBe(302);
    expect(response.location).toBe(
      "/?oauth_provider=deepseek&oauth_status=denied",
    );
  });

  it("maps a failed exchange to a short reason without leaking details", async () => {
    setSchoolMode(db, "teacher_class");
    const stateRow = validState("t1");
    stubFetch = async () =>
      Response.json(
        { error: "invalid_grant", secret: "leak-me" },
        {
          status: 400,
        },
      );
    const response = await request(
      `/api/oauth/deepseek/callback?code=c&state=${stateRow.state}`,
      "t1",
    );
    expect(response.location).toBe(
      "/?oauth_provider=deepseek&oauth_status=error&oauth_reason=exchange_failed",
    );
    expect(response.location).not.toContain("leak-me");
    expect(response.location.startsWith("/")).toBe(true);
  });

  it("never redirects to another origin", async () => {
    setSchoolMode(db, "teacher_class");
    const cases = [
      await request(`/api/oauth/qwen/callback?code=c&state=whatever`, "t1"),
      await request(`/api/oauth/deepseek/callback?code=c&state=missing`, "t1"),
    ];
    for (const response of cases) {
      expect(response.status).toBe(302);
      expect(response.location.startsWith("/")).toBe(true);
      expect(response.location.startsWith("//")).toBe(false);
    }
  });

  it("disconnects and falls back to API Key mode", async () => {
    setSchoolMode(db, "teacher_class");
    insertConnection(db, "t2", "deepseek", { access: "at" });
    db.prepare(
      "UPDATE users SET model_auth_mode='oauth', oauth_provider='deepseek' WHERE id='t2'",
    ).run();
    const response = await request(
      "/api/oauth/deepseek/disconnect",
      "t2",
      "POST",
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(getOAuthConnection(db, "t2", "deepseek")).toBeNull();
    expect(user(db, "t2").model_auth_mode).toBe("api_key");
    expect(user(db, "t2").oauth_provider).toBeNull();
  });

  it("switches the auth mode only with a live connection", async () => {
    setSchoolMode(db, "teacher_class");
    insertUser(db, { id: "t9", role: "teacher", name: "新老师" });
    const missing = await fetch(`${base}/api/model/auth-mode`, {
      method: "PUT",
      headers: { "x-test-user": "t9", "content-type": "application/json" },
      body: JSON.stringify({ mode: "oauth", provider: "deepseek" }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("请先完成 OAuth 授权");

    insertConnection(db, "t9", "deepseek", { access: "at" });
    const switched = await fetch(`${base}/api/model/auth-mode`, {
      method: "PUT",
      headers: { "x-test-user": "t9", "content-type": "application/json" },
      body: JSON.stringify({ mode: "oauth", provider: "deepseek" }),
    });
    expect(switched.status).toBe(200);
    expect(await switched.json()).toEqual({
      ok: true,
      mode: "oauth",
      provider: "deepseek",
    });
    expect(user(db, "t9").model_auth_mode).toBe("oauth");
    expect(user(db, "t9").oauth_provider).toBe("deepseek");

    const invalid = await fetch(`${base}/api/model/auth-mode`, {
      method: "PUT",
      headers: { "x-test-user": "t2", "content-type": "application/json" },
      body: JSON.stringify({ mode: "unknown" }),
    });
    expect(invalid.status).toBe(400);
    const forbidden = await fetch(`${base}/api/model/auth-mode`, {
      method: "PUT",
      headers: { "x-test-user": "st1", "content-type": "application/json" },
      body: JSON.stringify({ mode: "api_key" }),
    });
    expect(forbidden.status).toBe(403);
  });
});

describe("storage helpers", () => {
  it("packs and unpacks the refresh token ciphertext with its IV", () => {
    const packed = packEncrypted(["body", "iv"]);
    expect(packed).toBe("body.iv");
    expect(unpackEncrypted(packed)).toEqual({ body: "body", iv: "iv" });
    expect(() => unpackEncrypted("missing-separator")).toThrow();
  });
});
