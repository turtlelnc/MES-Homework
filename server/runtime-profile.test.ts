import { expect, it } from "vitest";
import { detectRuntime, deriveRuntime } from "./runtime-profile.mjs";
const GiB = 1024 ** 3;
it("reads cgroup v1 CPU quotas as well as Node's actual constrained memory", () => {
  const files: Record<string, string> = {
    "/proc/self/cgroup": "4:memory:/service\n3:cpu,cpuacct:/service",
    "/sys/fs/cgroup/cpu/service/cpu.cfs_quota_us": "50000",
    "/sys/fs/cgroup/cpu/service/cpu.cfs_period_us": "100000",
    "/sys/fs/cgroup/memory/service/memory.limit_in_bytes": String(GiB),
    "/sys/fs/cgroup/memory/service/memory.usage_in_bytes": String(GiB / 4),
  };
  const detected = detectRuntime({
    totalMemory: 64 * GiB,
    freeMemory: 32 * GiB,
    constrainedMemory: 0,
    parallelism: 64,
    platform: "linux",
    read: (file) => {
      if (!(file in files)) throw Error("missing");
      return files[file];
    },
  });
  expect(detected.memoryBytes).toBe(GiB);
  expect(detected.availableBytes).toBe((GiB * 3) / 4);
  expect(detected.cpuCapacity).toBe(0.5);
  expect(detected.cpuWorkers).toBe(1);
});
it("uses ancestor cgroup memory and CPU limits instead of host hardware or prior machine assumptions", () => {
  const files: Record<string, string> = {
    "/proc/self/cgroup": "0::/service",
    "/sys/fs/cgroup/service/memory.max": "8589934592",
    "/sys/fs/cgroup/service/cpu.max": "max 100000",
    "/sys/fs/cgroup/memory.max": "2147483648",
    "/sys/fs/cgroup/cpu.max": "150000 100000",
  };
  const result = detectRuntime({
    totalMemory: 64 * GiB,
    freeMemory: 32 * GiB,
    constrainedMemory: 0,
    parallelism: 32,
    platform: "linux",
    read: (file) => {
      if (!(file in files)) throw Error("missing");
      return files[file];
    },
  });
  expect(result.memoryBytes).toBe(2 * GiB);
  expect(result.cpuCapacity).toBe(1.5);
  expect(result.cpuWorkers).toBe(1);
  const profile = deriveRuntime(result, {});
  expect(profile.heapMiB).toBe(512);
  expect(profile.modelConcurrency).toBe(1);
  expect(profile.inlineMiB).toBe(64);
  expect(deriveRuntime(result, { SERVICE_HEAP_MB: "999999" }).heapMiB).toBe(
    1024,
  );
  expect(() =>
    deriveRuntime(result, { MODEL_GLOBAL_CONCURRENCY: "nonsense" }),
  ).toThrow(/正整数/);
});
it("uses the actual OS constraints on non-Linux systems and honors explicit limits without inventing a RAM fallback", () => {
  const result = detectRuntime({
    totalMemory: 8 * GiB,
    freeMemory: 3 * GiB,
    constrainedMemory: GiB,
    parallelism: 2,
    platform: "win32",
    read: () => {
      throw Error("no proc");
    },
  });
  expect(result.memoryBytes).toBe(GiB);
  const profile = deriveRuntime(result, {
    MODEL_GLOBAL_CONCURRENCY: "1",
    OCR_CONCURRENCY: "8",
    SERVICE_RSS_SOFT_MB: "128",
  });
  expect(profile.modelConcurrency).toBe(1);
  expect(profile.ocrConcurrency).toBe(1);
  expect(profile.rssMiB).toBe(128);
});
