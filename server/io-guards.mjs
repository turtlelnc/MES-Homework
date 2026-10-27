// Bound both response buffering and the lifetime of upstream connections.
export const ioError = (message, code = "IO_TIMEOUT") =>
  Object.assign(new Error(message), { code, status: 502 });
export const databaseBusy = (error) =>
  ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error?.code) ||
  (Number.isInteger(error?.errcode) && [5, 6].includes(error.errcode & 255));
export const storageStatus = (error) =>
  databaseBusy(error)
    ? 503
    : error?.code === "ENOSPC" || error?.code === "EDQUOT"
      ? 507
      : ["EIO", "EROFS", "EMFILE", "ENFILE"].includes(error?.code)
        ? 503
        : null;

export function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    void Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function requestJson(
  url,
  options,
  {
    request = (...args) => fetch(...args),
    timeoutMs = 60000,
    idleMs = 15000,
    maxBytes = 2 * 1024 * 1024,
    errorMaxBytes = 0,
  } = {},
) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(ioError("模型接口请求超时")),
    timeoutMs,
  );
  let reader, idle, response;
  try {
    signal.throwIfAborted();
    response = await abortable(request(url, { ...options, signal }), signal);
    if (!response.ok && !errorMaxBytes) {
      void response.body?.cancel().catch(() => {});
      return { response, body: null };
    }
    const limit = response.ok ? maxBytes : Math.min(errorMaxBytes, maxBytes);
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > limit)
    ) {
      if (!response.ok) return { response, body: null };
      else throw ioError("模型接口响应超过大小上限", "RESPONSE_TOO_LARGE");
    }
    reader = response.body?.getReader();
    if (!reader) {
      if (!response.ok) return { response, body: null };
      throw ioError("模型接口返回空响应", "INVALID_RESPONSE");
    }
    let size = 0;
    const chunks = [];
    while (true) {
      idle = setTimeout(
        () => controller.abort(ioError("模型接口响应长时间无进展")),
        idleMs,
      );
      let part;
      try {
        part = await abortable(reader.read(), signal);
      } catch (error) {
        if (!response.ok && !options.signal?.aborted)
          return { response, body: null };
        throw error;
      } finally {
        clearTimeout(idle);
      }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        if (!response.ok) return { response, body: null };
        throw ioError("模型接口响应超过大小上限", "RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(part.value));
    }
    try {
      return {
        response,
        body: JSON.parse(Buffer.concat(chunks, size).toString("utf8")),
      };
    } catch {
      if (!response.ok) return { response, body: null };
      throw ioError(
        "模型接口未返回有效 JSON 响应，请检查接口地址",
        "INVALID_RESPONSE",
      );
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(idle);
    controller.abort(ioError("模型接口连接已结束"));
    if (reader) void reader.cancel().catch(() => {});
    else void response?.body?.cancel().catch(() => {});
  }
}

// Watches request ingestion only; downstream work gets its own deadline.
// The socket is destroyed on timeout so parsers and pipeline writers see abort.
export function watchUpload(
  req,
  { maxBytes, totalMs = 60000, idleMs = 15000 } = {},
) {
  const controller = new AbortController();
  let bytes = 0,
    idle,
    stopped = false;
  const fail = (error) => {
    if (controller.signal.aborted) return;
    controller.abort(error);
    stop();
    req.destroy(error);
  };
  const reset = () => {
    clearTimeout(idle);
    idle = setTimeout(() => fail(ioError("上传长时间无进展")), idleMs);
  };
  const onData = (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) fail(ioError("上传超过大小上限", "UPLOAD_TOO_LARGE"));
    else reset();
  };
  const onAborted = () => fail(ioError("上传连接已断开", "UPLOAD_ABORTED"));
  const onClose = () => {
    if (!req.complete) onAborted();
  };
  const onError = () => {};
  const timer = setTimeout(() => fail(ioError("上传超过总时长上限")), totalMs);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(idle);
    req.off("data", onData);
    req.off("end", stop);
    req.off("aborted", onAborted);
    req.off("close", onClose);
    // Keep the error sink: destroy(error) emits asynchronously after cleanup.
  }
  req.on("error", onError);
  req.on("data", onData);
  req.once("end", stop);
  req.once("aborted", onAborted);
  req.once("close", onClose);
  reset();
  return {
    signal: controller.signal,
    stop,
    get bytes() {
      return bytes;
    },
  };
}
