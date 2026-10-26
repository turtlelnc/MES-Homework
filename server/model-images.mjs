import { runtimeProfile } from "./runtime-profile.mjs";
import fs from "node:fs";

// Account for Base64 characters before allocating file buffers/JSON strings.
// This is a work budget, not an exact measurement of V8/RSS memory.
export function createModelImages({
  maxBytes = runtimeProfile().inlineMiB * 1024 ** 2,
} = {}) {
  let activeBytes = 0;
  const singleLimit = 44 * 1024 ** 2;
  return {
    async acquire(images, signal) {
      let bytes = 0;
      for (const image of images) {
        signal?.throwIfAborted();
        const size = image.base64
          ? image.base64.length
          : 4 * Math.ceil((await fs.promises.stat(image.filePath)).size / 3);
        bytes += size;
        if (!Number.isSafeInteger(bytes) || bytes > singleLimit)
          throw new Error("内联图片合计过大，请减少页数或启用 Files API");
      }
      signal?.throwIfAborted();
      if (bytes > maxBytes)
        throw new Error("图片超过当前内联预算，请减少页数或启用 Files API");
      if (activeBytes + bytes > maxBytes)
        throw Object.assign(new Error("图片处理预算繁忙，请稍后重试"), {
          status: 429,
          code: "MODEL_BUSY",
        });
      activeBytes += bytes;
      let released = false;
      return {
        maxBytes: bytes,
        release() {
          if (!released) {
            activeBytes -= bytes;
            released = true;
          }
        },
      };
    },
    snapshot: () => ({ activeBytes, maxBytes }),
  };
}
