import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import {
  fallbackGuidance,
  normalizeAttemptGrade,
  registerMistakeRoutes,
  studentMistakeView,
  visibleGuidance,
} from "./mistakes-guide.mjs";

const root = path.resolve(import.meta.dirname, "..");
const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";
const STUDENT_VIEW_KEYS = [
  "created_at",
  "guidance",
  "id",
  "knowledge_title",
  "mastery",
  "practiceQuestions",
  "progress",
  "prompt",
  "reason",
  "student_answer",
];

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  return db;
}

function insert(db: DatabaseSync, table: string, columns: string[], values: any[]) {
  db.prepare(
    `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  ).run(...values);
}

function seedFixture() {
  const db = createDb();
  insert(db, "schools", ["id", "name", "created_at"], [
    "school-1",
    "测试学校",
    NOW,
  ]);
  const userColumns = [
    "id",
    "school_id",
    "role",
    "name",
    "username",
    "password_hash",
    "salt",
    "created_at",
  ];
  for (const [id, role] of [
    ["teacher-1", "teacher"],
    ["teacher-2", "teacher"],
    ["student-1", "student"],
    ["student-2", "student"],
    ["parent-1", "parent"],
  ])
    insert(db, "users", userColumns, [
      id,
      "school-1",
      role,
      id,
      id,
      "hash",
      "salt",
      NOW,
    ]);
  insert(
    db,
    "knowledge",
    [
      "id",
      "school_id",
      "stage",
      "subject",
      "title",
      "description",
      "created_by",
      "created_at",
    ],
    ["knowledge-1", "school-1", "小学", "数学", "加法", "", "teacher-1", NOW],
  );
  const assignmentColumns = [
    "id",
    "school_id",
    "teacher_id",
    "title",
    "stage",
    "subject",
    "class_name",
    "created_at",
    "grading_mode",
  ];
  insert(db, "assignments", assignmentColumns, [
    "assignment-bank",
    "school-1",
    "teacher-1",
    "作业一",
    "小学",
    "数学",
    "三 1 班",
    NOW,
    "bank",
  ]);
  insert(db, "assignments", assignmentColumns, [
    "assignment-direct",
    "school-1",
    "teacher-1",
    "作业二",
    "小学",
    "数学",
    "三 1 班",
    LATER,
    "direct",
  ]);
  insert(
    db,
    "questions",
    [
      "id",
      "assignment_id",
      "number",
      "prompt",
      "standard_answer",
      "knowledge_id",
      "score",
    ],
    ["question-1", "assignment-bank", 1, "1+1=?", "2", "knowledge-1", 5],
  );
  const submissionColumns = [
    "id",
    "assignment_id",
    "student_id",
    "student_name",
    "file_path",
    "file_type",
    "status",
    "teacher_reviewed",
    "created_at",
  ];
  insert(db, "submissions", submissionColumns, [
    "submission-bank",
    "assignment-bank",
    "student-1",
    "小明",
    "/tmp/one.pdf",
    "application/pdf",
    "completed",
    1,
    NOW,
  ]);
  insert(db, "submissions", submissionColumns, [
    "submission-direct",
    "assignment-direct",
    "student-1",
    "小明",
    "/tmp/two.pdf",
    "application/pdf",
    "completed",
    1,
    LATER,
  ]);
  const mistakeColumns = [
    "id",
    "submission_id",
    "student_id",
    "question_id",
    "knowledge_id",
    "reason",
    "student_answer",
    "correction",
    "created_at",
    "explanation",
    "practice_json",
    "mastery",
    "question_number",
    "prompt",
    "standard_answer",
    "question_score",
    "reasoning",
    "guidance_json",
  ];
  // 题库模式错题：题干/答案来自 questions 行。
  insert(db, "mistakes", mistakeColumns, [
    "mistake-bank",
    "submission-bank",
    "student-1",
    "question-1",
    "knowledge-1",
    "计算错误",
    "3",
    "SECRET_CORRECTION",
    NOW,
    "SECRET_EXPLANATION",
    JSON.stringify([
      {
        prompt: "BANK_PRACTICE_PROMPT",
        answer: "SECRET_PRACTICE_ANSWER",
        explanation: "SECRET_PRACTICE_EXPLANATION",
      },
    ]),
    0,
    1,
    "题库题干占位",
    "题库答案占位",
    5,
    "SECRET_REASONING",
    null,
  ]);
  // 直批模式错题：question_id 为 NULL，靠快照字段。
  insert(db, "mistakes", mistakeColumns, [
    "mistake-direct",
    "submission-direct",
    "student-1",
    null,
    "knowledge-1",
    "粗心",
    "8",
    "SECRET_DIRECT_CORRECTION",
    LATER,
    "SECRET_DIRECT_EXPLANATION",
    JSON.stringify([
      {
        prompt: "DIRECT_PRACTICE_PROMPT",
        answer: "SECRET_DIRECT_PRACTICE_ANSWER",
        explanation: "SECRET_DIRECT_PRACTICE_EXPLANATION",
      },
    ]),
    0,
    2,
    "求 3+4",
    "SECRET_DIRECT_STANDARD",
    10,
    "SECRET_DIRECT_REASONING",
    JSON.stringify({
      keyQuestion: "KEY_QUESTION_TEXT",
      hints: ["hint one", "hint two", "hint three"],
      selfCheck: ["自检一"],
    }),
  ]);
  insert(
    db,
    "mistake_progress",
    [
      "mistake_id",
      "student_id",
      "hints_used",
      "attempts",
      "solved",
      "revealed",
      "last_feedback",
      "updated_at",
    ],
    ["mistake-direct", "student-1", 1, 0, 0, 0, "", NOW],
  );
  return db;
}

describe("student view whitelist", () => {
  const row = {
    id: "mistake-1",
    knowledge_title: "加法",
    prompt: "求 3+4",
    student_answer: "8",
    reason: "粗心",
    mastery: 0,
    practice_json: JSON.stringify([
      {
        prompt: "同类题",
        answer: "SECRET_ANSWER",
        explanation: "SECRET_SOLUTION",
      },
    ]),
    correction: "SECRET_CORRECTION",
    explanation: "SECRET_EXPLANATION",
    standard_answer: "SECRET_STANDARD",
    reasoning: "SECRET_REASONING",
    created_at: NOW,
    guidance_json: JSON.stringify({
      keyQuestion: "关键问题",
      hints: ["提示一", "提示二"],
      selfCheck: ["自检"],
    }),
  };

  it("never exposes answers, corrections, explanations or reasoning", () => {
    const view = studentMistakeView(row, { hints_used: 1, attempts: 2, solved: 0, revealed: 0 });
    expect(Object.keys(view).sort()).toEqual(STUDENT_VIEW_KEYS);
    expect(view.practiceQuestions).toEqual([{ prompt: "同类题" }]);
    expect(view.guidance).toEqual({
      keyQuestion: "关键问题",
      hints: ["提示一"],
    });
    expect(view.progress).toEqual({
      hintsUsed: 1,
      attempts: 2,
      solved: 0,
      revealed: 0,
    });
    expect(JSON.stringify(view)).not.toContain("SECRET_");
    expect(JSON.stringify(view)).not.toContain("reasoning");
  });

  it("defaults missing progress to zero and uses fallback guidance", () => {
    const view = studentMistakeView({ ...row, guidance_json: null }, null);
    expect(view.progress).toEqual({
      hintsUsed: 0,
      attempts: 0,
      solved: 0,
      revealed: 0,
    });
    expect(view.guidance.hints).toEqual([]);
    expect(view.guidance.keyQuestion).toContain("加法");
  });
});

describe("visibleGuidance / fallbackGuidance", () => {
  const guidance = {
    keyQuestion: "关键问题",
    hints: ["提示一", "提示二", "提示三"],
    selfCheck: ["自检"],
  };

  it("reveals hints one by one based on hints_used", () => {
    expect(visibleGuidance(guidance, 0)).toEqual({
      keyQuestion: "关键问题",
      hints: [],
    });
    expect(visibleGuidance(guidance, 2).hints).toEqual(["提示一", "提示二"]);
    expect(visibleGuidance(guidance, 99).hints).toHaveLength(3);
    expect(visibleGuidance(null, 3)).toEqual({ keyQuestion: "", hints: [] });
  });

  it("builds three local hints from the reason and knowledge title", () => {
    const fallback = fallbackGuidance({
      knowledge_title: "加法",
      reason: "计算错误",
      prompt: "1+1=?",
    });
    expect(fallback.hints).toHaveLength(3);
    expect(fallback.keyQuestion).toContain("加法");
    expect(fallback.hints[1]).toContain("计算错误");
    expect(fallback.selfCheck.length).toBeGreaterThan(0);
    const blank = fallbackGuidance({});
    expect(blank.hints).toHaveLength(3);
    blank.hints.forEach((hint: string) => expect(hint.length).toBeGreaterThan(0));
  });
});

describe("normalizeAttemptGrade", () => {
  it("accepts a strict boolean verdict and trims the feedback", () => {
    expect(normalizeAttemptGrade({ correct: true, feedback: " 对了 " })).toEqual(
      { correct: true, feedback: "对了" },
    );
    expect(normalizeAttemptGrade({ correct: false })).toEqual({
      correct: false,
      feedback: "",
    });
    expect(
      normalizeAttemptGrade({ correct: false, feedback: "x".repeat(5000) })
        .feedback.length,
    ).toBe(2000);
  });

  it.each([[null], [{}], [{ correct: "true" }], [{ correct: 1 }]])(
    "rejects malformed grades %s",
    (raw: any) => {
      expect(() => normalizeAttemptGrade(raw)).toThrow(
        "模型批改结果格式无效，请重试",
      );
    },
  );
});

describe("mistake routes", () => {
  let db: DatabaseSync;
  let server: any;
  let base = "";
  let modelCalls: { user: any; prompt: string }[] = [];
  let modelImpl: (user: any, prompt: string) => any = () => ({});

  beforeEach(async () => {
    db = seedFixture();
    modelCalls = [];
    modelImpl = () => ({});
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const auth = (req: any, res: any, next: any) => {
      const id = String(req.headers["x-user"] || "");
      const user = db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
      if (!user) return res.status(401).json({ error: "请先登录" });
      req.user = user;
      next();
    };
    let sequence = 0;
    const ctx = {
      db,
      auth,
      uid: () => `generated-${++sequence}`,
      iso: () => NOW,
      callModel: async (user: any, prompt: string) => {
        modelCalls.push({ user, prompt });
        return modelImpl(user, prompt);
      },
      modelErrorStatus: (error: any) => Number(error?.status) || 500,
      publicPractice: (questions: any[]) =>
        (Array.isArray(questions) ? questions : []).map((question) => ({
          prompt: String(question?.prompt || ""),
        })),
      safeParse: (value: any, fallback: any) => {
        try {
          const parsed = JSON.parse(value);
          return parsed ?? fallback;
        } catch {
          return fallback;
        }
      },
    };
    registerMistakeRoutes(app, ctx);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    db?.close();
  });

  async function request(
    route: string,
    { user = "student-1", method = "GET", body }: any = {},
  ) {
    const response = await fetch(base + route, {
      method,
      headers: {
        "x-user": user,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    return { status: response.status, body: payload as any, text: JSON.stringify(payload) };
  }

  describe("GET /api/mistakes", () => {
    it("returns a whitelisted student view for both bank and direct mistakes", async () => {
      const { status, body, text } = await request("/api/mistakes");
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(text).not.toContain("SECRET_");
      for (const item of body) {
        expect(Object.keys(item).sort()).toEqual(STUDENT_VIEW_KEYS);
        expect(item.guidance).not.toHaveProperty("selfCheck");
      }
      const direct = body.find((item: any) => item.id === "mistake-direct");
      expect(direct.prompt).toBe("求 3+4");
      expect(direct.student_answer).toBe("8");
      expect(direct.guidance.keyQuestion).toBe("KEY_QUESTION_TEXT");
      expect(direct.guidance.hints).toEqual(["hint one"]);
      expect(direct.progress.hintsUsed).toBe(1);
      expect(direct.practiceQuestions).toEqual([
        { prompt: "DIRECT_PRACTICE_PROMPT" },
      ]);
      const bank = body.find((item: any) => item.id === "mistake-bank");
      // 题库模式优先使用 questions 行的题干与答案，而不是 mistakes 的空快照。
      expect(bank.prompt).toBe("1+1=?");
      expect(bank.guidance.hints).toEqual([]);
    });

    it("keeps the full teacher view with corrections and practice answers", async () => {
      const { status, body, text } = await request("/api/mistakes", {
        user: "teacher-1",
      });
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(text).toContain("SECRET_CORRECTION");
      expect(text).toContain("SECRET_EXPLANATION");
      const bank = body.find((item: any) => item.id === "mistake-bank");
      expect(bank.standard_answer).toBe("2");
      expect(bank.question_number).toBe(1);
      expect(bank.practiceQuestions[0].answer).toBe("SECRET_PRACTICE_ANSWER");
      expect(bank).not.toHaveProperty("practice_json");
      const direct = body.find((item: any) => item.id === "mistake-direct");
      expect(direct.standard_answer).toBe("SECRET_DIRECT_STANDARD");
      expect(direct.reasoning).toBe("SECRET_DIRECT_REASONING");
    });

    it("does not leak another teacher's mistakes and blocks parents", async () => {
      const other = await request("/api/mistakes", { user: "teacher-2" });
      expect(other.status).toBe(200);
      expect(other.body).toEqual([]);
      const parent = await request("/api/mistakes", { user: "parent-1" });
      expect(parent.status).toBe(403);
      expect(parent.body.error).toContain("仅教师或学生");
    });
  });

  describe("GET /api/mistakes/:id/guide", () => {
    it("hides answers before the retry succeeds", async () => {
      const { status, body, text } = await request(
        "/api/mistakes/mistake-direct/guide",
      );
      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: "mistake-direct",
        prompt: "求 3+4",
        myAnswer: "8",
        knowledgeTitle: "加法",
        canRevealAnswer: false,
      });
      expect(body.guidance.hints).toEqual(["hint one"]);
      expect(body.guidance.selfCheck).toEqual(["自检一"]);
      expect(text).not.toContain("SECRET_");
      expect(text).not.toContain('"reveal"');
    });

    it("reveals the reference answer once solved", async () => {
      db.prepare(
        "UPDATE mistake_progress SET solved=1,revealed=1 WHERE mistake_id=?",
      ).run("mistake-direct");
      const { body } = await request("/api/mistakes/mistake-direct/guide");
      expect(body.canRevealAnswer).toBe(true);
      expect(body.reveal.standardAnswer).toBe("SECRET_DIRECT_STANDARD");
      expect(body.reveal.reasoning).toBe("SECRET_DIRECT_REASONING");
    });

    it("scopes guides to the owning student and role", async () => {
      expect(
        (await request("/api/mistakes/mistake-direct/guide", { user: "student-2" }))
          .status,
      ).toBe(404);
      expect(
        (await request("/api/mistakes/mistake-direct/guide", { user: "teacher-1" }))
          .status,
      ).toBe(403);
    });
  });

  describe("POST /api/mistakes/:id/hint", () => {
    it("unlocks hints one at a time and reports exhaustion", async () => {
      const first = await request("/api/mistakes/mistake-direct/hint", {
        method: "POST",
      });
      expect(first.body).toEqual({
        hint: "hint two",
        hintsUsed: 2,
        totalHints: 3,
        exhausted: false,
      });
      const second = await request("/api/mistakes/mistake-direct/hint", {
        method: "POST",
      });
      expect(second.body).toEqual({
        hint: "hint three",
        hintsUsed: 3,
        totalHints: 3,
        exhausted: true,
      });
      const third = await request("/api/mistakes/mistake-direct/hint", {
        method: "POST",
      });
      expect(third.body).toEqual({
        hint: "hint three",
        hintsUsed: 3,
        totalHints: 3,
        exhausted: true,
      });
      const stored = db
        .prepare(
          "SELECT hints_used FROM mistake_progress WHERE mistake_id=? AND student_id=?",
        )
        .get("mistake-direct", "student-1") as any;
      expect(stored.hints_used).toBe(3);
    });

    it("asks the injected model only once when the mistake has no guidance yet", async () => {
      modelImpl = () => ({
        keyQuestion: "模型关键问题",
        hints: ["AI 提示一", "AI 提示二"],
        selfCheck: ["AI 自检"],
      });
      const first = await request("/api/mistakes/mistake-bank/hint", {
        method: "POST",
      });
      expect(first.status).toBe(200);
      expect(first.body.hint).toBe("AI 提示一");
      expect(first.body.totalHints).toBe(2);
      expect(modelCalls).toHaveLength(1);
      expect(modelCalls[0].prompt).toContain("1+1=?");
      expect(modelCalls[0].user.id).toBe("student-1");
      const persisted = db
        .prepare("SELECT guidance_json FROM mistakes WHERE id=?")
        .get("mistake-bank") as any;
      expect(JSON.parse(persisted.guidance_json).keyQuestion).toBe("模型关键问题");
      const second = await request("/api/mistakes/mistake-bank/hint", {
        method: "POST",
      });
      expect(second.body.hint).toBe("AI 提示二");
      expect(modelCalls).toHaveLength(1);
    });

    it("falls back to local hints when the model fails", async () => {
      modelImpl = () => {
        throw Object.assign(new Error("模型接口请求失败 (500)"), {
          status: 500,
        });
      };
      const { status, body, text } = await request(
        "/api/mistakes/mistake-bank/hint",
        { method: "POST" },
      );
      expect(status).toBe(200);
      expect(body.totalHints).toBe(3);
      expect(body.hint.length).toBeGreaterThan(0);
      expect(text).not.toContain("模型接口请求失败");
      expect(modelCalls).toHaveLength(1);
    });

    it("scopes hints to the owning student and role", async () => {
      expect(
        (await request("/api/mistakes/mistake-direct/hint", {
          method: "POST",
          user: "student-2",
        })).status,
      ).toBe(404);
      expect(
        (await request("/api/mistakes/mistake-direct/hint", {
          method: "POST",
          user: "teacher-1",
        })).status,
      ).toBe(403);
    });
  });

  describe("POST /api/mistakes/:id/attempt", () => {
    it("reveals the reference answer only after the AI accepts the retry", async () => {
      modelImpl = () => ({ correct: true, feedback: "这次算对啦" });
      const { status, body } = await request(
        "/api/mistakes/mistake-direct/attempt",
        { method: "POST", body: { answer: "7" } },
      );
      expect(status).toBe(200);
      expect(body.correct).toBe(true);
      expect(body.feedback).toBe("这次算对啦");
      expect(body.progress).toEqual({
        hintsUsed: 1,
        attempts: 1,
        solved: 1,
        revealed: 1,
      });
      expect(body.reveal).toEqual({
        standardAnswer: "SECRET_DIRECT_STANDARD",
        correction: "SECRET_DIRECT_CORRECTION",
        explanation: "SECRET_DIRECT_EXPLANATION",
        reasoning: "SECRET_DIRECT_REASONING",
      });
      expect(modelCalls[0].prompt).toContain("求 3+4");
      expect(modelCalls[0].prompt).toContain("SECRET_DIRECT_STANDARD");
      const progress = db
        .prepare(
          "SELECT * FROM mistake_progress WHERE mistake_id=? AND student_id=?",
        )
        .get("mistake-direct", "student-1") as any;
      expect(progress).toMatchObject({ attempts: 1, solved: 1, revealed: 1 });
    });

    it("keeps answers hidden while the retry is still wrong", async () => {
      modelImpl = () => ({ correct: false, feedback: "还差一步" });
      const { status, body, text } = await request(
        "/api/mistakes/mistake-direct/attempt",
        { method: "POST", body: { answer: "9" } },
      );
      expect(status).toBe(200);
      expect(body.correct).toBe(false);
      expect(body.progress).toEqual({
        hintsUsed: 1,
        attempts: 1,
        solved: 0,
        revealed: 0,
      });
      expect(text).not.toContain("SECRET_");
      expect(body).not.toHaveProperty("reveal");
    });

    it("reveals as a safety net on the third wrong attempt", async () => {
      db.prepare(
        "UPDATE mistake_progress SET attempts=2 WHERE mistake_id=? AND student_id=?",
      ).run("mistake-direct", "student-1");
      modelImpl = () => ({ correct: false, feedback: "再看看题目" });
      const { status, body } = await request(
        "/api/mistakes/mistake-direct/attempt",
        { method: "POST", body: { answer: "10" } },
      );
      expect(status).toBe(200);
      expect(body.correct).toBe(false);
      expect(body.progress.attempts).toBe(3);
      expect(body.progress.revealed).toBe(1);
      expect(body.feedback).toContain("已经尝试 3 次");
      expect(body.feedback).toContain("再看看题目");
      expect(body.reveal.standardAnswer).toBe("SECRET_DIRECT_STANDARD");
    });

    it("validates the answer and the owner", async () => {
      expect(
        (
          await request("/api/mistakes/mistake-direct/attempt", {
            method: "POST",
            body: { answer: "   " },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/api/mistakes/mistake-direct/attempt", {
            method: "POST",
            body: { answer: "x".repeat(10001) },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/api/mistakes/mistake-direct/attempt", {
            method: "POST",
            body: { answer: "7" },
            user: "student-2",
          })
        ).status,
      ).toBe(404);
      expect(modelCalls).toHaveLength(0);
    });

    it("maps model failures to HTTP errors without revealing answers", async () => {
      modelImpl = () => {
        throw Object.assign(new Error("模型接口请求失败 (429)"), {
          status: 429,
        });
      };
      const { status, body, text } = await request(
        "/api/mistakes/mistake-direct/attempt",
        { method: "POST", body: { answer: "7" } },
      );
      expect(status).toBe(429);
      expect(body.error).toContain("429");
      expect(text).not.toContain("SECRET_");
    });
  });

  describe("practice routes", () => {
    it("generates practice prompts without leaking the reference answers", async () => {
      modelImpl = () => ({
        questions: [
          { prompt: "练习一", answer: "SECRET_AI_ANSWER", explanation: "略" },
          { prompt: "练习二", answer: "另一个答案", explanation: "略" },
        ],
      });
      const { status, body, text } = await request(
        "/api/mistakes/mistake-direct/practice/generate",
        { method: "POST" },
      );
      expect(status).toBe(200);
      expect(body.questions).toEqual([
        { prompt: "练习一" },
        { prompt: "练习二" },
      ]);
      expect(text).not.toContain("SECRET_AI_ANSWER");
      const stored = db
        .prepare("SELECT practice_json FROM mistakes WHERE id=?")
        .get("mistake-direct") as any;
      expect(JSON.parse(stored.practice_json)[0].answer).toBe("SECRET_AI_ANSWER");
      expect(modelCalls[0].prompt).toContain("求 3+4");
    });

    it("rejects an empty generated practice set and non-student callers", async () => {
      modelImpl = () => ({ questions: [] });
      const empty = await request(
        "/api/mistakes/mistake-direct/practice/generate",
        { method: "POST" },
      );
      expect(empty.status).toBe(500);
      expect(empty.body.error).toContain("模型没有生成练习题");
      const teacher = await request(
        "/api/mistakes/mistake-direct/practice/generate",
        { method: "POST", user: "teacher-1" },
      );
      expect(teacher.status).toBe(403);
    });

    it("stores full answers and marks mastery after a passing submission", async () => {
      db.prepare("UPDATE mistakes SET practice_json=? WHERE id=?").run(
        JSON.stringify([
          { prompt: "练习一", answer: "答案一", explanation: "解析一" },
          { prompt: "练习二", answer: "答案二", explanation: "解析二" },
        ]),
        "mistake-direct",
      );
      modelImpl = () => ({
        passed: true,
        results: [
          { correct: true, feedback: "好" },
          { correct: true, feedback: "很好" },
        ],
      });
      const { status, body } = await request(
        "/api/mistakes/mistake-direct/practice/submit",
        { method: "POST", body: { answers: ["答案一", "答案二"] } },
      );
      expect(status).toBe(200);
      expect(body.passed).toBe(true);
      expect(body.results).toEqual([
        { correct: true, feedback: "好" },
        { correct: true, feedback: "很好" },
      ]);
      expect(modelCalls[0].prompt).toContain("请严格批改过关练习");
      const stored = db
        .prepare("SELECT mastery FROM mistakes WHERE id=?")
        .get("mistake-direct") as any;
      expect(stored.mastery).toBe(1);
    });

    it("validates practice state, answers and role", async () => {
      db.prepare("UPDATE mistakes SET practice_json=NULL WHERE id=?").run(
        "mistake-bank",
      );
      const missing = await request(
        "/api/mistakes/mistake-bank/practice/submit",
        { method: "POST", body: { answers: ["x"] } },
      );
      expect(missing.status).toBe(400);
      expect(missing.body.error).toContain("请先生成同类练习");
      db.prepare("UPDATE mistakes SET practice_json=? WHERE id=?").run(
        JSON.stringify([
          { prompt: "练习一", answer: "答案一", explanation: "" },
          { prompt: "练习二", answer: "答案二", explanation: "" },
        ]),
        "mistake-direct",
      );
      const wrongCount = await request(
        "/api/mistakes/mistake-direct/practice/submit",
        { method: "POST", body: { answers: ["只填一个"] } },
      );
      expect(wrongCount.status).toBe(400);
      expect(wrongCount.body.error).toContain("请完整填写每道练习的答案");
      const teacher = await request(
        "/api/mistakes/mistake-direct/practice/submit",
        { method: "POST", user: "teacher-1", body: { answers: ["a", "b"] } },
      );
      expect(teacher.status).toBe(403);
      expect(modelCalls).toHaveLength(0);
    });
  });
});
