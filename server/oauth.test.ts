import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";

// Provider modules are owned by parallel agents and are unit-tested next to
// their implementation. The core contract tests mock them completely so that
// routing / attempts / storage are verified without any network or real port.
vi.mock("./oauth-chatgpt.mjs", () => ({
  chatgptMetadata: {
    id: "chatgpt",
    name: "ChatGPT（Codex OAuth）",
    region: "global",
    mainlandUnavailable: true,
    flows: ["browser", "device"],
    model: "gpt-5.4",
    vision: false,
    description: "测试用 ChatGPT OAuth 元数据",
  },
  chatgptAuthorizeUrl: vi.fn(),
  chatgptRedirectUri: vi.fn(),
  chatgptExchangeCode: vi.fn(),
  chatgptRefresh: vi.fn(),
  chatgptDeviceStart: vi.fn(),
  chatgptDevicePoll: vi.fn(),
  chatgptDeviceExchange: vi.fn(),
  chatgptChat: vi.fn(),
}));

vi.mock("./oauth-workbuddy.mjs", () => ({
  workbuddyMetadata: {
    id: "workbuddy",
    name: "WorkBuddy",
    region: "cn",
    mainlandUnavailable: false,
    flows: ["browser", "device"],
    model: "workbuddy-chat",
    vision: false,
    description: "测试用 WorkBuddy OAuth 元数据",
  },
  workbuddyRegion: vi.fn((env: Record<string, string | undefined> = {}) =>
    env?.OAUTH_WORKBUDDY_REGION === "global" ? "global" : "cn",
  ),
  workbuddyStart: vi.fn(),
  workbuddyPoll: vi.fn(),
  workbuddyAccount: vi.fn(),
  workbuddyRefresh: vi.fn(),
  workbuddyChat: vi.fn(),
}));

import {
  OAUTH_PROVIDERS,
  buildAuthorizeUrl,
  clearOAuthAttempts,
  codeChallenge,
  configuredProvider,
  createPkcePair,
  exchangeCode,
  getOAuthConnection,
  oauthChat,
  oauthChatText,
  oauthConnectionMeta,
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
import * as chatgptModule from "./oauth-chatgpt.mjs";
import * as workbuddyModule from "./oauth-workbuddy.mjs";

const chatgptMock = chatgptModule as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;
const workbuddyMock = workbuddyModule as unknown as Record<
  string,
  ReturnType<typeof vi.fn>
>;

const SCHEMA = fs.readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-10-24T00:00:00.000Z";
const ENCRYPT_SECRET = createHash("sha256")
  .update("oauth-test-only-secret")
  .digest();

function encrypt(text: string) {
  const iv = Buffer.from("0123456789ab", "utf8");
  const cipher = createCipheriv("aes-256-gcm", ENCRYPT_SECRET, iv);
  const body = Buffer.concat([
    cipher.update(String(text)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [body.toString("base64"), iv.toString("base64")];
}

function decrypt(body: string, iv: string) {
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

function insertUser(db: DatabaseSync, user: Record<string, any>) {
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

function seedUsers(db: DatabaseSync) {
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
  insertUser(db, {
    id: "p1",
    role: "parent",
    name: "张家长",
  });
}

function setSchoolMode(db: DatabaseSync, mode: string) {
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES('s1',?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode",
  ).run(mode, NOW);
}

function userRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

function insertConnection(
  db: DatabaseSync,
  userId: string,
  provider: string,
  {
    access = "access-token",
    refresh = null as string | null,
    expiresAt = null as number | null,
    meta = "{}",
    status = "active",
  } = {},
) {
  const [accessBody, accessIv] = encrypt(access);
  const refreshPacked = refresh ? packEncrypted(encrypt(refresh)) : null;
  db.prepare(
    `INSERT INTO oauth_connections(id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,token_type,scope,expires_at,status,created_at,updated_at,meta_json)
     VALUES(?,?,?,'',?,?,?,'Bearer','',?,?,?,?,?)
     ON CONFLICT(user_id,provider) DO UPDATE SET
       encrypted_access=excluded.encrypted_access, encrypted_refresh=excluded.encrypted_refresh,
       iv=excluded.iv, expires_at=excluded.expires_at, status=excluded.status,
       updated_at=excluded.updated_at, meta_json=excluded.meta_json`,
  ).run(
    randomUUID(),
    userId,
    provider,
    accessBody,
    refreshPacked,
    accessIv,
    expiresAt,
    status,
    NOW,
    NOW,
    meta,
  );
}

// Environment variables touched by these tests. Each test starts from a clean
// slate (no OAUTH_* configuration) and restores the host process environment.
const ENV_NAMES = [
  "OAUTH_GEMINI_CLIENT_ID",
  "OAUTH_GEMINI_CLIENT_SECRET",
  "OAUTH_GEMINI_TOKEN_URL",
  "OAUTH_GEMINI_MODEL",
  "OAUTH_REDIRECT_BASE",
  "OAUTH_WORKBUDDY_REGION",
  "OAUTH_CHATGPT_DISABLED",
];
let savedEnv: Record<string, string | undefined> = {};

function resetMockModule(moduleMocks: Record<string, any>) {
  for (const value of Object.values(moduleMocks))
    if (typeof value?.mockReset === "function") value.mockReset();
}

function configureProviderMocks() {
  resetMockModule(chatgptMock);
  resetMockModule(workbuddyMock);
  chatgptMock.chatgptRedirectUri.mockReturnValue(
    "http://localhost:1455/auth/callback",
  );
  chatgptMock.chatgptAuthorizeUrl.mockImplementation(
    ({ state, codeChallenge: challenge }: Record<string, string>) =>
      `https://auth.openai.com/oauth/authorize?state=${encodeURIComponent(
        state,
      )}&code_challenge=${encodeURIComponent(challenge)}`,
  );
  workbuddyMock.workbuddyRegion.mockImplementation(
    (env: Record<string, string | undefined> = {}) =>
      env?.OAUTH_WORKBUDDY_REGION === "global" ? "global" : "cn",
  );
}

beforeEach(() => {
  savedEnv = {};
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  configureProviderMocks();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("OAuth provider catalogue", () => {
  it("only exposes chatgpt, gemini and workbuddy with their flows", () => {
    expect(OAUTH_PROVIDERS.map((provider) => provider.id)).toEqual([
      "chatgpt",
      "gemini",
      "workbuddy",
    ]);
    const chatgpt = oauthProvider("chatgpt")!;
    expect(chatgpt.flows).toEqual(["browser", "device"]);
    expect(chatgpt.region).toBe("global");
    expect(chatgpt.mainlandUnavailable).toBe(true);
    expect(chatgpt.vision).toBe(false);
    expect(chatgpt.model).toBe("gpt-5.4");
    const gemini = oauthProvider("gemini")!;
    expect(gemini.flows).toEqual(["browser"]);
    expect(gemini.vision).toBe(true);
    const workbuddy = oauthProvider("workbuddy")!;
    expect(workbuddy.flows).toEqual(["browser", "device"]);
    expect(workbuddy.region).toBe("cn");
    expect(workbuddy.mainlandUnavailable).toBe(false);
    for (const removed of ["claude", "qwen", "qianwen", "deepseek", "unknown"])
      expect(oauthProvider(removed)).toBeNull();
  });

  it("treats built-in clients as configured and reports gemini env hints", () => {
    expect(configuredProvider("chatgpt", {})).toMatchObject({
      configured: true,
      envHint: [],
      kind: "chatgpt",
    });
    expect(configuredProvider("workbuddy", {})).toMatchObject({
      configured: true,
      envHint: [],
      region: "cn",
    });
    expect(
      configuredProvider("workbuddy", { OAUTH_WORKBUDDY_REGION: "global" }),
    ).toMatchObject({
      configured: true,
      region: "global",
    });
    expect(
      configuredProvider("chatgpt", { OAUTH_CHATGPT_DISABLED: "1" }),
    ).toMatchObject({
      configured: false,
    });

    const unconfiguredGemini = configuredProvider("gemini", {});
    expect(unconfiguredGemini.configured).toBe(false);
    expect(unconfiguredGemini.envHint).toEqual(["OAUTH_GEMINI_CLIENT_ID"]);

    const gemini = configuredProvider("gemini", {
      OAUTH_GEMINI_CLIENT_ID: "google-client",
      OAUTH_GEMINI_CLIENT_SECRET: "google-secret",
    });
    expect(gemini).toMatchObject({
      configured: true,
      clientId: "google-client",
      clientSecret: "google-secret",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      model: "gemini-2.5-flash",
    });
    expect(gemini.envHint).toEqual([]);

    const insecureGemini = configuredProvider("gemini", {
      OAUTH_GEMINI_CLIENT_ID: "google-client",
      OAUTH_GEMINI_TOKEN_URL: "http://evil.test/token",
    });
    expect(insecureGemini.configured).toBe(false);
    expect(insecureGemini.envHint).toContain("OAUTH_GEMINI_TOKEN_URL");
  });

  it("keeps the legacy redirect base resolution", () => {
    expect(
      oauthRedirectUri("gemini", {
        OAUTH_REDIRECT_BASE: "https://school.example/",
      }),
    ).toBe("https://school.example/api/oauth/gemini/callback");
    expect(
      oauthRedirectUri("gemini", { APP_ORIGIN: "https://app.example" }),
    ).toBe("https://app.example/api/oauth/gemini/callback");
  });

  it("resolves HTTPS-only gemini model endpoints", () => {
    expect(oauthEndpoint("gemini", {})).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(
      oauthEndpoint("gemini", {
        OAUTH_GEMINI_API_ENDPOINT: "https://gateway.school.test/v1/chat",
      }),
    ).toBe("https://gateway.school.test/v1/chat");
    expect(() =>
      oauthEndpoint("gemini", {
        OAUTH_GEMINI_API_ENDPOINT: "http://127.0.0.1/chat",
      }),
    ).toThrow("HTTPS");
    expect(() => oauthEndpoint("chatgpt", {})).toThrow("尚未配置");
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

  it("builds a gemini URL with state, PKCE and no client secret", () => {
    const config = configuredProvider("gemini", {
      OAUTH_GEMINI_CLIENT_ID: "client-id",
      OAUTH_GEMINI_CLIENT_SECRET: "super-secret",
    });
    const url = new URL(
      buildAuthorizeUrl({
        provider: oauthProvider("gemini"),
        config,
        state: "state-1",
        challenge: "challenge-1",
        redirectUri: "http://127.0.0.1:8787/api/oauth/gemini/callback",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.href).not.toContain("super-secret");
  });

  it("refuses to build a URL for an unconfigured provider", () => {
    expect(() =>
      buildAuthorizeUrl({
        provider: oauthProvider("gemini"),
        config: configuredProvider("gemini", {}),
        state: "s",
        challenge: "c",
        redirectUri: "https://school.example/callback",
      }),
    ).toThrow("尚未配置");
  });
});

describe("gemini token exchange helpers", () => {
  const tokenConfig = () =>
    configuredProvider("gemini", {
      OAUTH_GEMINI_CLIENT_ID: "client-id",
      OAUTH_GEMINI_CLIENT_SECRET: "client-secret",
    });

  it("exchanges an authorization code with PKCE", async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, options: any) => {
      calls.push({ url, options });
      return Response.json({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
      });
    };
    const tokens = await exchangeCode({
      provider: oauthProvider("gemini"),
      config: tokenConfig(),
      code: "auth-code",
      verifier: "verifier-1",
      redirectUri: "https://school.example/api/oauth/gemini/callback",
      fetchImpl,
    });
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const body = new URLSearchParams(String(calls[0].options.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_secret")).toBe("client-secret");
  });

  it("refreshes with grant_type=refresh_token", async () => {
    let captured: any;
    const fetchImpl = async (_url: string, options: any) => {
      captured = options;
      return Response.json({ access_token: "at-2", expires_in: 1800 });
    };
    const tokens = await refreshToken({
      provider: oauthProvider("gemini"),
      config: tokenConfig(),
      refreshToken: "rt-1",
      fetchImpl,
    });
    expect(tokens.access_token).toBe("at-2");
    const body = new URLSearchParams(String(captured.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    await expect(
      refreshToken({
        provider: oauthProvider("gemini"),
        config: tokenConfig(),
        refreshToken: "",
        fetchImpl,
      }),
    ).rejects.toThrow("刷新令牌");
  });

  it("never surfaces the provider error body", async () => {
    const fetchImpl = async () =>
      Response.json(
        { error: "invalid_grant", secret: "leak-me" },
        { status: 400 },
      );
    await expect(
      exchangeCode({
        provider: oauthProvider("gemini"),
        config: tokenConfig(),
        code: "code",
        verifier: "verifier",
        redirectUri: "https://school.example/callback",
        fetchImpl,
      }),
    ).rejects.toSatisfy((error: any) => {
      expect(error.message).toContain("OAuth 授权失败");
      expect(JSON.stringify(error)).not.toContain("leak-me");
      return true;
    });
  });
});

describe("storage helpers", () => {
  it("packs and unpacks refresh ciphertext with its IV", () => {
    const packed = packEncrypted(["body", "iv"]);
    expect(packed).toBe("body.iv");
    expect(unpackEncrypted(packed)).toEqual({ body: "body", iv: "iv" });
    expect(() => unpackEncrypted("missing-separator")).toThrow();
  });

  it("reads encrypted tokens and provider metadata", () => {
    const db = openDb();
    seedUsers(db);
    insertConnection(db, "t1", "chatgpt", {
      access: "plain-at",
      refresh: "plain-rt",
      meta: JSON.stringify({ accountId: "acc", email: "a@x", flow: "browser" }),
    });
    const row = getOAuthConnection(db, "t1", "chatgpt")!;
    expect(readOAuthTokens(row, decrypt)).toMatchObject({
      accessToken: "plain-at",
      refreshToken: "plain-rt",
    });
    expect(oauthConnectionMeta(row)).toEqual({
      accountId: "acc",
      email: "a@x",
      flow: "browser",
    });
    expect(JSON.stringify(oauthConnectionMeta({ meta_json: "not-json" }))).toBe(
      "{}",
    );
    expect(JSON.stringify(oauthConnectionMeta({}))).toBe("{}");
    db.close();
  });
});

describe("oauthChatText dispatch", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = openDb();
    seedUsers(db);
  });
  afterEach(() => db.close());

  it("dispatches to chatgptChat with the account id from meta_json", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "cg-at",
      meta: JSON.stringify({
        accountId: "acc-1",
        email: "a@x",
        flow: "browser",
      }),
    });
    chatgptMock.chatgptChat.mockResolvedValue("批改完成");
    const fetchImpl = vi.fn();
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("chatgpt"),
      connection: getOAuthConnection(db, "t1", "chatgpt"),
      prompt: "请批改",
      decrypt,
      fetchImpl,
    });
    expect(text).toBe("批改完成");
    expect(chatgptMock.chatgptChat).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "cg-at",
        accountId: "acc-1",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "请批改" }],
        maxTokens: 4096,
      }),
    );
    expect(oauthChat).toBe(oauthChatText);
  });

  it("rejects images for non-vision providers", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "cg-at",
      meta: JSON.stringify({ accountId: "acc-1" }),
    });
    await expect(
      oauthChatText({
        user: { id: "t1" },
        provider: oauthProvider("chatgpt"),
        connection: getOAuthConnection(db, "t1", "chatgpt"),
        prompt: "看图",
        images: [{ mimeType: "image/png", base64: "x" }],
        decrypt,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("暂不支持图片识别");
    expect(chatgptMock.chatgptChat).not.toHaveBeenCalled();
  });

  it("refreshes an expired chatgpt token and keeps the old refresh token", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "old-at",
      refresh: "old-rt",
      expiresAt: Date.now() - 60_000,
      meta: JSON.stringify({
        accountId: "acc-1",
        email: "a@x",
        flow: "device",
      }),
    });
    chatgptMock.chatgptRefresh.mockResolvedValue({
      accessToken: "fresh-at",
      refreshToken: null,
      tokenType: "Bearer",
      scope: "openid",
      expiresAt: Date.now() + 3_600_000,
      accountId: null,
      email: null,
    });
    chatgptMock.chatgptChat.mockResolvedValue("done");
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: "chatgpt",
      connection: getOAuthConnection(db, "t1", "chatgpt"),
      prompt: "x",
      decrypt,
      encrypt,
      db,
      fetchImpl: vi.fn(),
    });
    expect(text).toBe("done");
    expect(chatgptMock.chatgptRefresh).toHaveBeenCalledTimes(1);
    expect(chatgptMock.chatgptChat).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fresh-at", accountId: "acc-1" }),
    );
    const row = getOAuthConnection(db, "t1", "chatgpt")!;
    expect(decrypt(row.encrypted_access, row.iv)).toBe("fresh-at");
    const tokens = readOAuthTokens(row, decrypt);
    expect(tokens.refreshToken).toBe("old-rt");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    expect(oauthConnectionMeta(row)).toMatchObject({
      accountId: "acc-1",
      email: "a@x",
      flow: "device",
    });
    expect(row.status).toBe("active");
  });

  it("marks the connection invalid when chatgpt refresh fails", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "old-at",
      refresh: "old-rt",
      expiresAt: Date.now() - 60_000,
      meta: JSON.stringify({ accountId: "acc-1" }),
    });
    chatgptMock.chatgptRefresh.mockRejectedValue(new Error("refresh failed"));
    await expect(
      oauthChatText({
        user: { id: "t1" },
        provider: oauthProvider("chatgpt"),
        connection: getOAuthConnection(db, "t1", "chatgpt"),
        prompt: "x",
        decrypt,
        encrypt,
        db,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("OAuth 授权已失效");
    expect(getOAuthConnection(db, "t1", "chatgpt")!.status).toBe("invalid");
    expect(chatgptMock.chatgptChat).not.toHaveBeenCalled();
  });

  it("requires reconnection for an expired token without refresh token", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "old-at",
      expiresAt: Date.now() - 60_000,
      meta: JSON.stringify({ accountId: "acc-1" }),
    });
    await expect(
      oauthChatText({
        user: { id: "t1" },
        provider: oauthProvider("chatgpt"),
        connection: getOAuthConnection(db, "t1", "chatgpt"),
        decrypt,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow("OAuth 授权已失效");
    expect(chatgptMock.chatgptRefresh).not.toHaveBeenCalled();
  });

  it("rejects a connection that cannot be decrypted", async () => {
    insertConnection(db, "t1", "chatgpt", {
      access: "at",
      meta: JSON.stringify({ accountId: "acc-1" }),
    });
    await expect(
      oauthChatText({
        user: { id: "t1" },
        provider: oauthProvider("chatgpt"),
        connection: getOAuthConnection(db, "t1", "chatgpt"),
        decrypt: () => {
          throw new Error("bad tag");
        },
      }),
    ).rejects.toThrow("OAuth 授权已失效");
  });

  it("dispatches to workbuddyChat with the stored credential", async () => {
    insertConnection(db, "t1", "workbuddy", {
      access: "wb-at",
      refresh: "wb-rt",
      meta: JSON.stringify({
        uid: "u1",
        enterpriseId: "e1",
        domain: "d1",
        region: "cn",
        nickname: "昵称",
        flow: "device",
      }),
    });
    workbuddyMock.workbuddyChat.mockResolvedValue("wb-ok");
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("workbuddy"),
      connection: getOAuthConnection(db, "t1", "workbuddy"),
      prompt: "请批改",
      decrypt,
      fetchImpl: vi.fn(),
    });
    expect(text).toBe("wb-ok");
    expect(workbuddyMock.workbuddyChat).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          accessToken: "wb-at",
          refreshToken: "wb-rt",
          uid: "u1",
          enterpriseId: "e1",
          domain: "d1",
          region: "cn",
        }),
        model: "workbuddy-chat",
        messages: [{ role: "user", content: "请批改" }],
      }),
    );
  });

  it("refreshes workbuddy credentials and persists the rotated tokens", async () => {
    insertConnection(db, "t1", "workbuddy", {
      access: "old-wb-at",
      refresh: "old-wb-rt",
      expiresAt: Date.now() - 60_000,
      meta: JSON.stringify({
        uid: "u1",
        enterpriseId: "e1",
        domain: "d1",
        region: "global",
        nickname: "昵称",
        flow: "device",
      }),
    });
    workbuddyMock.workbuddyRefresh.mockResolvedValue({
      accessToken: "new-wb-at",
      refreshToken: "new-wb-rt",
      expiresIn: 3600,
      domain: "d2",
    });
    workbuddyMock.workbuddyChat.mockResolvedValue("ok");
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("workbuddy"),
      connection: getOAuthConnection(db, "t1", "workbuddy"),
      prompt: "x",
      decrypt,
      encrypt,
      db,
      fetchImpl: vi.fn(),
    });
    expect(text).toBe("ok");
    expect(workbuddyMock.workbuddyRefresh).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({
          refreshToken: "old-wb-rt",
          region: "global",
        }),
      }),
    );
    const tokens = readOAuthTokens(
      getOAuthConnection(db, "t1", "workbuddy")!,
      decrypt,
    );
    expect(tokens).toMatchObject({
      accessToken: "new-wb-at",
      refreshToken: "new-wb-rt",
    });
    expect(
      oauthConnectionMeta(getOAuthConnection(db, "t1", "workbuddy")!).domain,
    ).toBe("d2");
  });

  it("calls the Gemini OpenAI-compatible endpoint", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    insertConnection(db, "t1", "gemini", { access: "gemini-at", meta: "{}" });
    const calls: any[] = [];
    const fetchImpl = async (url: string, options: any) => {
      calls.push({ url, options });
      return Response.json({
        choices: [{ message: { content: '{"items":[]}' } }],
      });
    };
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("gemini"),
      connection: getOAuthConnection(db, "t1", "gemini"),
      prompt: "请批改",
      decrypt,
      fetchImpl,
    });
    expect(text).toBe('{"items":[]}');
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(calls[0].options.headers.authorization).toBe("Bearer gemini-at");
    const body = JSON.parse(String(calls[0].options.body));
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toBe("请批改");
  });

  it("supports images through the Gemini content array", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    insertConnection(db, "t1", "gemini", { access: "gemini-at", meta: "{}" });
    let body: any;
    const fetchImpl = async (_url: string, options: any) => {
      body = JSON.parse(String(options.body));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("gemini"),
      connection: getOAuthConnection(db, "t1", "gemini"),
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

  it("maps Gemini 401 responses to a reconnect message", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    insertConnection(db, "t1", "gemini", { access: "gemini-at", meta: "{}" });
    await expect(
      oauthChatText({
        user: { id: "t1" },
        provider: oauthProvider("gemini"),
        connection: getOAuthConnection(db, "t1", "gemini"),
        prompt: "x",
        decrypt,
        fetchImpl: async () => Response.json({}, { status: 401 }),
      }),
    ).rejects.toThrow("OAuth 授权已失效，请重新连接");
  });

  it("refreshes an expired Gemini token and persists it", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    process.env.OAUTH_GEMINI_CLIENT_SECRET = "gemini-secret";
    insertConnection(db, "t1", "gemini", {
      access: "old-gemini-at",
      refresh: "old-gemini-rt",
      expiresAt: Date.now() - 60_000,
      meta: "{}",
    });
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "fresh-gemini-at",
          refresh_token: "fresh-gemini-rt",
          expires_in: 3600,
        });
      return Response.json({ choices: [{ message: { content: "done" } }] });
    };
    const text = await oauthChatText({
      user: { id: "t1" },
      provider: oauthProvider("gemini"),
      connection: getOAuthConnection(db, "t1", "gemini"),
      prompt: "x",
      decrypt,
      encrypt,
      db,
      fetchImpl,
    });
    expect(text).toBe("done");
    expect(calls).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ]);
    expect(
      readOAuthTokens(getOAuthConnection(db, "t1", "gemini")!, decrypt),
    ).toMatchObject({
      accessToken: "fresh-gemini-at",
      refreshToken: "fresh-gemini-rt",
    });
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function testAuth(db: DatabaseSync) {
  return (req: any, res: any, next: any) => {
    const id = req.get("x-test-user");
    const found = id
      ? db.prepare("SELECT * FROM users WHERE id=?").get(id)
      : null;
    if (!found) return res.status(401).json({ error: "请先登录" });
    req.user = found;
    next();
  };
}

async function findFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("OAuth routes", () => {
  let db: DatabaseSync;
  let servers: any[];
  let stubFetch: ((url: string, options: any) => Promise<Response>) | null;
  const fetchWrapper = (url: string, options: any) => {
    if (!stubFetch) throw new Error("unexpected fetch in test");
    return stubFetch(url, options);
  };

  beforeEach(() => {
    db = openDb();
    seedUsers(db);
    setSchoolMode(db, "teacher_class");
    servers = [];
    stubFetch = null;
  });

  afterEach(async () => {
    clearOAuthAttempts();
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  async function makeApp(timing?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    registerOAuthRoutes(app, {
      db,
      encrypt,
      decrypt,
      fetchImpl: fetchWrapper,
      auth: testAuth(db),
      ...(timing ? { oauthTiming: timing } : {}),
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const address = server.address() as net.AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async function request(
    base: string,
    path: string,
    userId = "",
    method = "GET",
    body?: unknown,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(userId ? { "x-test-user": userId } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return {
      status: response.status,
      body: payload,
      text,
      location: response.headers.get("location") || "",
    };
  }

  async function waitForAttempt(
    base: string,
    provider: string,
    attemptId: string,
    userId: string,
    statuses: string[],
    timeoutMs = 3000,
  ) {
    const startedAt = Date.now();
    let last: any = null;
    while (Date.now() - startedAt < timeoutMs) {
      last = await request(
        base,
        `/api/oauth/${provider}/attempt/${attemptId}`,
        userId,
      );
      if (last.body && statuses.includes(last.body.status)) return last;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `attempt did not reach ${statuses.join("/")}: ${JSON.stringify(last)}`,
    );
  }

  it("lists only the three supported providers with flows", async () => {
    const base = await makeApp();
    const response = await request(base, "/api/oauth/providers", "t1");
    expect(response.status).toBe(200);
    expect(response.body.authMode).toBe("api_key");
    expect(response.body.provider).toBeNull();
    expect(response.body.providers.map((card: any) => card.id)).toEqual([
      "chatgpt",
      "gemini",
      "workbuddy",
    ]);
    const byId = new Map(
      response.body.providers.map((card: any) => [card.id, card]),
    );
    expect(byId.get("chatgpt")).toMatchObject({
      configured: true,
      connected: false,
      connectedAt: null,
      flows: ["browser", "device"],
      model: "gpt-5.4",
      vision: false,
    });
    expect(byId.get("gemini")).toMatchObject({
      configured: false,
      flows: ["browser"],
      vision: true,
    });
    expect(byId.get("gemini").envHint).toContain("OAUTH_GEMINI_CLIENT_ID");
    expect(byId.get("workbuddy")).toMatchObject({
      configured: true,
      flows: ["browser", "device"],
      region: "cn",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("reports a live connection on the provider card", async () => {
    const base = await makeApp();
    insertConnection(db, "t1", "chatgpt", {
      access: "plain-at",
      refresh: "plain-rt",
      meta: JSON.stringify({ accountId: "acc" }),
    });
    const response = await request(base, "/api/oauth/providers", "t1");
    const card = response.body.providers.find(
      (row: any) => row.id === "chatgpt",
    );
    expect(card).toMatchObject({ connected: true, connectedAt: NOW });
    expect(JSON.stringify(response.body)).not.toContain("plain-at");
    expect(JSON.stringify(response.body)).not.toContain("plain-rt");
  });

  it("requires login for every OAuth route", async () => {
    const base = await makeApp();
    expect((await request(base, "/api/oauth/providers")).status).toBe(401);
    expect(
      (await request(base, "/api/oauth/gemini/browser/start", "", "POST", {}))
        .status,
    ).toBe(401);
    expect(
      (await request(base, "/api/oauth/chatgpt/device/start", "", "POST", {}))
        .status,
    ).toBe(401);
  });

  it("returns 404 for removed provider ids", async () => {
    const base = await makeApp();
    for (const removed of ["claude", "qwen", "qianwen", "deepseek"])
      expect(
        (await request(base, `/api/oauth/${removed}/start`, "t1", "POST", {}))
          .status,
      ).toBe(404);
    expect(
      (
        await request(
          base,
          "/api/oauth/deepseek/browser/start",
          "t1",
          "POST",
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          base,
          "/api/oauth/deepseek/device/start",
          "t1",
          "POST",
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(base, "/api/oauth/deepseek/callback?code=c&state=s", "t1"))
        .status,
    ).toBe(404);
    expect(
      (await request(base, "/api/oauth/deepseek/disconnect", "t1", "POST"))
        .status,
    ).toBe(404);
    expect(
      (await request(base, "/api/oauth/deepseek/attempt/whatever", "t1"))
        .status,
    ).toBe(404);
  });

  it("returns an actionable error for unconfigured gemini", async () => {
    const base = await makeApp();
    const response = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "admin1",
      "POST",
      {},
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("尚未配置");
    expect(response.body.error).toContain("OAUTH_GEMINI_CLIENT_ID");
    expect(
      (await request(base, "/api/oauth/gemini/start", "admin1", "POST", {}))
        .status,
    ).toBe(400);
    expect(
      (
        await request(
          base,
          "/api/oauth/gemini/device/start",
          "admin1",
          "POST",
          {},
        )
      ).status,
    ).toBe(400);
  });

  it("refuses to start OAuth when the school mode forbids it", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    setSchoolMode(db, "school");
    const base = await makeApp();
    const teacher = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    expect(teacher.status).toBe(403);
    expect(teacher.body.error).toContain("全校统一模式");
    const student = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "st1",
      "POST",
      {},
    );
    expect(student.status).toBe(403);
    expect(student.body.error).toContain("学生");
  });

  it("runs the gemini browser flow end to end through the callback", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    process.env.OAUTH_GEMINI_CLIENT_SECRET = "gemini-secret";
    const base = await makeApp();
    const started = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    expect(started.status).toBe(200);
    expect(started.body.mode).toBe("browser");
    expect(typeof started.body.attemptId).toBe("string");
    const url = new URL(started.body.url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("gemini-client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toContain(
      "/api/oauth/gemini/callback",
    );
    const state = url.searchParams.get("state") as string;
    expect(
      (
        await request(
          base,
          `/api/oauth/${"gemini"}/attempt/${started.body.attemptId}`,
          "t1",
        )
      ).body,
    ).toMatchObject({ status: "pending" });

    stubFetch = async () =>
      Response.json({
        access_token: "gemini-at",
        refresh_token: "gemini-rt",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      });
    const callback = await request(
      base,
      `/api/oauth/gemini/callback?code=code-1&state=${state}`,
      "t1",
    );
    expect(callback.status).toBe(302);
    expect(callback.location).toBe(
      "/?oauth_provider=gemini&oauth_status=connected",
    );
    const connection = getOAuthConnection(db, "t1", "gemini")!;
    expect(connection.status).toBe("active");
    expect(decrypt(connection.encrypted_access, connection.iv)).toBe(
      "gemini-at",
    );
    expect(readOAuthTokens(connection, decrypt).refreshToken).toBe("gemini-rt");
    expect(oauthConnectionMeta(connection)).toEqual({});

    const connected = await waitForAttempt(
      base,
      "gemini",
      started.body.attemptId,
      "t1",
      ["connected"],
    );
    expect(connected.body.connectedAt).toEqual(expect.any(String));

    // state is one-time
    const replay = await request(
      base,
      `/api/oauth/gemini/callback?code=code-1&state=${state}`,
      "t1",
    );
    expect(replay.location).toContain("oauth_reason=state_invalid");
  });

  it("keeps the legacy gemini start shape for old clients", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    const base = await makeApp();
    const response = await request(
      base,
      "/api/oauth/gemini/start",
      "t1",
      "POST",
      {},
    );
    expect(response.status).toBe(200);
    expect(typeof response.body.url).toBe("string");
    expect(response.body.authorizeUrl).toBe(response.body.url);
    expect(new URL(response.body.url).origin).toBe(
      "https://accounts.google.com",
    );
  });

  it("validates callback state, ownership, expiry and denial", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    const base = await makeApp();
    const started = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    const state = new URL(started.body.url).searchParams.get("state") as string;

    // another user's session cannot complete it
    const foreign = await request(
      base,
      `/api/oauth/gemini/callback?code=c&state=${state}`,
      "t2",
    );
    expect(foreign.location).toContain("oauth_reason=state_invalid");
    // unknown state
    const unknown = await request(
      base,
      "/api/oauth/gemini/callback?code=c&state=missing",
      "t1",
    );
    expect(unknown.location).toContain("oauth_reason=state_invalid");

    // denial is reported without exchanging a token
    const denied = await request(
      base,
      `/api/oauth/gemini/callback?error=access_denied&state=${state}`,
      "t1",
    );
    expect(denied.location).toBe("/?oauth_provider=gemini&oauth_status=denied");
    const attempt = await waitForAttempt(
      base,
      "gemini",
      started.body.attemptId,
      "t1",
      ["error"],
    );
    expect(attempt.body.message).toContain("取消");
  });

  it("maps a failed gemini exchange to a short reason", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    const base = await makeApp();
    const started = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    const state = new URL(started.body.url).searchParams.get("state") as string;
    stubFetch = async () =>
      Response.json(
        { error: "invalid_grant", secret: "leak-me" },
        { status: 400 },
      );
    const response = await request(
      base,
      `/api/oauth/gemini/callback?code=c&state=${state}`,
      "t1",
    );
    expect(response.location).toBe(
      "/?oauth_provider=gemini&oauth_status=error&oauth_reason=exchange_failed",
    );
    expect(response.location).not.toContain("leak-me");
    expect(
      (
        await waitForAttempt(base, "gemini", started.body.attemptId, "t1", [
          "error",
        ])
      ).body.message,
    ).toContain("Gemini");
  });

  it("expires a pending gemini attempt and rejects its callback", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    const base = await makeApp({ geminiTtlMs: 40 });
    const started = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    const state = new URL(started.body.url).searchParams.get("state") as string;
    const expired = await waitForAttempt(
      base,
      "gemini",
      started.body.attemptId,
      "t1",
      ["expired"],
    );
    expect(expired.body.message).toContain("超时");
    const callback = await request(
      base,
      `/api/oauth/gemini/callback?code=c&state=${state}`,
      "t1",
    );
    expect(callback.location).toContain("oauth_reason=state_invalid");
  });

  it("runs the chatgpt browser flow through a local 127.0.0.1 callback server", async () => {
    const port = await findFreePort();
    const base = await makeApp({ chatgptCallbackPort: port });
    const authorizeUrl =
      "https://auth.openai.com/oauth/authorize?state=test-state&code_challenge=test-challenge";
    chatgptMock.chatgptAuthorizeUrl.mockReturnValue(authorizeUrl);
    chatgptMock.chatgptExchangeCode.mockResolvedValue({
      accessToken: "cg-at",
      refreshToken: "cg-rt",
      tokenType: "Bearer",
      scope: "openid profile email offline_access",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acc-9",
      email: "teacher@example.com",
    });
    const started = await request(
      base,
      "/api/oauth/chatgpt/browser/start",
      "t1",
      "POST",
      {},
    );
    expect(started.status).toBe(200);
    expect(started.body.mode).toBe("browser");
    expect(started.body.url).toBe(authorizeUrl);
    const attemptId = started.body.attemptId;
    expect(
      (await request(base, `/api/oauth/chatgpt/attempt/${attemptId}`, "t1"))
        .body,
    ).toMatchObject({ status: "pending" });

    // The authorize URL is built with the temporary callback server's URI.
    const authorizeArgs =
      chatgptMock.chatgptAuthorizeUrl.mock.calls.at(-1)?.[0];
    expect(authorizeArgs.redirectUri).toBe(
      `http://localhost:${port}/auth/callback`,
    );
    const state = authorizeArgs.state as string;
    expect(authorizeArgs.codeChallenge).toEqual(expect.any(String));

    const callbackResponse = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=cb-code&state=${encodeURIComponent(state)}`,
    );
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("ChatGPT 授权完成");
    expect(chatgptMock.chatgptExchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "cb-code",
        codeVerifier: expect.any(String),
        redirectUri: `http://localhost:${port}/auth/callback`,
      }),
    );

    const connected = await waitForAttempt(base, "chatgpt", attemptId, "t1", [
      "connected",
    ]);
    expect(connected.body.connectedAt).toEqual(expect.any(String));
    const connection = getOAuthConnection(db, "t1", "chatgpt")!;
    expect(decrypt(connection.encrypted_access, connection.iv)).toBe("cg-at");
    expect(oauthConnectionMeta(connection)).toEqual({
      accountId: "acc-9",
      email: "teacher@example.com",
      flow: "browser",
    });
    expect(connection.account_label).toBe("teacher@example.com");

    // Replaying the callback is refused and the port stops listening.
    const receiveAgain = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=cb-code&state=${encodeURIComponent(state)}`,
    ).catch(() => null);
    if (receiveAgain) expect(receiveAgain.status).toBeGreaterThanOrEqual(400);
    const rejected = await request(
      base,
      `/api/oauth/chatgpt/attempt/${attemptId}`,
      "t2",
    );
    expect(rejected.status).toBe(404);
  });

  it("rejects a chatgpt browser start when the callback port is busy", async () => {
    const blocker = net.createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const busyPort = (blocker.address() as net.AddressInfo).port;
    try {
      const base = await makeApp({ chatgptCallbackPort: busyPort });
      const response = await request(
        base,
        "/api/oauth/chatgpt/browser/start",
        "t1",
        "POST",
        {},
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toContain("端口");
      expect(response.body.error).toContain(String(busyPort));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("runs the chatgpt device flow and stores the account identity", async () => {
    const base = await makeApp({ chatgptPollIntervalMs: 10 });
    chatgptMock.chatgptDeviceStart.mockResolvedValue({
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      intervalMs: 5000,
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    chatgptMock.chatgptDevicePoll
      .mockResolvedValueOnce({ pending: true })
      .mockResolvedValueOnce({
        pending: false,
        grant: { authorizationCode: "ac", codeVerifier: "cv" },
      });
    chatgptMock.chatgptDeviceExchange.mockResolvedValue({
      accessToken: "device-at",
      refreshToken: "device-rt",
      tokenType: "Bearer",
      scope: "openid",
      expiresAt: Date.now() + 3_600_000,
      accountId: "acc-device",
      email: "device@example.com",
    });
    const started = await request(
      base,
      "/api/oauth/chatgpt/device/start",
      "t1",
      "POST",
      {},
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      mode: "device",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    const connected = await waitForAttempt(
      base,
      "chatgpt",
      started.body.attemptId,
      "t1",
      ["connected"],
    );
    expect(connected.body.status).toBe("connected");
    expect(chatgptMock.chatgptDevicePoll).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceAuthId: "dev-1",
        userCode: "ABCD-EFGH",
        fetchImpl: expect.any(Function),
      }),
    );
    const connection = getOAuthConnection(db, "t1", "chatgpt")!;
    expect(decrypt(connection.encrypted_access, connection.iv)).toBe(
      "device-at",
    );
    expect(oauthConnectionMeta(connection)).toEqual({
      accountId: "acc-device",
      email: "device@example.com",
      flow: "device",
    });
    expect(connection.account_label).toBe("device@example.com");
  });

  it("marks a chatgpt device attempt as error when polling fails", async () => {
    const base = await makeApp({ chatgptPollIntervalMs: 10 });
    chatgptMock.chatgptDeviceStart.mockResolvedValue({
      deviceAuthId: "dev-err",
      userCode: "ERR-CODE",
      intervalMs: 5000,
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    chatgptMock.chatgptDevicePoll.mockRejectedValue(
      new Error("授权码已被使用"),
    );
    const started = await request(
      base,
      "/api/oauth/chatgpt/device/start",
      "t1",
      "POST",
      {},
    );
    const attempt = await waitForAttempt(
      base,
      "chatgpt",
      started.body.attemptId,
      "t1",
      ["error"],
    );
    expect(attempt.body.message).toContain("ChatGPT");
    expect(getOAuthConnection(db, "t1", "chatgpt")).toBeNull();
  });

  it("expires a chatgpt device attempt after its TTL", async () => {
    const base = await makeApp({
      chatgptPollIntervalMs: 5000,
      chatgptDeviceTtlMs: 40,
    });
    chatgptMock.chatgptDeviceStart.mockResolvedValue({
      deviceAuthId: "dev-ttl",
      userCode: "TTL-CODE",
      intervalMs: 5000,
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    const started = await request(
      base,
      "/api/oauth/chatgpt/device/start",
      "t1",
      "POST",
      {},
    );
    const expired = await waitForAttempt(
      base,
      "chatgpt",
      started.body.attemptId,
      "t1",
      ["expired"],
    );
    expect(expired.body.message).toContain("超时");
  });

  it("runs the workbuddy device flow and stores the account identity", async () => {
    const base = await makeApp({ workbuddyPollIntervalMs: 10 });
    workbuddyMock.workbuddyStart.mockResolvedValue({
      state: "wb-state-1",
      authUrl: "https://workbuddy.example.com/authorize",
    });
    workbuddyMock.workbuddyPoll
      .mockResolvedValueOnce({ pending: true })
      .mockResolvedValueOnce({
        pending: false,
        token: {
          accessToken: "wb-at",
          refreshToken: "wb-rt",
          expiresIn: 3600,
          domain: "dept-1",
        },
      });
    workbuddyMock.workbuddyAccount.mockResolvedValue({
      uid: "uid-1",
      enterpriseId: "ent-1",
      nickname: "王老师",
    });
    const started = await request(
      base,
      "/api/oauth/workbuddy/device/start",
      "t1",
      "POST",
      { region: "global" },
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      mode: "device",
      verificationUrl: "https://workbuddy.example.com/authorize",
      region: "global",
    });
    expect(workbuddyMock.workbuddyStart).toHaveBeenCalledWith(
      expect.objectContaining({ region: "global" }),
    );
    const connected = await waitForAttempt(
      base,
      "workbuddy",
      started.body.attemptId,
      "t1",
      ["connected"],
    );
    expect(connected.body.status).toBe("connected");
    expect(workbuddyMock.workbuddyAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "wb-state-1",
        accessToken: "wb-at",
        region: "global",
      }),
    );
    const connection = getOAuthConnection(db, "t1", "workbuddy")!;
    expect(decrypt(connection.encrypted_access, connection.iv)).toBe("wb-at");
    expect(readOAuthTokens(connection, decrypt).refreshToken).toBe("wb-rt");
    expect(oauthConnectionMeta(connection)).toEqual({
      uid: "uid-1",
      enterpriseId: "ent-1",
      domain: "dept-1",
      region: "global",
      nickname: "王老师",
      flow: "device",
    });
    expect(connection.account_label).toBe("王老师");
    expect(Number(connection.expires_at)).toBeGreaterThan(Date.now());
  });

  it("runs the workbuddy browser flow through the same official authorization", async () => {
    const base = await makeApp({ workbuddyPollIntervalMs: 10 });
    workbuddyMock.workbuddyStart.mockResolvedValue({
      state: "wb-state-browser",
      authUrl: "https://workbuddy.example.com/authorize",
    });
    workbuddyMock.workbuddyPoll.mockResolvedValue({
      pending: false,
      token: {
        accessToken: "wb-browser-at",
        refreshToken: "wb-browser-rt",
        expiresIn: 3600,
        domain: "dept-browser",
      },
    });
    workbuddyMock.workbuddyAccount.mockResolvedValue({
      uid: "uid-browser",
      enterpriseId: "ent-browser",
      nickname: "浏览器老师",
    });
    const started = await request(
      base,
      "/api/oauth/workbuddy/browser/start",
      "t1",
      "POST",
      { region: "global" },
    );
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      mode: "browser",
      url: "https://workbuddy.example.com/authorize",
      region: "global",
    });
    expect(workbuddyMock.workbuddyStart).toHaveBeenCalledWith(
      expect.objectContaining({ region: "global" }),
    );
    const connected = await waitForAttempt(
      base,
      "workbuddy",
      started.body.attemptId,
      "t1",
      ["connected"],
    );
    expect(connected.body.status).toBe("connected");
    const connection = getOAuthConnection(db, "t1", "workbuddy")!;
    expect(oauthConnectionMeta(connection)).toMatchObject({
      uid: "uid-browser",
      region: "global",
      flow: "browser",
    });
  });

  it("defaults the workbuddy region and reports poll failures", async () => {
    const base = await makeApp({ workbuddyPollIntervalMs: 10 });
    workbuddyMock.workbuddyStart.mockResolvedValue({
      state: "wb-state-2",
      authUrl: "https://workbuddy.example.com/authorize",
    });
    workbuddyMock.workbuddyPoll.mockRejectedValue(new Error("登录服务不可用"));
    const started = await request(
      base,
      "/api/oauth/workbuddy/device/start",
      "t1",
      "POST",
      {},
    );
    expect(started.status).toBe(200);
    expect(started.body.region).toBe("cn");
    expect(workbuddyMock.workbuddyStart).toHaveBeenCalledWith(
      expect.objectContaining({ region: "cn" }),
    );
    const attempt = await waitForAttempt(
      base,
      "workbuddy",
      started.body.attemptId,
      "t1",
      ["error"],
    );
    expect(attempt.body.message).toContain("WorkBuddy");
  });

  it("keeps legacy start compatibility for chatgpt and workbuddy", async () => {
    const port = await findFreePort();
    const base = await makeApp({ chatgptCallbackPort: port });
    chatgptMock.chatgptAuthorizeUrl.mockReturnValue(
      "https://auth.openai.com/oauth/authorize?state=x&code_challenge=y",
    );
    const chatgpt = await request(
      base,
      "/api/oauth/chatgpt/start",
      "t1",
      "POST",
      {},
    );
    expect(chatgpt.status).toBe(200);
    expect(chatgpt.body).toMatchObject({ mode: "browser" });
    expect(chatgpt.body.url).toBe(chatgpt.body.authorizeUrl);
    expect(typeof chatgpt.body.attemptId).toBe("string");

    const workbuddy = await request(
      base,
      "/api/oauth/workbuddy/start",
      "t1",
      "POST",
      {},
    );
    expect(workbuddy.status).toBe(409);
    expect(workbuddy.body.error).toContain("device/start");
  });

  it("never returns another user's or another provider's attempt", async () => {
    process.env.OAUTH_GEMINI_CLIENT_ID = "gemini-client";
    const base = await makeApp();
    const started = await request(
      base,
      "/api/oauth/gemini/browser/start",
      "t1",
      "POST",
      {},
    );
    expect(
      (
        await request(
          base,
          `/api/oauth/gemini/attempt/${started.body.attemptId}`,
          "t2",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          base,
          `/api/oauth/chatgpt/attempt/${started.body.attemptId}`,
          "t1",
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(base, `/api/oauth/gemini/attempt/unknown-id`, "t1"))
        .status,
    ).toBe(404);
  });

  it("disconnects and falls back to API Key mode", async () => {
    const base = await makeApp();
    insertConnection(db, "t2", "chatgpt", {
      access: "at",
      meta: JSON.stringify({ accountId: "acc" }),
    });
    db.prepare(
      "UPDATE users SET model_auth_mode='oauth', oauth_provider='chatgpt' WHERE id='t2'",
    ).run();
    const response = await request(
      base,
      "/api/oauth/chatgpt/disconnect",
      "t2",
      "POST",
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(getOAuthConnection(db, "t2", "chatgpt")).toBeNull();
    expect(userRow(db, "t2").model_auth_mode).toBe("api_key");
    expect(userRow(db, "t2").oauth_provider).toBeNull();
  });

  it("switches the auth mode only with a live connection", async () => {
    const base = await makeApp();
    insertUser(db, { id: "t9", role: "teacher", name: "新老师" });
    const missing = await request(base, "/api/model/auth-mode", "t9", "PUT", {
      mode: "oauth",
      provider: "chatgpt",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain("请先完成 OAuth 授权");

    insertConnection(db, "t9", "chatgpt", { access: "at" });
    const switched = await request(base, "/api/model/auth-mode", "t9", "PUT", {
      mode: "oauth",
      provider: "chatgpt",
    });
    expect(switched.status).toBe(200);
    expect(switched.body).toEqual({
      ok: true,
      mode: "oauth",
      provider: "chatgpt",
    });
    expect(userRow(db, "t9").model_auth_mode).toBe("oauth");

    const invalid = await request(base, "/api/model/auth-mode", "t9", "PUT", {
      mode: "unknown",
    });
    expect(invalid.status).toBe(400);
    const forbidden = await request(
      base,
      "/api/model/auth-mode",
      "st1",
      "PUT",
      {
        mode: "api_key",
      },
    );
    expect(forbidden.status).toBe(403);
    const removedProvider = await request(
      base,
      "/api/model/auth-mode",
      "t9",
      "PUT",
      { mode: "oauth", provider: "deepseek" },
    );
    expect(removedProvider.status).toBe(400);
  });
});
