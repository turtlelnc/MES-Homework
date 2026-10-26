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
