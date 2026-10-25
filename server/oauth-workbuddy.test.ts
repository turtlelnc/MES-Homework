import { describe, expect, it } from "vitest";
import {
  workbuddyAccount,
  workbuddyChat,
  workbuddyMetadata,
  workbuddyPoll,
  workbuddyRefresh,
  workbuddyRegion,
  workbuddyStart,
} from "./oauth-workbuddy.mjs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FetchCall = { url: string; init: RequestInit };

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input);
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function headersOf(call: FetchCall) {
  return call.init.headers as Record<string, string>;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(...events: string[]) {
  return new Response(events.join("\n\n") + "\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const CN_CREDENTIAL = {
  accessToken: "at-cn-secret",
  refreshToken: "rt-cn-secret",
  uid: "u-1",
  enterpriseId: "ent-1",
  domain: "workbuddy.cn",
  region: "cn",
};

describe("workbuddyMetadata / workbuddyRegion", () => {
  it("声明 device 流程、国内版默认区域与默认模型", () => {
    expect(workbuddyMetadata).toEqual({
      id: "workbuddy",
      name: "WorkBuddy",
      region: "cn",
      mainlandUnavailable: false,
      flows: ["browser", "device"],
      model: "workbuddy-chat",
      vision: false,
      description:
        "WorkBuddy 国内版/国际版：点击浏览器授权后由服务端轮询完成登录，无需 API Key。",
    });
  });

  it("默认 cn，OAUTH_WORKBUDDY_REGION=global 时切到国际版", () => {
    expect(workbuddyRegion({})).toBe("cn");
    expect(workbuddyRegion({ OAUTH_WORKBUDDY_REGION: "cn" })).toBe("cn");
    expect(workbuddyRegion({ OAUTH_WORKBUDDY_REGION: "global" })).toBe(
      "global",
    );
  });
});

describe("workbuddyStart", () => {
  it("cn：解析 state/authUrl，补 loginSessionId 并使用国内登录端点", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        msg: "ok",
        data: {
          state: "wb-state-1",
          authUrl: "https://www.workbuddy.cn/plugin-login?state=wb-state-1",
        },
      }),
    );

    const result = await workbuddyStart({ region: "cn", fetchImpl });

    expect(result.state).toBe("wb-state-1");
    const authUrl = new URL(result.authUrl);
    expect(authUrl.origin).toBe("https://www.workbuddy.cn");
    expect(authUrl.searchParams.get("state")).toBe("wb-state-1");
    expect(authUrl.searchParams.get("loginSessionId")).toMatch(UUID_RE);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://www.workbuddy.cn/v2/plugin/auth/state?platform=workbuddy",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(headersOf(calls[0])).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://www.codebuddy.cn",
      Referer: "https://www.codebuddy.cn/",
      "User-Agent": "CLI/2.63.2 CodeBuddy/2.63.2",
    });
  });

  it("global：使用国际版端点并保留上游已有的 loginSessionId", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        data: {
          state: "wb-state-g",
          authUrl:
            "https://www.workbuddy.ai/auth?state=wb-state-g&loginSessionId=keep-me",
        },
      }),
    );

    const result = await workbuddyStart({ region: "global", fetchImpl });

    expect(new URL(result.authUrl).searchParams.get("loginSessionId")).toBe(
      "keep-me",
    );
    expect(calls[0].url).toBe(
      "https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy",
    );
    expect(headersOf(calls[0]).Origin).toBe("https://www.workbuddy.ai");
    expect(headersOf(calls[0]).Referer).toBe("https://www.workbuddy.ai/");
  });

  it("上游业务失败时抛中文错误", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ code: 1001, msg: "服务繁忙，请稍后再试" }),
    );

    await expect(workbuddyStart({ region: "cn", fetchImpl })).rejects.toThrow(
      "WorkBuddy 登录服务失败：服务繁忙，请稍后再试",
    );
  });
});

describe("workbuddyPoll", () => {
  it("业务码非 0（用户尚未在浏览器完成授权）返回 pending", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({ code: 11217, msg: "11217:login ing..." }, 400),
    );

    await expect(
      workbuddyPoll({ state: "wb state/1", region: "cn", fetchImpl }),
    ).resolves.toEqual({ pending: true });

    expect(calls[0].url).toBe(
      `https://www.workbuddy.cn/v2/plugin/auth/token?state=${encodeURIComponent("wb state/1")}`,
    );
    expect(calls[0].init.method).toBe("GET");
    expect(headersOf(calls[0]).Authorization).toBeUndefined();
  });

  it("4xx 且响应不是 JSON 时同样视为 pending", async () => {
    const { fetchImpl } = mockFetch(
      () => new Response("login ing", { status: 428 }),
    );

    await expect(
      workbuddyPoll({ state: "wb-state-1", region: "cn", fetchImpl }),
    ).resolves.toEqual({ pending: true });
  });

  it("成功时返回 token bundle（expiresIn 为秒）", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        msg: "",
        data: {
          accessToken: "at-1",
          refreshToken: "rt-1",
          expiresIn: 3600,
          domain: "workbuddy.cn",
        },
      }),
    );

    await expect(
      workbuddyPoll({ state: "wb-state-1", region: "cn", fetchImpl }),
    ).resolves.toEqual({
      pending: false,
      token: {
        accessToken: "at-1",
        refreshToken: "rt-1",
        expiresIn: 3600,
        domain: "workbuddy.cn",
      },
    });
    expect(headersOf(calls[0])["User-Agent"]).toBe(
      "CLI/2.63.2 CodeBuddy/2.63.2",
    );
  });

  it("code=0 却缺少 accessToken 时报中文错误", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ code: 0, data: { refreshToken: "rt-only" } }),
    );

    await expect(
      workbuddyPoll({ state: "wb-state-1", region: "cn", fetchImpl }),
    ).rejects.toThrow(/访问令牌/);
  });
});

describe("workbuddyAccount", () => {
  it("携带 Bearer accessToken 并归一化 uid/enterpriseId/nickname", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        data: { uid: "u-1", enterpriseId: "ent-1", nickname: "王老师" },
      }),
    );

    await expect(
      workbuddyAccount({
        state: "wb-state-1",
        accessToken: "at-1",
        region: "cn",
        fetchImpl,
      }),
    ).resolves.toEqual({
      uid: "u-1",
      enterpriseId: "ent-1",
      nickname: "王老师",
    });

    expect(calls[0].url).toBe(
      "https://www.workbuddy.cn/v2/plugin/login/account?state=wb-state-1",
    );
    expect(calls[0].init.method).toBe("GET");
    expect(headersOf(calls[0]).Authorization).toBe("Bearer at-1");
    expect(headersOf(calls[0]).Origin).toBe("https://www.codebuddy.cn");
  });
});

describe("workbuddyRefresh", () => {
  it("POST 刷新端点，携带刷新头并解析轮换后的令牌", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        code: 0,
        data: {
          accessToken: "at-new",
          refreshToken: "rt-new",
          expiresIn: 7200,
          domain: "workbuddy.cn",
        },
      }),
    );

    const result = await workbuddyRefresh({
      credential: {
        accessToken: "at-old",
        refreshToken: "rt-old",
        uid: "u-1",
        enterpriseId: "ent-1",
        domain: "workbuddy.cn",
        region: "cn",
      },
      fetchImpl,
    });

    expect(result).toEqual({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 7200,
      domain: "workbuddy.cn",
    });
    expect(calls[0].url).toBe(
      "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe("{}");
    const headers = headersOf(calls[0]);
    expect(headers["X-Refresh-Token"]).toBe("rt-old");
    expect(headers["X-Auth-Refresh-Source"]).toBe("workbuddy");
    expect(headers["X-Enterprise-Id"]).toBe("ent-1");
    expect(headers["User-Agent"]).toBe("CLI/2.63.2 CodeBuddy/2.63.2");
    expect(headers.Origin).toBe("https://www.codebuddy.cn");
    expect(headers.Referer).toBe("https://www.codebuddy.cn/");
    expect(headers.Authorization).toBeUndefined();
  });

  it("上游未轮换 refreshToken 时沿用旧值", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({
        code: 0,
        data: { accessToken: "at-new", expiresIn: 60, domain: "workbuddy.cn" },
      }),
    );

    const result = await workbuddyRefresh({
      credential: {
        accessToken: "at-old",
        refreshToken: "rt-old",
        domain: "workbuddy.cn",
        region: "cn",
      },
      fetchImpl,
    });

    expect(result.refreshToken).toBe("rt-old");
    expect(result.expiresIn).toBe(60);
  });
});

describe("workbuddyChat", () => {
  it("cn：拼接 SSE delta，强制 stream 并把 developer 改写成 system", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"同"}}]}',
        'data: {"choices":[{"delta":{"content":"学你好"}}]}',
        "data: [DONE]",
      ),
    );
    const messages = [
      { role: "developer", content: "你是阅卷助手" },
      { role: "user", content: "请批改" },
    ];

    await expect(
      workbuddyChat({
        credential: CN_CREDENTIAL,
        model: "deepseek-v3",
        messages,
        fetchImpl,
      }),
    ).resolves.toBe("同学你好");

    expect(calls[0].url).toBe(
      "https://copilot.tencent.com/v2/chat/completions",
    );
    expect(calls[0].init.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.stream).toBe(true);
    expect(body.model).toBe("deepseek-v3");
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "你是阅卷助手",
    });
    expect(body.messages[1]).toEqual({ role: "user", content: "请批改" });
    // 不修改调用方传入的数组。
    expect(messages[0].role).toBe("developer");

    const headers = headersOf(calls[0]);
    expect(headers.Authorization).toBe("Bearer at-cn-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json, text/plain, */*");
    expect(headers.Origin).toBe("https://www.codebuddy.cn");
    expect(headers.Referer).toBe("https://www.codebuddy.cn/");
    expect(headers["User-Agent"]).toBe("WorkBuddy/5.5.6 WorkBuddy/5.5.6");
    expect(headers["X-IDE-Type"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Name"]).toBe("WorkBuddy");
    expect(headers["X-IDE-Version"]).toBe("5.5.6");
    expect(headers["X-Product"]).toBe("SaaS");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(headers["X-User-Id"]).toBe("u-1");
    expect(headers["X-Enterprise-Id"]).toBe("ent-1");
    expect(headers["X-Domain"]).toBe("workbuddy.cn");
    // Authorization 只允许 access token，refresh token 绝不出现在任何请求头里。
    expect(JSON.stringify(headers)).not.toContain("rt-cn-secret");
  });

  it("global：使用国际版聊天端点、UA 与 X-No-* 头", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      sseResponse(
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
      ),
    );

    await expect(
      workbuddyChat({
        credential: {
          accessToken: "at-global",
          refreshToken: "",
          region: "global",
        },
        model: "workbuddy-chat",
        messages: [{ role: "user", content: "hi" }],
        fetchImpl,
      }),
    ).resolves.toBe("ok");

    expect(calls[0].url).toBe("https://www.workbuddy.ai/v2/chat/completions");
    const headers = headersOf(calls[0]);
    expect(headers["User-Agent"]).toBe("WorkBuddy/5.5.2 WorkBuddy/5.5.2");
    expect(headers["X-IDE-Version"]).toBe("5.5.2");
    expect(headers.Origin).toBe("https://www.workbuddy.ai");
    expect(headers.Referer).toBe("https://www.workbuddy.ai/");
    expect(headers["X-No-User-Id"]).toBe("1");
    expect(headers["X-No-Enterprise-Id"]).toBe("1");
    expect(headers["X-No-Department-Info"]).toBe("1");
    expect(headers["X-Domain"]).toBeUndefined();
  });

  it("上游错误转成中文 Error，且不泄露 access/refresh token", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ code: 14018, msg: "额度已用尽，请购买加量包" }, 429),
    );

    const error = await workbuddyChat({
      credential: CN_CREDENTIAL,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    }).catch((reason: unknown) => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      "WorkBuddy 模型接口请求失败（HTTP 429）：额度已用尽，请购买加量包",
    );
    expect(error.message).not.toContain("at-cn-secret");
    expect(error.message).not.toContain("rt-cn-secret");
  });

  it("401 时提示重新授权并带 OAUTH_INVALID", async () => {
    const { fetchImpl } = mockFetch(() =>
      jsonResponse({ code: 401, msg: "unauthorized" }, 401),
    );

    const error = await workbuddyChat({
      credential: CN_CREDENTIAL,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    }).catch((reason: unknown) => reason as Error & { code?: string });

    expect(error.message).toContain("重新授权");
    expect(error.code).toBe("OAUTH_INVALID");
  });
});
