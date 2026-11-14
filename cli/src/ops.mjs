import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  databasePath,
  encryptSecret,
  openDatabase,
  packageRoot,
  prompt,
  choose,
  updateConfig,
  writeSettings,
  readSettings,
  appPaths,
} from "./runtime.mjs";
import { issueInvite } from "../../server/school-invites.mjs";
import { providers } from "../../server/providers.mjs";
import { cloudflaredPath } from "./cloudflared.mjs";

const ROLE_LABELS = {
  teacher: "老师",
  student: "学生",
  parent: "家长",
};

export function schools(db) {
  return db ? db.prepare("SELECT id,name,created_at FROM schools ORDER BY created_at").all() : [];
}

export function schoolAdmin(db, schoolId) {
  return db
    .prepare(
      "SELECT id,username,name FROM users WHERE school_id=? AND role='teacher' AND is_school_admin=1 ORDER BY created_at LIMIT 1",
    )
    .get(schoolId);
}

export async function issueCode(db, t) {
  if (!db) throw new Error(t("check.dbBad", { error: databasePath(appPaths) }));
  const note = await prompt(`${t("code.askNote")}: `);
  const days = await prompt(`${t("code.askDays")}: `);
  let expiresAt = null;
  if (days) {
    const n = Number(days);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 3650)
      throw new Error(t("code.askDays"));
    expiresAt = new Date(Date.now() + n * 86400000).toISOString();
  }
  const code = issueInvite(db, { note, expiresAt });
  process.stdout.write(`\n${t("code.title")}: ${code}\n`);
  process.stdout.write(
    `${expiresAt ? t("code.expires", { at: expiresAt }) : t("code.unlimited")}\n`,
  );
  process.stdout.write(`${t("code.note")}\n\n`);
  return code;
}

export async function configureApi(db, config, t) {
  const list = schools(db);
  if (!list.length) {
    process.stdout.write(`${t("api.noSchools")}\n`);
    return;
  }
  const schoolId = await choose(
    list.map((school) => ({
      value: school.id,
      label: `${school.name}（${school.id}）`,
    })),
    { title: t("api.chooseSchool") },
  );
  if (!schoolId) return;
  const admin = schoolAdmin(db, schoolId);
  if (!admin) {
    process.stdout.write(`${t("api.noAdmin")}\n`);
    return;
  }
  const existing = db
    .prepare("SELECT provider,model FROM provider_settings WHERE user_id=?")
    .get(admin.id);
  const providerIds = Object.keys(providers);
  process.stdout.write(
    `${providerIds.map((id) => `${id}(${providers[id].name})`).join("  ")}\n`,
  );
  const wanted = await prompt(
    `${t("api.askProvider")}${existing ? ` [${existing.provider}]` : ""}: `,
  );
  const provider = wanted || existing?.provider || providerIds[0];
  if (!providers[provider]) throw new Error(`未知厂商：${provider}`);
  const key = await prompt(`${t("api.askKey")}: `, { secret: true });
  const schoolName =
    list.find((school) => school.id === schoolId)?.name || schoolId;
  if (!key) {
    db.prepare("DELETE FROM provider_settings WHERE user_id=?").run(admin.id);
    process.stdout.write(`${t("api.cleared", { school: schoolName })}\n`);
    return;
  }
  const preset = providers[provider];
  const [encrypted, iv] = encryptSecret(config, key);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO provider_settings(id,user_id,provider,endpoint,model,encrypted_key,iv,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,endpoint=excluded.endpoint,model=excluded.model,encrypted_key=excluded.encrypted_key,iv=excluded.iv,updated_at=excluded.updated_at",
  ).run(randomUUID(), admin.id, provider, preset.endpoint, preset.model, encrypted, iv, now);
  process.stdout.write(
    `${t("api.saved", { school: schoolName, provider: preset.name })}\n`,
  );
}

export function listAccounts(db, t) {
  if (!db) {
    process.stdout.write(`${t("list.empty")}\n`);
    return [];
  }
  const rows = db
    .prepare(
      "SELECT u.role,u.username,u.name,u.school_id,s.name AS school_name FROM users u JOIN schools s ON s.id=u.school_id ORDER BY s.created_at,u.role,u.username",
    )
    .all();
  if (!rows.length) {
    process.stdout.write(`${t("list.empty")}\n`);
    return [];
  }
  process.stdout.write(`${t("list.title")}\n\n`);
  let current = null;
  for (const row of rows) {
    if (row.school_id !== current) {
      current = row.school_id;
      process.stdout.write(
        `${t("list.school", { name: row.school_name, code: row.school_id })}\n`,
      );
    }
    process.stdout.write(
      `${t("list.row", {
        role: ROLE_LABELS[row.role] || row.role,
        username: row.username || "—",
        name: row.name || "—",
      })}\n`,
    );
  }
  process.stdout.write("\n");
  return rows;
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export async function runCheck(db, config, t) {
  const results = [];
  const add = (ok, okKey, badKey, vars = {}) =>
    results.push({ ok, text: t(ok ? okKey : badKey, vars) });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 24, "check.nodeOk", "check.nodeBad", {
    version: process.versions.node,
  });
  add(
    Boolean(config.APP_SECRET) && config.APP_SECRET.length >= 32,
    "check.secretOk",
    "check.secretBad",
  );
  add(fs.existsSync(appPaths.config), "check.configOk", "check.configOk", {
    file: appPaths.config,
  });

  let writable = false;
  try {
    const probe = path.join(config.DATA_DIR, `.msh-check-${process.pid}`);
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch {}
  add(writable, "check.dataOk", "check.dataBad", { dir: config.DATA_DIR });

  add(fs.existsSync(path.join(packageRoot, "dist/index.html")), "check.distOk", "check.distBad");

  if (db) {
    try {
      const row = db.prepare("PRAGMA integrity_check").get();
      add(row?.integrity_check === "ok", "check.dbOk", "check.dbBad", {
        error: row?.integrity_check || "unknown",
      });
    } catch (error) {
      add(false, "check.dbOk", "check.dbBad", { error: error.message });
    }
  } else {
    // 全新安装尚未首次启动时没有数据库，这属于正常状态。
    results.push({ ok: true, text: t("check.dbMissing", { file: databasePath(config) }) });
  }

  const port = Number(config.PORT || 8787);
  const free = await portFree(port, config.HOST || "127.0.0.1");
  results.push({
    ok: free,
    text: t(free ? "check.portOk" : "check.portBusy", { port }),
  });
  add(Boolean(cloudflaredPath()), "check.cfInstalled", "check.cfMissing");

  process.stdout.write(`${t("check.title")}\n\n`);
  for (const item of results)
    process.stdout.write(`  ${item.ok ? "✓" : "✗"} ${item.text}\n`);
  const failed = results.filter((item) => !item.ok).length;
  process.stdout.write(
    `\n${failed ? t("check.fail", { count: failed }) : t("check.pass")}\n`,
  );
  return failed === 0;
}

export async function setWebsite(config, t) {
  if (config.APP_ORIGIN)
    process.stdout.write(`${t("website.current", { origin: config.APP_ORIGIN })}\n`);
  const origin = await prompt(`${t("website.ask")}: `);
  if (!origin) {
    updateConfig({ APP_ORIGIN: undefined });
    process.stdout.write(`${t("website.cleared")}\n`);
    return;
  }
  if (!/^https?:\/\/[^\s/]+/.test(origin))
    throw new Error(t("website.invalid"));
  updateConfig({ APP_ORIGIN: origin.replace(/\/+$/, "") });
  process.stdout.write(`${t("website.saved")}\n`);
}

export function setLanguage(value, { cliOnly = false } = {}, t) {
  const lang = String(value || "").toLowerCase();
  if (lang !== "zh" && lang !== "en") throw new Error(t("lang.invalid"));
  const patch = { cliLanguage: lang };
  if (!cliOnly) patch.serverLanguage = lang;
  writeSettings(patch);
  return { lang, cliOnly, server: readSettings().serverLanguage || lang };
}
