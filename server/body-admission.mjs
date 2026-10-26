import { runtimeProfile } from "./runtime-profile.mjs";
import { watchUpload } from "./io-guards.mjs";

// Body-parser's per-request limit alone permits N concurrent 2 MiB buffers.
// Bound their aggregate admission too, before allocating those buffers.
export function limitJsonBodies({
  concurrency = runtimeProfile().jsonConcurrency,
} = {}) {
  let active = 0;
  return (req, res, next) => {
    if (!req.is("application/json")) return next();
    const maxBytes = 2 * 1024 * 1024;
    const length = req.get("content-length");
    const status =
      length !== undefined && Number(length) > maxBytes
        ? 413
        : active >= concurrency
          ? 503
          : null;
    if (status)
      return res
        .set("Connection", "close")
        .set("Retry-After", "5")
        .status(status)
        .json({
          error:
            status === 413 ? "请求体超过大小限制" : "请求接收繁忙，请稍后重试",
        });
    active++;
    const watch = watchUpload(req, { maxBytes, totalMs: 10000, idleMs: 5000 });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      watch.stop();
    };
    req.once("end", release);
    req.once("aborted", release);
    req.once("error", release);
    res.once("close", release);
    next();
  };
}
