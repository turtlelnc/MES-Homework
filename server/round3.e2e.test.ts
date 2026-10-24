import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { seedTeachingFixture } from "./analysis.fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
let dir: string, base: string, port: number, preload: string;
let db: DatabaseSync, fixture: ReturnType<typeof seedTeachingFixture>;
let child: ReturnType<typeof spawn>;
let teacher: string, student: string, admin: string;
let mistakeId: string, submissionId: string;
const modelLog = () => path.join(dir, "calls.jsonl");
const calls = () =>
  fs.existsSync(modelLog())
    ? fs.readFileSync(modelLog(), "utf8").trim().split("\n").filter(Boolean)
        .length
    : 0;
function model(payload: unknown, delay = 0) {
  fs.writeFileSync(
    path.join(dir, "model.json"),
    JSON.stringify({ payload, delay }),
  );
}
async function request(
  route: string,
  cookie = "",
  method = "GET",
  body?: unknown,
) {
  return fetch(base + route, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
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
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "server/index.mjs"], {
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
      APP_SECRET: "round-three-test-only-secret-32-characters",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request("/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server failed to start");
}
async function stop() {
  if (child?.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
async function waitCalls(count: number) {
  for (let i = 0; i < 100; i++) {
    if (calls() >= count) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("mock request did not arrive");
}
function clearUsage() {
  db.exec("DELETE FROM model_usage");
}
const generate = () =>
  request(`/api/mistakes/${mistakeId}/practice/generate`, student, "POST", {});
const submit = () =>
  request(`/api/mistakes/${mistakeId}/practice/submit`, student, "POST", {
    answers: ["answer"],
  });
async function review(correct: boolean) {
  const questions = db
    .prepare(
      "SELECT id,score FROM questions WHERE assignment_id=? ORDER BY number",
    )
    .all(fixture.assignmentId);
  return request(`/api/submissions/${submissionId}/review`, teacher, "POST", {
    items: questions.map((q) => ({
      questionId: q.id,
      isCorrect: correct,
      score: correct ? q.score : 0,
      reason: "复核更新",
      studentAnswer: "answer",
      correction: "correct",
      practiceQuestions: [{ prompt: "practice", answer: "correct" }],
    })),
  });
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-round3-"));
  db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  fixture = seedTeachingFixture(db);
  const mistake = db
    .prepare(
      "SELECT m.id,m.submission_id FROM mistakes m JOIN submissions s ON s.id=m.submission_id WHERE m.student_id=? AND s.teacher_reviewed=1 LIMIT 1",
    )
    .get(fixture.students[0].id)!;
  mistakeId = String(mistake.id);
  submissionId = String(mistake.submission_id);
  db.prepare("UPDATE mistakes SET practice_json=? WHERE id=?").run(
    JSON.stringify([{ prompt: "practice", answer: "correct" }]),
    mistakeId,
  );
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((r) => listener.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  preload = path.join(dir, "mock.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
    import dns from 'node:dns';
    // Offline fixture: mock DNS alongside model HTTP responses.
    dns.promises.lookup=async()=>[{address:'1.1.1.1',family:4}];
    globalThis.fetch = async (_url, options) => {
      const {payload,delay}=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, "model.json"))},'utf8'));
      fs.appendFileSync(${JSON.stringify(modelLog())}, options.body+'\\n');
      await new Promise(r=>setTimeout(r,delay));
      return Response.json({choices:[{message:{content:JSON.stringify(payload)}}]});
    };`,
  );
  model({ questions: [{ prompt: "practice", answer: "correct" }] });
  await start();
  teacher = await login("teacher@fixture.test");
  student = await login("lin@fixture.test");
  admin = await login("admin@fixture.test");
  expect(
    (
      await request("/api/settings/provider", admin, "PUT", {
        provider: "qwen",
        apiKey: "mock-only",
      })
    ).status,
  ).toBe(200);
}, 20000);
afterAll(async () => {
  await stop();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("third-round security and consistency regressions (mock model only)", () => {
  it("lets roles self-enroll with a valid school code but never hijack identity", async () => {
    // v0.2.1 起学生/老师/家长可凭学校代码自助注册；仍不能跨校或重复账号。
    const created = await request("/api/auth/register", "", "POST", {
      role: "student",
      schoolCode: fixture.schoolId,
      name: "unapproved",
      username: "unapproved01",
      password: "ChangeMe123!",
      stage: "初中",
      className: "other-class",
    });
    expect(created.status).toBe(200);
    expect(
      db
        .prepare("SELECT id FROM users WHERE username=?")
        .get("unapproved01"),
    ).toBeTruthy();
    const duplicate = await request("/api/auth/register", "", "POST", {
      role: "student",
      schoolCode: fixture.schoolId,
      name: "duplicate",
      username: "unapproved01",
      password: "ChangeMe123!",
      stage: "初中",
      className: "other-class",
    });
    expect(duplicate.status).toBe(400);
    const badSchool = await request("/api/auth/register", "", "POST", {
      role: "teacher",
      schoolCode: "not-a-school",
      name: "attacker",
      username: "attacker01",
      password: "ChangeMe123!",
      stage: "初中",
      subject: "物理",
      className: "八年级（1）班",
    });
    expect(badSchool.status).toBe(400);
  });
  it("allows staff to create students through the admin path", async () => {
    expect(
      (
        await request("/api/students", teacher, "POST", {
          name: "approved",
          email: "approved@fixture.test",
          password: "ChangeMe123!",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).status,
    ).toBe(200);
  });
  it("blocks parallel generation before paying for a second model call", async () => {
    clearUsage();
    model({ questions: [{ prompt: "practice-new", answer: "correct" }] }, 400);
    const before = calls();
    const pending = generate();
    await waitCalls(before + 1);
    const denied = await generate();
    expect(denied.status).toBe(429);
    expect((await pending).status).toBe(200);
    expect(calls() - before).toBe(1);
  });
  it("blocks parallel grading and generate/grade overlap so older grades cannot overwrite newer attempts", async () => {
    clearUsage();
    model(
      { results: [{ correct: false, feedback: "old" }], passed: false },
      400,
    );
    const before = calls();
    const pending = submit();
    await waitCalls(before + 1);
    model({ results: [{ correct: true, feedback: "new" }], passed: true });
    expect((await submit()).status).toBe(429);
    expect((await generate()).status).toBe(429);
    expect((await pending).status).toBe(200);
    expect(calls() - before).toBe(1);
    expect((await submit()).status).toBe(200);
    expect(
      db.prepare("SELECT mastery FROM mistakes WHERE id=?").get(mistakeId)!
        .mastery,
    ).toBe(1);
  });
  it("keeps student hourly quota across server restarts", async () => {
    clearUsage();
    model({ results: [{ correct: true }], passed: true });
    const before = calls();
    for (let i = 0; i < 20; i++) expect((await submit()).status).toBe(200);
    expect((await submit()).status).toBe(429);
    expect(calls() - before).toBe(20);
    await stop();
    await start();
    expect((await submit()).status).toBe(429);
    expect(calls() - before).toBe(20);
  }, 20000);
  it("enforces staff and school budgets and school-wide active leases before model calls", async () => {
    const route = `/api/teaching/assignments/${fixture.assignmentId}/analyze`;
    const insert = db.prepare(
      "INSERT INTO model_usage(id,user_id,school_id,created_at,finished_at,lease_until) VALUES(?,?,?,?,?,?)",
    );
    const cases = [
      { count: 120, owner: fixture.teacherId, age: 1000, active: false },
      { count: 600, owner: "different-user", age: 1000, active: false },
      { count: 3000, owner: "different-user", age: 2 * 3600000, active: false },
      { count: 4, owner: "different-user", age: 1000, active: true },
    ];
    model({ brief: "must not call" });
    for (const c of cases) {
      clearUsage();
      const now = Date.now();
      db.exec("BEGIN");
      for (let i = 0; i < c.count; i++)
        insert.run(
          String(i),
          c.owner,
          fixture.schoolId,
          now - c.age,
          c.active ? null : now - 500,
          now + 60000,
        );
      db.exec("COMMIT");
      const before = calls();
      expect((await request(route, teacher, "POST", {})).status).toBe(429);
      expect(calls()).toBe(before);
    }
    clearUsage();
  });
  it("invalidates class and student diagnoses when reviewed answers change", async () => {
    clearUsage();
    model({ brief: "valid before re-review" });
    const route = `/api/teaching/assignments/${fixture.assignmentId}`;
    const studentRoute = `${route}/students/${fixture.students[0].id}`;
    expect(
      (await request(`${route}/analyze`, teacher, "POST", {})).status,
    ).toBe(200);
    expect(
      (await request(`${studentRoute}/analyze`, teacher, "POST", {})).status,
    ).toBe(200);
    expect(
      (await (await request(route, teacher)).json()).analysis,
    ).not.toBeNull();
    expect(
      (await (await request(studentRoute, teacher)).json()).analysis,
    ).not.toBeNull();
    expect((await review(true)).status).toBe(200);
    expect((await (await request(route, teacher)).json()).analysis).toBeNull();
    expect(
      (await (await request(studentRoute, teacher)).json()).analysis,
    ).toBeNull();
  });
  it("rejects a class diagnosis generated from grades superseded while the model was running", async () => {
    clearUsage();
    expect((await review(false)).status).toBe(200);
    model({ brief: "stale" }, 400);
    const count = db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!
      .n;
    const before = calls();
    const pending = request(
      `/api/teaching/assignments/${fixture.assignmentId}/analyze`,
      teacher,
      "POST",
      {},
    );
    await waitCalls(before + 1);
    expect((await review(true)).status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(
      db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!.n,
    ).toBe(count);
  });
  it("rejects a student diagnosis generated from grades superseded while the model was running", async () => {
    clearUsage();
    expect((await review(false)).status).toBe(200);
    model({ brief: "stale student" }, 400);
    const count = db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!
      .n;
    const before = calls();
    const pending = request(
      `/api/teaching/assignments/${fixture.assignmentId}/students/${fixture.students[0].id}/analyze`,
      teacher,
      "POST",
      {},
    );
    await waitCalls(before + 1);
    expect((await review(true)).status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(
      db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!.n,
    ).toBe(count);
  });
  it("preserves completed grades when OCR cannot reserve model capacity", async () => {
    clearUsage();
    expect((await review(true)).status).toBe(200);
    const before = db
      .prepare(
        "SELECT status,teacher_reviewed,score,analysis_json FROM submissions WHERE id=?",
      )
      .get(submissionId);
    const now = Date.now();
    for (let i = 0; i < 4; i++)
      db.prepare("INSERT INTO model_usage VALUES(?,?,?,?,NULL,?)").run(
        `busy-ocr-${i}`,
        fixture.teacherId,
        fixture.schoolId,
        now,
        now + 95000,
      );
    const count = calls();
    const busyResponse = await request(
      `/api/submissions/${submissionId}/recognize`,
      teacher,
      "POST",
      {},
    );
    expect(busyResponse.status).toBe(429);
    expect(
      db
        .prepare(
          "SELECT status,teacher_reviewed,score,analysis_json FROM submissions WHERE id=?",
        )
        .get(submissionId),
    ).toEqual(before);
    expect(calls()).toBe(count);
    clearUsage();
  });
  it("rejects malformed teaching output and hides corrupt historical analyses", async () => {
    clearUsage();
    const route = `/api/teaching/assignments/${fixture.assignmentId}`;
    model({ brief: "malformed", keyFindings: "oops" });
    const before = db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!
      .n;
    expect(
      (await request(`${route}/analyze`, teacher, "POST", {})).status,
    ).toBe(502);
    expect(
      db.prepare("SELECT COUNT(*) n FROM teaching_analyses").get()!.n,
    ).toBe(before);
    model({ brief: "valid" });
    const response = await request(`${route}/analyze`, teacher, "POST", {});
    expect(response.status).toBe(200);
    const { analysis } = await response.json();
    db.prepare("UPDATE teaching_analyses SET payload_json=? WHERE id=?").run(
      JSON.stringify({ keyFindings: "oops" }),
      analysis.id,
    );
    expect((await (await request(route, teacher)).json()).analysis).toBeNull();
  });
});
