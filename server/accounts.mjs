import { applicationCapabilities } from "./capabilities.mjs";
// v0.2.1 账号模块：4 身份注册、账号名/邮箱登录、管理员建号。
// 路由注册必须发生在 index.mjs 旧 auth / schools / teachers / students 路由之前，
// 并且由 Lead 删除旧路由，避免 Express 先注册的旧处理器抢先响应。
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { validPassword } from "./security.mjs";

const PUBLIC_ROLES = ["school", "teacher", "student", "parent"];
const ACCOUNT_ROLES = ["teacher", "student", "parent"];
const stagesFor = (ctx) => applicationCapabilities(ctx.db).stages;
const RELATIONS = ["父亲", "母亲", "其他监护人"];
const DEFAULT_RELATION = "家长";
const USERNAME_PATTERN = /^[a-z0-9_\u4e00-\u9fa5]+$/;
const USERNAME_ERROR = "账号名需为 2–32 位字母、数字、下划线或中文";

const normalizerFor = (ctx) =>
  ctx.pass ||
  ((password, salt) => scryptSync(password, salt, 64).toString("hex"));
const policyFor = (ctx) => ctx.validPassword || validPassword;
const newId = (ctx) => (ctx.uid ? ctx.uid() : randomUUID());
const nowIso = (ctx) => (ctx.iso ? ctx.iso() : new Date().toISOString());
const accountError = (message, status = 400) =>
  Object.assign(new Error(message), { status });

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value) {
  const text = trimmed(value);
  return text || null;
}

function normalizeEmail(value) {
  const text = trimmed(value).toLowerCase();
  return text || null;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+$/.test(email);
}

function squashUsername(value) {
  return String(value).replace(/\s+/g, "").toLowerCase();
}

/** 账号名规范化：去空格、ASCII 小写；不合法直接抛错。 */
export function normalizeUsername(value) {
  if (typeof value !== "string") throw new Error(USERNAME_ERROR);
  const normalized = squashUsername(value);
  const error = validateUsername(normalized);
  if (error) throw new Error(error);
  return normalized;
}

/** 返回错误文案（合法时返回空字符串），不会抛错，便于前端即时校验。 */
export function validateUsername(value) {
  if (typeof value !== "string" || !value.trim()) return "请填写账号名";
  const normalized = squashUsername(value);
  if (normalized.length < 2 || normalized.length > 32) return USERNAME_ERROR;
  if (!USERNAME_PATTERN.test(normalized)) return USERNAME_ERROR;
  return "";
}

function usernameFromEmail(email) {
  const prefix = String(email || "")
    .split("@")[0]
    .replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, "")
    .toLowerCase();
  return validateUsername(prefix) ? "" : prefix;
}

function uniqueUsername(db, base) {
  let stem = squashUsername(base || "user").slice(0, 28);
  if (validateUsername(stem)) stem = "user";
  for (let index = 0; index < 8; index += 1) {
    const suffix = index === 0 ? "" : randomBytes(2).toString("hex");
    const candidate = `${stem}${suffix}`.slice(0, 32);
    if (!db.prepare("SELECT id FROM users WHERE username=?").get(candidate))
      return candidate;
  }
  return `${stem.slice(0, 24)}${randomBytes(4).toString("hex")}`;
}

function uniqueMessage(error) {
  const text = String(error?.message || error);
  if (/idx_users_username|users\.username/i.test(text))
    return "该账号名已被使用";
  if (/idx_users_email|users\.email/i.test(text)) return "邮箱已注册";
  return "";
}

async function verifyPassword(ctx, password, user) {
  try {
    const provided = Buffer.from(
      await normalizerFor(ctx)(password, user.salt),
      "hex",
    );
    const expected = Buffer.from(String(user.password_hash || ""), "hex");
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  } catch (error) {
    throw Object.assign(error, { status: error.status || 503 });
  }
}

function resolveRelation(value) {
  const relation = trimmed(value);
  return RELATIONS.includes(relation) ? relation : DEFAULT_RELATION;
}

function resolveSchoolCode(db, rawCode) {
  const code = trimmed(rawCode).toLowerCase();
  if (!code) return null;
  const direct = db.prepare("SELECT * FROM schools WHERE id=?").get(code);
  if (direct) return direct;
  if (!/^[0-9a-f-]{4,36}$/.test(code)) return null;
  const matches = db
    .prepare("SELECT * FROM schools WHERE id LIKE ?")
    .all(`${code}%`);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 插入一个可登录账号（不含学校注册的事务包装）。
 * role 只接受 users.role 允许的 teacher/student/parent；school 身份请走 registerAccount。
 */
export async function insertUser(ctx, fields) {
  const db = ctx.db;
  const x = fields || {};
  const schoolId = trimmed(x.schoolId);
  const role = trimmed(x.role);
  const name = trimmed(x.name);
  if (!schoolId) throw new Error("缺少学校信息");
  if (!ACCOUNT_ROLES.includes(role)) throw new Error("账户身份无效");
  if (!name) throw new Error("请填写姓名");
  if (!policyFor(ctx)(x.password)) throw new Error("密码至少 8 位");
  const username = x.username ? normalizeUsername(x.username) : null;
  const email = normalizeEmail(x.email);
  if (email && !validEmail(email)) throw new Error("邮箱格式无效");
  let stage = null;
  if (role !== "parent" && x.stage !== undefined && x.stage !== null) {
    stage = trimmed(x.stage);
    if (stage) {
      if (!stagesFor(ctx).includes(stage)) throw new Error("学段无效");
    } else {
      stage = null;
    }
  }
  if (username) {
    const taken = db
      .prepare("SELECT id FROM users WHERE username=?")
      .get(username);
    if (taken) throw new Error("该账号名已被使用");
  }
  if (
    email &&
    db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").get(email)
  )
    throw new Error("邮箱已注册");
  const id = newId(ctx);
  const salt = randomBytes(16).toString("hex");
  try {
    db.prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      schoolId,
      role,
      name,
      username,
      email,
      await normalizerFor(ctx)(x.password, salt),
      salt,
      stage,
      role === "teacher" ? optionalText(x.subject) : null,
      role === "teacher" || role === "student"
        ? optionalText(x.className)
        : null,
      nowIso(ctx),
      x.isSchoolAdmin ? 1 : 0,
    );
  } catch (error) {
    const message = uniqueMessage(error);
    if (message) throw new Error(message);
    throw error;
  }
  return { id };
}

async function registerSchool(ctx, payload) {
  const db = ctx.db;
  const schoolName = trimmed(payload.schoolName);
  const name = trimmed(payload.name);
  if (!schoolName) throw new Error("请填写学校名称");
  if (!name) throw new Error("请填写管理员姓名");
  const username = normalizeUsername(payload.username);
  if (!policyFor(ctx)(payload.password)) throw new Error("密码至少 8 位");
  const email = normalizeEmail(payload.email);
  if (email && !validEmail(email)) throw new Error("邮箱格式无效");
  const schoolId = newId(ctx);
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
      schoolId,
      schoolName,
      nowIso(ctx),
    );
    const created = await insertUser(ctx, {
      schoolId,
      role: "teacher",
      name,
      username,
      password: payload.password,
      email,
      isSchoolAdmin: true,
    });
    db.exec("COMMIT");
    return {
      id: created.id,
      role: "teacher",
      schoolId,
      schoolCode: schoolId,
      schoolName,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function registerTeacher(ctx, payload, school, common) {
  const stage = trimmed(payload.stage);
  if (!stagesFor(ctx).includes(stage)) throw new Error("请选择有效学段");
  const subject = trimmed(payload.subject);
  const className = trimmed(payload.className ?? payload.class_name);
  if (!subject || !className) throw new Error("请填写学科和班级");
  const created = await insertUser(ctx, {
    schoolId: school.id,
    role: "teacher",
    name: common.name,
    username: common.username,
    password: common.password,
    email: common.email,
    stage,
    subject,
    className,
  });
  ctx.db
    .prepare(
      "INSERT INTO class_teachers(id,school_id,class_name,teacher_id,is_head,created_at) VALUES(?,?,?,?,0,?)",
    )
    .run(newId(ctx), school.id, className, created.id, nowIso(ctx));
  return { id: created.id, role: "teacher", schoolId: school.id };
}

async function registerStudent(ctx, payload, school, common) {
  const stage = trimmed(payload.stage);
  if (!stagesFor(ctx).includes(stage)) throw new Error("请选择有效学段");
  const className = trimmed(payload.className ?? payload.class_name);
  if (!className) throw new Error("请填写班级");
  const created = await insertUser(ctx, {
    schoolId: school.id,
    role: "student",
    name: common.name,
    username: common.username,
    password: common.password,
    email: common.email,
    stage,
    className,
  });
  return { id: created.id, role: "student", schoolId: school.id };
}

async function registerParent(ctx, payload, school, common) {
  const db = ctx.db;
  const childUsernameRaw = trimmed(
    payload.childUsername ?? payload.child_username,
  );
  const childPassword = payload.childPassword ?? payload.child_password;
  if (!childUsernameRaw || typeof childPassword !== "string" || !childPassword)
    throw accountError("孩子账号或密码错误");
  const childKey = squashUsername(childUsernameRaw);
  let child = db
    .prepare(
      "SELECT * FROM users WHERE school_id=? AND role='student' AND username=?",
    )
    .get(school.id, childKey);
  if (!child)
    child = db
      .prepare(
        "SELECT * FROM users WHERE school_id=? AND role='student' AND email=?",
      )
      .get(school.id, childUsernameRaw.toLowerCase());
  // 统一文案，避免泄露“账号是否存在/是否同校”。
  if (!child || !(await verifyPassword(ctx, childPassword, child)))
    throw accountError("孩子账号或密码错误");
  const created = await insertUser(ctx, {
    schoolId: school.id,
    role: "parent",
    name: common.name,
    username: common.username,
    password: common.password,
    email: common.email,
  });
  db.prepare(
    "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    newId(ctx),
    created.id,
    child.id,
    school.id,
    resolveRelation(payload.relation),
    nowIso(ctx),
  );
  return {
    id: created.id,
    role: "parent",
    schoolId: school.id,
    studentId: child.id,
    studentName: child.name || "",
  };
}

/**
 * 注册入口（供 e2e / 登录前置复用），payload 见 README「注册与登录」章节。
 * 返回值至少包含 {id, role, schoolId}；school 额外带 schoolCode/schoolName。
 */
export async function registerAccount(ctx, payload) {
  const x = payload || {};
  const role = trimmed(x.role);
  if (!PUBLIC_ROLES.includes(role)) throw new Error("请选择注册身份");
  if (role === "school") return await registerSchool(ctx, x);
  if (process.env.ALLOW_PUBLIC_REGISTRATION === "0")
    throw accountError("学校已关闭公开注册，请联系学校管理员创建账户", 403);
  const name = trimmed(x.name);
  if (!name) throw new Error("请填写姓名");
  const username = normalizeUsername(x.username);
  if (!policyFor(ctx)(x.password)) throw new Error("密码至少 8 位");
  const email = normalizeEmail(x.email);
  if (email && !validEmail(email)) throw new Error("邮箱格式无效");
  const school = resolveSchoolCode(ctx.db, x.schoolCode);
  if (!school) throw new Error("学校代码无效");
  const common = { name, username, password: x.password, email };
  if (role === "teacher") return await registerTeacher(ctx, x, school, common);
  if (role === "student") return await registerStudent(ctx, x, school, common);
  return await registerParent(ctx, x, school, common);
}

function findLoginUser(db, body) {
  const identifiers = [body.username, body.account, body.email]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim());
  for (const identifier of identifiers) {
    const lowered = identifier.toLowerCase();
    const compact = squashUsername(identifier);
    const user =
      compact &&
      db.prepare("SELECT * FROM users WHERE username=?").get(compact);
    if (user) return user;
    // A legacy database may contain mixed-case emails. Never pick an arbitrary
    // account if two old rows differ only by email case.
    const emails = db
      .prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE LIMIT 2")
      .all(lowered);
    if (emails.length > 1) return null;
    if (emails.length === 1) return emails[0];
  }
  return null;
}

function adminUsername(db, rawUsername, email) {
  if (trimmed(rawUsername)) return normalizeUsername(rawUsername);
  if (!email) throw new Error("请填写账号名或邮箱");
  // 兼容旧版 UI 只传邮箱的建号方式：能安全派生就派生，否则留空（旧账号仍可用邮箱登录）。
  const derived = usernameFromEmail(email);
  if (
    derived &&
    !db.prepare("SELECT id FROM users WHERE username=?").get(derived)
  )
    return derived;
  return null;
}

export function registerAccountsRoutes(app, ctx) {
  const db = ctx.db;
  const { auth, schoolAdmin, schoolStaff } = ctx;
  const fail = (res, error, fallback) => {
    const busy =
      error?.errcode === 5 ||
      error?.errcode === 6 ||
      error?.code === "SQLITE_BUSY" ||
      error?.code === "SQLITE_LOCKED";
    const status = busy ? 503 : Number(error?.status) || 400;
    if (status === 503) res.set("Retry-After", "5");
    res.status(status).json({
      error: busy
        ? "数据库繁忙，请稍后重试"
        : uniqueMessage(error) || error?.message || fallback,
    });
  };

  // 公开注册：4 身份；学校注册不受 ALLOW_PUBLIC_REGISTRATION 影响。
  app.post("/api/auth/register", async (req, res) => {
    try {
      const created = await registerAccount(ctx, req.body || {});
      if (typeof ctx.setSession === "function") ctx.setSession(res, created.id);
      if (created.schoolCode)
        return res.json({
          ok: true,
          schoolCode: created.schoolCode,
          schoolName: created.schoolName,
        });
      if (created.role === "parent")
        return res.json({ ok: true, studentName: created.studentName });
      res.json({ ok: true });
    } catch (error) {
      fail(res, error, "注册失败");
    }
  });

  // 登录兼容：{username}|{email}|{account} + password，失败统一文案。
  app.post("/api/auth/login", async (req, res) => {
    const body = req.body || {};
    if (
      typeof body.password !== "string" ||
      Buffer.byteLength(body.password) > 1024
    )
      return res.status(400).json({ error: "密码格式无效" });
    const user = findLoginUser(db, body);
    if (!user) {
      // Use the same bounded hashing admission as real accounts, so missing
      // accounts do not expose an immediate fast path for enumeration.
      await normalizerFor(ctx)(body.password, "login-dummy-salt");
      return res.status(401).json({ error: "账号或密码错误" });
    }
    if (!(await verifyPassword(ctx, body.password, user)))
      return res.status(401).json({ error: "账号或密码错误" });
    if (typeof ctx.setSession !== "function")
      return res.status(500).json({ error: "登录服务不可用" });
    ctx.setSession(res, user.id);
    res.json({ ok: true });
  });

  // 旧接口兼容：POST /api/schools/register（无 username 时由邮箱前缀生成）。
  app.post("/api/schools/register", async (req, res) => {
    try {
      const x = req.body || {};
      const email = normalizeEmail(x.email);
      if (
        !trimmed(x.schoolName) ||
        !trimmed(x.name) ||
        !email ||
        !policyFor(ctx)(x.password)
      )
        return res
          .status(400)
          .json({ error: "请完整填写学校与管理员信息，密码至少 8 位" });
      const username = trimmed(x.username)
        ? normalizeUsername(x.username)
        : uniqueUsername(db, usernameFromEmail(email) || "user");
      const created = await registerSchool(ctx, { ...x, username, email });
      if (typeof ctx.setSession === "function") ctx.setSession(res, created.id);
      res.json({
        ok: true,
        schoolCode: created.schoolCode,
        schoolName: created.schoolName,
      });
    } catch (error) {
      fail(
        res,
        error,
        /UNIQUE/i.test(String(error?.message))
          ? "管理员邮箱已注册"
          : "学校注册失败",
      );
    }
  });

  app.get("/api/teachers", auth, schoolAdmin, (req, res) => {
    res.json(
      db
        .prepare(
          "SELECT id,name,username,email,stage,subject,class_name,created_at FROM users WHERE school_id=? AND role='teacher' AND is_school_admin=0 ORDER BY name",
        )
        .all(req.user.school_id),
    );
  });

  app.post("/api/teachers", auth, schoolAdmin, async (req, res) => {
    try {
      const x = req.body || {};
      const name = trimmed(x.name);
      if (!name) return res.status(400).json({ error: "请填写教师姓名" });
      if (!policyFor(ctx)(x.password))
        return res.status(400).json({ error: "初始密码至少 8 位" });
      const stage = trimmed(x.stage);
      if (!stagesFor(ctx).includes(stage))
        return res.status(400).json({ error: "学段无效" });
      const subject = trimmed(x.subject);
      const className = trimmed(x.className ?? x.class_name);
      if (!subject || !className)
        return res.status(400).json({ error: "请填写学科和班级" });
      const email = normalizeEmail(x.email);
      if (email && !validEmail(email))
        return res.status(400).json({ error: "邮箱格式无效" });
      const username = adminUsername(db, x.username, email);
      const created = await insertUser(ctx, {
        schoolId: req.user.school_id,
        role: "teacher",
        name,
        username,
        password: x.password,
        email,
        stage,
        subject,
        className,
      });
      res.json({ id: created.id, username });
    } catch (error) {
      fail(res, error, "教师注册失败");
    }
  });

  app.get("/api/students", auth, schoolStaff, (req, res) => {
    res.json(
      db
        .prepare(
          "SELECT id,name,username,email,stage,class_name,created_at FROM users WHERE school_id=? AND role='student' ORDER BY class_name,name",
        )
        .all(req.user.school_id),
    );
  });

  app.post("/api/students", auth, schoolStaff, async (req, res) => {
    try {
      const x = req.body || {};
      const name = trimmed(x.name);
      if (!name) return res.status(400).json({ error: "请填写学生姓名" });
      if (!policyFor(ctx)(x.password))
        return res.status(400).json({ error: "初始密码至少 8 位" });
      const stage = trimmed(x.stage) || req.user.stage;
      if (!stagesFor(ctx).includes(stage))
        return res.status(400).json({ error: "学段无效" });
      const className =
        trimmed(x.className ?? x.class_name) || req.user.class_name || "";
      const email = normalizeEmail(x.email);
      if (email && !validEmail(email))
        return res.status(400).json({ error: "邮箱格式无效" });
      const username = adminUsername(db, x.username, email);
      const created = await insertUser(ctx, {
        schoolId: req.user.school_id,
        role: "student",
        name,
        username,
        password: x.password,
        email,
        stage,
        className,
      });
      res.json({ id: created.id, username });
    } catch (error) {
      fail(res, error, "学生注册失败");
    }
  });
}
