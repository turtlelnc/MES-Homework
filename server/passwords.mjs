import { runtimeProfile } from "./runtime-profile.mjs";
import { scrypt } from "node:crypto";

// Native hashing uses libuv workers; bounded admission reserves room for file I/O.
// A cancelled hash retains its slot until the native operation actually returns.
export function createPasswordHasher({
  concurrency = runtimeProfile().hashConcurrency,
  maxPending = 16,
  derive = (password, salt) =>
    new Promise((resolve, reject) =>
      scrypt(password, salt, 64, (error, key) =>
        error ? reject(error) : resolve(key.toString("hex")),
      ),
    ),
} = {}) {
  let active = 0;
  const pending = [];
  function pump() {
    while (active < concurrency && pending.length) {
      const index = pending.findIndex((job) => !job.batch);
      const job = pending.splice(index < 0 ? 0 : index, 1)[0];
      job.signal?.removeEventListener("abort", job.abort);
      if (job.signal?.aborted) {
        job.reject(job.signal.reason);
        continue;
      }
      active++;
      const cancel = () => job.reject(job.signal.reason);
      job.signal?.addEventListener("abort", cancel, { once: true });
      Promise.resolve()
        .then(() => derive(job.password, job.salt))
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          job.signal?.removeEventListener("abort", cancel);
          pump();
        });
    }
  }
  function hash(password, salt, { signal, batch = false } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (typeof password !== "string" || Buffer.byteLength(password) > 1024)
      return Promise.reject(
        Object.assign(new Error("密码格式无效"), { status: 400 }),
      );
    if (pending.length >= maxPending)
      return Promise.reject(
        Object.assign(new Error("认证繁忙，请稍后重试"), {
          status: 503,
          code: "AUTH_BUSY",
        }),
      );
    return new Promise((resolve, reject) => {
      const job = {
        password,
        salt,
        signal,
        batch,
        resolve,
        reject,
        abort: null,
      };
      job.abort = () => {
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", job.abort, { once: true });
      pending.push(job);
      pump();
    });
  }
  return {
    hash,
    snapshot: () => ({
      active,
      pending: pending.length,
      concurrency,
      maxPending,
    }),
  };
}
