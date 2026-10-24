import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { normalizeDirectReview } from "./grading.mjs";
import {
  REVIEW_MODES,
  annotateReviewItems,
  assertReviewModeComplete,
  commitReview,
  isSuspectItem,
  normalizeReviewMode,
  registerReviewRoutes,
  suspectItems,
} from "./review.mjs";

const root = path.resolve(import.meta.dirname, "..");
const NOW = "2026-01-01T00:00:00.000Z";

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

function seedUser(
  db: DatabaseSync,
  id: string,
  role: string,
  { isSchoolAdmin = 0, reviewMode = "all" } = {},
) {
  insert(
    db,
    "users",
    [
      "id",
      "school_id",
      "role",
      "name",
      "username",
      "password_hash",
      "salt",
      "created_at",
      "is_school_admin",
      "review_mode",
    ],
    [id, "school-1", role, id, id, "hash", "salt", NOW, isSchoolAdmin, reviewMode],
  );
}

function seedAssignment(
  db: DatabaseSync,
  id: string,
  { gradingMode = "bank", teacherId = "teacher-1" } = {},
) {
  insert(
    db,
    "assignments",
    [
      "id",
      "school_id",
      "teacher_id",
      "title",
      "stage",
      "subject",
      "class_name",
      "created_at",
      "grading_mode",
    ],
    [id, "school-1", teacherId, "作业", "小学", "数学", "三 1 班", NOW, gradingMode],
  );
}

function seedSubmission(
  db: DatabaseSync,
  id: string,
  assignmentId: string,
  {
    studentId = "student-1",
    analysis = null,
    reviewed = 0,
  }: { studentId?: string; analysis?: any; reviewed?: number } = {},
) {
  insert(
    db,
    "submissions",
    [
      "id",
      "assignment_id",
      "student_id",
      "student_name",
      "file_path",
      "file_type",
      "status",
      "teacher_reviewed",
      "created_at",
      "analysis_json",
    ],
    [
      id,
      assignmentId,
      studentId,
      "小明",
      "/tmp/answer.pdf",
      "application/pdf",
      reviewed ? "completed" : "review",
      reviewed,
      NOW,
      analysis ? JSON.stringify(analysis) : null,
    ],
  );
}

function seedBase() {
  const db = createDb();
  insert(db, "schools", ["id", "name", "created_at"], [
    "school-1",
    "测试学校",
    NOW,
  ]);
  seedUser(db, "teacher-1", "teacher");
  seedUser(db, "admin-1", "teacher", { isSchoolAdmin: 1 });
  seedUser(db, "student-1", "student");
  return db;
}

// 题库模式：两块正式题目
function seedBankSubmission(db: DatabaseSync) {
  seedAssignment(db, "assignment-bank");
  insert(db, "knowledge", [
    "id",
    "school_id",
    "stage",
    "subject",
    "title",
    "description",
    "created_by",
    "created_at",
  ], ["knowledge-1", "school-1", "小学", "数学", "加法", "", "teacher-1", NOW]);
  insert(
    db,
    "questions",
    ["id", "assignment_id", "number", "prompt", "standard_answer", "knowledge_id", "score"],
    ["q1", "assignment-bank", 1, "1+1=?", "2", "knowledge-1", 5],
  );
  insert(
    db,
    "questions",
    ["id", "assignment_id", "number", "prompt", "standard_answer", "knowledge_id", "score"],
    ["q2", "assignment-bank", 2, "2×3=?", "6", null, 10],
  );
  seedSubmission(db, "submission-bank", "assignment-bank", { reviewed: 0 });
  return {
    assignmentId: "assignment-bank",
    submission: db
      .prepare("SELECT * FROM submissions WHERE id=?")
      .get("submission-bank") as any,
    questions: db
      .prepare(
        "SELECT q.*,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE q.assignment_id=? ORDER BY q.number",
      )
      .all("assignment-bank") as any[],
  };
}

function seedDirectSubmission(db: DatabaseSync) {
  seedAssignment(db, "assignment-direct", { gradingMode: "direct" });
  seedSubmission(db, "submission-direct", "assignment-direct");
  return {
    assignmentId: "assignment-direct",
    submission: db
      .prepare("SELECT * FROM submissions WHERE id=?")
      .get("submission-direct") as any,
    questions: [
      {
        id: "dq1",
        number: 1,
        prompt: "求 3+4",
        standardAnswer: "7",
        score: 10,
        knowledgeId: "knowledge-1",
      },
      {
        id: "dq2",
        number: 2,
        prompt: "求 5×6",
        standardAnswer: "30",
        score: 10,
        knowledgeId: null,
      },
    ] as any[],
  };
}

function makeCtx(db: DatabaseSync) {
  let sequence = 0;
  return {
    db,
    uid: () => `id-${++sequence}`,
    iso: () => NOW,
  };
}

describe("review modes", () => {
  it("exposes the three documented modes and rejects unknown ones", () => {
    expect(REVIEW_MODES.map((mode) => mode.id)).toEqual([
      "all",
      "uncertain",
      "none",
    ]);
    expect(normalizeReviewMode("uncertain")).toBe("uncertain");
    expect(normalizeReviewMode(" none ")).toBe("none");
    expect(() => normalizeReviewMode("all")).not.toThrow();
    for (const invalid of ["", null, undefined, "auto", "全部"])
      expect(() => normalizeReviewMode(invalid)).toThrow();
  });
});

describe("isSuspectItem", () => {
  const question = { id: "q1", score: 10 };
  const good = {
    questionId: "q1",
    studentAnswer: "7",
    isCorrect: true,
    score: 10,
    confidence: 0.95,
    reasoning: "3+4=7，计算与题目要求一致",
  };

  it("passes a confident, consistent verdict", () => {
    expect(isSuspectItem(good, question)).toBe(false);
  });

  it.each([
    ["missing confidence", { confidence: undefined }],
    ["low confidence", { confidence: 0.79 }],
    ["unreadable answer", { studentAnswer: "[无法辨认]" }],
    ["non-numeric score", { score: "满分" }],
    ["missing verdict", { isCorrect: undefined }],
    ["missing reasoning", { reasoning: "" }],
    ["too-short reasoning", { reasoning: "对的" }],
  ])("flags %s", (_label, patch) => {
    expect(isSuspectItem({ ...good, ...patch }, question)).toBe(true);
  });

  it.each([
    ["score above max", { isCorrect: false, score: 11 }],
    ["negative score", { isCorrect: false, score: -1 }],
    ["correct but partial score", { isCorrect: true, score: 5 }],
    ["wrong but full score", { isCorrect: false, score: 10 }],
  ])("flags %s", (_label, patch) => {
    expect(isSuspectItem({ ...good, ...patch }, question)).toBe(true);
  });

  it("flags unknown or invalid questions instead of letting them pass", () => {
    expect(isSuspectItem(good, undefined)).toBe(true);
    expect(isSuspectItem(good, { id: "q1", score: Number.NaN })).toBe(true);
    expect(isSuspectItem(null, question)).toBe(true);
  });

  it("allows a wrong answer with partial credit", () => {
    expect(
      isSuspectItem(
        { ...good, isCorrect: false, score: 6, studentAnswer: "6" },
        question,
      ),
    ).toBe(false);
  });
});

describe("suspect annotations and review-mode completeness", () => {
  const questions = [
    { id: "q1", score: 10 },
    { id: "q2", score: 5 },
  ];
  const items = [
    {
      questionId: "q1",
      studentAnswer: "8",
      isCorrect: false,
      score: 4,
      confidence: 0.9,
      reasoning: "正确答案是 7，学生写成 8",
    },
    {
      questionId: "q2",
      studentAnswer: "3",
      isCorrect: false,
      score: 0,
      confidence: 0.4,
      reasoning: "结果不对",
    },
  ];

  it("annotates without mutating the input items", () => {
    const annotated = annotateReviewItems(items, questions);
    expect(annotated[0].suspect).toBe(false);
    expect(annotated[1].suspect).toBe(true);
    expect(items[1]).not.toHaveProperty("suspect");
    expect(suspectItems(items, questions).map((item: any) => item.questionId)).toEqual([
      "q2",
    ]);
  });

  it("only requires confirmation for suspect items in uncertain mode", () => {
    expect(assertReviewModeComplete("all", items, questions)).toBe("");
    expect(assertReviewModeComplete("none", items, questions)).toBe("");
    expect(assertReviewModeComplete("uncertain", items, questions)).toBe(
      "还有 1 道存疑题未核对完整",
    );
    const confirmed = [
      items[0],
      { ...items[1], confirmed: true },
    ];
    expect(assertReviewModeComplete("uncertain", confirmed, questions)).toBe("");
    expect(assertReviewModeComplete("bogus", items, questions)).toBe(
      "复核方式无效",
    );
  });
});

describe("normalizeDirectReview", () => {
  const questions = [
    { id: "dq1", score: 10 },
    { id: "dq2", score: 5 },
  ];

  it("matches direct verdicts and derives a bounded total", () => {
    const result = normalizeDirectReview(
      [
        { questionId: "dq1", isCorrect: false, score: 4, reasoning: "x" },
        { questionId: "dq2", isCorrect: true },
      ],
      questions,
    );
    expect(result.score).toBe(9);
    expect(result.items[1].score).toBe(5);
  });

  it("rejects mismatched, duplicated or inconsistent verdicts", () => {
    for (const items of [
      [{ questionId: "dq1", isCorrect: true }],
      [
        { questionId: "dq1", isCorrect: true, score: 10 },
        { questionId: "dq1", isCorrect: true, score: 5 },
      ],
      [
        { questionId: "foreign", isCorrect: true },
        { questionId: "dq2", isCorrect: true },
      ],
      [
        { questionId: "dq1", isCorrect: "yes", score: 10 },
        { questionId: "dq2", isCorrect: true },
      ],
      [
        { questionId: "dq1", isCorrect: false, score: 12 },
        { questionId: "dq2", isCorrect: true },
      ],
      [
        { questionId: "dq1", isCorrect: true, score: 5 },
        { questionId: "dq2", isCorrect: true },
      ],
    ])
      expect(() => normalizeDirectReview(items, questions)).toThrow();
  });
});

describe("commitReview", () => {
  it("persists bank-mode mistakes with question snapshots and review audit", () => {
    const db = seedBase();
    const { submission, questions } = seedBankSubmission(db);
    const ctx = makeCtx(db);
    const normalized = {
      items: [
        {
          questionId: "q1",
          studentAnswer: "3",
          isCorrect: false,
          score: 2,
          reason: "计算错误",
          correction: "2",
          explanation: "1+1=2",
          reasoning: "学生写成 3，与正确答案 2 不一致",
          confidence: 0.9,
        },
        { questionId: "q2", isCorrect: true, score: 10 },
      ],
      score: 12,
    };
    const result = commitReview(ctx, {
      submission,
      questions,
      items: normalized.items,
      actorId: "teacher-1",
      reviewMode: "all",
      auto: false,
    });
    expect(result.score).toBe(12);
    const mistake = db
      .prepare("SELECT * FROM mistakes WHERE submission_id=?")
      .get("submission-bank") as any;
    expect(mistake).toMatchObject({
      question_id: "q1",
      knowledge_id: "knowledge-1",
      question_number: 1,
      prompt: "1+1=?",
      standard_answer: "2",
      question_score: 5,
      reasoning: "学生写成 3，与正确答案 2 不一致",
      guidance_json: null,
      mastery: 0,
    });
    expect(mistake.practice_json).toBe("[]");
    const saved = db
      .prepare("SELECT * FROM submissions WHERE id=?")
      .get("submission-bank") as any;
    expect(saved.teacher_reviewed).toBe(1);
    expect(saved.status).toBe("completed");
    expect(saved.score).toBe(12);
    expect(JSON.parse(saved.analysis_json).items).toHaveLength(2);
    const audit = db
      .prepare("SELECT * FROM review_audit WHERE submission_id=?")
      .all("submission-bank") as any[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: "teacher-1",
      action: "review_saved",
      school_id: "school-1",
    });
    expect(JSON.parse(audit[0].after_json).score).toBe(12);
  });

  it("persists direct-mode mistakes with NULL question_id and full snapshot", () => {
    const db = seedBase();
    const { submission, questions } = seedDirectSubmission(db);
    const ctx = makeCtx(db);
    const items = normalizeDirectReview(
      [
        {
          questionId: "dq1",
          studentAnswer: "8",
          isCorrect: false,
          score: 2,
          reason: "粗心",
          correction: "7",
          explanation: "3+4=7",
          reasoning: "3+4 应为 7，学生写成 8",
          confidence: 0.9,
          practiceQuestions: [
            { prompt: "2+3", answer: "5", explanation: "略" },
          ],
          guidance: {
            keyQuestion: "先数一数",
            hints: ["从左往右数", "再检查一遍"],
            selfCheck: ["加对了吗"],
          },
        },
        { questionId: "dq2", isCorrect: true, score: 10 },
      ],
      questions,
    ).items;
    const result = commitReview(ctx, {
      submission,
      questions,
      items,
      actorId: "teacher-1",
      reviewMode: "none",
      auto: true,
    });
    expect(result.score).toBe(12);
    const mistake = db
      .prepare("SELECT * FROM mistakes WHERE submission_id=?")
      .get("submission-direct") as any;
    expect(mistake.question_id).toBeNull();
    expect(mistake).toMatchObject({
      prompt: "求 3+4",
      standard_answer: "7",
      question_number: 1,
      question_score: 10,
      reasoning: "3+4 应为 7，学生写成 8",
      knowledge_id: "knowledge-1",
    });
    const guidance = JSON.parse(mistake.guidance_json);
    expect(guidance.keyQuestion).toBe("先数一数");
    expect(guidance.hints).toHaveLength(2);
    expect(JSON.parse(mistake.practice_json)[0].prompt).toBe("2+3");
    const audit = db
      .prepare("SELECT * FROM review_audit WHERE submission_id=?")
      .all("submission-direct") as any[];
    expect(audit[0].action).toBe("auto_review_saved");
    expect(JSON.parse(audit[0].after_json).reviewMode).toBe("none");
  });

  it("replaces previous mistakes when a submission is reviewed again", () => {
    const db = seedBase();
    const { submission, questions } = seedBankSubmission(db);
    const ctx = makeCtx(db);
    insert(
      db,
      "mistakes",
      [
        "id",
        "submission_id",
        "student_id",
        "question_id",
        "knowledge_id",
        "reason",
        "student_answer",
        "correction",
        "created_at",
      ],
      ["old-mistake", "submission-bank", "student-1", "q1", null, "旧归因", "1", "2", NOW],
    );
    commitReview(ctx, {
      submission,
      questions,
      items: [
        { questionId: "q1", isCorrect: true, score: 5 },
        { questionId: "q2", isCorrect: true, score: 10 },
      ],
      actorId: "teacher-1",
    });
    const rows = db
      .prepare("SELECT id FROM mistakes WHERE submission_id=?")
      .all("submission-bank") as any[];
    expect(rows).toHaveLength(0);
    expect(
      db.prepare("SELECT COUNT(*) count FROM review_audit").get(),
    ).toMatchObject({ count: 1 });
  });

  it("rejects inconsistent input before writing anything", () => {
    const db = seedBase();
    const { submission, questions } = seedBankSubmission(db);
    const ctx = makeCtx(db);
    expect(() =>
      commitReview(ctx, {
        submission,
        questions,
        items: [{ questionId: "q1", isCorrect: true }],
      }),
    ).toThrow();
    expect(() =>
      commitReview(ctx, {
        submission,
        questions,
        items: [
          { questionId: "q1", isCorrect: true, score: 5 },
          { questionId: "foreign", isCorrect: true, score: 10 },
        ],
      }),
    ).toThrow();
    expect(() =>
      commitReview(ctx, {
        submission,
        questions,
        items: [
          { questionId: "q1", isCorrect: true, score: 5 },
          { questionId: "q2", isCorrect: false, score: 11 },
        ],
      }),
    ).toThrow("逐题得分须在满分范围内");
    expect(
      db.prepare("SELECT COUNT(*) count FROM submissions WHERE teacher_reviewed=1").get(),
    ).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM mistakes").get()).toMatchObject({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) count FROM review_audit").get()).toMatchObject({
      count: 0,
    });
  });

  it("rejects an unknown review mode", () => {
    const db = seedBase();
    const { submission, questions } = seedBankSubmission(db);
    const ctx = makeCtx(db);
    expect(() =>
      commitReview(ctx, {
        submission,
        questions,
        items: [
          { questionId: "q1", isCorrect: true, score: 5 },
          { questionId: "q2", isCorrect: true, score: 10 },
        ],
        reviewMode: "auto",
      }),
    ).toThrow();
  });
});

describe("registerReviewRoutes", () => {
  let db: DatabaseSync;
  let server: any;
  let base = "";

  beforeAll(async () => {
    db = seedBase();
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const auth = (req: any, res: any, next: any) => {
      const id = String(req.headers["x-user"] || "");
      const user = db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
      if (!user) return res.status(401).json({ error: "请先登录" });
      req.user = user;
      next();
    };
    registerReviewRoutes(app, { db, auth });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    db?.close();
  });

  async function request(route: string, user = "teacher-1", init: any = {}) {
    const response = await fetch(base + route, {
      method: init.method || "GET",
      headers: {
        "x-user": user,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: response.status, body: await response.json() };
  }

  it("returns the caller's stored mode plus the catalog", async () => {
    const { status, body } = await request("/api/settings/review-mode");
    expect(status).toBe(200);
    expect(body.mode).toBe("all");
    expect(body.modes.map((mode: any) => mode.id)).toEqual([
      "all",
      "uncertain",
      "none",
    ]);
  });

  it("lets a teacher change the mode", async () => {
    const saved = await request("/api/settings/review-mode", "teacher-1", {
      method: "PUT",
      body: { mode: "uncertain" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true, mode: "uncertain" });
    const stored = db
      .prepare("SELECT review_mode FROM users WHERE id=?")
      .get("teacher-1") as any;
    expect(stored.review_mode).toBe("uncertain");
    const reloaded = await request("/api/settings/review-mode", "teacher-1");
    expect(reloaded.body.mode).toBe("uncertain");
  });

  it("rejects invalid modes", async () => {
    const { status, body } = await request(
      "/api/settings/review-mode",
      "teacher-1",
      { method: "PUT", body: { mode: "auto" } },
    );
    expect(status).toBe(400);
    expect(body.error).toContain("复核方式无效");
  });

  it("keeps school admins and non-teachers out", async () => {
    const admin = await request("/api/settings/review-mode", "admin-1", {
      method: "PUT",
      body: { mode: "none" },
    });
    expect(admin.status).toBe(403);
    expect(admin.body.error).toBe("学校管理员不参与作业复核");
    const student = await request("/api/settings/review-mode", "student-1", {
      method: "PUT",
      body: { mode: "none" },
    });
    expect(student.status).toBe(403);
    const anonymous = await request("/api/settings/review-mode", "");
    expect(anonymous.status).toBe(401);
  });
});
