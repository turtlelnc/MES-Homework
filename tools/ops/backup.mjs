import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createBackupGate } from "./backup-pressure.mjs";
import { createBackup, verifyBackup, restoreBackup } from "./storage.mjs";
import { storageProfile } from "../../server/storage-profile.mjs";

const SNAPSHOT = /^snapshot-\d{8}T\d{9}Z-[a-f0-9-]{36}$/;
const read = (file) => {
  if (fs.statSync(file).size > 32 * 1024 * 1024)
    throw new Error("备份元数据过大");
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
function write(file, value) {
  const temp = file + ".tmp-" + randomUUID();
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  }
}
const positive = (value, fallback) => {
  const n = Number(value);
  if (value !== undefined && (!Number.isSafeInteger(n) || n <= 0))
    throw new Error("备份配置须为正整数");
  return value === undefined ? fallback : n;
};
export function backupSettings(env = process.env) {
  if (!env.DATA_DIR || !env.BACKUP_DIR)
    throw new Error("必须配置 DATA_DIR 和 BACKUP_DIR");
  const storage = storageProfile(env.BACKUP_DIR);
  const total =
    positive(
      env.BACKUP_MAX_TOTAL_MB,
      Math.max(1, Math.floor(storage.freeBytes / 4 / 1024 ** 2)),
    ) *
    1024 ** 2;
  return {
    source: path.resolve(env.DATA_DIR),
    pressureEnabled: env.SYSTEM_PRESSURE_ENABLED !== "0",
    root: path.resolve(env.BACKUP_DIR),
    recent: positive(env.BACKUP_KEEP_RECENT, 24),
    days: positive(env.BACKUP_KEEP_DAYS, 7),
    maxTotalBytes: total,
    maxSnapshotBytes: Math.min(
      positive(
        env.BACKUP_MAX_SNAPSHOT_MB,
        Math.max(1, Math.floor(total / 2 / 1024 ** 2)),
      ) *
        1024 ** 2,
      Math.floor(total / 2),
    ),
    minFreeBytes:
      positive(
        env.BACKUP_MIN_FREE_MB,
        Math.max(1, Math.ceil(storage.totalBytes / 20 / 1024 ** 2)),
      ) *
      1024 ** 2,
    drillDays: positive(env.BACKUP_RESTORE_DRILL_DAYS, 7),
  };
}
function lockRoot(root) {
  const lockFile = path.join(root, ".backup-lock.sqlite");
  if (fs.existsSync(lockFile) && fs.lstatSync(lockFile).isSymbolicLink())
    throw new Error("备份锁文件不能为符号链接");
  const db = new DatabaseSync(lockFile);
  try {
    fs.chmodSync(path.join(root, ".backup-lock.sqlite"), 0o600);
    db.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY); BEGIN IMMEDIATE",
    );
  } catch {
    db.close();
    throw new Error("已有备份或恢复演练正在运行，请稍后重试");
  }
  return () => {
    db.exec("ROLLBACK");
    db.close();
  };
}
function inventory(root, ownerId) {
  const rows = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SNAPSHOT.test(entry.name)) continue;
    try {
      const manifest = read(path.join(root, entry.name, "manifest.json"));
      if (manifest.ownerId !== ownerId || manifest.version !== 1) continue;
      // Only sum paths admitted by the backup format, never arbitrary manifest paths.
      let bytes = 0;
      for (const name of Object.keys(manifest.files)) {
        if (
          (name !== "smart-campus.sqlite" && !name.startsWith("uploads/")) ||
          path.isAbsolute(name) ||
          name.split(/[\\/]/).includes("..")
        )
          throw new Error("Invalid path");
        const file = path.join(root, entry.name, name);
        if (fs.lstatSync(file).isSymbolicLink())
          throw new Error("Invalid symlink");
        bytes += fs.statSync(file).size;
      }
      rows.push({ name: entry.name, createdAt: manifest.createdAt, bytes });
    } catch {
      /* Unknown/corrupt folders are retained for manual inspection. */
    }
  }
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}
export function retentionPlan(
  rows,
  { recent, days, maxTotalBytes },
  now,
  protect = rows[0]?.name,
) {
  const keep = new Set(rows.slice(0, recent).map((r) => r.name));
  if (protect) keep.add(protect);
  const dates = new Set();
  for (const row of rows) {
    const date = row.createdAt?.slice(0, 10);
    if (
      new Date(row.createdAt).getTime() >= now - days * 86400000 &&
      !dates.has(date)
    ) {
      keep.add(row.name);
      dates.add(date);
    }
  }
  let total = rows
    .filter((r) => keep.has(r.name))
    .reduce((n, r) => n + r.bytes, 0);
  for (const row of [...rows].reverse()) {
    if (total <= maxTotalBytes) break;
    if (row.name !== protect && keep.delete(row.name)) total -= row.bytes;
  }
  return rows.filter((r) => !keep.has(r.name));
}
function recoverInflight(root, ownerId) {
  const file = path.join(root, ".inflight.json");
  if (!fs.existsSync(file)) return;
  const job = read(file);
  if (
    job.ownerId !== ownerId ||
    !SNAPSHOT.test(job.target) ||
    job.drill !== ".restore-" + job.target
  )
    throw new Error("备份中断记录无效，需人工检查");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = entry.name;
    const partial =
      name.startsWith(job.target + ".partial-") ||
      name.startsWith(job.drill + ".partial-");
    if (partial || name === job.drill)
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  // A snapshot published just before a crash is kept; it is never assumed to
  // have completed verification until a later run produces its own good copy.
  fs.rmSync(file);
}
export async function runBackup(
  settings,
  { now = Date.now, gate = null } = {},
) {
  const source = fs.realpathSync(settings.source);
  fs.mkdirSync(settings.root, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(settings.root);
  if (root === source || root.startsWith(source + path.sep))
    throw new Error("备份目录必须在 DATA_DIR 之外");
  const unlock = lockRoot(root);
  let state = {},
    ownerId,
    statusOwned = false;
  const statusFile = path.join(root, "status.json");
  const guard =
    gate ||
    (settings.pressureEnabled ? createBackupGate(settings.source) : null);
  const checkpoint = () => guard?.check();
  try {
    const identityFile = path.join(root, ".backup-root.json");
    if (!fs.existsSync(identityFile))
      write(identityFile, { version: 1, source, ownerId: randomUUID() });
    const identity = read(identityFile);
    if (
      identity.version !== 1 ||
      identity.source !== source ||
      typeof identity.ownerId !== "string"
    )
      throw new Error("此备份目录属于另一数据目录，禁止混用");
    ownerId = identity.ownerId;
    if (fs.existsSync(statusFile)) state = read(statusFile);
    statusOwned = true;
    await guard?.ready;
    checkpoint();
    recoverInflight(root, ownerId);
    const time = now();
    const target =
      "snapshot-" +
      new Date(time).toISOString().replace(/[-:.]/g, "") +
      "-" +
      randomUUID();
    const drill = ".restore-" + target;
    const needsDrill =
      !state.lastRestoreDrillAt ||
      !Number.isFinite(Date.parse(state.lastRestoreDrillAt)) ||
      time < Date.parse(state.lastRestoreDrillAt) ||
      time - Date.parse(state.lastRestoreDrillAt) >=
        settings.drillDays * 86400000;
    write(path.join(root, ".inflight.json"), { ownerId, target, drill });
    write(statusFile, {
      ...state,
      state: "running",
      startedAt: new Date(time).toISOString(),
      error: null,
    });
    const destination = path.join(root, target);
    await createBackup(settings.source, destination, {
      ownerId,
      maxBytes: settings.maxSnapshotBytes,
      minFreeBytes: settings.minFreeBytes,
      spaceCopies: needsDrill ? 2 : 1,
      createdAt: new Date(time).toISOString(),
      checkpoint,
    });
    const verified = verifyBackup(destination, { checkpoint });
    if (needsDrill) {
      restoreBackup(destination, path.join(root, drill), { checkpoint });
      fs.rmSync(path.join(root, drill), { recursive: true });
    }
    state = {
      state: "succeeded",
      startedAt: new Date(time).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      lastSuccessfulAt: new Date(time).toISOString(),
      lastSnapshot: target,
      lastRestoreDrillAt: needsDrill
        ? new Date(time).toISOString()
        : state.lastRestoreDrillAt,
      files: verified.files,
      bytes: verified.bytes,
      error: null,
    };
    // Never prune old backups before the new snapshot and any due drill pass.
    const rows = inventory(root, ownerId);
    const prune = retentionPlan(rows, settings, time, target);
    for (const row of prune)
      fs.rmSync(path.join(root, row.name), { recursive: true });
    state.retained = rows.length - prune.length;
    state.pruned = prune.length;
    write(statusFile, state);
    fs.rmSync(path.join(root, ".inflight.json"));
    return state;
  } catch (error) {
    if (statusOwned)
      write(statusFile, {
        ...state,
        state: error.code === "BACKUP_DEFERRED" ? "deferred" : "failed",
        finishedAt: new Date(now()).toISOString(),
        error: error.message,
      });
    throw error;
  } finally {
    guard?.stop();
    unlock();
  }
}
export function backupStatus(settings, { now = Date.now } = {}) {
  const file = path.join(settings.root, "status.json");
  if (!fs.existsSync(file)) return { state: "missing", healthy: false };
  const state = read(file);
  const healthy =
    ["succeeded", "running", "deferred"].includes(state.state) &&
    typeof state.lastSnapshot === "string" &&
    SNAPSHOT.test(state.lastSnapshot) &&
    fs.existsSync(
      path.join(settings.root, state.lastSnapshot, "manifest.json"),
    ) &&
    Number.isFinite(Date.parse(state.lastSuccessfulAt)) &&
    now() >= Date.parse(state.lastSuccessfulAt) &&
    now() - Date.parse(state.lastSuccessfulAt) < 2 * 3600000;
  return { ...state, healthy };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const settings = backupSettings();
    if (process.argv[2] === "status") {
      const state = backupStatus(settings);
      console.log(JSON.stringify(state, null, 2));
      if (!state.healthy) process.exitCode = 1;
    } else if (process.argv[2] === "run") {
      const result = await runBackup(settings);
      console.log(
        `备份完成并验证：${result.lastSnapshot}；保留 ${result.retained} 份`,
      );
    } else throw new Error("用法：node tools/ops/backup.mjs <run|status>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === "BACKUP_DEFERRED" ? 75 : 1;
  }
}
