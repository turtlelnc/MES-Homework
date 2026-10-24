import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { normalizeDirectReview } from "./grading.mjs";
import {
  buildDirectGradingPrompt,
  linkQuestions,
  normalizeDirectGrading,
} from "./direct-grading.mjs";

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

function makeCtx(db: DatabaseSync) {
  let sequence = 0;
  return {
    db,
    uid: () => `generated-${++sequence}`,
    iso: () => NOW,
  };
}

function validGrading() {
  return {
    ocrText: "1. 3+4= 2. 5×6=",
    questions: [
      {
        number: 2,
        prompt: "求 5×6 的值",
        referenceAnswer: "30",
        score: 10,
        knowledgeTitle: "乘法",
      },
      {
        number: 1,
        prompt: "求 3+4 的值",
        referenceAnswer: "7",
        score: 5,
        knowledgeTitle: "加法",
      },
    ],
    items: [
      {
        number: 2,
        studentAnswer: "11",
        isCorrect: false,
        score: 0,
        reason: "乘法当成加法",
        correction: "30",
        explanation: "先算 5×6=30",
        reasoning: "学生把 5×6 算成 5+6，属于运算规则用错",
        confidence: 0.9,
        practiceQuestions: [
          { prompt: "求 4×7", answer: "28", explanation: "四七二十八" },
        ],
        guidance: {
          keyQuestion: "乘法表示几个几相加？",
          hints: ["先回忆口诀", "再逐位相乘"],
          selfCheck: ["结果合理吗"],
        },
      },
      {
        number: 1,
        studentAnswer: "7",
        isCorrect: true,
        score: 5,
        reasoning: "3+4=7，计算正确",
        confidence: 0.98,
      },
    ],
    warnings: ["第 2 题字迹略淡"],
  };
}

describe("buildDirectGradingPrompt", () => {
  it("describes the assignment, the optional teacher note and the answer sheet source", () => {
    const prompt = buildDirectGradingPrompt({
      assignment: {
        title: "第 3 周练习",
        stage: "初中",
        subject: "数学",
        class_name: "初二 3 班",
        description: "一元二次方程配方法",
      },
      userId: "teacher-1",
      documentText: "1. x²-4=0",
      imageCount: 2,
    });
    expect(prompt).toContain("第 3 周练习");
    expect(prompt).toContain("初中");
    expect(prompt).toContain("数学");
    expect(prompt).toContain("初二 3 班");
    expect(prompt).toContain("一元二次方程配方法");
    expect(prompt).toContain("x²-4=0");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("无法辨认");
    expect(prompt).toContain('"items"');
  });

  it("marks the teacher description as optional and mentions attached pages", () => {
    const prompt = buildDirectGradingPrompt({
      assignment: {
        title: "作业",
        stage: "小学",
        subject: "语文",
        class_name: "三 1 班",
      },
      imageCount: 2,
    });
    expect(prompt).toContain("教师没有填写描述");
    expect(prompt).toContain("2 页");
    expect(prompt).toContain("页面已附在消息中");
    expect(prompt).not.toContain("undefined");
  });
});

describe("normalizeDirectGrading", () => {
  it("renumbers questions by answer-sheet order and matches items by the model number", () => {
    const result = normalizeDirectGrading(validGrading());
    expect(result.questions.map((question: any) => question.number)).toEqual([
      1, 2,
    ]);
    expect(result.questions.map((question: any) => question.id)).toEqual([
      "dq1",
      "dq2",
    ]);
    // 模型把第 2 题写在数组前面：数组顺序重排题号，但判分仍按模型题号对齐。
    expect(result.questions[0].prompt).toBe("求 5×6 的值");
    expect(result.questions[0].standardAnswer).toBe("30");
    expect(result.items.map((item: any) => item.questionId)).toEqual([
      "dq1",
      "dq2",
    ]);
    expect(result.items[0].isCorrect).toBe(false);
    expect(result.items[0].score).toBe(0);
    expect(result.items[0].reasoning).toContain("运算规则用错");
    expect(result.items[0].guidance.hints).toEqual(["先回忆口诀", "再逐位相乘"]);
    expect(result.items[1].isCorrect).toBe(true);
    expect(result.items[1].score).toBe(5);
    expect(result.warnings).toContain("第 2 题字迹略淡");
  });

  it("fills missing verdicts with a zero-confidence failure and warns", () => {
    const parsed = validGrading();
    parsed.items = parsed.items.filter((item) => item.number === 1);
    const result = normalizeDirectGrading(parsed);
    expect(result.items).toHaveLength(2);
    const missing = result.items.find(
      (item: any) => item.questionId === result.questions[0].id,
    );
    expect(missing).toMatchObject({ isCorrect: false, score: 0, confidence: 0 });
    expect(
      result.warnings.some((warning: string) => warning.includes("缺少模型判分")),
    ).toBe(true);
  });

  it("clamps scores, confidence and repeated field lengths", () => {
    const parsed = {
      ocrText: "x".repeat(30000),
      questions: [
        { prompt: "p".repeat(9000), referenceAnswer: "a", score: 10 },
      ],
      items: [
        {
          number: 1,
          studentAnswer: "s".repeat(9000),
          isCorrect: true,
          score: 99,
          reason: "r".repeat(3000),
          correction: "c".repeat(9000),
          explanation: "e".repeat(9000),
          reasoning: "reasoning ".repeat(1000),
          confidence: 5,
          practiceQuestions: Array.from({ length: 8 }, (_, index) => ({
            prompt: `p${index}`,
            answer: "a",
            explanation: "e",
          })),
          guidance: {
            keyQuestion: "k".repeat(1000),
            hints: Array.from({ length: 8 }, (_, index) => `hint-${index}`),
            selfCheck: Array.from({ length: 9 }, (_, index) => `check-${index}`),
          },
        },
      ],
    };
    const result = normalizeDirectGrading(parsed);
    expect(result.ocrText.length).toBe(20000);
    expect(result.questions[0].prompt.length).toBe(4000);
    expect(result.items[0].studentAnswer.length).toBe(4000);
    expect(result.items[0].correction.length).toBe(4000);
    expect(result.items[0].explanation.length).toBe(4000);
    expect(result.items[0].reasoning.length).toBe(4000);
    expect(result.items[0].reason.length).toBe(1000);
    expect(result.items[0].score).toBe(10);
    expect(result.items[0].confidence).toBe(1);
    expect(result.items[0].practiceQuestions).toHaveLength(5);
    expect(result.items[0].guidance.hints).toHaveLength(5);
    expect(result.items[0].guidance.selfCheck).toHaveLength(6);
    expect(result.items[0].guidance.keyQuestion.length).toBe(500);
  });

  it("keeps scores consistent with the verdict so the review validator accepts them", () => {
    const result = normalizeDirectGrading({
      questions: [
        { prompt: "题一", score: 10 },
        { prompt: "题二", score: 5 },
      ],
      items: [
        { number: 1, isCorrect: true, score: 3, reasoning: "算对了" },
        { number: 2, isCorrect: false, score: 5, reasoning: "结果不对" },
      ],
    });
    expect(result.items[0].score).toBe(10);
    expect(result.items[1].score).toBe(4.5);
    // 直批结果随后会走复核归一化，二者必须保持同一套分数/正误不变量。
    const reviewed = normalizeDirectReview(result.items, result.questions);
    expect(reviewed.score).toBe(14.5);
  });

  it("keeps -1 confidence when the model omits it so the review mode flags it", () => {
    const result = normalizeDirectGrading({
      questions: [{ prompt: "题目", score: 5 }],
      items: [{ number: 1, isCorrect: false, score: 0, reasoning: "判分依据充分" }],
    });
    expect(result.items[0].confidence).toBe(-1);
  });

  it("repairs invalid question scores and duplicate/extra verdicts with warnings", () => {
    const result = normalizeDirectGrading({
      questions: [
        { number: 1, prompt: "题一", email: "x", score: 5000 },
        { number: 2, prompt: "题二", score: 5 },
      ],
      items: [
        { number: 1, isCorrect: false, score: 0, reasoning: "理由充分" },
        { number: 1, isCorrect: true, score: 5, reasoning: "重复判分理由" },
        { number: 9, isCorrect: true, score: 5, reasoning: "对不上题目" },
      ],
    });
    expect(result.questions[0].score).toBe(0);
    expect(
      result.warnings.some((warning: string) => warning.includes("0–1000")),
    ).toBe(true);
    expect(
      result.warnings.some((warning: string) => warning.includes("重复判分")),
    ).toBe(true);
    expect(
      result.warnings.some((warning: string) => warning.includes("找不到对应题目")),
    ).toBe(true);
  });

  it("treats a non-array items field as every question missing its verdict", () => {
    const result = normalizeDirectGrading({
      questions: [
        { prompt: "题一", score: 5 },
        { prompt: "题二", score: 5 },
      ],
      items: "not-an-array",
    });
    expect(result.items.map((item: any) => item.isCorrect)).toEqual([
      false,
      false,
    ]);
    expect(
      result.warnings.some((warning: string) =>
        warning.includes("逐题判分格式无效"),
      ),
    ).toBe(true);
  });

  it("caps the question count at 200", () => {
    const result = normalizeDirectGrading({
      questions: Array.from({ length: 205 }, (_, index) => ({
        prompt: `题 ${index + 1}`,
        score: 1,
      })),
      items: [{ number: 1, isCorrect: true, score: 1, reasoning: "理由充分" }],
    });
    expect(result.questions).toHaveLength(200);
    expect(
      result.warnings.some((warning: string) => warning.includes("超过 200")),
    ).toBe(true);
  });

  it.each([null, undefined, "text", [], {}])(
    "throws a Chinese format error for %s",
    (parsed: any) => {
      expect(() => normalizeDirectGrading(parsed)).toThrow(
        "模型返回的批改结果格式无效，请重试",
      );
    },
  );

  it("throws when no question could be parsed", () => {
    expect(() => normalizeDirectGrading({ questions: [] })).toThrow(
      "模型返回的批改结果格式无效，请重试",
    );
  });
});

describe("linkQuestions", () => {
  function seedSchool(db: DatabaseSync, schoolId: string, suffix: string) {
    insert(db, "schools", ["id", "name", "created_at"], [
      schoolId,
      `学校${suffix}`,
      NOW,
    ]);
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
      ],
      [
        `teacher-${suffix}`,
        schoolId,
        "teacher",
        "老师",
        `teacher-${suffix}`,
        "hash",
        "salt",
        NOW,
      ],
    );
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
      [
        `assignment-${suffix}`,
        schoolId,
        `teacher-${suffix}`,
        "直批作业",
        "小学",
        "数学",
        "三 1 班",
        NOW,
        "direct",
      ],
    );
  }

  it("reuses existing knowledge, creates missing titles and keeps direct question ids", () => {
    const db = createDb();
    seedSchool(db, "school-a", "a");
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
      ["knowledge-existing", "school-a", "小学", "数学", "加法", "", "teacher-a", NOW],
    );
    const ctx = makeCtx(db);
    const assignment = db
      .prepare("SELECT * FROM assignments WHERE id=?")
      .get("assignment-a") as any;
    const questions = [
      {
        id: "dq1",
        number: 1,
        prompt: "3+4",
        standardAnswer: "7",
        score: 5,
        knowledgeTitle: "加法",
      },
      {
        id: "dq2",
        number: 2,
        prompt: "0.1+0.2",
        standardAnswer: "0.3",
        score: 5,
        knowledgeTitle: "小数加法",
      },
      { id: "dq3", number: 3, prompt: "无知识点", score: 5 },
    ];
    const linked = linkQuestions(ctx, {
      assignment,
      questions,
      teacherId: "teacher-a",
    });
    expect(linked.map((question: any) => question.id)).toEqual([
      "dq1",
      "dq2",
      "dq3",
    ]);
    expect(linked[0].knowledgeId).toBe("knowledge-existing");
    expect(linked[0].knowledgeTitle).toBe("加法");
    expect(typeof linked[1].knowledgeId).toBe("string");
    expect(linked[1].knowledgeId).not.toBe("knowledge-existing");
    expect(linked[2].knowledgeId).toBeNull();
    const created = db
      .prepare("SELECT * FROM knowledge WHERE id=?")
      .get(linked[1].knowledgeId) as any;
    expect(created).toMatchObject({
      school_id: "school-a",
      stage: "小学",
      subject: "数学",
      title: "小数加法",
      created_by: "teacher-a",
    });
  });

  it("creates one knowledge row per title even when several questions share it", () => {
    const db = createDb();
    seedSchool(db, "school-b", "b");
    const ctx = makeCtx(db);
    const linked = linkQuestions(ctx, {
      assignment: { id: "assignment-b" },
      questions: [
        { id: "dq1", knowledgeTitle: "分数" },
        { id: "dq2", knowledgeTitle: "分数" },
      ],
      teacherId: "teacher-b",
    });
    expect(linked[0].knowledgeId).toBe(linked[1].knowledgeId);
    const rows = db
      .prepare("SELECT COUNT(*) count FROM knowledge WHERE title='分数'")
      .get() as any;
    expect(rows.count).toBe(1);
  });

  it("never reuses or accepts another school's knowledge id", () => {
    const db = createDb();
    seedSchool(db, "school-c", "c");
    seedSchool(db, "school-d", "d");
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
      ["foreign-knowledge", "school-d", "小学", "数学", "分数", "", "teacher-d", NOW],
    );
    const ctx = makeCtx(db);
    const linked = linkQuestions(ctx, {
      assignment: { id: "assignment-c" },
      questions: [
        { id: "dq1", knowledgeTitle: "分数" },
        { id: "dq2", knowledgeId: "foreign-knowledge" },
      ],
    });
    expect(linked[0].knowledgeId).not.toBe("foreign-knowledge");
    const own = db
      .prepare("SELECT school_id FROM knowledge WHERE id=?")
      .get(linked[0].knowledgeId) as any;
    expect(own.school_id).toBe("school-c");
    expect(linked[1].knowledgeId).toBeNull();
  });

  it("returns an empty list for missing question input and loads the assignment by id", () => {
    const db = createDb();
    seedSchool(db, "school-e", "e");
    const ctx = makeCtx(db);
    expect(linkQuestions(ctx, { questions: null })).toEqual([]);
    const linked = linkQuestions(ctx, {
      assignment: { id: "assignment-e" },
      questions: [{ id: "dq1", knowledgeTitle: "图形" }],
    });
    expect(linked[0].knowledgeId).toBeTruthy();
  });
});
