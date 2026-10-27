import { describe, expect, it, vi } from "vitest";
import {
  CHATGPT_AUTH_URL,
  CHATGPT_CLIENT_ID,
  CHATGPT_DEVICE_REDIRECT_URI,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_DEVICE_USERCODE_URL,
  CHATGPT_DEVICE_VERIFICATION_URL,
  CHATGPT_RESPONSES_URL,
  CHATGPT_SCOPE,
  CHATGPT_TOKEN_URL,
  chatgptAuthorizeUrl,
  chatgptChat,
  chatgptDecodeIdToken,
  chatgptDeviceExchange,
  chatgptDevicePoll,
  chatgptDeviceStart,
  chatgptExchangeCode,
  chatgptMetadata,
  chatgptRedirectUri,
  chatgptRefresh,
} from "./oauth-chatgpt.mjs";

// 全部测试使用注入的假 fetch：不访问真实网络、不发起真实登录。
type FetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(handler: (url: string, init: FetchInit) => unknown) {
  return vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init || {}) as FetchInit),
  );
}

function bodyParams(init: FetchInit): URLSearchParams {
  return new URLSearchParams(String(init.body ?? ""));
}

function bodyJson(init: FetchInit): Record<string, unknown> {
  return JSON.parse(String(init.body ?? "{}"));
}

function headersOf(init: FetchInit): Record<string, string> {
  return (init.headers || {}) as Record<string, string>;
}

/** 用未签名的 JWT 构造 id_token / access_token 的声明部分（本模块不验签）。 */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

const ID_TOKEN = jwt({
  email: "Teacher@Example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" },
});

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "at-abc",
    refresh_token: "rt-def",
    id_token: ID_TOKEN,
    token_type: "Bearer",
    scope: "openid profile email offline_access",
    expires_in: 3600,
    ...overrides,
  };
}

async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error as any;
  }
  throw new Error("预期该调用失败，但它成功了");
}

describe("chatgptMetadata", () => {
  it("声明 ChatGPT 浏览器 + 设备码双流程", () => {
    expect(chatgptMetadata).toMatchObject({
      id: "chatgpt",
      name: "ChatGPT（Codex OAuth）",
      region: "global",
      mainlandUnavailable: true,
      flows: ["browser", "device"],
      model: "gpt-5.4",
      vision: false,
    });
    expect(typeof chatgptMetadata.description).toBe("string");
    expect(chatgptMetadata.description.length).toBeGreaterThan(0);
  });

  it("使用官方 Codex 公共 PKCE 客户端与固定端点", () => {
    expect(CHATGPT_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(CHATGPT_AUTH_URL).toBe("https://auth.openai.com/oauth/authorize");
    expect(CHATGPT_TOKEN_URL).toBe("https://auth.openai.com/oauth/token");
    expect(CHATGPT_DEVICE_USERCODE_URL).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
    );
    expect(CHATGPT_DEVICE_TOKEN_URL).toBe(
      "https://auth.openai.com/api/accounts/deviceauth/token",
    );
    expect(CHATGPT_DEVICE_VERIFICATION_URL).toBe(
      "https://auth.openai.com/codex/device",
    );
    expect(CHATGPT_DEVICE_REDIRECT_URI).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(CHATGPT_RESPONSES_URL).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    );
  });
});

describe("chatgptAuthorizeUrl", () => {
  it("包含 client_id / redirect_uri / PKCE / scope / Codex 参数", () => {
    const href = chatgptAuthorizeUrl({
      state: "state-1",
      codeChallenge: "challenge-1",
    });
    const url = new URL(href);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    const params = url.searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(chatgptRedirectUri());
    expect(params.get("state")).toBe("state-1");
    expect(params.get("code_challenge")).toBe("challenge-1");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("scope")).toBe(CHATGPT_SCOPE);
    expect(params.get("codex_cli_simplified_flow")).toBe("true");
    expect(params.get("originator")).toBe("codex_cli_rs");
    expect(params.has("client_secret")).toBe(false);
  });

  it("缺少 state 或 PKCE challenge 时给中文错误且不拼出半成品 URL", () => {
    expect(() => chatgptAuthorizeUrl({ codeChallenge: "c" })).toThrow(
      /授权参数不完整/,
    );
    expect(() =>
      chatgptAuthorizeUrl({ state: "s", codeChallenge: "" }),
    ).toThrow(/授权参数不完整/);
  });
});

describe("chatgptRedirectUri", () => {
  it("固定为本机 1455 回调地址", () => {
    expect(chatgptRedirectUri()).toBe("http://localhost:1455/auth/callback");
  });
});

describe("chatgptDecodeIdToken", () => {
  it("从 id_token 解出 accountId（命名空间声明）与 email", () => {
    expect(chatgptDecodeIdToken(ID_TOKEN)).toEqual({
      accountId: "acct-123",
      email: "teacher@example.com",
    });
  });

  it("兼容顶层 chatgpt_account_id 与 organizations 回退", () => {
    expect(
      chatgptDecodeIdToken(jwt({ chatgpt_account_id: "acct-top" })),
    ).toMatchObject({ accountId: "acct-top" });
    expect(
      chatgptDecodeIdToken(jwt({ organizations: [{ id: "org-1" }] })),
    ).toMatchObject({ accountId: "org-1" });
  });

  it("格式非法的令牌不抛异常，只返回空身份", () => {
    expect(chatgptDecodeIdToken("")).toEqual({ accountId: null, email: null });
    expect(chatgptDecodeIdToken("not-a-jwt")).toEqual({
      accountId: null,
      email: null,
    });
    expect(chatgptDecodeIdToken("a.%%%.c")).toEqual({
      accountId: null,
      email: null,
    });
  });
});

describe("chatgptExchangeCode", () => {
  it("uses the upstream JWT expiry without guessing an hour when expires_in is absent", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 90;
    const bundle = await chatgptExchangeCode({
      code: "code",
      codeVerifier: "verifier",
      fetchImpl: fetchMock(() =>
        jsonResponse({ access_token: jwt({ exp: expiry }) }),
      ) as any,
    });
    expect(bundle.expiresAt).toBe(expiry * 1000);
    const unknown = await chatgptExchangeCode({
      code: "code",
      codeVerifier: "verifier",
      fetchImpl: fetchMock(() =>
        jsonResponse({ access_token: "opaque-token" }),
      ) as any,
    });
    expect(unknown.expiresAt).toBeNull();
  });
  it("用 authorization_code + PKCE 换回统一 token bundle", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(tokenResponse()));
    const before = Date.now();
    const bundle = await chatgptExchangeCode({
      code: "code-1",
      codeVerifier: "verifier-1",
      fetchImpl: fetchImpl as any,
    });
    const after = Date.now();

    expect(bundle).toMatchObject({
      accessToken: "at-abc",
      refreshToken: "rt-def",
      tokenType: "Bearer",
      scope: "openid profile email offline_access",
      accountId: "acct-123",
      email: "teacher@example.com",
    });
    expect(bundle.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(bundle.expiresAt).toBeLessThanOrEqual(after + 3600_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
    expect(String(url)).toBe(CHATGPT_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(headersOf(init)["content-type"]).toContain(
      "application/x-www-form-urlencoded",
    );
    const params = bodyParams(init);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(params.get("code")).toBe("code-1");
    expect(params.get("code_verifier")).toBe("verifier-1");
    expect(params.get("redirect_uri")).toBe(chatgptRedirectUri());
    expect(params.has("client_secret")).toBe(false);
  });

  it("无 id_token 时 accountId/email 留空但仍返回令牌", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({ access_token: "at-only", expires_in: 60 }),
    );
    const bundle = await chatgptExchangeCode({
      code: "code-2",
      codeVerifier: "verifier-2",
      fetchImpl: fetchImpl as any,
    });
    expect(bundle.accessToken).toBe("at-only");
    expect(bundle.refreshToken).toBeNull();
    expect(bundle.tokenType).toBe("Bearer");
    expect(bundle.accountId).toBeNull();
    expect(bundle.email).toBeNull();
  });

  it("access_token 也带 ChatGPT 声明时作为 id_token 的回退身份来源", async () => {
    const accessToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-access" },
      email: "fallback@example.com",
    });
    const fetchImpl = fetchMock(() =>
      jsonResponse({ access_token: accessToken, expires_in: 60 }),
    );
    const bundle = await chatgptExchangeCode({
      code: "code-3",
      codeVerifier: "verifier-3",
      fetchImpl: fetchImpl as any,
    });
    expect(bundle.accountId).toBe("acct-access");
    expect(bundle.email).toBe("fallback@example.com");
  });

  it("缺少 access_token 的响应给中文错误", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({ refresh_token: "rt-only" }),
    );
    const error = await captureError(
      chatgptExchangeCode({
        code: "code",
        codeVerifier: "verifier",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/未返回访问令牌/);
  });

  it("HTTP 失败时给中文错误（含状态），且不回显响应体里的敏感内容", async () => {
    const secret = "sk-should-not-leak";
    const fetchImpl = fetchMock(() =>
      jsonResponse(
        { error: { code: "invalid_grant", message: `bad request ${secret}` } },
        400,
      ),
    );
    const error = await captureError(
      chatgptExchangeCode({
        code: "code",
        codeVerifier: "verifier",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error.message).toMatch(/ChatGPT 授权失败/);
    expect(error.message).toContain("HTTP 400");
    expect(error.message).toContain("invalid_grant");
    expect(error.message).not.toContain(secret);
    expect(error.status).toBe(400);
  });

  it("网络异常包装成中文可重试错误", async () => {
    const fetchImpl = fetchMock(() => {
      throw new Error("ECONNRESET");
    });
    const error = await captureError(
      chatgptExchangeCode({
        code: "code",
        codeVerifier: "verifier",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error.message).toMatch(/连接失败/);
    expect(error.retryable).toBe(true);
  });

  it("缺少 code/codeVerifier 时直接报中文错误且不发请求", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(tokenResponse()));
    const missingCode = await captureError(
      chatgptExchangeCode({ fetchImpl: fetchImpl as any }),
    );
    expect(missingCode.message).toMatch(/缺少 ChatGPT 授权码/);
    const missingVerifier = await captureError(
      chatgptExchangeCode({ code: "code", fetchImpl: fetchImpl as any }),
    );
    expect(missingVerifier.message).toMatch(/PKCE/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("chatgptRefresh", () => {
  it("发送 refresh_token 授权类型的 form 请求", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse(
        tokenResponse({ access_token: "at-new", refresh_token: "rt-new" }),
      ),
    );
    const bundle = await chatgptRefresh({
      refreshToken: "rt-old",
      fetchImpl: fetchImpl as any,
    });
    expect(bundle.accessToken).toBe("at-new");
    expect(bundle.refreshToken).toBe("rt-new");
    expect(bundle.accountId).toBe("acct-123");

    const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
    expect(String(url)).toBe(CHATGPT_TOKEN_URL);
    const params = bodyParams(init);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(params.get("refresh_token")).toBe("rt-old");
    expect(params.has("code")).toBe(false);
    expect(params.has("code_verifier")).toBe(false);
  });

  it("没有 refresh_token 时给中文错误", async () => {
    const error = await captureError(chatgptRefresh({}));
    expect(error.message).toMatch(/没有可用的刷新令牌/);
    expect(error.code).toBe("refresh_failed");
  });

  it("刷新被拒绝时给中文错误并带 HTTP 状态", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({ error: { code: "invalid_grant" } }, 401),
    );
    const error = await captureError(
      chatgptRefresh({ refreshToken: "rt", fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/刷新失败/);
    expect(error.message).toContain("HTTP 401");
    expect(error.status).toBe(401);
  });
});

describe("chatgptDeviceStart", () => {
  it("申请设备码并规范化 interval", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({
        device_auth_id: "dev-1",
        user_code: "ABCD-EFGH",
        interval: 5,
      }),
    );
    const result = await chatgptDeviceStart({ fetchImpl: fetchImpl as any });
    expect(result).toEqual({
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      intervalMs: 5000,
      verificationUrl: CHATGPT_DEVICE_VERIFICATION_URL,
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
    expect(String(url)).toBe(CHATGPT_DEVICE_USERCODE_URL);
    expect(init.method).toBe("POST");
    expect(headersOf(init)["content-type"]).toContain("application/json");
    expect(bodyJson(init)).toEqual({ client_id: CHATGPT_CLIENT_ID });
  });

  it("兼容 usercode 别名与字符串 interval，异常 interval 回退默认值", async () => {
    const alias = fetchMock(() =>
      jsonResponse({
        device_auth_id: "dev-2",
        usercode: "WXYZ-1234",
        interval: "2",
      }),
    );
    expect(await chatgptDeviceStart({ fetchImpl: alias as any })).toMatchObject(
      { deviceAuthId: "dev-2", userCode: "WXYZ-1234", intervalMs: 2000 },
    );

    for (const interval of [0, -5, "abc", undefined, 100000]) {
      const odd = fetchMock(() =>
        jsonResponse({ device_auth_id: "d", user_code: "u", interval }),
      );
      const result = await chatgptDeviceStart({ fetchImpl: odd as any });
      expect(result.intervalMs).toBeGreaterThanOrEqual(1000);
      expect(result.intervalMs).toBeLessThanOrEqual(15 * 60 * 1000);
    }
    const missing = fetchMock(() =>
      jsonResponse({ device_auth_id: "d", user_code: "u" }),
    );
    expect(
      (await chatgptDeviceStart({ fetchImpl: missing as any })).intervalMs,
    ).toBe(5000);
  });

  it("缺少必要字段的响应给中文错误", async () => {
    const fetchImpl = fetchMock(() => jsonResponse({ device_auth_id: "only" }));
    const error = await captureError(
      chatgptDeviceStart({ fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/缺少必要字段/);
  });

  it("HTTP 失败给中文错误并包含状态", async () => {
    const fetchImpl = fetchMock(() => new Response("", { status: 500 }));
    const error = await captureError(
      chatgptDeviceStart({ fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/设备授权请求失败/);
    expect(error.message).toContain("HTTP 500");
  });
});

describe("chatgptDevicePoll", () => {
  it("403/404 都视为 pending，且不抛错", async () => {
    for (const status of [403, 404]) {
      const fetchImpl = fetchMock(() => new Response("", { status }));
      const result = await chatgptDevicePoll({
        deviceAuthId: "dev-1",
        userCode: "ABCD-EFGH",
        fetchImpl: fetchImpl as any,
      });
      expect(result).toEqual({ pending: true });
      const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
      expect(String(url)).toBe(CHATGPT_DEVICE_TOKEN_URL);
      expect(bodyJson(init)).toEqual({
        device_auth_id: "dev-1",
        user_code: "ABCD-EFGH",
      });
    }
  });

  it("用户完成授权后返回服务端 grant（authorization_code + code_verifier）", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({
        authorization_code: "auth-code-1",
        code_verifier: "server-verifier-1",
      }),
    );
    const result = await chatgptDevicePoll({
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      fetchImpl: fetchImpl as any,
    });
    expect(result).toEqual({
      pending: false,
      grant: {
        authorizationCode: "auth-code-1",
        codeVerifier: "server-verifier-1",
      },
    });
  });

  it("grant 缺字段时给中文错误", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({ authorization_code: "only-code" }),
    );
    const error = await captureError(
      chatgptDevicePoll({
        deviceAuthId: "dev-1",
        userCode: "ABCD-EFGH",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error.message).toMatch(/缺少必要字段/);
  });

  it("其他 HTTP 失败按终态中文错误返回，并带状态与可重试标记", async () => {
    const fetchImpl = fetchMock(() => new Response("", { status: 500 }));
    const error = await captureError(
      chatgptDevicePoll({
        deviceAuthId: "dev-1",
        userCode: "ABCD-EFGH",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error.message).toMatch(/设备授权查询失败/);
    expect(error.message).toContain("HTTP 500");
    expect(error.retryable).toBe(true);
  });

  it("缺少轮询参数时直接报中文错误且不发请求", async () => {
    const fetchImpl = fetchMock(() => new Response("", { status: 403 }));
    const error = await captureError(
      chatgptDevicePoll({ fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/设备码授权参数不完整/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("chatgptDeviceExchange", () => {
  it("用设备码 grant + 设备流程 redirect_uri 兑换令牌", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(tokenResponse()));
    const bundle = await chatgptDeviceExchange({
      grant: {
        authorizationCode: "auth-code-1",
        codeVerifier: "server-verifier-1",
      },
      fetchImpl: fetchImpl as any,
    });
    expect(bundle).toMatchObject({
      accessToken: "at-abc",
      accountId: "acct-123",
      email: "teacher@example.com",
    });

    const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
    expect(String(url)).toBe(CHATGPT_TOKEN_URL);
    const params = bodyParams(init);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(params.get("code")).toBe("auth-code-1");
    expect(params.get("code_verifier")).toBe("server-verifier-1");
    expect(params.get("redirect_uri")).toBe(CHATGPT_DEVICE_REDIRECT_URI);
  });

  it("grant 不完整时给中文错误", async () => {
    const fetchImpl = fetchMock(() => jsonResponse(tokenResponse()));
    const error = await captureError(
      chatgptDeviceExchange({
        grant: { authorizationCode: "only" },
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(error.message).toMatch(/设备码授权凭据不完整/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("chatgptChat", () => {
  const chatArgs = {
    accessToken: "at-abc",
    accountId: "acct-123",
    model: "gpt-5.4",
    messages: [{ role: "user", content: "请批改这份作业" }],
  };

  it("调用 Responses API 并拼接 output 中 message/output_text 文本", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse({
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "第一段" },
              { type: "output_text", text: "续写" },
            ],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "第二段" }],
          },
        ],
      }),
    );
    const text = await chatgptChat({
      ...chatArgs,
      maxTokens: 256,
      fetchImpl: fetchImpl as any,
    });
    expect(text).toBe("第一段续写\n第二段");

    const [url, init] = fetchImpl.mock.calls[0] as [string, FetchInit];
    expect(String(url)).toBe(CHATGPT_RESPONSES_URL);
    expect(init.method).toBe("POST");
    const headers = headersOf(init);
    expect(headers.authorization).toBe("Bearer at-abc");
    expect(headers["chatgpt-account-id"]).toBe("acct-123");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers["content-type"]).toContain("application/json");

    const body = bodyJson(init);
    expect(body.model).toBe("gpt-5.4");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "请批改这份作业" }],
      },
    ]);
  });

  it("messages 支持字符串、多角色与 text part 数组；maxTokens 缺省时不发 max_output_tokens", async () => {
    const fetchImpl = fetchMock(() => jsonResponse({ output: [] }));
    await captureError(
      chatgptChat({
        ...chatArgs,
        messages: "直接字符串提示",
        fetchImpl: fetchImpl as any,
      }),
    );
    let body = bodyJson((fetchImpl.mock.calls[0] as [string, FetchInit])[1]);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "直接字符串提示" }],
      },
    ]);

    const partsFetch = fetchMock(() => jsonResponse({ output: [] }));
    await captureError(
      chatgptChat({
        ...chatArgs,
        messages: [
          { role: "system", content: "你是老师" },
          {
            role: "user",
            content: [
              { type: "text", text: "第一行" },
              { type: "text", text: "第二行" },
            ],
          },
        ],
        fetchImpl: partsFetch as any,
      }),
    );
    body = bodyJson((partsFetch.mock.calls[0] as [string, FetchInit])[1]);
    expect(body.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "你是老师" }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: "第一行" },
          { type: "input_text", text: "第二行" },
        ],
      },
    ]);
  });

  it("上游返回空 output 时给中文错误", async () => {
    const fetchImpl = fetchMock(() => jsonResponse({ output: [] }));
    const error = await captureError(
      chatgptChat({ ...chatArgs, fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/没有返回内容/);
  });

  it("401/403 视为授权失效，提示重新连接", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = fetchMock(() => new Response("", { status }));
      const error = await captureError(
        chatgptChat({ ...chatArgs, fetchImpl: fetchImpl as any }),
      );
      expect(error.message).toMatch(/授权已失效/);
      expect(error.message).not.toContain("at-abc");
      expect(error.code).toBe("OAUTH_INVALID");
    }
  });

  it("其他 HTTP 失败给中文错误（含状态）且不回显上游 message/令牌", async () => {
    const fetchImpl = fetchMock(() =>
      jsonResponse(
        { error: { code: "server_error", message: "boom Bearer at-abc" } },
        500,
      ),
    );
    const error = await captureError(
      chatgptChat({ ...chatArgs, fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/模型接口请求失败/);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain("server_error");
    expect(error.message).not.toContain("at-abc");
    expect(error.retryable).toBe(true);
  });

  it("网络异常包装成中文可重试错误", async () => {
    const fetchImpl = fetchMock(() => {
      throw new Error("socket hang up");
    });
    const error = await captureError(
      chatgptChat({ ...chatArgs, fetchImpl: fetchImpl as any }),
    );
    expect(error.message).toMatch(/连接失败/);
    expect(error.retryable).toBe(true);
  });

  it("缺少 accessToken/accountId 时先报中文错误、不发请求", async () => {
    const fetchImpl = fetchMock(() => jsonResponse({ output: [] }));
    const tokenError = await captureError(
      chatgptChat({
        ...chatArgs,
        accessToken: "",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(tokenError.message).toMatch(/缺少 ChatGPT 访问令牌/);
    const accountError = await captureError(
      chatgptChat({
        ...chatArgs,
        accountId: "",
        fetchImpl: fetchImpl as any,
      }),
    );
    expect(accountError.message).toMatch(/缺少 ChatGPT 账户标识/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an interrupted Responses stream instead of accepting partial grading", async () => {
    const fetchImpl = fetchMock(
      () =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        ),
    );
    await expect(
      chatgptChat({ ...chatArgs, fetchImpl: fetchImpl as any }),
    ).rejects.toThrow("未完整结束");
  });

  it("按官方 Responses SSE 的完成事件解析增量", async () => {
    const sse = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"批改"}',
      "",
      'data: {"type":"response.output_text.delta","delta":"完成"}',
      "",
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
      "",
    ].join("\n");
    const fetchImpl = fetchMock(
      () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const text = await chatgptChat({
      ...chatArgs,
      fetchImpl: fetchImpl as any,
    });
    expect(text).toBe("批改完成");
  });
});
