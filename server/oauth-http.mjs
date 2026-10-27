import { abortable, ioError } from "./io-guards.mjs";

// OAuth grants and SSE responses need the same hard lifetime and buffering
// bounds as API-key requests. A fetch timeout alone does not bound body reads.
export async function oauthFetch(
  url,
  options = {},
  {
    request = (...args) => fetch(...args),
    timeoutMs = 30000,
    maxBytes = 65536,
  } = {},
) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(ioError("OAuth 上游请求超时")),
    timeoutMs,
  );
  let response, reader;
  try {
    signal.throwIfAborted();
    response = await abortable(
      request(url, { ...options, redirect: "error", signal }),
      signal,
    );
    let text;
    if (response.body?.getReader) {
      const declared = response.headers?.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
        throw ioError("OAuth 上游响应超过大小上限", "RESPONSE_TOO_LARGE");
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes)
          throw ioError("OAuth 上游响应超过大小上限", "RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(part.value));
      }
      text = Buffer.concat(chunks, size).toString("utf8");
    } else {
      // Compatibility with injected, trusted test doubles without a Web stream.
      text =
        typeof response.text === "function"
          ? await abortable(response.text(), signal)
          : JSON.stringify(await abortable(response.json(), signal));
      if (Buffer.byteLength(text) > maxBytes)
        throw ioError("OAuth 上游响应超过大小上限", "RESPONSE_TOO_LARGE");
    }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel?.().catch(() => {});
  }
}
