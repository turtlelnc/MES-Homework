import { expect, it } from "vitest";
import { requestJson } from "./io-guards.mjs";

it("cancels an oversized chunked response without buffering it all", async () => {
  let cancelled = false,
    reads = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(512));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(
    requestJson(
      "https://mock.invalid",
      {},
      {
        request: async () => response,
        maxBytes: 1024,
      },
    ),
  ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(cancelled).toBe(true);
  expect(reads).toBeLessThanOrEqual(5);
});

it("times out a stalled response body and closes the underlying reader", async () => {
  let cancelled = false,
    signal: AbortSignal;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(
    requestJson(
      "https://mock.invalid",
      {},
      {
        request: async (_url, options) => {
          signal = options.signal;
          return response;
        },
        idleMs: 20,
        timeoutMs: 200,
      },
    ),
  ).rejects.toMatchObject({ code: "IO_TIMEOUT" });
  expect(cancelled).toBe(true);
  expect(signal!.aborted).toBe(true);
});

it("aborts while waiting for headers and remains usable on the next request", async () => {
  await expect(
    requestJson(
      "https://mock.invalid",
      {},
      {
        request: () => new Promise(() => {}),
        timeoutMs: 20,
      },
    ),
  ).rejects.toMatchObject({ code: "IO_TIMEOUT" });
  const { body } = await requestJson(
    "https://mock.invalid",
    {},
    {
      request: async () => Response.json({ recovered: true }),
    },
  );
  expect(body).toEqual({ recovered: true });
});

it("cancels error bodies without consuming unbounded provider diagnostics", async () => {
  let cancelled = false;
  const { response, body } = await requestJson(
    "https://mock.invalid",
    {},
    {
      request: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        ),
    },
  );
  expect(response.status).toBe(503);
  expect(body).toBeNull();
  expect(cancelled).toBe(true);
});

it("propagates caller cancellation even when the provider never responds", async () => {
  const controller = new AbortController();
  const call = requestJson(
    "https://mock.invalid",
    { signal: controller.signal },
    {
      request: () => new Promise(() => {}),
    },
  );
  controller.abort(new Error("client disconnected"));
  await expect(call).rejects.toThrow("client disconnected");
});

it("reads only bounded error JSON for safe provider classification", async () => {
  const { body, response } = await requestJson(
    "https://mock.invalid",
    {},
    {
      request: async () =>
        Response.json({ error: { code: "model_not_found" } }, { status: 400 }),
      errorMaxBytes: 1024,
    },
  );
  expect(response.status).toBe(400);
  expect(body).toEqual({ error: { code: "model_not_found" } });
});

it("preserves upstream status when error diagnostics overflow, stall, or are not JSON", async () => {
  for (const variant of ["oversize", "declared", "stall", "html", "empty"]) {
    let cancelled = false;
    const response =
      variant === "empty"
        ? new Response(null, { status: 402 })
        : new Response(
            new ReadableStream({
              start(controller) {
                if (variant === "stall") return;
                controller.enqueue(
                  new TextEncoder().encode(
                    variant === "html"
                      ? "<html>Bad gateway</html>"
                      : "x".repeat(2048),
                  ),
                );
                if (variant === "html") controller.close();
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: 402,
              headers:
                variant === "declared" ? { "content-length": "2048" } : {},
            },
          );
    const result = await requestJson(
      "https://mock.invalid",
      {},
      {
        request: async () => response,
        errorMaxBytes: 1024,
        idleMs: 20,
        timeoutMs: 200,
      },
    );
    expect(result.response.status).toBe(402);
    expect(result.body).toBeNull();
    if (!["empty", "html"].includes(variant)) expect(cancelled).toBe(true);
  }
});

it("waits for non-streaming generation while retaining a hard total deadline", async () => {
  const { modelResponseLimits } = await import("./provider-protocol.mjs");
  let timer;
  const result = await requestJson(
    "https://mock.invalid",
    {},
    {
      ...modelResponseLimits({ MODEL_REQUEST_TIMEOUT_MS: "200" }),
      request: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              timer = setTimeout(() => {
                controller.enqueue(new TextEncoder().encode('\n\n{"ok":true}'));
                controller.close();
              }, 40);
            },
            cancel() {
              clearTimeout(timer);
            },
          }),
        ),
    },
  );
  expect(result.body).toEqual({ ok: true });
  await expect(
    requestJson(
      "https://mock.invalid",
      {},
      {
        ...modelResponseLimits({ MODEL_REQUEST_TIMEOUT_MS: "30" }),
        request: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("\n"));
              },
            }),
          ),
      },
    ),
  ).rejects.toMatchObject({ code: "IO_TIMEOUT" });
});

it("does not expose response content in malformed-JSON parse errors", async () => {
  await expect(
    requestJson(
      "https://mock.invalid",
      {},
      {
        request: async () => new Response("private homework secret-key"),
      },
    ),
  ).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
    message: "模型接口未返回有效 JSON 响应，请检查接口地址",
  });
});
