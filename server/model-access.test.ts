import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { once } from "node:events";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import {
  MODEL_MODES,
  canConfigureOwnModel,
  createModelAccess,
  createModelConfigGuard,
  describeModelAccess,
  findHeadTeacher,
  getSchoolModelMode,
  listSchoolClasses,
  modelConfigDeniedMessage,
  normalizeModelMode,
  registerModelAccessRoutes,
  resolveCredentialOwner,
  resolveModelRoute,
} from "./model-access.mjs";

const SCHEMA = fs.readFileSync(
  new URL("./schema.sql", import.meta.url),
  "utf8",
);
const NOW = "2026-10-24T00:00:00.000Z";

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function insertUser(db, user) {
  db.prepare(
    `INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin,review_mode,model_auth_mode,oauth_provider)
     VALUES(?,?,?,?,?,?,?,'salt',?,?,?,?,?,?,'api_key',?)`,
  ).run(
    user.id,
    user.schoolId || "s1",
    user.role,
    user.name,
    user.username || null,
    user.email || null,
    "hash",
    user.stage || "初中",
    user.subject || null,
    user.className || null,
    user.createdAt || NOW,
    user.isSchoolAdmin ? 1 : 0,
    "all",
    user.oauthProvider || null,
  );
  if (user.authMode || user.oauthProvider) {
    db.prepare(
      "UPDATE users SET model_auth_mode=?, oauth_provider=? WHERE id=?",
    ).run(user.authMode || "api_key", user.oauthProvider || null, user.id);
  }
}

function insertClassTeacher(db, schoolId, className, teacherId, isHead) {
  db.prepare(
    "INSERT INTO class_teachers(id,school_id,class_name,teacher_id,is_head,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    `${className}-${teacherId}`,
    schoolId,
    className,
    teacherId,
    isHead ? 1 : 0,
    NOW,
  );
}

function insertProviderKey(db, userId, provider = "deepseek") {
  db.prepare(
    "INSERT INTO provider_settings(id,user_id,provider,endpoint,model,encrypted_key,iv,updated_at) VALUES(?,?,?,?,?,'enc','iv',?)",
  ).run(
    `ps-${userId}`,
    userId,
    provider,
    "https://api.deepseek.com/chat/completions",
    "deepseek-chat",
    NOW,
  );
}

function insertOAuth(db, userId, provider = "deepseek") {
  db.prepare(
    `INSERT INTO oauth_connections(id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,token_type,scope,expires_at,status,created_at,updated_at)
     VALUES(?,?,?,'','enc',NULL,'iv','Bearer','',NULL,'active',?,?)`,
  ).run(`oc-${userId}-${provider}`, userId, provider, NOW, NOW);
}

function seed(db) {
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run("s1", "示例中学", NOW);
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    "s2",
    "无管理员中学",
    NOW,
  );
  insertUser(db, {
    id: "admin1",
    role: "teacher",
    name: "学校管理员",
    isSchoolAdmin: true,
  });
  insertUser(db, {
    id: "t1",
    role: "teacher",
    name: "张老师",
    subject: "数学",
  });
  insertUser(db, {
    id: "t2",
    role: "teacher",
    name: "李老师",
    subject: "语文",
  });
  insertUser(db, {
    id: "t3",
    role: "teacher",
    name: "王老师",
    subject: "英语",
  });
  insertUser(db, {
    id: "st1",
    role: "student",
    name: "学生甲",
    className: "初一(1)班",
  });
  insertUser(db, {
    id: "st2",
    role: "student",
    name: "学生乙",
    className: "初一(2)班",
  });
  insertUser(db, {
    id: "st9",
    role: "student",
    name: "学生丙",
    className: "初一(1)班",
  });
  insertUser(db, { id: "p1", role: "parent", name: "家长甲" });
  insertUser(db, { id: "p2", role: "parent", name: "家长乙" });
  insertUser(db, {
    id: "admin2",
    role: "teacher",
    name: "外校管理员",
    isSchoolAdmin: true,
    schoolId: "s2",
  });
  insertClassTeacher(db, "s1", "初一(1)班", "t1", true);
  insertClassTeacher(db, "s1", "初一(1)班", "t2", false);
  insertClassTeacher(db, "s1", "初一(2)班", "t3", false);
  db.prepare(
    "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
  ).run("ps1", "p1", "st1", "s1", "母亲", NOW);
}

function setMode(db, mode) {
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES('s1',?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode",
  ).run(mode, NOW);
}

function user(db, id) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id);
}

describe("model modes and class mapping", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seed(db);
  });
  afterEach(() => db.close());

  it("exposes the three documented modes", () => {
    expect(MODEL_MODES.map((mode) => mode.id)).toEqual([
      "school",
      "teacher_class",
      "teacher_parent",
    ]);
    for (const mode of MODEL_MODES) {
      expect(mode.label.length).toBeGreaterThan(0);
      expect(mode.desc.length).toBeGreaterThan(8);
    }
    expect(() => normalizeModelMode("mixed")).toThrow("模型调用模式无效");
    expect(normalizeModelMode("teacher_parent")).toBe("teacher_parent");
  });

  it("reads and writes the school mode with a school-wide default", () => {
    expect(getSchoolModelMode(db, "s1")).toBe("school");
    expect(getSchoolModelMode(db, "missing")).toBe("school");
    setMode(db, "teacher_class");
    expect(getSchoolModelMode(db, "s1")).toBe("teacher_class");
  });

  it("finds the head teacher of a class only", () => {
    expect(findHeadTeacher(db, "s1", "初一(1)班")?.id).toBe("t1");
    expect(findHeadTeacher(db, "s1", "初一(2)班")).toBeNull();
    expect(findHeadTeacher(db, "s1", "")).toBeNull();
    expect(findHeadTeacher(db, "s2", "初一(1)班")).toBeNull();
  });

  it("lists classes with head teacher, students and subject teachers", () => {
    const classes = listSchoolClasses(db, "s1");
    expect(classes.map((row) => row.className)).toEqual([
      "初一(1)班",
      "初一(2)班",
    ]);
    const first = classes.find((row) => row.className === "初一(1)班");
    expect(first.studentCount).toBe(2);
    expect(first.headTeacher).toEqual({ id: "t1", name: "张老师" });
    expect(first.subjectTeachers.map((row) => row.id)).toContain("t2");
    expect(first.subjectTeachers.map((row) => row.id)).not.toContain("t1");
    const second = classes.find((row) => row.className === "初一(2)班");
    expect(second.headTeacher).toBeNull();
    expect(second.subjectTeachers.map((row) => row.id)).toContain("t3");
  });
});

describe("resolveCredentialOwner role matrix", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seed(db);
  });
  afterEach(() => db.close());

  it("routes everyone to the school administrator in school mode", () => {
    for (const id of ["t1", "st1", "st2", "p1", "p2"]) {
      const route = resolveCredentialOwner(db, user(db, id));
      expect(route.mode).toBe("school");
      expect(route.ownerId).toBe("admin1");
      expect(route.source).toBe("school");
      expect(route.fallback).toBe(false);
    }
    const adminRoute = resolveCredentialOwner(db, user(db, "admin1"));
    expect(adminRoute).toMatchObject({
      ownerId: "admin1",
      source: "self",
      fallback: false,
    });
  });

  it("routes teachers to self and students/parents to the head teacher in teacher_class mode", () => {
    setMode(db, "teacher_class");
    expect(resolveCredentialOwner(db, user(db, "t2"))).toMatchObject({
      ownerId: "t2",
      source: "self",
    });
    expect(resolveCredentialOwner(db, user(db, "st1"))).toMatchObject({
      ownerId: "t1",
      source: "head_teacher",
      fallback: false,
    });
    expect(resolveCredentialOwner(db, user(db, "p1"))).toMatchObject({
      ownerId: "t1",
      source: "head_teacher",
    });
    // No head teacher for 初一(2)班 -> school administrator fallback.
    expect(resolveCredentialOwner(db, user(db, "st2"))).toMatchObject({
      ownerId: "admin1",
      source: "school",
      fallback: true,
    });
    // Parent without a bound child cannot know a class -> fallback.
    expect(resolveCredentialOwner(db, user(db, "p2"))).toMatchObject({
      ownerId: "admin1",
      source: "school",
      fallback: true,
    });
  });

  it("routes students to the bound parent first in teacher_parent mode", () => {
    setMode(db, "teacher_parent");
    expect(resolveCredentialOwner(db, user(db, "t1"))).toMatchObject({
      ownerId: "t1",
      source: "self",
    });
    expect(resolveCredentialOwner(db, user(db, "p1"))).toMatchObject({
      ownerId: "p1",
      source: "self",
    });
    expect(resolveCredentialOwner(db, user(db, "st1"))).toMatchObject({
      ownerId: "p1",
      source: "parent",
      fallback: false,
    });
    // st9 has no bound parent but its class has a head teacher -> fallback.
    expect(resolveCredentialOwner(db, user(db, "st9"))).toMatchObject({
      ownerId: "t1",
      source: "head_teacher",
      fallback: true,
    });
    // st2 has neither bound parent nor head teacher.
    expect(resolveCredentialOwner(db, user(db, "st2"))).toMatchObject({
      ownerId: "admin1",
      source: "school",
      fallback: true,
    });
  });

  it("always lets the administrator use their own credential", () => {
    for (const mode of ["school", "teacher_class", "teacher_parent"]) {
      setMode(db, mode);
      const route = resolveCredentialOwner(db, user(db, "admin1"));
      expect(route).toMatchObject({ ownerId: "admin1", source: "self" });
    }
  });

  it("returns a null owner when the school has no administrator", () => {
    insertClassTeacher(db, "s2", "高一(1)班", "admin2", true);
    db.prepare(
      "UPDATE users SET is_school_admin=0, role='teacher' WHERE id='admin2'",
    ).run();
    insertUser(db, {
      id: "st3",
      role: "student",
      name: "外校学生",
      className: "高一(1)班",
      schoolId: "s2",
    });
    const route = resolveCredentialOwner(db, user(db, "st3"));
    expect(route.ownerId).toBeNull();
    expect(route.owner).toBeNull();
  });

  it("exposes the same resolution through the bound helper", () => {
    setMode(db, "teacher_class");
    const access = createModelAccess(db);
    expect(access.resolveModelRoute(user(db, "st1")).ownerId).toBe("t1");
    expect(access.getSchoolModelMode("s1")).toBe("teacher_class");
    expect(resolveModelRoute(db, user(db, "t2")).ownerId).toBe("t2");
  });
});

describe("canConfigureOwnModel", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seed(db);
  });
  afterEach(() => db.close());

  it("only lets the school administrator configure credentials in school mode", () => {
    const flags = ["admin1", "t1", "st1", "p1"].map((id) =>
      canConfigureOwnModel(db, user(db, id)),
    );
    expect(flags).toEqual([true, false, false, false]);
    expect(modelConfigDeniedMessage(db, user(db, "t1"))).toContain(
      "全校统一模式",
    );
    expect(modelConfigDeniedMessage(db, user(db, "st1"))).toContain("学生");
  });

  it("lets teachers configure but not parents in teacher_class mode", () => {
    setMode(db, "teacher_class");
    expect(canConfigureOwnModel(db, user(db, "t1"))).toBe(true);
    expect(canConfigureOwnModel(db, user(db, "p1"))).toBe(false);
    expect(canConfigureOwnModel(db, user(db, "st1"))).toBe(false);
    expect(canConfigureOwnModel(db, user(db, "admin1"))).toBe(true);
    expect(modelConfigDeniedMessage(db, user(db, "p1"))).toContain("班费模式");
  });

  it("lets teachers and parents configure in teacher_parent mode", () => {
    setMode(db, "teacher_parent");
    expect(canConfigureOwnModel(db, user(db, "t1"))).toBe(true);
    expect(canConfigureOwnModel(db, user(db, "p1"))).toBe(true);
    expect(canConfigureOwnModel(db, user(db, "st1"))).toBe(false);
    expect(canConfigureOwnModel(db, null)).toBe(false);
  });
});

describe("describeModelAccess", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seed(db);
  });
  afterEach(() => db.close());

  it("reports the administrator credential inherited by teachers", () => {
    insertProviderKey(db, "admin1", "qwen");
    const access = describeModelAccess(db, user(db, "t1"));
    expect(access).toMatchObject({
      mode: "school",
      ownerId: "admin1",
      ownerName: "学校管理员",
      ownerRole: "teacher",
      hasApiKey: true,
      hasOAuth: false,
      authMode: "api_key",
      provider: "qwen",
      configured: true,
      hint: "",
      source: "school",
      fallback: false,
    });
    expect(JSON.stringify(access)).not.toContain("enc");
  });

  it("tells the owner to configure a credential when none exists", () => {
    const own = describeModelAccess(db, user(db, "admin1"));
    expect(own.configured).toBe(false);
    expect(own.hint).toContain("请先配置");
    const inherited = describeModelAccess(db, user(db, "st1"));
    expect(inherited.configured).toBe(false);
    expect(inherited.hint).toContain("学校管理员");
  });

  it("flags a stale OAuth mode with an actionable hint", () => {
    db.prepare(
      "UPDATE users SET model_auth_mode='oauth', oauth_provider='deepseek' WHERE id='admin1'",
    ).run();
    const stale = describeModelAccess(db, user(db, "t1"));
    expect(stale.configured).toBe(false);
    expect(stale.authMode).toBe("oauth");
    expect(stale.provider).toBe("deepseek");
    expect(stale.hasOAuth).toBe(false);
    expect(stale.hint).toBe("OAuth 授权已失效，请重新连接或改用 API Key");

    insertOAuth(db, "admin1", "deepseek");
    const live = describeModelAccess(db, user(db, "t1"));
    expect(live.configured).toBe(true);
    expect(live.hasOAuth).toBe(true);
    expect(live.hint).toBe("");
  });

  it("explains a fallback owner when no head teacher is assigned", () => {
    setMode(db, "teacher_class");
    insertProviderKey(db, "admin1", "deepseek");
    const access = describeModelAccess(db, user(db, "st2"));
    expect(access.fallback).toBe(true);
    expect(access.source).toBe("school");
    expect(access.configured).toBe(true);
    expect(access.hint).toContain("回退");
  });

  it("reports a missing owner for a school without an administrator", () => {
    db.prepare("UPDATE users SET is_school_admin=0 WHERE school_id='s2'").run();
    insertUser(db, {
      id: "st3",
      role: "student",
      name: "外校学生",
      className: "高一(1)班",
      schoolId: "s2",
    });
    const access = describeModelAccess(db, user(db, "st3"));
    expect(access.ownerId).toBeNull();
    expect(access.configured).toBe(false);
    expect(access.hint).toContain("学校管理员");
  });
});

describe("createModelConfigGuard", () => {
  let db;
  beforeEach(() => {
    db = openDb();
    seed(db);
  });
  afterEach(() => db.close());

  function run(reqUser) {
    const guard = createModelConfigGuard(db);
    const result = { status: 0, body: null, next: false };
    const res = {
      status(code) {
        result.status = code;
        return this;
      },
      json(body) {
        result.body = body;
        return this;
      },
    };
    guard({ user: reqUser }, res, () => {
      result.next = true;
    });
    return result;
  }

  it("allows the school administrator", () => {
    expect(run(user(db, "admin1"))).toMatchObject({ status: 0, next: true });
  });

  it("rejects teachers in school mode with a mode-specific message", () => {
    const result = run(user(db, "t1"));
    expect(result.status).toBe(403);
    expect(result.body.error).toContain("全校统一模式");
  });

  it("rejects students and unauthenticated callers", () => {
    expect(run(user(db, "st1"))).toMatchObject({ status: 403 });
    expect(run(null)).toMatchObject({
      status: 401,
      body: { error: "请先登录" },
    });
  });
});

describe("model access routes", () => {
  let db, server, base;
  beforeAll(async () => {
    db = openDb();
    seed(db);
    insertProviderKey(db, "admin1", "deepseek");
    const app = express();
    app.use(express.json());
    const ctx = {
      db,
      auth: (req, res, next) => {
        const id = req.get("x-test-user");
        if (!id) return res.status(401).json({ error: "请先登录" });
        const found = db.prepare("SELECT * FROM users WHERE id=?").get(id);
        if (!found) return res.status(401).json({ error: "请先登录" });
        req.user = found;
        next();
      },
      schoolAdmin: (req, res, next) =>
        req.user?.is_school_admin
          ? next()
          : res.status(403).json({ error: "仅学校管理员可执行此操作" }),
    };
    registerModelAccessRoutes(app, ctx);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        db.close();
      }),
  );

  async function request(path, userId, method = "GET", body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(userId ? { "x-test-user": userId } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, body: payload };
  }

  it("returns the effective credential description", async () => {
    const response = await request("/api/model/access", "t1");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      mode: "school",
      ownerId: "admin1",
      canConfigure: false,
      schoolMode: "school",
      configured: true,
    });
    expect(response.body.modes).toHaveLength(3);
    expect(JSON.stringify(response.body)).not.toContain("enc");
  });

  it("requires a login for every route", async () => {
    expect((await request("/api/model/access")).status).toBe(401);
    expect((await request("/api/school/model-mode")).status).toBe(401);
  });

  it("only lets the school administrator read the mode panel", async () => {
    expect((await request("/api/school/model-mode", "t1")).status).toBe(403);
    const response = await request("/api/school/model-mode", "admin1");
    expect(response.status).toBe(200);
    expect(response.body.mode).toBe("school");
    expect(response.body.classes).toHaveLength(2);
    expect(response.body.classes[0].headTeacher).toEqual({
      id: "t1",
      name: "张老师",
    });
    expect(response.body.teachers.map((row) => row.id)).toContain("t2");
  });

  it("persists a valid mode and rejects an invalid one", async () => {
    const invalid = await request("/api/school/model-mode", "admin1", "PUT", {
      mode: "mixed",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("模型调用模式无效");

    const saved = await request("/api/school/model-mode", "admin1", "PUT", {
      mode: "teacher_parent",
    });
    expect(saved).toMatchObject({
      status: 200,
      body: { ok: true, mode: "teacher_parent" },
    });
    expect(getSchoolModelMode(db, "s1")).toBe("teacher_parent");
    expect(
      (
        await request("/api/school/model-mode", "t1", "PUT", {
          mode: "school",
        })
      ).status,
    ).toBe(403);
  });

  it("assigns, replaces and clears the head teacher of a class", async () => {
    const className = encodeURIComponent("初一(2)班");
    const assigned = await request(
      `/api/school/classes/${className}/head-teacher`,
      "admin1",
      "PUT",
      { teacherId: "t3" },
    );
    expect(assigned).toMatchObject({
      status: 200,
      body: { ok: true, teacherId: "t3" },
    });
    expect(findHeadTeacher(db, "s1", "初一(2)班")?.id).toBe("t3");
    expect(user(db, "t3").class_name).toBe("初一(2)班");

    // Replacing the head teacher keeps exactly one head per class.
    const replaced = await request(
      `/api/school/classes/${encodeURIComponent("初一(1)班")}/head-teacher`,
      "admin1",
      "PUT",
      { teacherId: "t2" },
    );
    expect(replaced.status).toBe(200);
    expect(findHeadTeacher(db, "s1", "初一(1)班")?.id).toBe("t2");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) total FROM class_teachers WHERE school_id='s1' AND class_name='初一(1)班' AND is_head=1",
        )
        .get().total,
    ).toBe(1);

    const cleared = await request(
      `/api/school/classes/${encodeURIComponent("初一(1)班")}/head-teacher`,
      "admin1",
      "PUT",
      { teacherId: null },
    );
    expect(cleared.status).toBe(200);
    expect(findHeadTeacher(db, "s1", "初一(1)班")).toBeNull();
  });

  it("rejects a head teacher from another school or a non-administrator", async () => {
    const crossSchool = await request(
      `/api/school/classes/${encodeURIComponent("初一(2)班")}/head-teacher`,
      "admin1",
      "PUT",
      { teacherId: "admin2" },
    );
    expect(crossSchool.status).toBe(400);
    expect(crossSchool.body.error).toContain("同校教师");
    const outsider = await request(
      `/api/school/classes/${encodeURIComponent("初一(2)班")}/head-teacher`,
      "t1",
      "PUT",
      { teacherId: "t3" },
    );
    expect(outsider.status).toBe(403);
  });
});

describe("route registration is independent of express version details", () => {
  it("registers every documented route", () => {
    const registered = [];
    const app = {
      get: (path) => registered.push(`GET ${path}`),
      put: (path) => registered.push(`PUT ${path}`),
    };
    registerModelAccessRoutes(app, {
      db: { prepare: () => ({ get: () => null, all: () => [] }) },
      auth: () => {},
      schoolAdmin: () => {},
    });
    expect(registered).toEqual(
      expect.arrayContaining([
        "GET /api/model/access",
        "GET /api/school/model-mode",
        "PUT /api/school/model-mode",
        "PUT /api/school/classes/:className/head-teacher",
      ]),
    );
  });
});
