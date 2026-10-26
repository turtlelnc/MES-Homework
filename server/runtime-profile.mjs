import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";

const MiB = 1024 ** 2;
// These are allocation policies, not claims about the machine's capacity.
export const allocationPolicy = Object.freeze({
  heapFraction: 1 / 4,
  rssFraction: 1 / 2,
  inlineFraction: 1 / 32,
  parserHeapFraction: 1 / 16,
  parserRssFraction: 1 / 8,
});
const positive = (value) => Number.isFinite(value) && value > 0;
export function detectRuntime({
  totalMemory = os.totalmem(),
  freeMemory = os.freemem(),
  constrainedMemory = process.constrainedMemory?.(),
  parallelism = os.availableParallelism(),
  platform = process.platform,
  read = (file) => {
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(32768);
      return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString();
    } finally {
      fs.closeSync(fd);
    }
  },
  cgroupMount = "/sys/fs/cgroup",
} = {}) {
  let memoryBytes = Math.min(
      totalMemory,
      positive(constrainedMemory) ? constrainedMemory : totalMemory,
    ),
    cpuCapacity = parallelism;
  const sources = positive(constrainedMemory)
    ? ["os", "node.constrainedMemory"]
    : ["os"];
  let availableBytes = Math.min(freeMemory, memoryBytes);
  const optional = (file) => {
    try {
      return read(file).trim();
    } catch {
      return null;
    }
  };
  if (platform === "linux") {
    const relative = optional("/proc/self/cgroup")?.match(/^0::([^\n]*)/m)?.[1];
    let group =
      relative === undefined
        ? cgroupMount
        : path.resolve(cgroupMount, "." + relative);
    if (!group.startsWith(cgroupMount + path.sep) && group !== cgroupMount)
      group = cgroupMount;
    if (optional(path.join(group, "memory.max")) === null) group = cgroupMount;
    while (group === cgroupMount || group.startsWith(cgroupMount + path.sep)) {
      const max = Number(optional(path.join(group, "memory.max")));
      if (positive(max)) {
        memoryBytes = Math.min(memoryBytes, max);
        const used = Number(optional(path.join(group, "memory.current")));
        const inactive = Number(
          optional(path.join(group, "memory.stat"))?.match(
            /^inactive_file (\d+)/m,
          )?.[1] || 0,
        );
        if (positive(used))
          availableBytes = Math.min(
            availableBytes,
            Math.max(0, max - Math.max(0, used - inactive)),
          );
        if (!sources.includes("cgroup")) sources.push("cgroup");
      }
      const [quota, period] = (optional(path.join(group, "cpu.max")) || "")
        .split(/\s+/)
        .map(Number);
      if (positive(quota) && positive(period))
        cpuCapacity = Math.min(cpuCapacity, quota / period);
      if (group === cgroupMount) break;
      group = path.dirname(group);
    }
    if (relative === undefined) {
      const membership = optional("/proc/self/cgroup") || "";
      for (const kind of ["memory", "cpu", "cpu,cpuacct"]) {
        const controller = kind === "memory" ? "memory" : "cpu";
        const entry = membership
          .split("\n")
          .find((line) => line.split(":")[1]?.split(",").includes(controller));
        if (!entry) continue;
        const base = path.join(cgroupMount, kind);
        let current = path.resolve(base, "." + entry.split(":")[2]);
        while (current === base || current.startsWith(base + path.sep)) {
          if (controller === "memory") {
            const limit = Number(
              optional(path.join(current, "memory.limit_in_bytes")),
            );
            const used = Number(
              optional(path.join(current, "memory.usage_in_bytes")),
            );
            if (positive(limit)) {
              memoryBytes = Math.min(memoryBytes, limit);
              if (positive(used))
                availableBytes = Math.min(
                  availableBytes,
                  Math.max(0, limit - used),
                );
            }
          } else {
            const quota = Number(
                optional(path.join(current, "cpu.cfs_quota_us")),
              ),
              period = Number(
                optional(path.join(current, "cpu.cfs_period_us")),
              );
            if (positive(quota) && positive(period))
              cpuCapacity = Math.min(cpuCapacity, quota / period);
          }
          if (current === base) break;
          current = path.dirname(current);
        }
      }
      sources.push("cgroup-v1-probe");
    }
  }
  return {
    memoryBytes,
    availableBytes: Math.min(memoryBytes, availableBytes),
    cpuCapacity,
    cpuWorkers: Math.max(1, Math.floor(cpuCapacity)),
    sources,
    detectedAt: Date.now(),
  };
}
export function deriveRuntime(detected, env = process.env) {
  const memoryMiB = Math.floor(detected.memoryBytes / MiB);
  const setting = (name, fallback, max = Number.MAX_SAFE_INTEGER) => {
    const raw = env[name];
    if (
      raw !== undefined &&
      raw !== "" &&
      (!Number.isSafeInteger(Number(raw)) || Number(raw) <= 0)
    )
      throw new Error(`${name} 必须为正整数`);
    return Math.max(
      1,
      Math.min(
        max,
        raw === undefined || raw === "" ? Math.floor(fallback) : Number(raw),
      ),
    );
  };
  const heapMiB = setting(
    "SERVICE_HEAP_MB",
    memoryMiB * allocationPolicy.heapFraction,
    Math.floor(memoryMiB / 2),
  );
  const rssMiB = setting(
    "SERVICE_RSS_SOFT_MB",
    memoryMiB * allocationPolicy.rssFraction,
    Math.floor((memoryMiB * 3) / 4),
  );
  const inlineMiB = setting(
    "MODEL_INLINE_BUDGET_MB",
    memoryMiB * allocationPolicy.inlineFraction,
    Math.min(256, Math.floor(heapMiB / 4)),
  );
  const modelConcurrency = setting(
    "MODEL_GLOBAL_CONCURRENCY",
    detected.cpuWorkers,
    Math.max(
      1,
      Math.floor(
        heapMiB /
          8 /
          (Math.min(
            Number(env.MODEL_RESPONSE_MAX_BYTES) || 2 * 1024 ** 2,
            8 * 1024 ** 2,
          ) /
            MiB),
      ),
    ),
  );
  const ocrConcurrency = setting(
    "OCR_CONCURRENCY",
    modelConcurrency,
    modelConcurrency,
  );
  const httpActive = setting(
    "HTTP_MAX_ACTIVE_REQUESTS",
    detected.cpuWorkers * 8,
    Math.max(1, Math.floor(heapMiB / 2)),
  );
  const jsonConcurrency = setting(
    "HTTP_JSON_CONCURRENCY",
    detected.cpuWorkers * 4,
    Math.max(1, Math.floor(heapMiB / 8 / 2)),
  );
  const httpConnections = setting(
    "HTTP_MAX_CONNECTIONS",
    httpActive * 4,
    Math.max(1, Math.floor((heapMiB * MiB) / 8 / (64 * 1024 * 2 + 16384))),
  );
  const nativePool = setting("UV_THREADPOOL_SIZE", 4, 128); // Node's documented libuv default.
  return {
    ...detected,
    memoryMiB,
    heapMiB,
    rssMiB,
    inlineMiB,
    httpActive,
    jsonConcurrency,
    httpConnections,
    modelConcurrency,
    ocrConcurrency,
    schoolConcurrency: setting(
      "MODEL_SCHOOL_CONCURRENCY",
      modelConcurrency,
      modelConcurrency,
    ),
    staffConcurrency: setting(
      "MODEL_STAFF_CONCURRENCY",
      modelConcurrency,
      modelConcurrency,
    ),
    ocrUserConcurrency: setting(
      "OCR_USER_CONCURRENCY",
      ocrConcurrency,
      ocrConcurrency,
    ),
    uploadConcurrency: setting(
      "UPLOAD_CONCURRENCY",
      Math.min(detected.cpuWorkers, Math.floor(inlineMiB / 44)),
      Math.max(1, Math.floor(rssMiB / 50)),
    ),
    hashConcurrency: setting(
      "PASSWORD_CONCURRENCY",
      Math.min(
        detected.cpuWorkers,
        Math.max(1, nativePool - 1),
        Math.max(1, Math.floor(heapMiB / 32)),
      ),
      Math.max(1, nativePool - 1),
    ),
    parserHeapMiB: setting(
      "PARSER_HEAP_MB",
      memoryMiB * allocationPolicy.parserHeapFraction,
      heapMiB,
    ),
    parserRssMiB: setting(
      "PARSER_RSS_MB",
      memoryMiB * allocationPolicy.parserRssFraction,
      rssMiB,
    ),
    v8HeapLimitMiB: Math.floor(v8.getHeapStatistics().heap_size_limit / MiB),
    allocationPolicy,
  };
}
let cached;
export const runtimeProfile = () => deriveRuntime((cached ||= detectRuntime()));
