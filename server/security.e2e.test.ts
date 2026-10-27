import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { seedTeachingFixture } from "./analysis.fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
let dir: string,
  base: string,
  db: DatabaseSync,
  child: ReturnType<typeof spawn>;
let fixture: ReturnType<typeof seedTeachingFixture>;
let student: string,
  peer: string,
  teacher: string,
  outsider: string,
  peerTeacher: string,
  adminCookie: string;
let submissionId: string,
  filename: string,
  hiddenAssignment: string,
  foreignKnowledge: string;
async function request(
  route: string,
  cookie = "",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function login(email: string) {
  const response = await request("/api/auth/login", "", "POST", {
    email,
    password: "ChangeMe123!",
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-security-"));
  fs.mkdirSync(path.join(dir, "uploads"));
  db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  fixture = seedTeachingFixture(db);
  db.exec("DROP TABLE submission_files"); // Existing deployments have no attachment table.
  const sample = db
    .prepare("SELECT * FROM users WHERE id=?")
    .get(fixture.teacherId)!;
  const otherSchool = randomUUID();
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    otherSchool,
    "Other",
    new Date().toISOString(),
  );
  for (const [email, school] of [
    ["outside@fixture.test", otherSchool],
    ["peer-teacher@fixture.test", fixture.schoolId],
  ]) {
    db.prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) SELECT ?,?,role,name,?,?,password_hash,salt,stage,subject,class_name,created_at,0 FROM users WHERE id=?",
    ).run(randomUUID(), school, email.split("@")[0], email, sample.id);
  }
  hiddenAssignment = randomUUID();
  db.prepare(
    "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at,description,grading_mode) SELECT ?,school_id,teacher_id,title,stage,subject,'other-class',due_at,status,created_at,'','bank' FROM assignments WHERE id=?",
  ).run(hiddenAssignment, fixture.assignmentId);
  foreignKnowledge = randomUUID();
  db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)").run(
    foreignKnowledge,
    otherSchool,
    "初中",
    "物理",
    "private",
    "",
    "outside",
    new Date().toISOString(),
  );
  const submission = db
    .prepare(
      "SELECT id FROM submissions WHERE student_id=? AND teacher_reviewed=1",
    )
    .get(fixture.students[0].id)!;
  submissionId = String(submission.id);
  filename = `${submissionId}.png`;
  fs.writeFileSync(
    path.join(dir, "uploads", filename),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  db.prepare(
    "UPDATE submissions SET file_path=?,file_type='image/png',analysis_json=? WHERE id=?",
  ).run(
    path.join(dir, "uploads", filename),
    JSON.stringify({ items: [], secret: "old-reviewed-result" }),
    submissionId,
  );
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const preload = path.join(dir, "mock-model.mjs");
  fs.writeFileSync(
    preload,
    `import fs from "node:fs";
    import dns from "node:dns";
    // Fixture model traffic is mocked; DNS must also stay deterministic and offline.
    dns.promises.lookup=async()=>[{address:"1.1.1.1",family:4}];
    globalThis.fetch = async (_url, options) => {
      fs.writeFileSync(${JSON.stringify(path.join(dir, "model-request.json"))}, options.body);
      const configFile=${JSON.stringify(path.join(dir, "model-response.json"))};
      const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,"utf8")):{delay:500,payload:{ocrText:"RACE_UNREVIEWED",items:[]}};
      await new Promise(r=>setTimeout(r,config.delay||0));
      return Response.json({choices:[{message:{content:JSON.stringify(config.payload)}}]});
    };`,
  );
  child = spawn(
    process.execPath,
    ["--import", pathToFileURL(preload).href, "server/index.mjs"],
    {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: String(port),
        HOST: "127.0.0.1",
        NODE_ENV: "test",
        SYSTEM_PRESSURE_ENABLED: "0",
        CLIENT_TILING_ENABLED: "0",
        DEEPSEEK_FILES_ENABLED: "0",
        MODEL_SCHOOL_DAILY_MICRO_CNY: "0",
        MODEL_USER_DAILY_MICRO_CNY: "0",
        APP_SECRET: "security-test-only-32-character-secret",
      },
      stdio: "ignore",
    },
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request("/api/health")).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  teacher = await login("teacher@fixture.test");
  student = await login("lin@fixture.test");
  peer = await login("qing@fixture.test");
  outsider = await login("outside@fixture.test");
  peerTeacher = await login("peer-teacher@fixture.test");
  adminCookie = await login("admin@fixture.test");
  // v0.2.1：切到「老师分开」模式，教师才能配置自己的模型凭证（安全用例需要）。
  expect(
    (
      await request("/api/school/model-mode", adminCookie, "PUT", {
        mode: "teacher_class",
      })
    ).status,
  ).toBe(200);
}, 20000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("HTTP authorization regressions (isolated SQLite; no model requests)", () => {
  it("retains an existing same-vendor key and activates it only when explicitly requested", async () => {
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "deepseek",
          apiKey: "mock-retained-key",
        })
      ).status,
    ).toBe(200);
    const old = db
      .prepare("SELECT encrypted_key,iv FROM provider_settings WHERE user_id=?")
      .get(fixture.teacherId);
    db.prepare(
      "UPDATE users SET model_auth_mode='oauth',oauth_provider='chatgpt' WHERE id=?",
    ).run(fixture.teacherId);
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "deepseek",
          apiKey: "",
          model: "custom-model",
        })
      ).status,
    ).toBe(200);
    expect(
      db
        .prepare(
          "SELECT encrypted_key,iv FROM provider_settings WHERE user_id=?",
        )
        .get(fixture.teacherId),
    ).toEqual(old);
    expect(
      db
        .prepare("SELECT model_auth_mode FROM users WHERE id=?")
        .get(fixture.teacherId)?.model_auth_mode,
    ).toBe("oauth");
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "openai",
          apiKey: "",
        })
      ).status,
    ).toBe(400);
    const activated = await request("/api/settings/provider", teacher, "PUT", {
      provider: "deepseek",
      apiKey: "",
      activate: true,
    });
    expect(await activated.json()).toMatchObject({ activated: true });
    expect(
      db
        .prepare("SELECT model_auth_mode,oauth_provider FROM users WHERE id=?")
        .get(fixture.teacherId),
    ).toMatchObject({ model_auth_mode: "api_key", oauth_provider: null });
  });
  it("normalizes copied model credentials and rejects invalid settings without replacing the saved configuration", async () => {
    const saved = await request("/api/settings/provider", teacher, "PUT", {
      provider: "deepseek",
      apiKey: "  mock-only\r\n",
      model: " deepseek-flash ",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ model: "deepseek-flash" });
    for (const settings of [
      { apiKey: " \r\n " },
      { apiKey: "a\nb" },
      { apiKey: "mock-only", model: { unexpected: true } },
    ]) {
      expect(
        (
          await request("/api/settings/provider", teacher, "PUT", {
            provider: "deepseek",
            ...settings,
          })
        ).status,
      ).toBe(400);
    }
    const read = await (
      await request("/api/settings/provider", teacher)
    ).json();
    expect(read).toMatchObject({
      provider: "deepseek",
      model: "deepseek-flash",
    });
    expect(JSON.stringify(read)).not.toContain("mock-only");
  });
  it("blocks anonymous, peer, unrelated teacher, and other-school access to private files and answers", async () => {
    for (const cookie of ["", peer, peerTeacher, outsider]) {
      expect([401, 404]).toContain(
        (await request(`/api/submissions/${submissionId}`, cookie)).status,
      );
      expect([401, 404]).toContain(
        (await request(`/uploads/${filename}`, cookie)).status,
      );
    }
    expect(
      (await request(`/api/submissions/${submissionId}`, student)).status,
    ).toBe(200);
    const download = await request(`/uploads/${filename}`, teacher);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe("attachment");
  });
  it("exposes official review answers only to authorized staff", async () => {
    const staff = await (
      await request(`/api/submissions/${submissionId}`, teacher)
    ).json();
    const learner = await (
      await request(`/api/submissions/${submissionId}`, student)
    ).json();
    expect(staff.questions.length).toBeGreaterThan(0);
    expect(
      staff.questions.every((q: any) => typeof q.standard_answer === "string"),
    ).toBe(true);
    expect(
      learner.questions.every((q: any) => !Object.hasOwn(q, "standard_answer")),
    ).toBe(true);
    expect(staff.files.length).toBeGreaterThan(0);
  });
  it("hides standard answers and enforces class/teacher scope on assignment details", async () => {
    const assignment = await (
      await request(`/api/assignments/${fixture.assignmentId}`, student)
    ).json();
    expect(assignment.questions).toHaveLength(8);
    expect(
      assignment.questions.every((q: object) => !("standard_answer" in q)),
    ).toBe(true);
    for (const cookie of [student, peer])
      expect(
        (await request(`/api/assignments/${hiddenAssignment}`, cookie)).status,
      ).toBe(404);
    expect(
      (await request(`/api/assignments/${fixture.assignmentId}`, peerTeacher))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/assignments/${fixture.assignmentId}`, outsider))
        .status,
    ).toBe(404);
  });
  it("allows account-name self-enrollment by role while keeping class boundaries", async () => {
    // v0.2.1: 老师/学生/家长可凭学校代码自助注册（需求 4）。学校代码仍然
    // 决定加入哪所学校，注册接口不能用来创建学校管理员或跨校身份。
    const teacherRegister = await request("/api/auth/register", "", "POST", {
      role: "teacher",
      schoolCode: fixture.schoolId,
      name: "新老师",
      username: "newteacher01",
      password: "attacker-password",
      stage: "初中",
      subject: "物理",
      className: "八年级（1）班",
    });
    expect(teacherRegister.status).toBe(200);
    expect(
      (
        await request("/api/auth/register", "", "POST", {
          role: "student",
          schoolCode: fixture.schoolId,
          name: "新同学",
          username: "newstudent01",
          password: "attacker-password",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/auth/register", "", "POST", {
          role: "parent",
          schoolCode: fixture.schoolId,
          name: "新家长",
          username: "newparent01",
          password: "attacker-password",
          childUsername: "lin",
          childPassword: "ChangeMe123!",
        })
      ).status,
    ).toBe(200);
    // 无效学校代码与重复账号名都必须被拒绝。
    expect(
      (
        await request("/api/auth/register", "", "POST", {
          role: "student",
          schoolCode: "not-a-school",
          name: "冒名",
          username: "newstudent02",
          password: "attacker-password",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/auth/register", "", "POST", {
          role: "student",
          schoolCode: fixture.schoolId,
          name: "重名",
          username: "newstudent01",
          password: "attacker-password",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/api/me", student, "PATCH", { className: "other-class" }))
        .status,
    ).toBe(403);
    // Students must never modify staff-managed attributes such as subject.
    expect(
      (await request("/api/me", student, "PATCH", { subject: "物理" })).status,
    ).toBe(403);
    expect(
      (await request("/api/me", student, "PATCH", { stage: "高中" })).status,
    ).toBe(403);
    expect(
      (
        await request("/api/me", student, "PATCH", {
          name: "新姓名",
          subject: "物理",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("/api/me", student, "PATCH", { name: "新姓名" })).status,
    ).toBe(200);
  });
  it("rejects cross-site state changes including login CSRF", async () => {
    expect(
      (
        await request(
          "/api/me",
          teacher,
          "PATCH",
          { name: "attacker" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/api/auth/login",
          "",
          "POST",
          { email: "teacher@fixture.test", password: "ChangeMe123!" },
          { "sec-fetch-site": "cross-site" },
        )
      ).status,
    ).toBe(403);
  });
  it("rejects unsafe model destinations and prototype property provider names", async () => {
    for (const provider of ["openai", "__proto__", "constructor"])
      expect(
        (
          await request("/api/settings/provider", teacher, "PUT", {
            provider,
            endpoint: "http://169.254.169.254/",
            apiKey: "not-a-real-key",
          })
        ).status,
      ).toBe(400);
  });
  it("rejects cross-school knowledge and fabricated review question links without changing records", async () => {
    expect(
      (
        await request("/api/assignments", teacher, "POST", {
          title: "test",
          questions: [
            {
              prompt: "q",
              standardAnswer: "a",
              score: 1,
              knowledgeId: foreignKnowledge,
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review`,
          teacher,
          "POST",
          { items: [{ questionId: randomUUID(), isCorrect: false }] },
        )
      ).status,
    ).toBe(400);
    expect(
      db
        .prepare("SELECT teacher_reviewed FROM submissions WHERE id=?")
        .get(submissionId)!.teacher_reviewed,
    ).toBe(1);
  });
  it("rejects active uploads and removes rejected temporary files", async () => {
    const before = fs.readdirSync(path.join(dir, "uploads"));
    const form = new FormData();
    form.append(
      "files",
      new Blob(["<script>alert(1)</script>"], { type: "image/png" }),
      "malicious.html",
    );
    const response = await fetch(
      `${base}/api/assignments/${fixture.assignmentId}/submissions`,
      { method: "POST", headers: { cookie: student }, body: form },
    );
    expect(response.status).toBe(400);
    expect(fs.readdirSync(path.join(dir, "uploads"))).toEqual(before);
    expect(
      (
        await fetch(`${base}/api/assignments/${hiddenAssignment}/submissions`, {
          method: "POST",
          headers: { cookie: student },
          body: form,
        })
      ).status,
    ).toBe(404);
  });
  it("uses canonical upload extensions and preserves authorized teacher review", async () => {
    const form = new FormData();
    form.append(
      "files",
      new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: "image/png",
      }),
      "image.html",
    );
    const response = await fetch(
      `${base}/api/assignments/${fixture.assignmentId}/submissions`,
      { method: "POST", headers: { cookie: student }, body: form },
    );
    expect(response.status).toBe(200);
    const [{ id }] = await response.json();
    expect(
      String(
        db.prepare("SELECT file_path FROM submissions WHERE id=?").get(id)!
          .file_path,
      ),
    ).toMatch(/\.png$/);
    const items = [...fixture.questionIdByNumber.values()].map(
      (questionId) => ({ questionId, isCorrect: true }),
    );
    expect(
      (
        await request(`/api/submissions/${id}/review`, teacher, "POST", {
          items,
          score: 60,
        })
      ).status,
    ).toBe(200);
  });
  it("hides unreviewed OCR and model output, including after re-recognition", async () => {
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "openai",
          apiKey: "mock-only",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/recognize`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(200);
    const row = await (
      await request(`/api/submissions/${submissionId}`, student)
    ).json();
    expect(row.teacher_reviewed).toBe(0);
    expect(row.analysis).toBeNull();
    expect(row.analysis_json).toBeNull();
    expect(row.ocr_text).toBeNull();
  });
  it("serializes recognition and review so late model output cannot inherit approval", async () => {
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "openai",
          apiKey: "mock-only",
        })
      ).status,
    ).toBe(200);
    const pending = request(
      `/api/submissions/${submissionId}/recognize`,
      teacher,
      "POST",
    );
    for (let i = 0; i < 50; i++) {
      if (
        db
          .prepare("SELECT status FROM submissions WHERE id=?")
          .get(submissionId)!.status === "recognizing"
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const items = [...fixture.questionIdByNumber.values()].map(
      (questionId) => ({ questionId, isCorrect: true }),
    );
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review`,
          teacher,
          "POST",
          { items, score: 60 },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/recognize`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(409);
    expect((await pending).status).toBe(200);
    const visible = await (
      await request(`/api/submissions/${submissionId}`, student)
    ).json();
    expect(visible.teacher_reviewed).toBe(0);
    expect(visible.analysis).toBeNull();
  });
  it("migrates legacy storage and keeps legacy submissions readable without creating duplicate files", async () => {
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='submission_files'",
        )
        .get(),
    ).toBeTruthy();
    const response = await request(`/api/submissions/${submissionId}`, teacher);
    const detail = await response.json();
    expect(detail.files).toHaveLength(1);
    expect(detail.questions).toHaveLength(8);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM submission_files WHERE submission_id=?",
        )
        .get(submissionId)!.n,
    ).toBe(0);
  });
  it("stores ordered pages as one submission and authorizes every attachment", async () => {
    const admin = db
      .prepare("SELECT id FROM users WHERE is_school_admin=1")
      .get()!;
    db.prepare(
      "INSERT INTO provider_settings SELECT ?,?,provider,endpoint,model,encrypted_key,iv,updated_at FROM provider_settings WHERE user_id=?",
    ).run(randomUUID(), admin.id, fixture.teacherId);

    const pages = [
      Buffer.from([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        ...Buffer.from("page-one"),
      ]),
      Buffer.from([
        137,
        80,
        78,
        71,
        13,
        10,
        26,
        10,
        ...Buffer.from("page-two"),
      ]),
    ];
    const form = new FormData();
    pages.forEach((page, i) =>
      form.append(
        "files",
        new Blob([page], { type: "image/png" }),
        `page-${i}.png`,
      ),
    );
    const before = db.prepare("SELECT COUNT(*) n FROM submissions").get()!
      .n as number;
    const uploaded = await fetch(
      `${base}/api/assignments/${fixture.assignmentId}/submissions`,
      { method: "POST", headers: { cookie: student }, body: form },
    );
    expect(uploaded.status).toBe(200);
    const rows = await uploaded.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].fileCount).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM submissions").get()!.n).toBe(
      before + 1,
    );
    const id = rows[0].id;
    const detail = await (
      await request(`/api/submissions/${id}`, teacher)
    ).json();
    expect(detail.files.map((file: any) => file.name)).toEqual([
      "page-0.png",
      "page-1.png",
    ]);
    for (const file of detail.files) {
      expect((await request(file.url, student)).status).toBe(200);
      expect((await request(file.url, peer)).status).toBe(404);
      expect((await request(file.url, outsider)).status).toBe(404);
      expect((await request(file.url)).status).toBe(401);
    }
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({ payload: { ocrText: "both-pages", items: [] } }),
    );
    expect(
      (await request(`/api/submissions/${id}/recognize`, teacher, "POST"))
        .status,
    ).toBe(200);
    const model = JSON.parse(
      fs.readFileSync(path.join(dir, "model-request.json"), "utf8"),
    );
    expect(
      model.messages[0].content
        .filter((part: any) => part.type === "image_url")
        .map((part: any) => part.image_url.url),
    ).toEqual(
      pages.map((page) => `data:image/png;base64,${page.toString("base64")}`),
    );
    const questions = detail.questions;
    const reviewItems = questions.map((q: any, i: number) => ({
      questionId: q.id,
      isCorrect: i !== 0,
      score: i === 0 ? 2 : q.score,
      studentAnswer: "student-value",
      practiceQuestions:
        i === 0
          ? [
              {
                prompt: "new-question",
                answer: "PRIVATE_PRACTICE_REFERENCE",
                explanation: "PRIVATE_PRACTICE_EXPLANATION",
              },
            ]
          : [],
    }));
    expect(
      (
        await request(`/api/submissions/${id}/review`, teacher, "POST", {
          items: reviewItems,
          score: 999999,
        })
      ).status,
    ).toBe(200);
    const saved = db
      .prepare("SELECT score FROM submissions WHERE id=?")
      .get(id)!;
    expect(saved.score).toBe(
      questions.reduce((sum: number, q: any) => sum + q.score, 0) -
        questions[0].score +
        2,
    );
    for (const invalid of [-1, questions[0].score + 1, "2"]) {
      expect(
        (
          await request(`/api/submissions/${id}/review`, teacher, "POST", {
            items: reviewItems.map((item: any, i: number) =>
              i === 0 ? { ...item, score: invalid } : item,
            ),
          })
        ).status,
      ).toBe(400);
      expect(
        db.prepare("SELECT score FROM submissions WHERE id=?").get(id)!.score,
      ).toBe(saved.score);
    }
    const own = await (await request(`/api/submissions/${id}`, student)).json();
    expect(JSON.stringify(own)).not.toContain("PRIVATE_PRACTICE");
    const notebook = await (await request("/api/mistakes", student)).json();
    // v0.2.1 学生错题视图按白名单返回，不再包含 submission_id；用题干定位。
    const mistake = notebook.find((m: any) => m.prompt === questions[0].prompt);
    expect(mistake.practiceQuestions).toEqual([{ prompt: "new-question" }]);
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({
        payload: { passed: "false", results: [{ correct: "false" }] },
      }),
    );
    expect(
      (
        await request(
          `/api/mistakes/${mistake.id}/practice/submit`,
          student,
          "POST",
          { answers: ["incorrect"] },
        )
      ).status,
    ).toBe(502);
    expect(
      db.prepare("SELECT mastery FROM mistakes WHERE id=?").get(mistake.id)!
        .mastery,
    ).toBe(0);
    expect(
      (
        await request(
          `/api/mistakes/${mistake.id}/practice/submit`,
          student,
          "POST",
          { answers: [] },
        )
      ).status,
    ).toBe(400);
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({
        payload: {
          passed: true,
          results: [{ correct: true, feedback: "ok", answer: "private" }],
        },
      }),
    );
    const graded = await (
      await request(
        `/api/mistakes/${mistake.id}/practice/submit`,
        student,
        "POST",
        { answers: ["correct"] },
      )
    ).json();
    expect(graded).toEqual({
      passed: true,
      results: [{ correct: true, feedback: "ok" }],
    });
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({
        payload: {
          questions: [
            { prompt: "replacement", answer: "HIDDEN", explanation: "HIDDEN" },
          ],
        },
      }),
    );
    const generated = await (
      await request(
        `/api/mistakes/${mistake.id}/practice/generate`,
        student,
        "POST",
      )
    ).json();
    expect(generated).toEqual({ questions: [{ prompt: "replacement" }] });
    expect(
      db.prepare("SELECT mastery FROM mistakes WHERE id=?").get(mistake.id)!
        .mastery,
    ).toBe(0);
  });
  it("does not publish re-recognized mistakes or accept stale practice grades", async () => {
    const mistake = db
      .prepare(
        "SELECT m.* FROM mistakes m JOIN submissions s ON s.id=m.submission_id WHERE m.student_id=? AND s.teacher_reviewed=1 AND m.practice_json IS NOT NULL ORDER BY m.created_at DESC LIMIT 1",
      )
      .get(fixture.students[0].id)!;
    fs.rmSync(path.join(dir, "model-request.json"), { force: true });
    const questions = JSON.parse(String(mistake.practice_json));
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({
        delay: 300,
        payload: {
          passed: true,
          results: questions.map(() => ({ correct: true })),
        },
      }),
    );
    const pending = request(
      `/api/mistakes/${mistake.id}/practice/submit`,
      student,
      "POST",
      { answers: questions.map(() => "answer") },
    );
    for (
      let i = 0;
      i < 50 && !fs.existsSync(path.join(dir, "model-request.json"));
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    // Change the question set while grading is in flight; the old result must not authorize it.
    db.prepare("UPDATE mistakes SET practice_json=?,mastery=0 WHERE id=?").run(
      JSON.stringify([{ prompt: "changed", answer: "new" }]),
      mistake.id,
    );
    expect((await pending).status).toBe(409);
    expect(
      db.prepare("SELECT mastery FROM mistakes WHERE id=?").get(mistake.id)!
        .mastery,
    ).toBe(0);
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({ payload: { ocrText: "re-recognized", items: [] } }),
    );
    expect(
      (
        await request(
          `/api/submissions/${mistake.submission_id}/recognize`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      (await (await request("/api/mistakes", student)).json()).some(
        (m: any) => m.id === mistake.id,
      ),
    ).toBe(false);
    expect(
      (
        await request(
          `/api/mistakes/${mistake.id}/practice/submit`,
          student,
          "POST",
          { answers: ["x"] },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/mistakes/${mistake.id}/practice/generate`,
          student,
          "POST",
        )
      ).status,
    ).toBe(404);
    const created = await (
      await request("/api/assignments", teacher, "POST", {
        title: "isolated pending source",
        questions: [
          { prompt: "dedicated-question", standardAnswer: "a", score: 5 },
        ],
      })
    ).json();
    const assignment = await (
      await request(`/api/assignments/${created.id}`, teacher)
    ).json();
    const qid = assignment.questions[0].id;
    const form = new FormData();
    form.append(
      "files",
      new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: "image/png",
      }),
      "only.png",
    );
    const [submission] = await (
      await fetch(`${base}/api/assignments/${created.id}/submissions`, {
        method: "POST",
        headers: { cookie: student },
        body: form,
      })
    ).json();
    expect(
      (
        await request(
          `/api/submissions/${submission.id}/review`,
          teacher,
          "POST",
          { items: [{ questionId: qid, isCorrect: false, score: 0 }] },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/submissions/${submission.id}/recognize`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      db
        .prepare("SELECT teacher_reviewed FROM submissions WHERE id=?")
        .get(submission.id)!.teacher_reviewed,
    ).toBe(0);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM mistakes WHERE submission_id=?")
        .get(submission.id)!.n,
    ).toBe(1);
    const paper = await (
      await request("/api/papers/generate", teacher, "POST", { count: 50 })
    ).json();
    expect(paper.questions.some((q: any) => q.id === qid)).toBe(false);
  });
  it("queues OCR with authorization, deduplication, polling and private audit history", async () => {
    db.exec("DELETE FROM model_usage");
    fs.writeFileSync(
      path.join(dir, "model-response.json"),
      JSON.stringify({
        delay: 600,
        payload: { ocrText: "BACKGROUND_OCR", items: [] },
      }),
    );
    const route = `/api/submissions/${submissionId}/recognition-jobs`;
    expect((await request(route, student, "POST")).status).toBe(403);
    expect((await request(route, outsider, "POST")).status).toBe(403);
    expect((await request(route, peerTeacher, "POST")).status).toBe(404);
    const response = await request(route, teacher, "POST");
    expect(response.status).toBe(202);
    const job = await response.json();
    expect(job).not.toHaveProperty("user_id");
    expect(job).not.toHaveProperty("token");
    expect((await request(route, teacher, "POST")).status).toBe(409);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/recognize`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review`,
          teacher,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review-history`,
          student,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review-history`,
          outsider,
        )
      ).status,
    ).toBe(404);
    let detail: any;
    for (let i = 0; i < 60; i++) {
      detail = await (
        await request(`/api/submissions/${submissionId}`, teacher)
      ).json();
      if (detail.recognitionJob?.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail.status).toBe("review");
    expect(detail.ocr_text).toBe("BACKGROUND_OCR");
    const hidden = await (
      await request(`/api/submissions/${submissionId}`, student)
    ).json();
    expect(hidden.analysis).toBeNull();
    expect(hidden.recognitionJob).toBeUndefined();
    const questions = db
      .prepare("SELECT id FROM questions WHERE assignment_id=?")
      .all(fixture.assignmentId);
    expect(
      (
        await request(
          `/api/submissions/${submissionId}/review`,
          teacher,
          "POST",
          {
            items: questions.map((q) => ({
              questionId: q.id,
              isCorrect: false,
              score: 0,
            })),
          },
        )
      ).status,
    ).toBe(200);
    const history = await (
      await request(`/api/submissions/${submissionId}/review-history`, teacher)
    ).json();
    expect(
      history.some((row: any) => row.action === "recognition_requested"),
    ).toBe(true);
    expect(history.some((row: any) => row.action === "review_saved")).toBe(
      true,
    );
    expect((await request("/api/operations", teacher)).status).toBe(403);
    const admin = db
      .prepare("SELECT id FROM users WHERE school_id=? AND is_school_admin=1")
      .get(fixture.schoolId)!;
    const sid = randomUUID();
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      sid,
      admin.id,
      new Date(Date.now() + 60000).toISOString(),
    );
    const status = await (
      await request("/api/operations", `sc_session=${sid}`)
    ).json();
    expect(
      status.jobs.some(
        (row: any) => row.status === "succeeded" && row.count >= 1,
      ),
    ).toBe(true);
    expect(status.modelUsage.callsLastDay).toBeGreaterThan(0);
    const foreignStatus = await (
      await request("/api/operations", outsider)
    ).json();
    expect(foreignStatus.jobs).toEqual([]);
    expect(foreignStatus.modelUsage.callsLastDay).toBe(0);
  });
  it("handles malformed password values and limits repeated login attempts", async () => {
    expect(
      (
        await request("/api/auth/login", "", "POST", {
          email: "teacher@fixture.test",
          password: {},
        })
      ).status,
    ).toBe(400);
    let last = 0;
    for (let i = 0; i < 35; i++)
      last = (
        await request("/api/auth/login", "", "POST", {
          email: "missing@test",
          password: "wrong",
        })
      ).status;
    expect(last).toBe(429);
  });
});
