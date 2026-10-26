import { runtimeProfile } from "./runtime-profile.mjs";
import fs from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createSystemSampler, pressureLevel } from "./system-pressure.mjs";
const uploadError = (message, status) =>
  Object.assign(new Error(message), { status });

// A single async probe prevents slow statfs calls from accumulating in libuv.
// Stale or failed probes close admission; they never block the HTTP event loop.
export function createResourcePressure(
  dataDir,
  {
    probe = () => fs.promises.statfs(dataDir),
    rss = () => process.memoryUsage.rss(),
    now = Date.now,
    systemProbe = process.env.SYSTEM_PRESSURE_ENABLED === "0"
      ? async () => ({ supported: false })
      : createSystemSampler(),
    lag = null,
    recoveryMs = 30000,
    publish = true,
  } = {},
) {
  const rssLimit = runtimeProfile().rssMiB * 1024 ** 2;
  const delay = lag ? null : monitorEventLoopDelay({ resolution: 20 });
  delay?.enable();
  let sample = { supported: false },
    sampledAt = 0,
    systemPending,
    level = 0,
    reasons = [],
    recoveringAt = null,
    reportPending;
  const levelNow = () => {
    if (rss() >= rssLimit || (sample.supported && now() - sampledAt > 15000)) {
      level = 2;
      recoveringAt = null;
    }
    return level;
  };
  function snapshot() {
    return {
      version: 1,
      updatedAt: now(),
      sampledAt,
      level: ["normal", "limited", "critical"][levelNow()],
      reasons: [
        ...reasons,
        ...(rss() >= rssLimit ? ["process_rss"] : []),
        ...(sample.supported && now() - sampledAt > 15000
          ? ["monitor_stale"]
          : []),
      ],
      rssMiB: Math.round(rss() / 1024 ** 2),
      diskFreeMiB:
        disk === undefined
          ? null
          : Math.floor(Math.max(0, disk - diskDebt) / 1024 ** 2),
      diskReserveMiB: Math.ceil(diskReserve / 1024 ** 2),
      systemSupported: sample.supported,
      availableMiB: sample.supported
        ? Math.round(sample.availableBytes / 1024 ** 2)
        : null,
      budgetMiB: sample.supported
        ? Math.round(sample.totalBytes / 1024 ** 2)
        : null,
    };
  }
  function report() {
    if (!publish || reportPending || closed) return;
    const target = path.join(dataDir, ".resource-pressure.json"),
      temp = target + ".tmp";
    reportPending = fs.promises
      .writeFile(temp, JSON.stringify(snapshot()), { mode: 0o600 })
      .then(() => fs.promises.rename(temp, target))
      .catch(() => {})
      .finally(() => {
        reportPending = null;
      });
  }
  function refreshSystem() {
    if (closed || systemPending) return systemPending;
    systemPending = Promise.resolve()
      .then(systemProbe)
      .then(
        (value) => {
          sample = value;
          sampledAt = now();
          const lagMs = lag ? lag() : (delay?.percentile(95) || 0) / 1e6;
          delay?.reset();
          const candidate = pressureLevel(sample, lagMs);
          if (rss() >= rssLimit) {
            candidate.level = 2;
            candidate.reasons.push("process_rss");
          }
          reasons = candidate.reasons;
          if (candidate.level >= level) {
            level = candidate.level;
            recoveringAt = null;
          } else {
            reasons.push("recovery_wait");
            recoveringAt ??= now();
            if (now() - recoveringAt >= recoveryMs) {
              level--;
              recoveringAt = now();
            }
          }
          report();
        },
        () => {
          if (sample.supported) reasons = ["monitor_unavailable"];
        },
      )
      .finally(() => {
        systemPending = null;
      });
    return systemPending;
  }
  let diskDebt = 0,
    diskReserve = 0;
  let disk,
    checkedAt = 0,
    pending,
    closed = false;
  function refresh() {
    if (pending || closed) return pending;
    const debtAtStart = diskDebt;
    pending = Promise.resolve()
      .then(probe)
      .then(
        (value) => {
          disk = value.bavail * value.bsize;
          diskReserve = process.env.DISK_MIN_FREE_MB
            ? Number(process.env.DISK_MIN_FREE_MB) * 1024 ** 2
            : Math.max(
                value.bsize,
                Math.floor(((value.blocks || value.bavail) * value.bsize) / 20),
              );
          diskDebt -= debtAtStart;
          checkedAt = now();
        },
        () => {
          disk = undefined;
        },
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  function assertMemory() {
    const current = levelNow();
    if (rss() >= rssLimit) throw uploadError("服务器内存繁忙，请稍后重试", 503);
    if (current === 2) throw uploadError("服务器资源繁忙，请稍后重试", 503);
  }
  function assertUpload(reservedBytes = 0) {
    assertMemory();
    if (disk === undefined || now() - checkedAt > 15000)
      throw uploadError("存储暂不可用，请稍后重试", 503);
    if (disk - diskDebt <= reservedBytes + diskReserve)
      throw uploadError("服务器可用空间不足，暂不能接收文件", 507);
  }
  const ready = Promise.all([refresh(), refreshSystem()]);
  const timer = setInterval(() => {
    refresh();
    refreshSystem();
  }, 5000);
  timer.unref();
  return {
    assertMemory,
    assertUpload,
    chargeDisk(bytes) {
      diskDebt += bytes;
    },
    ready,
    refresh,
    refreshSystem,
    snapshot,
    limit(configured) {
      return levelNow() === 2
        ? 0
        : levelNow() === 1
          ? Math.min(1, configured)
          : configured;
    },
    assertParser() {
      assertMemory();
      if (levelNow() !== 0) throw uploadError("资源紧张，暂缓文件解析", 503);
    },
    stop() {
      closed = true;
      clearInterval(timer);
      delay?.disable();
    },
  };
}
