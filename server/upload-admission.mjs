import { storageStatus } from "./io-guards.mjs";
import { runtimeProfile } from "./runtime-profile.mjs";
import { storageProfile } from "./storage-profile.mjs";
import { randomUUID } from "node:crypto";
import { createResourcePressure } from "./resource-pressure.mjs";
import { watchUpload } from "./io-guards.mjs";
export const uploadError = (message, status = 400) =>
  Object.assign(new Error(message), { status });
export const positive = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};
export function createUploadAdmission(
  db,
  dataDir,
  { pressure = createResourcePressure(dataDir) } = {},
) {
  const maxBytes = positive("UPLOAD_TOTAL_MB", 50) * 1024 * 1024;
  const storage = storageProfile(dataDir);
  const globalScratch = Math.min(
    positive(
      "UPLOAD_SCRATCH_MB",
      Math.max(
        1,
        Math.floor(
          Math.min(storage.freeBytes / 4, runtimeProfile().memoryBytes) /
            1024 ** 2,
        ),
      ),
    ) *
      1024 ** 2,
    Math.floor(storage.freeBytes / 2),
  );
  const schoolScratch = Math.min(
    positive(
      "UPLOAD_SCHOOL_SCRATCH_MB",
      Math.ceil(Math.max(maxBytes, globalScratch / 4) / 1024 ** 2),
    ) *
      1024 ** 2,
    globalScratch,
  );
  const globalConcurrent = runtimeProfile().uploadConcurrency;
  const activeWriters = new Map();
  const totalMs = Math.min(positive("UPLOAD_TIMEOUT_MS", 60000), 60000);
  const idleMs = Math.min(positive("UPLOAD_IDLE_TIMEOUT_MS", 15000), totalMs);
  const ipWindows = new Map();
  function ipLimit(ip) {
    const time = Date.now(),
      value = ipWindows.get(ip);
    const current =
      value && value.until > time ? value : { until: time + 60000, count: 0 };
    if (++current.count > positive("UPLOAD_IP_REQUESTS_PER_MINUTE", 600))
      throw uploadError("上传请求过于频繁，请稍后重试", 429);
    ipWindows.delete(ip);
    ipWindows.set(ip, current);
    if (ipWindows.size > 2000) ipWindows.delete(ipWindows.keys().next().value);
  }
  function reserve(
    user,
    {
      assignmentId = null,
      studentId = null,
      plan = [],
      ttl = 600000,
      bytes = maxBytes,
    } = {},
  ) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maxBytes)
      throw uploadError("上传总大小超过上限", 413);
    const time = Date.now(),
      id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      const usage = db
        .prepare(
          `SELECT COUNT(*) count,
        COALESCE(SUM(CASE WHEN status='open' AND expires_at>? THEN reserved_bytes ELSE 0 END),0) reserved,
        COALESCE(SUM(CASE WHEN school_id=? AND status='open' AND expires_at>? THEN reserved_bytes ELSE 0 END),0) school_reserved,
        COALESCE(SUM(CASE WHEN user_id=? AND status='open' AND expires_at>? THEN 1 ELSE 0 END),0) user_open,
        COALESCE(SUM(CASE WHEN user_id=? AND created_at>? THEN 1 ELSE 0 END),0) user_day,
        COALESCE(SUM(CASE WHEN school_id=? AND created_at>? THEN 1 ELSE 0 END),0) school_day
        FROM upload_sessions WHERE status='open' OR created_at>?`,
        )
        .get(
          time,
          user.school_id,
          time,
          user.id,
          time,
          user.id,
          time - 86400000,
          user.school_id,
          time - 86400000,
          time - 86400000,
        );
      if (
        usage.count >= positive("UPLOAD_GLOBAL_DAILY_LIMIT", 10000) ||
        usage.user_open >= 2 ||
        usage.user_day >= positive("UPLOAD_USER_DAILY_LIMIT", 30) ||
        usage.school_day >= positive("UPLOAD_SCHOOL_DAILY_LIMIT", 500)
      )
        throw uploadError("上传会话配额已满，请稍后重试", 429);
      if (
        usage.reserved + bytes > globalScratch ||
        usage.school_reserved + bytes > schoolScratch
      )
        throw uploadError("上传暂存空间繁忙，请稍后重试", 429);
      pressure.assertUpload(usage.reserved + bytes);
      db.prepare(
        "INSERT INTO upload_sessions VALUES(?,?,?,?,?,'open',?,?,0,?,?,NULL)",
      ).run(
        id,
        user.id,
        user.school_id,
        assignmentId,
        studentId,
        JSON.stringify(plan),
        bytes,
        time,
        time + ttl,
      );
      db.exec("COMMIT");
      pressure.chargeDisk(bytes);
      return db.prepare("SELECT * FROM upload_sessions WHERE id=?").get(id);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  // Persistent ingress leases include legacy multipart requests. They bound active
  // writers and recover after a process crash without trusting forwarded IP headers.
  db.exec(
    "CREATE TABLE IF NOT EXISTS upload_writers(id TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER NOT NULL)",
  );
  function acquire(user, ip) {
    pressure.assertUpload();
    ipLimit(ip);
    const allowed = pressure.limit(globalConcurrent);
    if (
      activeWriters.size >= allowed ||
      [...activeWriters.values()].includes(user.id)
    )
      throw uploadError("正在上传其他文件，请稍后重试", 429);
    const time = Date.now(),
      id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM upload_writers WHERE expires_at<=?").run(time);
      const count = db
        .prepare(
          "SELECT COUNT(*) total,COALESCE(SUM(user_id=?),0) own FROM upload_writers",
        )
        .get(user.id);
      if (count.total >= allowed || count.own >= 1)
        throw uploadError("正在上传其他文件，请稍后重试", 429);
      db.prepare("INSERT INTO upload_writers VALUES(?,?,?)").run(
        id,
        user.id,
        time + 90000,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    activeWriters.set(id, user.id);
    return () => {
      try {
        db.prepare("DELETE FROM upload_writers WHERE id=?").run(id);
      } finally {
        activeWriters.delete(id);
      }
    };
  }
  function chargeTransfer(user, bytes, ownTransaction = true) {
    const time = Date.now();
    if (ownTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM upload_attempts WHERE created_at<=?").run(
        time - 86400000,
      );
      const usage = db
        .prepare(
          `SELECT COUNT(*) total_hour,
        COALESCE(SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END),0) user_hour,
        COALESCE(SUM(CASE WHEN school_id=? THEN 1 ELSE 0 END),0) school_hour
        FROM upload_attempts WHERE created_at>?`,
        )
        .get(user.id, user.school_id, time - 3600000);
      const daily = db
        .prepare(
          `SELECT COALESCE(SUM(bytes_reserved),0) total,
        COALESCE(SUM(CASE WHEN user_id=? THEN bytes_reserved ELSE 0 END),0) own,
        COALESCE(SUM(CASE WHEN school_id=? THEN bytes_reserved ELSE 0 END),0) school FROM upload_attempts`,
        )
        .get(user.id, user.school_id);
      if (
        usage.total_hour >= positive("UPLOAD_GLOBAL_HOURLY_PARTS", 6000) ||
        usage.user_hour >= positive("UPLOAD_USER_HOURLY_PARTS", 180) ||
        usage.school_hour >= positive("UPLOAD_SCHOOL_HOURLY_PARTS", 3000) ||
        daily.total + bytes >
          positive("UPLOAD_GLOBAL_DAILY_MB", 8192) * 1024 * 1024 ||
        daily.own + bytes >
          positive("UPLOAD_USER_DAILY_MB", 300) * 1024 * 1024 ||
        daily.school + bytes >
          positive("UPLOAD_SCHOOL_DAILY_MB", 3072) * 1024 * 1024
      )
        throw uploadError(
          "上传尝试次数或传输额度已达上限，失败尝试也计入额度",
          429,
        );
      db.prepare("INSERT INTO upload_attempts VALUES(?,?,?,?,?)").run(
        randomUUID(),
        user.id,
        user.school_id,
        bytes,
        time,
      );
      if (ownTransaction) db.exec("COMMIT");
    } catch (e) {
      if (ownTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  function legacy(req, res, next) {
    let release, session;
    try {
      release = acquire(req.user, req.ip);
      const declaredLength = req.get("content-length");
      const length =
        declaredLength === undefined ? maxBytes : Number(declaredLength);
      // Disk/memory destinations still enforce their own per-file limits.
      if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes)
        throw uploadError("上传大小无效或超过总大小上限", 413);
      session = reserve(req.user, { ttl: 90000, bytes: length });
      chargeTransfer(req.user, length);
      let done = false;
      const watch = watchUpload(req, { maxBytes: length, totalMs, idleMs });
      req.uploadWatch = watch;
      const finish = () => {
        if (done) return;
        done = true;
        watch.stop();
        // A hung kernel write must retain its local concurrency slot even if
        // the DB lease expires. Do not admit replacement writers indefinitely.
        void Promise.allSettled([...(req.uploadTasks || [])])
          .then(() => {
            release();
            db.prepare(
              "UPDATE upload_sessions SET status=?,actual_bytes=? WHERE id=?",
            ).run(
              req.complete && res.writableFinished && res.statusCode < 400
                ? "complete"
                : "cancelled",
              watch.bytes,
              session.id,
            );
          })
          .catch(() => console.error("Upload lease cleanup failed"));
      };
      res.once("finish", finish);
      res.once("close", finish);
      next();
    } catch (e) {
      release?.();
      if (session)
        db.prepare(
          "UPDATE upload_sessions SET status='cancelled' WHERE id=?",
        ).run(session.id);
      res
        .set("Connection", "close")
        .set("Retry-After", "5")
        .status(storageStatus(e) || e.status || 400)
        .json({ error: e.message });
    }
  }
  return {
    reserve,
    acquire,
    chargeTransfer,
    legacy,
    maxBytes,
    totalMs,
    idleMs,
    ready: pressure.ready,
    stop: () => pressure.stop(),
  };
}
