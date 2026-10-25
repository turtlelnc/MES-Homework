import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

// v0.2.1-rc4 端到端验收：真实启动服务，模型调用由 preload 的假 fetch 按顺序返回
// 预置 JSON。覆盖四身份注册、模型模式与凭证归属、三种复核方式、无原题直批、
// 引导式错题本、家长端看板/学情分析与 OAuth 目录。

const root = path.resolve(import.meta.dirname, "..");
let dir: string,
  base: string,
  port: number,
  db: DatabaseSync,
  child: ReturnType<typeof spawn>;
let admin = "",
  teacher = "",
  student = "",
  parent = "";
let schoolCode = "";
let adminId = "",
  teacherId = "",
  studentId = "";
const modelLog = () => path.join(dir, "calls.jsonl");
const queueFile = () => path.join(dir, "model-queue.json");
const paint = (
  room: number,
  studentName: string,
  score: number,
  totalScore: number,
) => ({});
const calls = () =>
  fs.existsSync(modelLog())
    ? fs.readFileSync(modelLog(), "utf8").trim().split("\n").filter(Boolean)
        .length
    : 0;
function queueModels(payloads: unknown[]) {
  fs.writeFileSync(queueFile(), JSON.stringify({ payloads }));
}
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
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function register(body: Record<string, unknown>) {
  const response = await request("/api/auth/register", "", "POST", body);
  const data = await response.json().catch(() => ({}));
  return {
    response,
    data,
    cookie: (response.headers.get("set-cookie") || "").split(";")[0],
  };
}
async function login(body: Record<string, unknown>) {
  const response = await request("/api/auth/login", "", "POST", body);
  return {
    response,
    cookie: (response.headers.get("set-cookie") || "").split(";")[0],
  };
}
async function start() {
  child = spawn(process.execPath, ["--import", pathToFileURL(path.join(dir, "mock.mjs")).href, "server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      APP_SECRET: "v021-e2e-test-only-secret-32-characters",
      OAUTH_CHATGPT_CLIENT_ID: "test-client-id",
      OAUTH_CHATGPT_CLIENT_SECRET: "test-client-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout?.on("data", (chunk) => (serverLog += chunk));
  child.stderr?.on("data", (chunk) => (serverLog += chunk));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await request("/api/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server failed to start: ${serverLog.slice(0, 4000)}`);
}
async function stop() {
  if (child?.exitCode === null) {
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
}
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  timeout = 25000,
) {
  const started = Date.now();
  let last: T;
  while (Date.now() - started < timeout) {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
const pngUpload = () => {
  const form = new FormData();
  form.append(
    "files",
    new Blob([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])], {
      type: "image/png",
    }),
    "work.png",
  );
  return form;
};
async function upload(submissionAssignment: string, cookie: string) {
  const response = await fetch(
    `${base}/api/assignments/${submissionAssignment}/submissions`,
    { method: "POST", headers: { cookie }, body: pngUpload() },
  );
  const data = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return String(data[0].id);
}
async function recognize(submissionId: string) {
  const response = await request(
    `/api/submissions/${submissionId}/recognition-jobs`,
    teacher,
    "POST",
  );
  expect(response.status).toBe(202);
  return submissionId;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-v021-"));
  fs.writeFileSync(
    path.join(dir, "mock.mjs"),
    `import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const body = String(options?.body || "");
      fs.appendFileSync(${JSON.stringify(modelLog())}, body.replace(/\\n/g,' ')+'\\n');
      const queue=JSON.parse(fs.readFileSync(${JSON.stringify(queueFile())},'utf8'));
      const count=fs.readFileSync(${JSON.stringify(modelLog())},'utf8').trim().split('\\n').filter(Boolean).length;
      const payload=queue.payloads[Math.min(count-1,queue.payloads.length-1)];
      return Response.json({choices:[{message:{content:JSON.stringify(payload)}}]});
    };`,
  );
  queueModels([{}]);
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((r) => listener.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  await start();
  db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
}, 30000);
afterAll(async () => {
  await stop();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("v0.2.1-rc4 (mock model only)", () => {
  it("reports the new version and build number", async () => {
    const health = await (await request("/api/health")).json();
    expect(health.version).toBe("v0.2.1-rc4");
    expect(health.build).toBe("26102501");
    expect(health.versionLabel).toBe("v0.2.1-rc4 (build26102501)");
  });

  it("registers school / teacher / student / parent with account names", async () => {
    const school = await register({
      role: "school",
      schoolName: "端到端测试中学",
      name: "校长",
      username: "principal",
      password: "ChangeMe123!",
    });
    expect(school.response.status).toBe(200);
    expect(school.data.schoolCode).toBeTruthy();
    schoolCode = school.data.schoolCode;
    admin = school.cookie;

    const newTeacher = await register({
      role: "teacher",
      schoolCode,
      name: "王老师",
      username: "wanglaoshi",
      password: "ChangeMe123!",
      stage: "初中",
      subject: "物理",
      className: "八年级（1）班",
    });
    expect(newTeacher.response.status).toBe(200);
    teacher = newTeacher.cookie;

    const newStudent = await register({
      role: "student",
      schoolCode,
      name: "林一",
      username: "linyi",
      password: "ChangeMe123!",
      stage: "初中",
      className: "八年级（1）班",
    });
    expect(newStudent.response.status).toBe(200);
    student = newStudent.cookie;

    const newParent = await register({
      role: "parent",
      schoolCode,
      name: "林家长",
      username: "linjiazhang",
      password: "ChangeMe123!",
      childUsername: "linyi",
      childPassword: "ChangeMe123!",
      relation: "母亲",
    });
    expect(newParent.response.status).toBe(200);
    expect(newParent.data.studentName).toBe("林一");
    parent = newParent.cookie;

    // 账号名登录；重复账号名与错误学校代码都被拒绝。
    expect(
      (await login({ username: "linyi", password: "ChangeMe123!" })).response
        .status,
    ).toBe(200);
    expect(
      (
        await register({
          role: "student",
          schoolCode,
          name: "重复",
          username: "linyi",
          password: "ChangeMe123!",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await register({
          role: "student",
          schoolCode: "wrong-school",
          name: "外校",
          username: "outsider1",
          password: "ChangeMe123!",
          stage: "初中",
          className: "八年级（1）班",
        })
      ).response.status,
    ).toBe(400);

    adminId = String(
      (await (await request("/api/me", admin)).json()).id,
    );
    studentId = String(
      (await (await request("/api/me", student)).json()).id,
    );
    const teachers = await (await request("/api/teachers", admin)).json();
    teacherId = String(teachers.find((row: any) => row.username === "wanglaoshi").id);
  });

  it("assigns the class head teacher and switches the school model mode", async () => {
    expect(
      (
        await request("/api/school/model-mode", admin, "PUT", {
          mode: "teacher_parent",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/school/classes/${encodeURIComponent("八年级（1）班")}/head-teacher`,
          admin,
          "PUT",
          { teacherId },
        )
      ).status,
    ).toBe(200);
    const mode = await (await request("/api/school/model-mode", admin)).json();
    expect(mode.mode).toBe("teacher_parent");
    expect(
      mode.classes.find((item: any) => item.className === "八年级（1）班")
        .headTeacher.id,
    ).toBe(teacherId);
  });

  it("routes student credentials to the bound parent in teacher_parent mode", async () => {
    expect(
      (
        await request("/api/settings/provider", teacher, "PUT", {
          provider: "qwen",
          apiKey: "mock-teacher-key",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/settings/provider", parent, "PUT", {
          provider: "qwen",
          apiKey: "mock-parent-key",
        })
      ).status,
    ).toBe(200);
    const access = await (await request("/api/model/access", student)).json();
    expect(access.mode).toBe("teacher_parent");
    expect(access.ownerRole).toBe("parent");
    expect(access.configured).toBe(true);
    const teacherAccess = await (
      await request("/api/model/access", teacher)
    ).json();
    expect(teacherAccess.ownerRole).toBe("teacher");
  });

  it("auto-completes a bank assignment in no-review mode with AI reasoning", async () => {
    expect(
      (
        await request("/api/settings/review-mode", teacher, "PUT", {
          mode: "none",
        })
      ).status,
    ).toBe(200);
    const created = await (
      await request("/api/assignments", teacher, "POST", {
        title: "第一章 加法测评",
        questions: [
          { prompt: "1+1 等于多少？", standardAnswer: "2", score: 10 },
        ],
      })
    ).json();
    const detail = await (
      await request(`/api/assignments/${created.id}`, teacher)
    ).json();
    const questionId = detail.questions[0].id;
    const submissionId = await upload(created.id, student);
    queueModels([
      {
        ocrText: "1+1=3",
        items: [
          {
            questionId,
            studentAnswer: "3",
            isCorrect: false,
            score: 0,
            reason: "计算粗心",
            correction: "2",
            explanation: "1 加 1 等于 2。",
            reasoning: "对照参考答案 2，学生作答 3，判定为计算错误。",
            confidence: 0.93,
            practiceQuestions: [
              { prompt: "1+2 等于多少？", answer: "3", explanation: "逐个数。" },
            ],
            guidance: {
              keyQuestion: "你能再检查一次这个加法吗？",
              hints: ["先数一数", "可以画一画", "检查一下进位"],
              selfCheck: ["结果合理吗？"],
            },
          },
        ],
      },
    ]);
    await recognize(submissionId);
    const result = await waitFor(
      async () => (await request(`/api/submissions/${submissionId}`, teacher)).json(),
      (row: any) => ["completed", "failed"].includes(row.status),
      "bank auto review",
    );
    expect(result.status).toBe("completed");
    expect(result.teacher_reviewed).toBe(1);
    expect(result.score).toBe(0);
    expect(result.analysis.items[0].reasoning).toContain("参考答案");
    expect(
      db
        .prepare(
          "SELECT question_id,question_number,prompt,standard_answer,reasoning FROM mistakes WHERE submission_id=?",
        )
        .get(submissionId),
    ).toMatchObject({
      question_id: questionId,
      question_number: 1,
      standard_answer: "2",
    });
  });

  it("supports direct grading without uploaded questions and only-uncertain review", async () => {
    expect(
      (
        await request("/api/settings/review-mode", teacher, "PUT", {
          mode: "uncertain",
        })
      ).status,
    ).toBe(200);
    const created = await (
      await request("/api/assignments", teacher, "POST", {
        title: "第三章 加法练习",
        gradingMode: "direct",
        description: "1–2 题，重点考查加法计算，不必上传原题。",
      })
    ).json();
    expect(created.gradingMode).toBe("direct");
    const submissionId = await upload(created.id, student);
    queueModels([
      {
        ocrText: "直接批改原文",
        warnings: [],
        questions: [
          {
            number: 1,
            prompt: "3+4 等于多少？",
            referenceAnswer: "7",
            score: 10,
            knowledgeTitle: "加法",
          },
          {
            number: 2,
            prompt: "5+6 等于多少？",
            referenceAnswer: "11",
            score: 10,
            knowledgeTitle: "加法",
          },
        ],
        items: [
          {
            number: 1,
            studentAnswer: "8",
            isCorrect: false,
            score: 0,
            reason: "计算粗心",
            correction: "7",
            explanation: "3 加 4 等于 7。",
            reasoning: "参考答案为 7，学生作答 8，属于计算错误。",
            confidence: 0.55,
            practiceQuestions: [],
            guidance: {
              keyQuestion: "3 和 4 合起来是多少？",
              hints: ["先数 3 个", "再数 4 个", "合起来数一数"],
              selfCheck: ["有没有多数一个？"],
            },
          },
          {
            number: 2,
            studentAnswer: "11",
            isCorrect: true,
            score: 10,
            reason: "",
            correction: "11",
            explanation: "",
            reasoning: "学生作答与参考答案 11 一致，判定正确。",
            confidence: 0.96,
            practiceQuestions: [],
            guidance: null,
          },
        ],
      },
    ]);
    await recognize(submissionId);
    const detail = await waitFor(
      async () => (await request(`/api/submissions/${submissionId}`, teacher)).json(),
      (row: any) => row.status === "review",
      "direct recognition",
    );
    expect(detail.grading_mode).toBe("direct");
    expect(detail.assignment_description).toContain("不必上传原题");
    expect(detail.questions).toHaveLength(2);
    expect(detail.questions[0].standard_answer).toBe("7");
    expect(detail.analysis.items[0].reasoning).toContain("参考答案");
    expect(detail.analysis.items[0].suspect).toBe(true);
    expect(detail.analysis.items[1].suspect).toBe(false);

    const items = detail.analysis.items.map((item: any) => ({
      ...item,
      score: Number(item.score),
      confirmed: item.suspect ? false : undefined,
    }));
    expect(
      (
        await request(`/api/submissions/${submissionId}/review`, teacher, "POST", {
          items,
        })
      ).status,
    ).toBe(400);
    items[0].confirmed = true;
    expect(
      (
        await request(`/api/submissions/${submissionId}/review`, teacher, "POST", {
          items,
        })
      ).status,
    ).toBe(200);
    const completed = await (
      await request(`/api/submissions/${submissionId}`, teacher)
    ).json();
    expect(completed.status).toBe("completed");
    const directMistake = db
      .prepare(
        "SELECT question_id,question_number,prompt,standard_answer,question_score,reasoning,guidance_json FROM mistakes WHERE submission_id=?",
      )
      .get(submissionId);
    expect(directMistake.question_id).toBeNull();
    expect(directMistake.prompt).toBe("3+4 等于多少？");
    expect(directMistake.question_score).toBe(10);
    expect(String(directMistake.reasoning)).toContain("计算错误");
    expect(directMistake.guidance_json).toContain("keyQuestion");
  });

  it("keeps the guided mistake book answer-free until a correct retry", async () => {
    const mistakes = await (await request("/api/mistakes", student)).json();
    const direct = mistakes.find((row: any) => row.prompt === "3+4 等于多少？");
    expect(direct).toBeTruthy();
    const text = JSON.stringify(direct);
    expect(text).not.toContain("correction");
    expect(text).not.toContain("explanation");
    expect(text).not.toContain("standard_answer");
    expect(direct.practiceQuestions.every((row: any) => !("answer" in row))).toBe(
      true,
    );
    expect(direct.guidance.keyQuestion).toContain("合起来");

    const hint = await (
      await request(`/api/mistakes/${direct.id}/hint`, student, "POST")
    ).json();
    expect(hint.hint.length).toBeGreaterThan(0);
    expect(hint.hint).not.toContain("7");

    queueModels([{ correct: true, feedback: "这次算对了。" }]);
    const attempt = await (
      await request(`/api/mistakes/${direct.id}/attempt`, student, "POST", {
        answer: "7",
      })
    ).json();
    expect(attempt.correct).toBe(true);
    expect(attempt.reveal.standardAnswer).toBe("7");
    expect(attempt.reveal.explanation.length).toBeGreaterThan(0);
  });

  it("gives parents a dashboard, per-question reasoning and an AI learning analysis", async () => {
    const children = await (
      await request("/api/parent/children", parent)
    ).json();
    expect(children).toHaveLength(1);
    const childId = children[0].id;
    const dashboard = await (
      await request(`/api/parent/children/${childId}/dashboard`, parent)
    ).json();
    expect(dashboard.summary.reviewedSubmissions).toBe(2);
    expect(dashboard.summary.mistakeCount).toBe(2);
    expect(dashboard.recent.length).toBe(2);
    expect(dashboard.knowledge.some((row: any) => row.title === "加法")).toBe(
      true,
    );
    const directSubmission = db
      .prepare(
        "SELECT id FROM submissions WHERE student_id=? AND assignment_id=(SELECT id FROM assignments WHERE title='第三章 加法练习')",
      )
      .get(studentId);
    const detail = await (
      await request(
        `/api/parent/children/${childId}/submissions/${directSubmission.id}`,
        parent,
      )
    ).json();
    const wrong = detail.items.find((item: any) => !item.isCorrect);
    expect(wrong.reasoning).toContain("参考答案");
    expect(wrong.standardAnswer).toBe("7");
    expect(wrong.prompt).toBe("3+4 等于多少？");

    queueModels([
      {
        summary: "孩子整体计算基础尚可，但粗心失分明显。",
        strengths: ["加法口算速度不错"],
        weaknesses: [
          { knowledge: "加法", evidence: "第 1 题算错", suggestion: "每天 5 道口算" },
        ],
        subjectAnalysis: [
          { subject: "物理", level: "稳定", detail: "作业完成度稳定" },
        ],
        studyHabits: ["检查习惯需要加强"],
        homeActions: [
          { action: "陪孩子检查作业", how: "让孩子先自查再签字", frequency: "每天" },
        ],
        encouragement: "你已经会做大部分题了，继续保持。",
      },
    ]);
    const analyzed = await request(
      `/api/parent/children/${childId}/insights/analyze`,
      parent,
      "POST",
    );
    expect(analyzed.status).toBe(200);
    const payload = await analyzed.json();
    expect(payload.insight.content.summary).toContain("粗心");
    expect(payload.stats.summary.reviewedSubmissions).toBe(2);
    const saved = await (
      await request(`/api/parent/children/${childId}/insights`, parent)
    ).json();
    expect(saved.id).toBe(payload.insight.id);
    // 30 秒内再次生成会被限流。
    expect(
      (
        await request(
          `/api/parent/children/${childId}/insights/analyze`,
          parent,
          "POST",
        )
      ).status,
    ).toBe(429);
  });

  it("exposes the rc4 OAuth provider matrix and browser/device flows", async () => {
    const catalog = await (
      await request("/api/oauth/providers", teacher)
    ).json();
    expect(catalog.providers.map((row: any) => row.id).sort()).toEqual([
      "chatgpt",
      "gemini",
      "workbuddy",
    ]);
    const byId = new Map(catalog.providers.map((row: any) => [row.id, row]));
    expect(byId.get("chatgpt")).toMatchObject({
      configured: true,
      mainlandUnavailable: true,
      flows: ["browser", "device"],
    });
    expect(byId.get("workbuddy")).toMatchObject({
      configured: true,
      flows: ["browser", "device"],
    });
    // Gemini 需要部署方配置 Google Cloud OAuth 客户端；e2e 环境未配置。
    expect(byId.get("gemini")).toMatchObject({
      configured: false,
      flows: ["browser"],
    });
    expect(byId.get("gemini").envHint).toContain("OAUTH_GEMINI_CLIENT_ID");

    const started = await request(
      "/api/oauth/chatgpt/browser/start",
      teacher,
      "POST",
      {},
    );
    // 本机 1455 端口可能被其他 ChatGPT/Codex 客户端占用，此时允许 409。
    expect([200, 409]).toContain(started.status);
    if (started.status === 200) {
      const browser = await started.json();
      expect(browser.mode).toBe("browser");
      expect(typeof browser.attemptId).toBe("string");
      const url = new URL(browser.url);
      expect(url.origin).toBe("https://auth.openai.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")).toBeTruthy();
      const attempt = await request(
        `/api/oauth/chatgpt/attempt/${browser.attemptId}`,
        teacher,
      );
      expect(attempt.status).toBe(200);
      expect((await attempt.json()).status).toBe("pending");
    } else {
      const busy = await started.json();
      expect(String(busy.error)).toContain("1455");
    }

    // WorkBuddy 仅支持设备码：旧 start 返回 409；已移除 provider 一律 404。
    expect(
      (await request("/api/oauth/workbuddy/start", teacher, "POST", {})).status,
    ).toBe(409);
    expect(
      (await request("/api/oauth/deepseek/start", teacher, "POST", {})).status,
    ).toBe(404);
  });
});
