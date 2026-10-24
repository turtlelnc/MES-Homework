import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  buildParentDashboard,
  normalizeStudentInsight,
  registerParentRoutes,
} from "./parent.mjs";

const PASSWORD = "ChangeMe123!";
const root = new URL(".", import.meta.url);
let db: DatabaseSync;
let harness: ReturnType<typeof createHarness>;
let ids: {
  schoolId: string;
  otherSchoolId: string;
  teacherId: string;
  parentId: string;
  studentId: string;
  otherStudentId: string;
  foreignStudentId: string;
  unreviewedSubmissionId: string;
  bankSubmissionId: string;
  bankSubmission2Id: string;
  directSubmissionId: string;
  otherSubmissionId: string;
  foreignSubmissionId: string;
};
let originalFlag: string | undefined;

function pass(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

function iso(value: string | number = Date.now()) {
  return new Date(value).toISOString();
}

function user(id: string) {
  return db.prepare("SELECT * FROM users WHERE id=?").get(id) as any;
}

// 只做 method+path 匹配的 Express 替身：不监听端口、不联网。
function createHarness(
  options: {
    callModel?: (user: any, prompt: string) => any;
    resolveModelRoute?: (user: any) => any;
  } = {},
) {
  const routes: {
    method: string;
    path: string;
    handlers: ((req: any, res: any, next?: any) => any)[];
  }[] = [];
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
  const modelCalls: { user: any; prompt: string }[] = [];
  const ctx = {
    db,
    uid: () => randomUUID(),
    iso: () => new Date().toISOString(),
    pass,
    validPassword: (value: unknown) =>
      typeof value === "string" && value.length >= 8,
    safeParse: (value: string, fallback: unknown) => {
      try {
        return JSON.parse(value) ?? fallback;
      } catch {
        return fallback;
      }
    },
    auth: (req: any, res: any, next: any) =>
      req.user ? next() : res.status(401).json({ error: "请先登录" }),
    callModel:
      options.callModel ||
      (async (author: any, prompt: string) => {
        modelCalls.push({ user: author, prompt });
        return {
          summary: "总体平稳",
          strengths: ["计算准确"],
          weaknesses: [
            {
              knowledge: "电路基础",
              evidence: "第 2 题",
              suggestion: "多做单位换算",
            },
          ],
          subjectAnalysis: [
            { subject: "物理", level: "稳定", detail: "基础较稳" },
          ],
          studyHabits: ["作业按时完成"],
          homeActions: [
            { action: "每天检查错题", how: "口头复述", frequency: "每天" },
          ],
          encouragement: "继续加油！",
        };
      }),
    modelErrorStatus: (error: any) =>
      [409, 429].includes(error?.status) ? error.status : 502,
    resolveModelRoute:
      options.resolveModelRoute ||
      (() => ({ mode: "school", model: "mock-model-x" })),
  };
  registerParentRoutes(app as any, ctx as any);
  return { routes, ctx, modelCalls };
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
    for (const routeHandler of route.handlers) {
      if (routeHandler.length >= 3) {
        let moved = false;
        routeHandler(req, res, () => {
          moved = true;
        });
        if (!moved) break;
      } else {
        await routeHandler(req, res);
        break;
      }
    }
    return res;
  }
  throw new Error(`测试路由未注册：${method} ${path}`);
}

function seedDatabase() {
  const schoolId = randomUUID();
  const otherSchoolId = randomUUID();
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    schoolId,
    "测试中学",
    iso(),
  );
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    otherSchoolId,
    "外校",
    iso(),
  );
  const insertUser = db.prepare(
    "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const seedUser = (
    role: string,
    name: string,
    username: string,
    email: string,
    school = schoolId,
    stage: string | null = role === "parent" ? null : "初中",
    className: string | null = role === "parent" ? null : "八年级（1）班",
  ) => {
    const id = randomUUID();
    const salt = randomBytesHex();
    insertUser.run(
      id,
      school,
      role,
      name,
      username,
      email,
      pass(PASSWORD, salt),
      salt,
      stage,
      role === "teacher" ? "物理" : null,
      className,
      iso(),
      0,
    );
    return id;
  };
  const teacherId = seedUser(
    "teacher",
    "王老师",
    "teacher",
    "teacher@school.test",
  );
  const parentId = seedUser(
    "parent",
    "林妈妈",
    "lin_mom",
    "mom@school.test",
    schoolId,
    null,
    null,
  );
  const studentId = seedUser("student", "林一", "lin", "lin@school.test");
  const otherStudentId = seedUser("student", "秦二", "qin", "qin@school.test");
  const foreignStudentId = seedUser(
    "student",
    "外校学生",
    "outsider",
    "outsider@other.test",
    otherSchoolId,
  );
  db.prepare(
    "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
  ).run(randomUUID(), parentId, studentId, schoolId, "母亲", iso());
  const insertKnowledge = db.prepare(
    "INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)",
  );
  const knowledgeBase = randomUUID();
  insertKnowledge.run(
    knowledgeBase,
    schoolId,
    "初中",
    "物理",
    "电路基础",
    "",
    teacherId,
    iso(),
  );
  const knowledgeCurrent = randomUUID();
  insertKnowledge.run(
    knowledgeCurrent,
    schoolId,
    "初中",
    "物理",
    "电流方向",
    "",
    teacherId,
    iso(),
  );
  const insertAssignment = db.prepare(
    "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const insertQuestion = db.prepare(
    "INSERT INTO questions VALUES(?,?,?,?,?,?,?)",
  );
  const insertSubmission = db.prepare(
    "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,ocr_text,analysis_json,teacher_reviewed,score,created_at,questions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertMistake = db.prepare(
    "INSERT INTO mistakes(id,submission_id,student_id,question_id,knowledge_id,reason,student_answer,correction,created_at,explanation,practice_json,mastery,question_number,prompt,standard_answer,question_score,reasoning) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );

  // bank 模式作业 1：2 题共 10 分，得 5 分，第 2 题错（含 reasoning 快照）。
  const bankAssignment = randomUUID();
  insertAssignment.run(
    bankAssignment,
    schoolId,
    teacherId,
    "第一章电路检测",
    "初中",
    "物理",
    "八年级（1）班",
    iso("2026-10-01T08:00:00.000Z"),
  );
  const q1 = randomUUID();
  const q2 = randomUUID();
  insertQuestion.run(
    q1,
    bankAssignment,
    1,
    "第1题：串联电路电流",
    "0.5A",
    knowledgeBase,
    5,
  );
  insertQuestion.run(
    q2,
    bankAssignment,
    2,
    "第2题：并联电路电压",
    "3V",
    knowledgeBase,
    5,
  );
  const bankSubmissionId = randomUUID();
  insertSubmission.run(
    bankSubmissionId,
    bankAssignment,
    studentId,
    "林一",
    "/tmp/bank1.jpg",
    "image/jpeg",
    "completed",
    "OCR",
    JSON.stringify({
      ocrText: "OCR",
      items: [
        {
          questionId: q1,
          studentAnswer: "0.5A",
          isCorrect: true,
          score: 5,
          knowledgeId: knowledgeBase,
        },
        {
          questionId: q2,
          studentAnswer: "2V",
          isCorrect: false,
          score: 0,
          knowledgeId: knowledgeBase,
          reason: "计算粗心，单位看错",
          correction: "3V",
          explanation: "先判断并联电压相等",
          confidence: 0.9,
        },
      ],
    }),
    1,
    5,
    "2026-10-01T09:00:00.000Z",
    null,
  );
  insertMistake.run(
    randomUUID(),
    bankSubmissionId,
    studentId,
    q2,
    knowledgeBase,
    "计算粗心，单位看错",
    "2V",
    "3V",
    iso("2026-10-01T09:00:00.000Z"),
    "先判断并联电压相等",
    "[]",
    1,
    2,
    "第2题：并联电路电压",
    "3V",
    5,
    "对照参考答案要素：并联支路电压相等，学生写成 2V，少了单位换算。",
  );

  // bank 模式作业 2：数学 10 分得 8 分，全部正确（无错题）。
  const bankAssignment2 = randomUUID();
  insertAssignment.run(
    bankAssignment2,
    schoolId,
    teacherId,
    "第二章方程检测",
    "初中",
    "数学",
    "八年级（1）班",
    iso("2026-10-02T08:00:00.000Z"),
  );
  const q3 = randomUUID();
  insertQuestion.run(q3, bankAssignment2, 1, "第1题：解方程", "x=2", null, 10);
  const bankSubmission2Id = randomUUID();
  insertSubmission.run(
    bankSubmission2Id,
    bankAssignment2,
    studentId,
    "林一",
    "/tmp/bank2.jpg",
    "image/jpeg",
    "completed",
    "OCR",
    JSON.stringify({
      ocrText: "OCR",
      scoreTotal: 10,
      items: [
        { questionId: q3, studentAnswer: "x=2", isCorrect: true, score: 10 },
      ],
    }),
    1,
    8,
    "2026-10-02T09:00:00.000Z",
    null,
  );

  // direct 模式作业：没有题库，总分取 questions_json 快照。
  const directAssignment = randomUUID();
  insertAssignment.run(
    directAssignment,
    schoolId,
    teacherId,
    "无原题直批作业",
    "初中",
    "物理",
    "八年级（1）班",
    iso("2026-10-03T08:00:00.000Z"),
  );
  const directSubmissionId = randomUUID();
  insertSubmission.run(
    directSubmissionId,
    directAssignment,
    studentId,
    "林一",
    "/tmp/direct.jpg",
    "image/jpeg",
    "completed",
    "OCR",
    JSON.stringify({
      ocrText: "OCR",
      questions: [
        {
          id: "dq1",
          number: 1,
          prompt: "直批第1题：电流方向",
          standardAnswer: "从正极流向负极",
          score: 10,
          knowledgeTitle: "电流方向",
        },
      ],
      items: [
        {
          questionId: "dq1",
          studentAnswer: "从负极流向正极",
          isCorrect: false,
          score: 0,
          reason: "审题偏差，把方向记反",
          confidence: 0.4,
          reasoning: "学生答案方向与参考答案相反。",
        },
      ],
    }),
    1,
    0,
    "2026-10-03T09:00:00.000Z",
    JSON.stringify([
      {
        id: "dq1",
        number: 1,
        prompt: "直批第1题：电流方向",
        standardAnswer: "从正极流向负极",
        score: 10,
        knowledgeTitle: "电流方向",
      },
    ]),
  );
  insertMistake.run(
    randomUUID(),
    directSubmissionId,
    studentId,
    null,
    knowledgeCurrent,
    "审题偏差，把方向记反",
    "从负极流向正极",
    "从正极流向负极",
    iso("2026-10-03T09:00:00.000Z"),
    "电流由正极经外电路流向负极",
    "[]",
    0,
    1,
    "直批第1题：电流方向",
    "从正极流向负极",
    10,
    "学生答案方向与参考答案相反。",
  );

  // 未复核提交：家长看板/明细必须过滤掉。
  const unreviewedSubmissionId = randomUUID();
  insertSubmission.run(
    unreviewedSubmissionId,
    bankAssignment,
    studentId,
    "林一",
    "/tmp/pending.jpg",
    "image/jpeg",
    "review",
    "OCR",
    JSON.stringify({ items: [] }),
    0,
    null,
    "2026-10-04T09:00:00.000Z",
    null,
  );

  // 同校其他学生 + 外校学生的已复核提交：家长不可见。
  const otherSubmissionId = randomUUID();
  insertSubmission.run(
    otherSubmissionId,
    bankAssignment,
    otherStudentId,
    "秦二",
    "/tmp/other.jpg",
    "image/jpeg",
    "completed",
    "OCR",
    JSON.stringify({ items: [] }),
    1,
    10,
    "2026-10-01T10:00:00.000Z",
    null,
  );
  const foreignAssignment = randomUUID();
  insertAssignment.run(
    foreignAssignment,
    otherSchoolId,
    teacherId,
    "外校作业",
    "初中",
    "物理",
    "八年级（1）班",
    iso("2026-10-01T08:00:00.000Z"),
  );
  const foreignSubmissionId = randomUUID();
  insertSubmission.run(
    foreignSubmissionId,
    foreignAssignment,
    foreignStudentId,
    "外校学生",
    "/tmp/foreign.jpg",
    "image/jpeg",
    "completed",
    "OCR",
    JSON.stringify({ items: [], scoreTotal: 100 }),
    1,
    100,
    "2026-10-01T10:00:00.000Z",
    null,
  );

  // 完全没有已复核数据的同校学生（用于分析 400 分支）。
  const emptyStudentId = seedUser(
    "student",
    "空数据学生",
    "empty_student",
    "empty@school.test",
  );

  return {
    schoolId,
    otherSchoolId,
    teacherId,
    parentId,
    studentId,
    otherStudentId,
    foreignStudentId,
    emptyStudentId,
    unreviewedSubmissionId,
    bankSubmissionId,
    bankSubmission2Id,
    directSubmissionId,
    otherSubmissionId,
    foreignSubmissionId,
    bankAssignment,
    questions: { q1, q2, q3 },
  };
}

function randomBytesHex() {
  return randomBytes(16).toString("hex");
}

let seeded: ReturnType<typeof seedDatabase>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(fs.readFileSync(new URL("./schema.sql", root), "utf8"));
  seeded = seedDatabase();
  harness = createHarness();
  const {
    schoolId,
    otherSchoolId,
    teacherId,
    parentId,
    studentId,
    otherStudentId,
    foreignStudentId,
    unreviewedSubmissionId,
    bankSubmissionId,
    bankSubmission2Id,
    directSubmissionId,
    otherSubmissionId,
    foreignSubmissionId,
  } = seeded;
  ids = {
    schoolId,
    otherSchoolId,
    teacherId,
    parentId,
    studentId,
    otherStudentId,
    foreignStudentId,
    unreviewedSubmissionId,
    bankSubmissionId,
    bankSubmission2Id,
    directSubmissionId,
    otherSubmissionId,
    foreignSubmissionId,
  };
  originalFlag = process.env.ALLOW_PUBLIC_REGISTRATION;
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.ALLOW_PUBLIC_REGISTRATION;
  else process.env.ALLOW_PUBLIC_REGISTRATION = originalFlag;
  db.close();
});

const parentUser = () => user(ids.parentId);
const teacherUser = () => user(ids.teacherId);
const studentUser = () => user(ids.studentId);

describe("buildParentDashboard（确定性看板纯函数）", () => {
  it("空数据返回零值与空数组", () => {
    const dashboard = buildParentDashboard([]);
    expect(dashboard.summary).toEqual({
      assignments: 0,
      reviewedSubmissions: 0,
      averageScoreRate: 0,
      mistakeCount: 0,
      masteredCount: 0,
      masteryRate: 0,
    });
    expect(dashboard.subjects).toEqual([]);
    expect(dashboard.recent).toEqual([]);
    expect(dashboard.knowledge).toEqual([]);
    expect(dashboard.reasons).toEqual([]);
    expect(dashboard.trend).toEqual([]);
    expect(dashboard).not.toHaveProperty("student");
  });

  it("聚合已复核提交、学科、知识点、错因与趋势", () => {
    const dashboard = buildParentDashboard(
      [
        {
          id: "s1",
          assignmentId: "a1",
          assignmentTitle: "物理检测",
          subject: "物理",
          reviewedAt: "2026-10-02T00:00:00.000Z",
          score: 5,
          analysis: { scoreTotal: 10 },
          items: [],
          mistakes: [
            {
              number: 2,
              knowledgeTitle: "电路基础",
              reason: "计算粗心，单位看错",
              studentAnswer: "2V",
              mastery: 1,
            },
          ],
        },
        {
          id: "s2",
          assignmentId: "a2",
          assignmentTitle: "数学检测",
          subject: "数学",
          reviewedAt: "2026-10-03T00:00:00.000Z",
          score: 8,
          analysis: { scoreTotal: 10 },
          items: [],
          mistakes: [],
        },
        {
          id: "s3",
          assignmentId: "a3",
          assignmentTitle: "物理直批",
          subject: "物理",
          reviewedAt: "2026-10-04T00:00:00.000Z",
          score: 0,
          analysis: {},
          questionsJson: JSON.stringify([{ score: 10 }]),
          items: [],
          mistakes: [
            {
              number: 1,
              knowledgeTitle: "电流方向",
              reason: "审题偏差",
              studentAnswer: "反了",
              mastery: 0,
            },
          ],
        },
      ],
      { id: "stu", name: "林一", stage: "初中", class_name: "八年级（1）班" },
    );
    expect(dashboard.student).toEqual({
      id: "stu",
      name: "林一",
      stage: "初中",
      class_name: "八年级（1）班",
    });
    expect(dashboard.summary.assignments).toBe(3);
    expect(dashboard.summary.reviewedSubmissions).toBe(3);
    expect(dashboard.summary.averageScoreRate).toBeCloseTo(0.4333, 3);
    expect(dashboard.summary.mistakeCount).toBe(2);
    expect(dashboard.summary.masteredCount).toBe(1);
    expect(dashboard.summary.masteryRate).toBe(0.5);
    expect(dashboard.subjects).toEqual([
      {
        subject: "物理",
        reviewedSubmissions: 2,
        averageScoreRate: 0.25,
        mistakeCount: 2,
      },
      {
        subject: "数学",
        reviewedSubmissions: 1,
        averageScoreRate: 0.8,
        mistakeCount: 0,
      },
    ]);
    expect(dashboard.recent.map((item: any) => item.submissionId)).toEqual([
      "s3",
      "s2",
      "s1",
    ]);
    expect(dashboard.recent[0]).toMatchObject({
      assignmentTitle: "物理直批",
      score: 0,
      totalScore: 10,
      scoreRate: 0,
    });
    expect(dashboard.knowledge).toEqual([
      {
        title: "电流方向",
        subject: "物理",
        mistakeCount: 1,
        questionNumbers: [1],
      },
      {
        title: "电路基础",
        subject: "物理",
        mistakeCount: 1,
        questionNumbers: [2],
      },
    ]);
    expect(
      [...dashboard.reasons].sort((a: any, b: any) =>
        a.label.localeCompare(b.label, "zh-CN"),
      ),
    ).toEqual(
      [
        { label: "审题偏差", count: 1, share: 50 },
        { label: "计算粗心", count: 1, share: 50 },
      ].sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    );
    expect(
      dashboard.reasons.reduce((sum: number, item: any) => sum + item.share, 0),
    ).toBe(100);
    expect(dashboard.trend.map((item: any) => item.submissionId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("总分缺失时正分按 100% 兜底、0 分仍为 0", () => {
    const [positive, zero] = [
      buildParentDashboard([
        { id: "p", assignmentId: "a", subject: "物理", score: 6 },
      ]).recent[0],
      buildParentDashboard([
        { id: "z", assignmentId: "a", subject: "物理", score: 0 },
      ]).recent[0],
    ];
    expect(positive).toMatchObject({ totalScore: null, scoreRate: 1 });
    expect(zero).toMatchObject({ totalScore: null, scoreRate: 0 });
  });

  it("错因占比整数且总和为 100，趋势最多 12 条并按时间升序", () => {
    const rows = Array.from({ length: 13 }, (_, index) => ({
      id: `s${index}`,
      assignmentId: `a${index}`,
      subject: "物理",
      reviewedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      score: 5,
      analysis: { scoreTotal: 10 },
      items: [],
      mistakes: [
        {
          number: index + 1,
          knowledgeTitle: "电路基础",
          reason: ["计算粗心", "审题偏差", "概念混淆"][index % 3],
          studentAnswer: "x",
          mastery: 0,
        },
      ],
    }));
    const dashboard = buildParentDashboard(rows);
    expect(dashboard.trend).toHaveLength(12);
    expect(dashboard.trend[0].submissionId).toBe("s1");
    expect(dashboard.trend[11].submissionId).toBe("s12");
    expect(dashboard.reasons).toHaveLength(3);
    expect(
      dashboard.reasons.reduce((sum: number, item: any) => sum + item.share, 0),
    ).toBe(100);
    expect(dashboard.summary.mistakeCount).toBe(13);
    expect(dashboard.subjects[0]).toMatchObject({
      subject: "物理",
      mistakeCount: 13,
    });
  });
});

describe("normalizeStudentInsight（白名单归一化）", () => {
  it("保留合法字段并给出缺省值", () => {
    const insight = normalizeStudentInsight({
      summary: "  总体平稳  ",
      strengths: ["计算准确", 123, ""],
      weaknesses: [
        { knowledge: "电路", evidence: "第2题", suggestion: "多练" },
        { knowledge: "", evidence: "", suggestion: "" },
      ],
      subjectAnalysis: [
        { subject: "物理", level: "薄弱", detail: "电学弱" },
        { subject: "数学", level: "未知", detail: "稳定" },
      ],
      studyHabits: ["按时完成"],
      homeActions: [{ action: "检查错题", how: "口述", frequency: "每天" }],
      encouragement: "加油",
    });
    expect(insight.summary).toBe("总体平稳");
    expect(insight.strengths).toEqual(["计算准确"]);
    expect(insight.weaknesses).toEqual([
      { knowledge: "电路", evidence: "第2题", suggestion: "多练" },
    ]);
    expect(insight.subjectAnalysis[1].level).toBe("稳定");
    expect(insight.homeActions).toHaveLength(1);
    expect(insight.encouragement).toBe("加油");
  });

  it("缺失字段给空数组/空文本", () => {
    const insight = normalizeStudentInsight({});
    expect(insight).toEqual({
      summary: "",
      strengths: [],
      weaknesses: [],
      subjectAnalysis: [],
      studyHabits: [],
      homeActions: [],
      encouragement: "",
    });
  });

  it("数组与字符串超长被裁剪", () => {
    const insight = normalizeStudentInsight({
      summary: "a".repeat(3000),
      strengths: Array.from({ length: 30 }, () => "优点"),
      weaknesses: Array.from({ length: 30 }, () => ({ knowledge: "k" })),
    });
    expect(insight.summary).toHaveLength(2000);
    expect(insight.strengths).toHaveLength(12);
    expect(insight.weaknesses).toHaveLength(12);
  });

  it("接受 JSON 字符串，非法 JSON / 非对象直接抛错", () => {
    expect(() => normalizeStudentInsight('{"summary":"ok"}')).not.toThrow();
    expect(() => normalizeStudentInsight("not-json")).toThrow();
    expect(() => normalizeStudentInsight([])).toThrow();
    expect(() => normalizeStudentInsight(null)).toThrow();
  });
});

describe("家长路由鉴权与孩子列表", () => {
  it("仅家长可访问，学生/教师返回 403", async () => {
    for (const author of [studentUser(), teacherUser()]) {
      const response = await request("GET", "/api/parent/children", {
        user: author,
      });
      expect(response.statusCode).toBe(403);
      expect(response.payload.error).toBe("仅家长账户可访问");
    }
    const anonymous = await request("GET", "/api/parent/children");
    expect(anonymous.statusCode).toBe(401);
  });

  it("返回已绑定孩子的 relation 与学校名", async () => {
    const response = await request("GET", "/api/parent/children", {
      user: parentUser(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.payload).toEqual([
      {
        id: ids.studentId,
        name: "林一",
        stage: "初中",
        class_name: "八年级（1）班",
        relation: "母亲",
        school_name: "测试中学",
      },
    ]);
  });
});

describe("家长绑定孩子", () => {
  it("凭孩子账号 + 密码绑定（大小写不敏感），重复绑定幂等", async () => {
    const first = await request("POST", "/api/parent/children/bind", {
      user: parentUser(),
      body: {
        childUsername: " QIN ",
        childPassword: PASSWORD,
        relation: "父亲",
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.payload).toEqual({
      ok: true,
      studentName: "秦二",
      id: ids.otherStudentId,
    });
    const binding = db
      .prepare(
        "SELECT * FROM parent_students WHERE parent_id=? AND student_id=?",
      )
      .get(ids.parentId, ids.otherStudentId) as any;
    expect(binding.relation).toBe("父亲");
    const again = await request("POST", "/api/parent/children/bind", {
      user: parentUser(),
      body: { childUsername: "qin", childPassword: PASSWORD },
    });
    expect(again.statusCode).toBe(200);
    expect(again.payload.alreadyBound).toBe(true);
  });

  it("账号或密码错误统一文案，外校孩子不可绑定", async () => {
    const cases = [
      { childUsername: "qin", childPassword: "WrongPass123!" },
      { childUsername: "not-exist", childPassword: PASSWORD },
      { childUsername: "outsider", childPassword: PASSWORD },
    ];
    for (const body of cases) {
      const response = await request("POST", "/api/parent/children/bind", {
        user: parentUser(),
        body,
      });
      expect(response.statusCode).toBe(400);
      expect(response.payload.error).toBe("孩子账号或密码错误");
    }
  });

  it("学生/教师不能绑定孩子", async () => {
    const response = await request("POST", "/api/parent/children/bind", {
      user: teacherUser(),
      body: { childUsername: "qin", childPassword: PASSWORD },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("家长看板与已复核答卷明细", () => {
  it("看板只统计已复核提交，并给出完整统计口径", async () => {
    const authed = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/dashboard`,
      { user: parentUser() },
    );
    expect(authed.statusCode).toBe(200);
    expect(authed.payload.student).toEqual({
      id: ids.studentId,
      name: "林一",
      stage: "初中",
      class_name: "八年级（1）班",
    });
    expect(authed.payload.summary).toMatchObject({
      assignments: 3,
      reviewedSubmissions: 3,
      mistakeCount: 2,
      masteredCount: 1,
      masteryRate: 0.5,
    });
    expect(authed.payload.summary.averageScoreRate).toBeCloseTo(0.4333, 3);
    expect(authed.payload.subjects).toEqual([
      {
        subject: "物理",
        reviewedSubmissions: 2,
        averageScoreRate: 0.25,
        mistakeCount: 2,
      },
      {
        subject: "数学",
        reviewedSubmissions: 1,
        averageScoreRate: 0.8,
        mistakeCount: 0,
      },
    ]);
    expect(authed.payload.recent).toHaveLength(3);
    expect(authed.payload.recent[0].submissionId).toBe(ids.directSubmissionId);
    expect(authed.payload.recent[0]).toMatchObject({
      subject: "物理",
      score: 0,
      totalScore: 10,
      scoreRate: 0,
    });
    expect(authed.payload.knowledge).toHaveLength(2);
    expect(
      authed.payload.reasons.reduce(
        (sum: number, item: any) => sum + item.share,
        0,
      ),
    ).toBe(100);
    expect(authed.payload.trend.map((item: any) => item.submissionId)).toEqual([
      ids.bankSubmissionId,
      ids.bankSubmission2Id,
      ids.directSubmissionId,
    ]);
    expect(
      authed.payload.recent.some(
        (item: any) => item.submissionId === ids.unreviewedSubmissionId,
      ),
    ).toBe(false);
  });

  it("非绑定孩子（含外校）返回 404，教师返回 403", async () => {
    for (const studentId of [
      ids.otherStudentId,
      ids.foreignStudentId,
      "missing",
    ]) {
      const response = await request(
        "GET",
        `/api/parent/children/${studentId}/dashboard`,
        { user: parentUser() },
      );
      expect(response.statusCode).toBe(404);
    }
    const teacher = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/dashboard`,
      { user: teacherUser() },
    );
    expect(teacher.statusCode).toBe(403);
  });

  it("bank 模式明细包含 reasoning、参考答案与逐题批改结果", async () => {
    const response = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/submissions/${ids.bankSubmissionId}`,
      { user: parentUser() },
    );
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      id: ids.bankSubmissionId,
      title: "第一章电路检测",
      subject: "物理",
      score: 5,
      totalScore: 10,
    });
    expect(response.payload.items).toHaveLength(2);
    expect(response.payload.items[0]).toMatchObject({
      number: 1,
      isCorrect: true,
      score: 5,
      maxScore: 5,
      standardAnswer: "0.5A",
    });
    const wrong = response.payload.items[1];
    expect(wrong).toMatchObject({
      number: 2,
      prompt: "第2题：并联电路电压",
      studentAnswer: "2V",
      isCorrect: false,
      score: 0,
      maxScore: 5,
      correction: "3V",
      standardAnswer: "3V",
      explanation: "先判断并联电压相等",
    });
    expect(wrong.reasoning).toContain("并联支路电压相等");
    for (const item of response.payload.items) {
      expect(item).toHaveProperty("reasoning");
      expect(item).toHaveProperty("standardAnswer");
    }
  });

  it("direct 模式明细从 questions_json 快照补齐题干、参考答案与总分", async () => {
    const response = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/submissions/${ids.directSubmissionId}`,
      { user: parentUser() },
    );
    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({ score: 0, totalScore: 10 });
    expect(response.payload.items[0]).toMatchObject({
      number: 1,
      prompt: "直批第1题：电流方向",
      studentAnswer: "从负极流向正极",
      isCorrect: false,
      score: 0,
      maxScore: 10,
      standardAnswer: "从正极流向负极",
    });
    expect(response.payload.items[0].reasoning).toBe(
      "学生答案方向与参考答案相反。",
    );
  });

  it("未复核提交、非绑定孩子明细一律 404", async () => {
    for (const [studentId, submissionId] of [
      [ids.studentId, ids.unreviewedSubmissionId],
      [ids.otherStudentId, ids.otherSubmissionId],
      [ids.studentId, ids.otherSubmissionId],
      [ids.studentId, ids.foreignSubmissionId],
      [ids.studentId, "missing"],
    ]) {
      const response = await request(
        "GET",
        `/api/parent/children/${studentId}/submissions/${submissionId}`,
        { user: parentUser() },
      );
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("AI 学情分析", () => {
  it("没有已复核数据时返回 400 且不调用模型", async () => {
    db.prepare(
      "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      ids.parentId,
      seeded.emptyStudentId,
      ids.schoolId,
      "家长",
      iso(),
    );
    const response = await request(
      "POST",
      `/api/parent/children/${seeded.emptyStudentId}/insights/analyze`,
      { user: parentUser() },
    );
    expect(response.statusCode).toBe(400);
    expect(response.payload.error).toBe(
      "孩子还没有已复核的作业，暂不能生成学情分析",
    );
    expect(harness.modelCalls).toHaveLength(0);
  });

  it("生成分析：prompt 使用确定性统计，输出归一化后落库", async () => {
    const response = await request(
      "POST",
      `/api/parent/children/${ids.studentId}/insights/analyze`,
      { user: parentUser() },
    );
    expect(response.statusCode).toBe(200);
    expect(response.payload.insight.content).toMatchObject({
      summary: "总体平稳",
      strengths: ["计算准确"],
      encouragement: "继续加油！",
    });
    expect(response.payload.insight.model).toBe("mock-model-x");
    expect(response.payload.stats.summary).toMatchObject({
      reviewedSubmissions: 3,
      mistakeCount: 2,
    });
    expect(harness.modelCalls).toHaveLength(1);
    const prompt = harness.modelCalls[0].prompt;
    expect(harness.modelCalls[0].user.id).toBe(ids.parentId);
    expect(prompt).toContain("平均得分率：43%");
    expect(prompt).toContain("错题数：2 道");
    expect(prompt).toContain("林一");
    expect(prompt).toContain("电路基础");
    expect(prompt).toContain("只引用上面统计里出现的数字");
    const row = db
      .prepare("SELECT * FROM student_insights WHERE student_id=?")
      .get(ids.studentId) as any;
    expect(row).toMatchObject({
      school_id: ids.schoolId,
      created_by: ids.parentId,
      model: "mock-model-x",
    });
    expect(JSON.parse(row.payload_json).summary).toBe("总体平稳");
    expect(JSON.parse(row.stats_json).summary.reviewedSubmissions).toBe(3);
  });

  it("30 秒内同一学生只允许生成一次（429），冷却后可再次生成", async () => {
    const path = `/api/parent/children/${ids.studentId}/insights/analyze`;
    const first = await request("POST", path, { user: parentUser() });
    expect(first.statusCode).toBe(200);
    const second = await request("POST", path, { user: parentUser() });
    expect(second.statusCode).toBe(429);
    expect(second.payload.error).toContain("过于频繁");
    expect(harness.modelCalls).toHaveLength(1);
    db.prepare(
      "UPDATE student_insights SET created_at=? WHERE student_id=?",
    ).run(new Date(Date.now() - 40_000).toISOString(), ids.studentId);
    const third = await request("POST", path, { user: parentUser() });
    expect(third.statusCode).toBe(200);
    expect(harness.modelCalls).toHaveLength(2);
  });

  it("限流按学生维度隔离，不同孩子互不影响", async () => {
    db.prepare(
      "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      ids.parentId,
      ids.otherStudentId,
      ids.schoolId,
      "家长",
      iso(),
    );
    await request(
      "POST",
      `/api/parent/children/${ids.studentId}/insights/analyze`,
      {
        user: parentUser(),
      },
    );
    const other = await request(
      "POST",
      `/api/parent/children/${ids.otherStudentId}/insights/analyze`,
      { user: parentUser() },
    );
    // 其他孩子只有 1 份已复核提交（秦二的 bank 提交），可以生成。
    expect(other.statusCode).toBe(200);
    expect(harness.modelCalls).toHaveLength(2);
  });

  it("模型报错按 modelErrorStatus 映射，非法输出 502 且不落库", async () => {
    const limited = createHarness({
      callModel: async () => {
        throw Object.assign(new Error("模型调用已达限额"), { status: 429 });
      },
    });
    harness = limited;
    const limitedResponse = await request(
      "POST",
      `/api/parent/children/${ids.studentId}/insights/analyze`,
      { user: parentUser() },
    );
    expect(limitedResponse.statusCode).toBe(429);
    expect(limitedResponse.payload.error).toBe("模型调用已达限额");
    db.prepare("DELETE FROM student_insights").run();

    const invalid = createHarness({
      callModel: async () => "not-a-json-object",
    });
    harness = invalid;
    const invalidResponse = await request(
      "POST",
      `/api/parent/children/${ids.studentId}/insights/analyze`,
      { user: parentUser() },
    );
    expect(invalidResponse.statusCode).toBe(502);
    expect(invalidResponse.payload.error).toContain("格式无效");
    expect(
      db.prepare("SELECT COUNT(*) total FROM student_insights").get(),
    ).toMatchObject({ total: 0 });
  });

  it("非绑定孩子与教师不能生成分析", async () => {
    for (const [studentId, author] of [
      [ids.otherStudentId, parentUser()],
      [ids.foreignStudentId, parentUser()],
      [ids.studentId, teacherUser()],
    ]) {
      const response = await request(
        "POST",
        `/api/parent/children/${studentId}/insights/analyze`,
        { user: author },
      );
      expect([403, 404]).toContain(response.statusCode);
    }
    expect(harness.modelCalls).toHaveLength(0);
  });

  it("GET insights 返回最新一条或 null", async () => {
    const empty = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/insights`,
      { user: parentUser() },
    );
    expect(empty.statusCode).toBe(200);
    expect(empty.payload).toBeNull();
    await request(
      "POST",
      `/api/parent/children/${ids.studentId}/insights/analyze`,
      {
        user: parentUser(),
      },
    );
    const latest = await request(
      "GET",
      `/api/parent/children/${ids.studentId}/insights`,
      { user: parentUser() },
    );
    expect(latest.statusCode).toBe(200);
    expect(latest.payload).toMatchObject({ model: "mock-model-x" });
    expect(latest.payload.content.summary).toBe("总体平稳");
    expect(latest.payload.id).toBeTruthy();
    expect(latest.payload.created_at).toBeTruthy();
  });
});

// timingSafeEqual 在测试里额外校验一遍密码哈希逻辑（与实现解耦）。
describe("密码校验辅助", () => {
  it("孩子密码哈希与 scrypt 保持一致", () => {
    const student = user(ids.studentId);
    const provided = Buffer.from(pass(PASSWORD, student.salt), "hex");
    const expected = Buffer.from(student.password_hash, "hex");
    expect(timingSafeEqual(provided, expected)).toBe(true);
  });
});
