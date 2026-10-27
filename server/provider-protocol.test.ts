import { expect, it } from "vitest";
import { providerRequest, providerReply } from "./provider-protocol.mjs";
it("uses Anthropic authentication, image blocks, response text and actual usage instead of guessing OpenAI compatibility", () => {
  const config = { provider: "anthropic", model: "explicit-model" };
  const request = providerRequest(
    config,
    [
      { type: "text", text: "grade" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,YWJj" } },
    ],
    "dummy",
    123,
  );
  expect(request.headers).toMatchObject({
    "x-api-key": "dummy",
    "anthropic-version": "2023-06-01",
  });
  expect(request.headers).not.toHaveProperty("authorization");
  expect(request.body.messages[0].content[1]).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "YWJj" },
  });
  expect(request.body).not.toHaveProperty("response_format");
  expect(request.body.max_tokens).toBe(123);
  expect(
    providerReply(config, {
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: { input_tokens: 88, output_tokens: 17 },
    }),
  ).toEqual({
    text: '{"ok":true}',
    usage: { prompt_tokens: 88, completion_tokens: 17 },
  });
});
it("preserves OpenAI-compatible non-streaming requests and returned usage", () => {
  const request = providerRequest(
    { provider: "deepseek", model: "explicit" },
    "grade",
    "dummy",
    456,
  );
  expect(request.headers.authorization).toBe("Bearer dummy");
  expect(request.body.stream).toBe(false);
  const raw = {
    choices: [{ message: { content: "answer" } }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
  expect(providerReply({ provider: "deepseek" }, raw)).toEqual({
    text: "answer",
    usage: raw.usage,
  });
});

it("classifies upstream failures without reflecting keys or submitted content", async () => {
  const { providerHttpError } = await import("./provider-protocol.mjs");
  for (const [status, raw, hint] of [
    [401, null, "API Key"],
    [402, null, "余额"],
    [
      400,
      {
        error: {
          code: "model_not_found",
          message: "private-homework secret-credential",
        },
      },
      "模型名称",
    ],
    [400, { error: { message: "maximum context length exceeded" } }, "上下文"],
    [429, null, "限流"],
    [503, null, "暂时不可用"],
    [404, null, "接口路径"],
  ] as const) {
    const error = providerHttpError(status, raw);
    expect(error.message).toContain(hint);
    expect(error.message).not.toMatch(/private-homework|secret-credential/);
    expect(error.retryable).toBe(status === 429 || status >= 500);
  }
});

it("rejects truncated or filtered completions before parsing partial JSON", async () => {
  const { assertProviderCompletion } = await import("./provider-protocol.mjs");
  for (const [config, raw] of [
    [
      { provider: "deepseek" },
      {
        choices: [
          {
            finish_reason: "length",
            message: { reasoning_content: "private reasoning", content: "" },
          },
        ],
      },
    ],
    [{ provider: "anthropic" }, { stop_reason: "max_tokens" }],
  ])
    expect(() => assertProviderCompletion(config, raw)).toThrow(/被截断/);
  expect(() =>
    assertProviderCompletion(
      { provider: "deepseek" },
      { choices: [{ finish_reason: "content_filter" }] },
    ),
  ).toThrow(/拒绝/);
  expect(() =>
    assertProviderCompletion(
      { provider: "deepseek" },
      { choices: [{ finish_reason: "stop" }] },
    ),
  ).not.toThrow();
});

it("bounds non-streaming generation by the total deadline rather than a shorter default body-idle timeout", async () => {
  const { modelResponseLimits } = await import("./provider-protocol.mjs");
  expect(modelResponseLimits({})).toMatchObject({
    timeoutMs: 60000,
    idleMs: 60000,
  });
  expect(
    modelResponseLimits({ MODEL_REQUEST_TIMEOUT_MS: "120000" }),
  ).toMatchObject({ timeoutMs: 120000, idleMs: 120000 });
  expect(
    modelResponseLimits({
      MODEL_REQUEST_TIMEOUT_MS: "200",
      MODEL_RESPONSE_IDLE_MS: "300",
    }),
  ).toMatchObject({ timeoutMs: 200, idleMs: 200 });
  expect(modelResponseLimits({ MODEL_RESPONSE_IDLE_MS: "15000" }).idleMs).toBe(
    15000,
  );
  expect(
    modelResponseLimits({
      MODEL_REQUEST_TIMEOUT_MS: "999999",
      MODEL_RESPONSE_MAX_BYTES: "999999999",
    }),
  ).toMatchObject({ timeoutMs: 120000, maxBytes: 8 * 1024 ** 2 });
});

it("accepts copied credential whitespace for existing saved configurations", () => {
  const request = providerRequest(
    { provider: "deepseek", model: "deepseek-flash" },
    "Return JSON: {}",
    " mock-key\r\n",
    128,
  );
  expect(request.headers.authorization).toBe("Bearer mock-key");
  expect(request.body.model).toBe("deepseek-flash");
  expect(providerReply({ provider: "deepseek" }, null)).toEqual({
    text: undefined,
    usage: undefined,
  });
});
