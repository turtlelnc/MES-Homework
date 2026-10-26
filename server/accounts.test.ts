import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  insertUser,
  normalizeUsername,
  registerAccount,
  registerAccountsRoutes,
  validateUsername,
} from "./accounts.mjs";

const PASSWORD = "ChangeMe123!";
const root = new URL(".", import.meta.url);
let db: DatabaseSync;
let harness: ReturnType<typeof createHarness>;
let originalRegistrationFlag: string | undefined;

function pass(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

function iso() {
  return new Date().toISOString();
}

// 极简 Express 替身：只做 method+path 匹配与同步中间件链，避免测试真实监听端口。
function createHarness() {
  const routes: {
    method: string;
    path: string;
    handlers: ((req: any, res: any, next?: any) => any)[];
  }[] = [];
  const sessions: string[] = [];
  const app = {
    get: (path: string, ...handlers: any[]) =>
      routes.push({ method: "GET", path, handlers }),
    post: (path: string, ...handlers: any[]) =>
      routes.push({ method: "POST", path, handlers }),
    put: (path: string, ...handlers: any[]) =>
      routes.push({ method: "PUT", path, handlers }),
    patch: (path: string, ...handlers: any[]) =>
      routes.push({ method: "PATCH", path, handlers }),
  };
  const ctx = {
    db,
    uid: () => randomUUID(),
    iso,
    pass,
    validPassword: (value: unknown) =>
      typeof value === "string" &&
      value.length >= 8 &&
      Buffer.byteLength(value) <= 1024,
    setSession: (res: any, userId: string) => {
      sessions.push(userId);
      res.setHeader("set-cookie", `sc_session=${userId}`);
    },
    auth: (req: any, res: any, next: any) =>
      req.user ? next() : res.status(401).json({ error: "请先登录" }),
    schoolAdmin: (req: any, res: any, next: any) =>
      req.user?.is_school_admin
        ? next()
        : res.status(403).json({ error: "仅学校管理员可执行此操作" }),
    schoolStaff: (req: any, res: any, next: any) =>
      req.user?.role === "teacher"
        ? next()
        : res.status(403).json({ error: "仅学校教职工可执行此操作" }),
  };
  registerAccountsRoutes(app as any, ctx as any);
  return { routes, ctx, sessions };
}

function matchPath(pattern: string, pathname: string) {
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index];
    if (part.startsWith(":"))
      params[part.slice(1)] = decodeURIComponent(actual[index]);
    else if (part !== actual[index]) return null;
  }
  return params;
}

async function request(
  method: string,
  path: string,
  options: { body?: unknown; user?: any } = {},
) {
  const pathname = path.split("?")[0];
  for (const route of harness.routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (!params) continue;
    const req: any = {
      method,
      path: pathname,
      params,
      query: {},
      headers: {},
      body: options.body ?? {},
      user: options.user,
      get: () => "",
    };
    const res: any = {
      statusCode: 200,
      payload: undefined as any,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.payload = payload;
        return this;
      },
      setHeader(name: string, value: unknown) {
        this.headers[name.toLowerCase()] = String(value);
        return this;
      },
      set(name: string, value: unknown) {
        return this.setHeader(name, value);
      },
    };
    for (const handler of route.handlers) {
      if (handler.length >= 3) {
        let moved = false;
        handler(req, res, () => {
          moved = true;
        });
        if (!moved) break;
      } else {
        await handler(req, res);
        break;
      }
    }
    return res;
  }
  throw new Error(`测试路由未注册：${method} ${path}`);
}

function userRow(id: string) {
  return harness.ctx.db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(id) as any;
}

async function createSchool(
  overrides: Record<string, unknown> = {},
): Promise<{ schoolCode: string; schoolName: string; adminId: string }> {
  const response = await request("POST", "/api/auth/register", {
    body: {
      role: "school",
      schoolName: "海沙实验中学",
      name: "王校长",
      username: "principal",
      password: PASSWORD,
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(200);
  const admin = harness.ctx.db
    .prepare("SELECT id FROM users WHERE school_id=? AND is_school_admin=1")
    .get(response.payload.schoolCode) as any;
  return {
    schoolCode: response.payload.schoolCode,
    schoolName: response.payload.schoolName,
    adminId: admin.id,
  };
}

async function createStudent(schoolCode: string, suffix = "01") {
  harness.ctx.db
    .prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      `student-${suffix}`,
      schoolCode,
      "student",
      `学生${suffix}`,
      `stu${suffix}`,
      `stu${suffix}@example.test`,
      pass(PASSWORD, "salt-student"),
      "salt-student",
      "初中",
      null,
      "八年级（1）班",
      iso(),
      0,
    );
  return harness.ctx.db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(`student-${suffix}`) as any;
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(fs.readFileSync(new URL("./schema.sql", root), "utf8"));
  harness = createHarness();
  originalRegistrationFlag = process.env.ALLOW_PUBLIC_REGISTRATION;
});

afterEach(() => {
  if (originalRegistrationFlag === undefined)
    delete process.env.ALLOW_PUBLIC_REGISTRATION;
  else process.env.ALLOW_PUBLIC_REGISTRATION = originalRegistrationFlag;
  db.close();
});

describe("账号名规范化", () => {
  it("去空格并小写化 ASCII，保留中文", () => {
    expect(normalizeUsername("  Zhang_San  ")).toBe("zhang_san");
    expect(normalizeUsername("A B C")).toBe("abc");
    expect(normalizeUsername(" 张三 ")).toBe("张三");
  });

  it("拒绝非法账号名", () => {
    for (const value of [
      "",
      " a ",
      "a".repeat(33),
      "bad name!",
      "a@b",
      "张三!",
    ])
      expect(() => normalizeUsername(value)).toThrow();
    expect(() => normalizeUsername(123 as any)).toThrow();
  });

  it("validateUsername 返回文案而不抛错", () => {
    expect(validateUsername("teacher_01")).toBe("");
    expect(validateUsername("张三")).toBe("");
    expect(validateUsername("a")).not.toBe("");
    expect(validateUsername(undefined)).not.toBe("");
  });
});

describe("insertUser", () => {
  it("插入可登录账号并哈希密码", async () => {
    const school = await createSchool();
    const created = await insertUser(harness.ctx as any, {
      schoolId: school.schoolCode,
      role: "teacher",
      name: "李老师",
      username: "Li_Teacher",
      password: PASSWORD,
      email: "Li@Example.test",
      stage: "初中",
      subject: "物理",
      className: "八年级（1）班",
    });
    const row = userRow(created.id);
    expect(row.role).toBe("teacher");
    expect(row.username).toBe("li_teacher");
    expect(row.email).toBe("li@example.test");
    expect(row.stage).toBe("初中");
    expect(row.is_school_admin).toBe(0);
    expect(
      timingSafeEqual(
        Buffer.from(pass(PASSWORD, row.salt), "hex"),
        Buffer.from(row.password_hash, "hex"),
      ),
    ).toBe(true);
  });

  it("校验密码、身份与唯一性", async () => {
    const school = await createSchool();
    const base = {
      schoolId: school.schoolCode,
      role: "student",
      name: "张三",
      username: "zhangsan",
      password: PASSWORD,
      stage: "初中",
      className: "八年级（2）班",
    };
    await expect(
      insertUser(harness.ctx as any, { ...base, password: "short" }),
    ).rejects.toThrow("密码至少 8 位");
    await expect(
      insertUser(harness.ctx as any, { ...base, role: "school" }),
    ).rejects.toThrow("账户身份无效");
    await insertUser(harness.ctx as any, base);
    await expect(insertUser(harness.ctx as any, base)).rejects.toThrow(
      "该账号名已被使用",
    );
  });
});

describe("4 身份注册", () => {
  it("学校注册创建学校与首位管理员，并自动登录", async () => {
    const school = await createSchool();
    const row = userRow(school.adminId);
    expect(row.role).toBe("teacher");
    expect(row.username).toBe("principal");
    expect(row.is_school_admin).toBe(1);
    expect(row.stage).toBeNull();
    expect(row.subject).toBeNull();
    expect(harness.sessions).toEqual([school.adminId]);
    const stored = db
      .prepare("SELECT * FROM schools WHERE id=?")
      .get(school.schoolCode) as any;
    expect(stored.name).toBe("海沙实验中学");
  });

  it("老师注册支持完整学校代码与前 8 位前缀，并写入任课记录", async () => {
    const school = await createSchool();
    const response = await request("POST", "/api/auth/register", {
      body: {
        role: "teacher",
        schoolCode: school.schoolCode.slice(0, 8),
        name: "李老师",
        username: "li_teacher",
        password: PASSWORD,
        stage: "初中",
        subject: "物理",
        className: "九年级（3）班",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true });
    const row = userRow(
      (
        db
          .prepare("SELECT id FROM users WHERE username='li_teacher'")
          .get() as any
      ).id,
    );
    expect(row.role).toBe("teacher");
    expect(row.school_id).toBe(school.schoolCode);
    const mapping = db
      .prepare("SELECT * FROM class_teachers WHERE teacher_id=?")
      .get(row.id) as any;
    expect(mapping).toMatchObject({
      school_id: school.schoolCode,
      class_name: "九年级（3）班",
      is_head: 0,
    });
  });

  it("学生注册写入学段与班级", async () => {
    const school = await createSchool();
    const response = await request("POST", "/api/auth/register", {
      body: {
        role: "student",
        schoolCode: school.schoolCode,
        name: "林一",
        username: "linyi",
        password: PASSWORD,
        stage: "高中",
        className: "高一（1）班",
      },
    });
    expect(response.payload).toEqual({ ok: true });
    const row = userRow(
      (db.prepare("SELECT id FROM users WHERE username='linyi'").get() as any)
        .id,
    );
    expect(row).toMatchObject({
      role: "student",
      stage: "高中",
      class_name: "高一（1）班",
    });
  });

  it("家长凭孩子账号与密码注册并绑定", async () => {
    const school = await createSchool();
    const student = await createStudent(school.schoolCode, "01");
    const response = await request("POST", "/api/auth/register", {
      body: {
        role: "parent",
        schoolCode: school.schoolCode,
        name: "林妈妈",
        username: "lin_mom",
        password: PASSWORD,
        childUsername: "STU01",
        childPassword: PASSWORD,
        relation: "母亲",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true, studentName: "学生01" });
    const parent = userRow(
      (db.prepare("SELECT id FROM users WHERE username='lin_mom'").get() as any)
        .id,
    );
    expect(parent.role).toBe("parent");
    const binding = db
      .prepare("SELECT * FROM parent_students WHERE parent_id=?")
      .get(parent.id) as any;
    expect(binding.student_id).toBe(student.id);
    expect(binding.relation).toBe("母亲");
  });

  it("家长绑错孩子密码统一报错，且不泄露账号是否存在", async () => {
    const school = await createSchool();
    await createStudent(school.schoolCode, "02");
    for (const child of [
      { childUsername: "stu02", childPassword: "WrongPass123!" },
      { childUsername: "not-exist", childPassword: PASSWORD },
    ]) {
      const response = await request("POST", "/api/auth/register", {
        body: {
          role: "parent",
          schoolCode: school.schoolCode,
          name: "家长",
          username: `parent_${Math.random().toString(16).slice(2, 8)}`,
          password: PASSWORD,
          ...child,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.payload.error).toBe("孩子账号或密码错误");
    }
  });

  it("无效学校代码与无效学段被拒绝", async () => {
    const wrongSchool = await request("POST", "/api/auth/register", {
      body: {
        role: "student",
        schoolCode: "deadbeef",
        name: "无校学生",
        username: "no_school",
        password: PASSWORD,
        stage: "初中",
        className: "八年级（1）班",
      },
    });
    expect(wrongSchool.statusCode).toBe(400);
    expect(wrongSchool.payload.error).toBe("学校代码无效");
    const school = await createSchool();
    const wrongStage = await request("POST", "/api/auth/register", {
      body: {
        role: "student",
        schoolCode: school.schoolCode,
        name: "无学段",
        username: "no_stage",
        password: PASSWORD,
        stage: "大学",
        className: "大一",
      },
    });
    expect(wrongStage.statusCode).toBe(400);
    expect(wrongStage.payload.error).toBe("请选择有效学段");
  });

  it("账号名冲突返回中文文案", async () => {
    const school = await createSchool();
    const response = await request("POST", "/api/auth/register", {
      body: {
        role: "student",
        schoolCode: school.schoolCode,
        name: "重复账号",
        username: "PRINCIPAL",
        password: PASSWORD,
        stage: "初中",
        className: "八年级（1）班",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.payload.error).toBe("该账号名已被使用");
  });

  it("ALLOW_PUBLIC_REGISTRATION=0 时仅关闭非学校自注册", async () => {
    process.env.ALLOW_PUBLIC_REGISTRATION = "0";
    const school = await createSchool();
    await createStudent(school.schoolCode, "03");
    for (const payload of [
      {
        role: "teacher",
        schoolCode: school.schoolCode,
        name: "封闭校老师",
        username: "closed_teacher",
        password: PASSWORD,
        stage: "初中",
        subject: "物理",
        className: "八年级（1）班",
      },
      {
        role: "student",
        schoolCode: school.schoolCode,
        name: "封闭校学生",
        username: "closed_student",
        password: PASSWORD,
        stage: "初中",
        className: "八年级（1）班",
      },
      {
        role: "parent",
        schoolCode: school.schoolCode,
        name: "封闭校家长",
        username: "closed_parent",
        password: PASSWORD,
        childUsername: "stu03",
        childPassword: PASSWORD,
      },
    ]) {
      const response = await request("POST", "/api/auth/register", {
        body: payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload.error).toBe(
        "学校已关闭公开注册，请联系学校管理员创建账户",
      );
    }
  });
});

describe("登录兼容 username / email / account", () => {
  it("支持账号名（大小写/空格不敏感）登录并建立会话", async () => {
    const school = await createSchool();
    const response = await request("POST", "/api/auth/login", {
      body: { username: " Principal ", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual({ ok: true });
    expect(harness.sessions.at(-1)).toBe(school.adminId);
  });

  it("does not report authentication overload as an incorrect password", async () => {
    await createSchool();
    harness.ctx.pass = () => {
      throw Object.assign(new Error("认证繁忙"), {
        status: 503,
        code: "AUTH_BUSY",
      });
    };
    for (const username of ["principal", "missing_user"]) {
      await expect(
        request("POST", "/api/auth/login", {
          body: { username, password: PASSWORD },
        }),
      ).rejects.toMatchObject({ status: 503, code: "AUTH_BUSY" });
    }
  });

  it("accepts mixed-case emails stored by legacy deployments", async () => {
    await createSchool();
    db.prepare(
      "UPDATE users SET email='Principal@Example.test' WHERE username='principal'",
    ).run();
    const response = await request("POST", "/api/auth/login", {
      body: { account: "PRINCIPAL@EXAMPLE.TEST", password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses ambiguous legacy emails instead of choosing an arbitrary account", async () => {
    const school = await createSchool();
    const row = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(school.adminId)!;
    db.prepare(
      "UPDATE users SET email='Principal@Example.test' WHERE id=?",
    ).run(row.id);
    db.prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      row.school_id,
      "teacher",
      "fixture",
      "legacy_case",
      "principal@example.test",
      row.password_hash,
      row.salt,
      iso(),
    );
    const before = harness.sessions.length;
    const response = await request("POST", "/api/auth/login", {
      body: { account: "principal@example.test", password: PASSWORD },
    });
    expect(response.statusCode).toBe(401);
    expect(harness.sessions.length).toBe(before);
  });

  it("does not allow registration to collide with a legacy email by case", async () => {
    const school = await createSchool();
    db.prepare(
      "UPDATE users SET email='Principal@Example.test' WHERE id=?",
    ).run(school.adminId);
    await expect(
      insertUser(harness.ctx, {
        schoolId: school.schoolCode,
        role: "teacher",
        name: "fixture",
        username: "new_teacher",
        email: "principal@example.test",
        password: PASSWORD,
      }),
    ).rejects.toThrow("邮箱已注册");
  });

  it("uses bounded password derivation for both missing and incorrect accounts", async () => {
    await createSchool();
    const derive = harness.ctx.pass;
    let calls = 0;
    harness.ctx.pass = (password, salt) => {
      calls++;
      return derive(password, salt);
    };
    const missing = await request("POST", "/api/auth/login", {
      body: { account: "missing_user", password: PASSWORD },
    });
    expect(missing.statusCode).toBe(401);
    expect(calls).toBe(1);
    const wrong = await request("POST", "/api/auth/login", {
      body: { account: "principal", password: "wrong-password" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(calls).toBe(2);
  });

  it("支持 account 字段填邮箱与旧 email 字段", async () => {
    await createSchool({ email: "principal@example.test" });
    db.prepare("UPDATE users SET email=? WHERE username='principal'").run(
      "principal@example.test",
    );
    const byAccount = await request("POST", "/api/auth/login", {
      body: { account: "PRINCIPAL@example.test", password: PASSWORD },
    });
    expect(byAccount.statusCode).toBe(200);
    const byEmail = await request("POST", "/api/auth/login", {
      body: { email: "principal@example.test", password: PASSWORD },
    });
    expect(byEmail.statusCode).toBe(200);
  });

  it("失败统一文案，非法密码格式返回 400", async () => {
    await createSchool();
    for (const body of [
      { username: "principal", password: "WrongPass123!" },
      { username: "nobody", password: PASSWORD },
      { password: PASSWORD },
    ]) {
      const response = await request("POST", "/api/auth/login", { body });
      expect(response.statusCode).toBe(401);
      expect(response.payload.error).toBe("账号或密码错误");
    }
    const invalid = await request("POST", "/api/auth/login", {
      body: { username: "principal", password: 123 },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("旧接口兼容与管理员建号", () => {
  it("/api/schools/register 无 username 时由邮箱前缀生成账号名", async () => {
    const response = await request("POST", "/api/schools/register", {
      body: {
        schoolName: "旧版学校",
        name: "旧管理员",
        email: "OldAdmin@Example.test",
        password: PASSWORD,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload.schoolName).toBe("旧版学校");
    const row = userRow(
      (
        db
          .prepare("SELECT id FROM users WHERE email='oldadmin@example.test'")
          .get() as any
      ).id,
    );
    expect(row.username).toBe("oldadmin");
    expect(row.is_school_admin).toBe(1);
  });

  it("/api/teachers 仅学校管理员可创建，返回 username 并校验唯一性", async () => {
    const school = await createSchool();
    const admin = userRow(school.adminId);
    const forbidden = await request("POST", "/api/teachers", {
      body: {
        name: "李老师",
        username: "li_teacher",
        password: PASSWORD,
        stage: "初中",
        subject: "物理",
        className: "八年级（1）班",
      },
      user: { ...admin, is_school_admin: 0 },
    });
    expect(forbidden.statusCode).toBe(403);
    const created = await request("POST", "/api/teachers", {
      body: {
        name: "李老师",
        username: "Li_Teacher",
        email: "li@example.test",
        password: PASSWORD,
        stage: "初中",
        subject: "物理",
        className: "八年级（1）班",
      },
      user: admin,
    });
    expect(created.statusCode).toBe(200);
    expect(created.payload.username).toBe("li_teacher");
    const duplicate = await request("POST", "/api/teachers", {
      body: {
        name: "重复老师",
        username: "li_teacher",
        password: PASSWORD,
        stage: "初中",
        subject: "数学",
        className: "八年级（2）班",
      },
      user: admin,
    });
    expect(duplicate.payload.error).toBe("该账号名已被使用");
    const list = await request("GET", "/api/teachers", { user: admin });
    expect(list.payload).toHaveLength(1);
    expect(list.payload[0]).toMatchObject({
      username: "li_teacher",
      email: "li@example.test",
      subject: "物理",
      class_name: "八年级（1）班",
    });
    expect(list.payload[0]).toHaveProperty("created_at");
  });

  it("管理员创建老师/学生时邮箱可选，邮箱冲突返回“邮箱已注册”", async () => {
    const school = await createSchool({ email: "principal@example.test" });
    const admin = userRow(school.adminId);
    const teacher = await request("POST", "/api/teachers", {
      body: {
        name: "无邮箱老师",
        username: "no_email_teacher",
        password: PASSWORD,
        stage: "高中",
        subject: "化学",
        className: "高一（1）班",
      },
      user: admin,
    });
    expect(teacher.statusCode).toBe(200);
    expect(userRow(teacher.payload.id).email).toBeNull();
    const duplicateEmail = await request("POST", "/api/teachers", {
      body: {
        name: "邮箱冲突",
        username: "conflict_teacher",
        email: "principal@example.test",
        password: PASSWORD,
        stage: "初中",
        subject: "数学",
        className: "七年级（1）班",
      },
      user: admin,
    });
    expect(duplicateEmail.payload.error).toBe("邮箱已注册");
  });

  it("/api/students 保持旧用法（仅姓名/邮箱/密码），并回填学段与班级", async () => {
    const school = await createSchool();
    const teacherId = randomUUID();
    db.prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      teacherId,
      school.schoolCode,
      "teacher",
      "任课老师",
      "course_teacher",
      "course@example.test",
      pass(PASSWORD, "salt-teacher"),
      "salt-teacher",
      "初中",
      "物理",
      "九年级（1）班",
      iso(),
      0,
    );
    const teacher = userRow(teacherId);
    const created = await request("POST", "/api/students", {
      body: {
        name: "新学生",
        email: "newstudent@example.test",
        password: PASSWORD,
      },
      user: teacher,
    });
    expect(created.statusCode).toBe(200);
    expect(created.payload.username).toBe("newstudent");
    const row = userRow(created.payload.id);
    expect(row).toMatchObject({
      role: "student",
      stage: "初中",
      class_name: "九年级（1）班",
    });
    const list = await request("GET", "/api/students", { user: teacher });
    expect(list.payload[0]).toHaveProperty("username", "newstudent");
  });

  it("registerAccount 直接调用返回 {id, role, schoolId}", async () => {
    const school = await createSchool();
    const student = await createStudent(school.schoolCode, "09");
    const created = await registerAccount(harness.ctx as any, {
      role: "parent",
      schoolCode: school.schoolCode,
      name: "直接家长",
      username: "direct_parent",
      password: PASSWORD,
      childUsername: student.username,
      childPassword: PASSWORD,
    });
    expect(created.role).toBe("parent");
    expect(created.schoolId).toBe(school.schoolCode);
    expect(userRow(created.id).role).toBe("parent");
  });
});
