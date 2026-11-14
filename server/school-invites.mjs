import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// 去掉易混淆的 I/O，字母表正好 32 个字符，按字节取模无偏。
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 10;

const inviteError = (message) =>
  Object.assign(new Error(message), { status: 400 });

// 吊销用 1970 的过期时间标记，运维列表据此区分"已吊销"与"自然过期"。
export const REVOKED_EXPIRY = new Date(0).toISOString();

/**
 * 学校注册默认要求开通码；SCHOOL_INVITE_REQUIRED=0 仅供本地开发/演示关闭。
 */
export function schoolInviteRequired(env = process.env) {
  return env.SCHOOL_INVITE_REQUIRED !== "0";
}

/** 用户可输入 abcde-fghjk / ABCDE FGHJK / abcdefghjk，统一成展示形式。 */
export function normalizeInviteCode(raw) {
  const clean = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return clean.length === CODE_LENGTH
    ? `${clean.slice(0, 5)}-${clean.slice(5)}`
    : clean;
}

export function generateInviteCode(bytes = randomBytes(CODE_LENGTH)) {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1)
    code += ALPHABET[bytes[index] % ALPHABET.length];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function issueInvite(
  db,
  {
    note = "",
    expiresAt = null,
    now = new Date().toISOString(),
    bytes = undefined,
  } = {},
) {
  const label = String(note ?? "")
    .trim()
    .slice(0, 120);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode(bytes ?? randomBytes(CODE_LENGTH));
    try {
      db.prepare(
        "INSERT INTO school_invites(code,note,expires_at,used_at,school_id,created_at) VALUES(?,?,?,NULL,NULL,?)",
      ).run(code, label, expiresAt, now);
      return code;
    } catch (error) {
      // 生日碰撞重试；其他数据库错误直接抛出。
      if (!/UNIQUE|PRIMARY KEY/i.test(String(error?.message))) throw error;
    }
  }
  throw new Error("生成开通码失败，请重试");
}

/**
 * 核销开通码：必须与建校在同一个事务里调用，保证一码只能用一次。
 * 无效/已用/过期统一文案，避免泄露某个码是否存在。
 */
export function consumeInvite(
  db,
  rawCode,
  { schoolId, now = new Date().toISOString() } = {},
) {
  const code = normalizeInviteCode(rawCode);
  if (!code) throw inviteError("请填写学校开通码");
  const row = db
    .prepare("SELECT expires_at,used_at FROM school_invites WHERE code=?")
    .get(code);
  if (!row || row.used_at) throw inviteError("开通码无效或已使用");
  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.parse(now))
    throw inviteError("开通码无效或已使用");
  const result = db
    .prepare(
      "UPDATE school_invites SET used_at=?,school_id=? WHERE code=? AND used_at IS NULL",
    )
    .run(now, schoolId ?? null, code);
  if (result.changes !== 1) throw inviteError("开通码无效或已使用");
  return code;
}

export function revokeInvite(
  db,
  rawCode,
  { now = new Date().toISOString() } = {},
) {
  const code = normalizeInviteCode(rawCode);
  const result = db
    .prepare(
      "UPDATE school_invites SET expires_at=? WHERE code=? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .run(REVOKED_EXPIRY, code, now);
  return result.changes === 1;
}

export function listInvites(db) {
  return db
    .prepare(
      "SELECT code,note,expires_at,used_at,school_id,created_at FROM school_invites ORDER BY created_at DESC, code",
    )
    .all();
}

/**
 * 全新部署既没有学校、也没有可用开通码时签发（或复用）一枚引导码。
 * 这样按默认策略安装后仍能完成首次建校，又不需要向公网放开建校入口。
 */
export function bootstrapInvite(
  db,
  { now = new Date().toISOString(), required = schoolInviteRequired() } = {},
) {
  if (!required) return null;
  if (db.prepare("SELECT 1 FROM schools LIMIT 1").get()) return null;
  const reusable = db
    .prepare(
      "SELECT code FROM school_invites WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at LIMIT 1",
    )
    .get(now);
  return reusable
    ? reusable.code
    : issueInvite(db, { note: "首次启动引导码", now });
}

/** 把引导码写进数据目录并打印，供安装包/服务模式下没有 npm 的运维取用。 */
export function announceBootstrapInvite(dir, code, log = console.log) {
  log(`[开通码] 还没有任何学校，首次建校请使用开通码：${code}`);
  try {
    const file = path.join(dir, "first-school-invite.txt");
    fs.writeFileSync(file, `${code}\n`, { mode: 0o600 });
    log(`[开通码] 已写入 ${file}（建校成功后可删除该文件）`);
  } catch (error) {
    log(`[开通码] 写入文件失败：${error.message}；请直接使用上面的开通码`);
  }
}

/** 已经建过学校后清掉遗留的引导码文件，避免凭据长期留在磁盘上。 */
export function clearBootstrapInviteFile(dir) {
  try {
    fs.rmSync(path.join(dir, "first-school-invite.txt"), { force: true });
  } catch {}
}
