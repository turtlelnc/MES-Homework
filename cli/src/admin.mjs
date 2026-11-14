import fs from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import express from "express";
import { appPaths } from "./runtime.mjs";
import { issueInvite, listInvites } from "../../server/school-invites.mjs";
import { APP_VERSION, VERSION_LABEL } from "../../server/version.mjs";

const TOKEN_FILE = () => path.join(appPaths.base, "admin-token");

export function adminToken() {
  try {
    const text = fs.readFileSync(TOKEN_FILE(), "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(text)) return text;
  } catch {}
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(appPaths.base, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE(), `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function refuse(res, status, error) {
  res.status(status).json({ error });
}

export function createAdminApp(db, config) {
  const token = adminToken();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const authorized = (req) => {
    const header = req.get("authorization") || "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    return sameToken(bearer || req.query.token || "", token);
  };

  app.get("/", (_req, res) => {
    res.type("html").send(PAGE.replace("__VERSION__", VERSION_LABEL));
  });

  app.use("/api", (req, res, next) =>
    authorized(req) ? next() : refuse(res, 401, "需要管理员令牌"),
  );

  app.get("/api/summary", (_req, res) => {
    const count = (sql, ...args) => db.prepare(sql).get(...args)?.n ?? 0;
    res.json({
      version: APP_VERSION,
      label: VERSION_LABEL,
      schools: count("SELECT COUNT(*) n FROM schools"),
      users: count("SELECT COUNT(*) n FROM users"),
      invites: count("SELECT COUNT(*) n FROM school_invites WHERE used_at IS NULL"),
      dataDir: config.DATA_DIR,
      host: config.HOST,
      port: config.PORT,
      origin: process.env.APP_ORIGIN || null,
    });
  });

  app.get("/api/schools", (_req, res) => {
    res.json(
      db
        .prepare(
          "SELECT s.id,s.name,s.created_at,(SELECT COUNT(*) FROM users u WHERE u.school_id=s.id) users,(SELECT model_mode FROM school_settings ss WHERE ss.school_id=s.id) model_mode FROM schools s ORDER BY s.created_at",
        )
        .all(),
    );
  });

  app.patch("/api/schools/:id", (req, res) => {
    const body = req.body || {};
    if (typeof body.name === "string" && body.name.trim())
      db.prepare("UPDATE schools SET name=? WHERE id=?").run(
        body.name.trim().slice(0, 120),
        req.params.id,
      );
    if (typeof body.modelMode === "string") {
      if (!["school", "teacher_class", "teacher_parent"].includes(body.modelMode))
        return refuse(res, 400, "无效的模型模式");
      db.prepare(
        "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES(?,?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode,updated_at=excluded.updated_at",
      ).run(req.params.id, body.modelMode, new Date().toISOString());
    }
    res.json({ ok: true });
  });

  app.get("/api/users", (req, res) => {
    const school = req.query.school;
    const sql =
      "SELECT id,school_id,role,name,username,email,stage,class_name,subject,created_at,is_school_admin,review_mode FROM users" +
      (school ? " WHERE school_id=?" : " ORDER BY school_id,role,name");
    const statement = db.prepare(sql);
    res.json(school ? statement.all(school) : statement.all());
  });

  app.patch("/api/users/:id", (req, res) => {
    const body = req.body || {};
    const fields = [];
    const values = [];
    const text = (name, max) =>
      typeof body[name] === "string" ? body[name].trim().slice(0, max) : undefined;
    const name = text("name", 60);
    if (name) {
      fields.push("name=?");
      values.push(name);
    }
    const className = text("className", 60);
    if (className !== undefined) {
      fields.push("class_name=?");
      values.push(className || null);
    }
    const subject = text("subject", 60);
    if (subject !== undefined) {
      fields.push("subject=?");
      values.push(subject || null);
    }
    if (typeof body.isSchoolAdmin === "boolean") {
      fields.push("is_school_admin=?");
      values.push(body.isSchoolAdmin ? 1 : 0);
    }
    if (typeof body.reviewMode === "string") {
      if (!["all", "uncertain", "none"].includes(body.reviewMode))
        return refuse(res, 400, "无效的复核方式");
      fields.push("review_mode=?");
      values.push(body.reviewMode);
    }
    if (!fields.length) return refuse(res, 400, "没有可更新的字段");
    values.push(req.params.id);
    db.prepare(`UPDATE users SET ${fields.join(",")} WHERE id=?`).run(...values);
    res.json({ ok: true });
  });

  app.post("/api/users/:id/password", (req, res) => {
    const password = req.body?.password;
    if (typeof password !== "string" || password.length < 8)
      return refuse(res, 400, "密码至少 8 位");
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    db.prepare("UPDATE users SET password_hash=?,salt=? WHERE id=?").run(
      hash,
      salt,
      req.params.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/users/:id", (req, res) => {
    db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/invites", (_req, res) => res.json(listInvites(db)));

  app.post("/api/invites", (req, res) => {
    const body = req.body || {};
    const days = Number(body.days);
    const expiresAt =
      Number.isSafeInteger(days) && days > 0 && days <= 3650
        ? new Date(Date.now() + days * 86400000).toISOString()
        : null;
    res.json({
      code: issueInvite(db, { note: String(body.note || "").slice(0, 120), expiresAt }),
      expiresAt,
    });
  });

  app.delete("/api/invites/:code", (req, res) => {
    db.prepare(
      "UPDATE school_invites SET expires_at=? WHERE code=? AND used_at IS NULL",
    ).run(new Date(0).toISOString(), req.params.code);
    res.json({ ok: true });
  });

  return { app, token };
}

export function openAdmin(db, config, t) {
  return new Promise((resolve, reject) => {
    const { app, token } = createAdminApp(db, config);
    const port = Number(process.env.MSH_ADMIN_PORT || 8790);
    const server = app.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}/?token=${token}`;
      process.stdout.write(`${t("mgr.url", { url })}\n`);
      process.stdout.write(`${t("mgr.token", { token })}\n`);
      process.stdout.write(`${t("mgr.hint")}\n`);
      resolve({ server, url });
    });
    server.on("error", reject);
  });
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>MES-Homework 服务器管理</title>
<style>
:root{--bg:#0b1220;--panel:rgba(255,255,255,.06);--line:rgba(148,163,184,.22);--text:#e6edf7;--muted:#94a3b8;--accent:#4f8cff;--accent2:#8b5cf6;--ok:#34d399;--danger:#f87171}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;color:var(--text);
background:radial-gradient(1200px 600px at 20% -10%,rgba(79,140,255,.28),transparent 60%),radial-gradient(900px 500px at 100% 0%,rgba(139,92,246,.22),transparent 55%),var(--bg);min-height:100vh}
header{display:flex;align-items:center;gap:14px;padding:22px 28px;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
.logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;font-weight:700}
h1{font-size:17px;margin:0;font-weight:600;letter-spacing:.2px}
.badge{margin-left:auto;font-size:12px;color:var(--muted);border:1px solid var(--line);padding:4px 10px;border-radius:999px}
main{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 79px)}
nav{padding:18px 14px;border-right:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
nav button{all:unset;cursor:pointer;padding:10px 14px;border-radius:10px;color:var(--muted);font-weight:500}
nav button:hover{background:var(--panel);color:var(--text)}
nav button.active{background:linear-gradient(135deg,rgba(79,140,255,.25),rgba(139,92,246,.18));color:#fff;border:1px solid rgba(79,140,255,.35)}
section{padding:26px 30px;display:none}
section.active{display:block}
h2{font-size:15px;margin:0 0 16px;color:var(--muted);font-weight:600;letter-spacing:.08em;text-transform:uppercase}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px 18px}
.card b{display:block;font-size:26px;font-weight:650;letter-spacing:-.02em}
.card span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:600;background:rgba(255,255,255,.03)}
tr:last-child td{border-bottom:0}
tr:hover td{background:rgba(255,255,255,.035)}
input,select{background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:7px 10px;font:inherit;min-width:0}
button.act{background:rgba(79,140,255,.16);border:1px solid rgba(79,140,255,.4);color:#cfe0ff;border-radius:9px;padding:6px 12px;cursor:pointer;font:inherit}
button.act:hover{background:rgba(79,140,255,.28)}
button.danger{background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.4);color:#fecaca}
.toolbar{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.toast{position:fixed;right:22px;bottom:22px;background:#111a2c;border:1px solid var(--line);padding:12px 16px;border-radius:12px;opacity:0;transform:translateY(8px);transition:.25s}
.toast.show{opacity:1;transform:none}
.empty{color:var(--muted);padding:18px 0}
</style></head><body>
<header><div class="logo">M</div><h1>MES-Homework 服务器管理</h1><span class="badge">__VERSION__</span></header>
<main>
<nav>
<button class="active" data-tab="overview">概览</button>
<button data-tab="schools">学校</button>
<button data-tab="users">用户</button>
<button data-tab="invites">开通码</button>
</nav>
<section id="overview" class="active"><h2>运行状态</h2><div class="cards" id="summary"></div></section>
<section id="schools"><h2>学校</h2><div id="schoolRows"></div></section>
<section id="users"><h2>用户</h2><div class="toolbar"><select id="userSchool"><option value="">全部学校</option></select></div><div id="userRows"></div></section>
<section id="invites"><h2>开通码</h2><div class="toolbar"><input id="inviteNote" placeholder="备注"/><input id="inviteDays" placeholder="有效期天数" style="width:110px"/><button class="act" id="newInvite">签发</button></div><div id="inviteRows"></div></section>
</main>
<div class="toast" id="toast"></div>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const api = async (url, options = {}) => {
  const res = await fetch(url, { ...options, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
};
const toast = (text) => { const el = document.getElementById('toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); };
const esc = (value) => String(value ?? '');
document.querySelectorAll('nav button').forEach((button) => button.onclick = () => {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b === button));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('active', s.id === button.dataset.tab));
});
const table = (rows, columns, actions) => {
  if (!rows.length) return '<div class="empty">暂无数据</div>';
  const head = columns.map((c) => '<th>' + c.label + '</th>').join('') + (actions ? '<th></th>' : '');
  const body = rows.map((row) => '<tr>' + columns.map((c) => '<td>' + esc(c.value(row)) + '</td>').join('') + (actions ? '<td>' + actions(row) + '</td>' : '') + '</tr>').join('');
  return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
};
async function loadSummary() {
  const s = await api('/api/summary');
  document.getElementById('summary').innerHTML = [['学校', s.schools], ['用户', s.users], ['可用开通码', s.invites]].map(([label, value]) => '<div class="card"><b>' + value + '</b><span>' + label + '</span></div>').join('') + '<div class="card" style="grid-column:span 2"><b style="font-size:14px">' + esc(s.dataDir) + '</b><span>数据目录 · ' + esc(s.host) + ':' + esc(s.port) + (s.origin ? ' · ' + esc(s.origin) : '') + '</span></div>';
}
async function loadSchools() {
  const rows = await api('/api/schools');
  document.getElementById('schoolRows').innerHTML = table(rows, [
    { label: '学校', value: (r) => r.name },
    { label: '代码', value: (r) => r.id },
    { label: '用户', value: (r) => r.users },
    { label: '模型模式', value: (r) => r.model_mode || 'school' },
  ], (r) => '<button class="act" onclick="renameSchool(\\'' + r.id + '\\')">改名</button>');
}
window.renameSchool = async (id) => {
  const name = prompt('新的学校名称');
  if (!name) return;
  await api('/api/schools/' + id, { method: 'PATCH', body: JSON.stringify({ name }) });
  toast('已更新'); loadSchools();
};
async function loadUsers() {
  const school = document.getElementById('userSchool').value;
  const rows = await api('/api/users' + (school ? '?school=' + encodeURIComponent(school) : ''));
  document.getElementById('userRows').innerHTML = table(rows, [
    { label: '账号', value: (r) => r.username || '—' },
    { label: '姓名', value: (r) => r.name },
    { label: '角色', value: (r) => ({ teacher: '老师', student: '学生', parent: '家长' })[r.role] || r.role },
    { label: '班级', value: (r) => r.class_name || '—' },
    { label: '管理员', value: (r) => (r.is_school_admin ? '是' : '') },
  ], (r) => '<button class="act" onclick="resetPassword(\\'' + r.id + '\\')">重置密码</button> <button class="act danger" onclick="removeUser(\\'' + r.id + '\\')">删除</button>');
}
window.resetPassword = async (id) => {
  const password = prompt('新密码（至少 8 位）');
  if (!password) return;
  await api('/api/users/' + id + '/password', { method: 'POST', body: JSON.stringify({ password }) });
  toast('密码已重置'); loadUsers();
};
window.removeUser = async (id) => {
  if (!confirm('确定删除该用户？')) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  toast('已删除'); loadUsers();
};
async function loadInvites() {
  const rows = await api('/api/invites');
  document.getElementById('inviteRows').innerHTML = table(rows, [
    { label: '开通码', value: (r) => r.code },
    { label: '状态', value: (r) => r.used_at ? '已使用' : (r.expires_at && Date.parse(r.expires_at) < Date.now() ? '已失效' : '可用') },
    { label: '备注', value: (r) => r.note || '—' },
  ], (r) => r.used_at ? '' : '<button class="act danger" onclick="revokeInvite(\\'' + r.code + '\\')">吊销</button>');
}
window.revokeInvite = async (code) => {
  await api('/api/invites/' + encodeURIComponent(code), { method: 'DELETE' });
  toast('已吊销'); loadInvites();
};
document.getElementById('newInvite').onclick = async () => {
  const note = document.getElementById('inviteNote').value;
  const days = Number(document.getElementById('inviteDays').value);
  const data = await api('/api/invites', { method: 'POST', body: JSON.stringify({ note, days: Number.isFinite(days) ? days : 0 }) });
  toast('已签发 ' + data.code); loadInvites(); loadSummary();
};
document.getElementById('userSchool').onchange = loadUsers;
(async () => {
  try {
    await loadSummary();
    const rows = await api('/api/schools');
    document.getElementById('userSchool').innerHTML = '<option value="">全部学校</option>' + rows.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('');
    await Promise.all([loadSchools(), loadUsers(), loadInvites()]);
  } catch (error) { toast('加载失败：' + error.message); }
})();
</script></body></html>`;
