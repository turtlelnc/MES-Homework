import { runtimeProfile } from "./runtime-profile.mjs";
import { fork } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

let active = 0;
// Native PDF/Word parsers run in a separate process: a native crash must not
// crash the API. Heap and sampled RSS limits complement the service cgroup.
export function recognitionFiles(
  files,
  signal,
  {
    entry = new URL("./recognition-files-worker.mjs", import.meta.url),
    rssMB = runtimeProfile().parserRssMiB,
    intervalMs = 250,
    admission = () => {},
  } = {},
) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (
    files.length > 0 &&
    files.length <= 10 &&
    files.every((file) =>
      ["image/jpeg", "image/png", "image/webp"].includes(file.file_type),
    )
  )
    return Promise.resolve({
      images: files.map((file) => ({
        filePath: file.file_path,
        mimeType: file.file_type,
      })),
      documentText: "",
      warnings: [],
    });
  if (active >= 1)
    return Promise.reject(
      Object.assign(new Error("文件解析繁忙，请稍后重试"), {
        status: 503,
        code: "MODEL_BUSY",
      }),
    );
  try {
    admission();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = fork(
      entry instanceof URL ? fileURLToPath(entry) : entry,
      [],
      {
        execArgv: [`--max-old-space-size=${runtimeProfile().parserHeapMiB}`],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    active++;
    let counted = true;
    const release = () => {
      if (counted) {
        active--;
        counted = false;
      }
    };
    let settled = false,
      probing = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      clearTimeout(deadline);
      clearInterval(monitor);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(signal.reason || new Error("文件处理已取消"));
    const deadline = setTimeout(
      () => finish(new Error("文件解析超时")),
      120000,
    );
    const monitor = setInterval(async () => {
      if (probing || settled || process.platform !== "linux" || !child.pid)
        return;
      probing = true;
      try {
        const status = await fs.promises.readFile(
          `/proc/${child.pid}/status`,
          "utf8",
        );
        const kb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1] || 0);
        if (kb > rssMB * 1024)
          finish(new Error("文件解析内存超限，请拆分或压缩文件"));
      } catch {
        /* Exit is handled below. */
      } finally {
        probing = false;
      }
    }, intervalMs);
    monitor.unref();
    child.once("message", (message) =>
      finish(message.error ? new Error(message.error) : null, message.result),
    );
    child.once("error", (error) => {
      release();
      finish(error);
    });
    child.once("exit", (code) => {
      release();
      finish(new Error(`文件处理进程退出 (${code})`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.send(files, (error) => {
      if (error) finish(error);
    });
  });
}
