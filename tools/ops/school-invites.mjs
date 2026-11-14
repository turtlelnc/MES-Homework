import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REVOKED_EXPIRY,
  issueInvite,
  listInvites,
  normalizeInviteCode,
  revokeInvite,
} from "../../server/school-invites.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function inviteDatabase(env = process.env) {
  const data = path.resolve(env.DATA_DIR || path.join(root, "data"));
  const file = path.join(data, "smart-campus.sqlite");
  if (!fs.existsSync(file))
    throw new Error(`数据库不存在：${file}；请先启动一次服务或设置 DATA_DIR`);
  const db = new DatabaseSync(file);
  // 独立进程，等服务写完再读比直接报 database is locked 更有用。
  db.exec("PRAGMA busy_timeout=2000");
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='school_invites'",
      )
      .get()
  ) {
    db.close();
    throw new Error(
      `数据库尚未升级（缺少 school_invites 表）：请先启动一次新版服务完成迁移，再运行本命令。库文件：${file}`,
    );
  }
  return db;
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error(`--${name} 需要一个值`);
  return value;
}

function expiry(argv, now) {
  const days = option(argv, "days");
  const expires = option(argv, "expires");
  if (days !== undefined && expires !== undefined)
    throw new Error("--days 与 --expires 只能选一个");
  if (days !== undefined) {
    const n = Number(days);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 3650)
      throw new Error("--days 必须是 1–3650 的整数");
    return new Date(now + n * 86400000).toISOString();
  }
  if (expires !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires))
      throw new Error("--expires 格式应为 YYYY-MM-DD");
    const at = Date.parse(`${expires}T23:59:59.999Z`);
    if (!Number.isFinite(at)) throw new Error("--expires 不是有效日期");
    // 日期字符串可能合法但不是日历日期（如 2026-02-31），也会解析成 3 月。
    if (new Date(at).toISOString().slice(0, 10) !== expires)
      throw new Error(`--expires 不是有效日期：${expires}`);
    if (at <= now) throw new Error("--expires 必须是今天或之后的日期");
    return new Date(at).toISOString();
  }
  return null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  let db;
  try {
    db = inviteDatabase();
    if (command === "create") {
      const countRaw = option(argv, "count") ?? "1";
      const count = Number(countRaw);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100)
        throw new Error("--count 必须是 1–100 的整数");
      const note = option(argv, "note") ?? "";
      const expiresAt = expiry(argv, Date.now());
      const codes = [];
      for (let index = 0; index < count; index += 1)
        codes.push(issueInvite(db, { note, expiresAt }));
      console.log(
        expiresAt
          ? `已生成 ${codes.length} 个开通码（有效期至 ${expiresAt}）：`
          : `已生成 ${codes.length} 个开通码（长期有效）：`,
      );
      for (const code of codes) console.log(code);
    } else if (command === "list") {
      const rows = listInvites(db);
      if (!rows.length) console.log("暂无开通码");
      for (const row of rows) {
        const state = row.used_at
          ? `已使用 ${row.used_at}`
          : row.expires_at === REVOKED_EXPIRY
            ? "已吊销"
            : row.expires_at && Date.parse(row.expires_at) <= Date.now()
              ? `已过期 ${row.expires_at}`
              : row.expires_at
                ? `有效期至 ${row.expires_at}`
                : "未使用";
        console.log(
          `${row.code}\t${state}\t${row.note || "—"}\t${row.school_id || ""}`,
        );
      }
    } else if (command === "revoke") {
      const code = normalizeInviteCode(argv[1]);
      if (!code) throw new Error("用法：revoke <开通码>");
      if (revokeInvite(db, code)) console.log(`已吊销 ${code}`);
      else console.log(`未找到未使用的开通码 ${code}`);
    } else {
      throw new Error(
        '用法：node tools/ops/school-invites.mjs <create|list|revoke> [选项]\n  create --count 5 --note "某某中学" --days 30\n  list\n  revoke A1B2C-3D4E5',
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
