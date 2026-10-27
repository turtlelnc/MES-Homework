import { expect, it } from "vitest";
import { oauthFetch } from "./oauth-http.mjs";

it("bounds OAuth body bytes and cancels oversized SSE without parsing credentials", async () => {
  let cancelled = false;
  await expect(
    oauthFetch(
      "https://mock.invalid",
      {},
      {
        maxBytes: 1024,
        request: async () =>
          new Response(
            new ReadableStream({
              pull(c) {
                c.enqueue(new Uint8Array(800));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      },
    ),
  ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  expect(cancelled).toBe(true);
});

it("bounds OAuth response-body time after headers have arrived", async () => {
  let cancelled = false;
  await expect(
    oauthFetch(
      "https://mock.invalid",
      {},
      {
        timeoutMs: 20,
        request: async () =>
          new Response(
            new ReadableStream({
              start() {},
              cancel() {
                cancelled = true;
              },
            }),
          ),
      },
    ),
  ).rejects.toMatchObject({ code: "IO_TIMEOUT" });
  expect(cancelled).toBe(true);
});

it("propagates cancellation while waiting for headers and remains usable", async () => {
  const controller = new AbortController();
  const call = oauthFetch(
    "https://mock.invalid",
    { signal: controller.signal },
    { request: () => new Promise(() => {}) },
  );
  controller.abort(new Error("caller cancelled"));
  await expect(call).rejects.toThrow("caller cancelled");
  const result = await oauthFetch(
    "https://mock.invalid",
    {},
    { request: async () => Response.json({ ok: true }) },
  );
  expect(await result.json()).toEqual({ ok: true });
});
