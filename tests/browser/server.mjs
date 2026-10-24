// Isolated fixture server. Never import this entrypoint in production.
import fs from "node:fs";
import dns from "node:dns";
// All model traffic is synthetic, including endpoint DNS checks.
dns.promises.lookup = async () => [{ address: "1.1.1.1", family: 4 }];
process.env.CLIENT_TILING_ENABLED = "1";
process.env.DEEPSEEK_FILES_ENABLED = "0";
process.env.MODEL_SCHOOL_DAILY_MICRO_CNY = "1000000000";
process.env.MODEL_USER_DAILY_MICRO_CNY = "1000000000";
process.env.MODEL_COST_RATES_JSON = JSON.stringify({
  "openai/gpt-4.1-mini": { input: 1000000, output: 2000000, imageTokens: 4096 },
});
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { seedTeachingFixture } from "../../server/analysis.fixture.mjs";
const root = fileURLToPath(new URL("../..", import.meta.url));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "mes-browser-"));
process.env.DATA_DIR = data;
process.env.HOST = "127.0.0.1";
process.env.PORT = process.env.FIXTURE_PORT || "18877";
process.env.NODE_ENV = "test";
process.env.SYSTEM_PRESSURE_ENABLED = "0";
process.env.APP_SECRET = "browser-test-only-not-a-real-production-secret";
fs.mkdirSync(path.join(data, "uploads"));
const db = new DatabaseSync(path.join(data, "smart-campus.sqlite"));
db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
const f = seedTeachingFixture(db);
// v0.2.1：教师分开模式才允许教师配置自己的模型凭证（浏览器用例沿用此假设）。
db.prepare(
  "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES(?,?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode,updated_at=excluded.updated_at",
).run(f.schoolId, "teacher_class", new Date().toISOString());
db.prepare("UPDATE assignments SET title=?,created_at=? WHERE id=?").run(
  "浏览器作业 A",
  "2026-01-02T00:00:00.000Z",
  f.assignmentId,
);
const b = randomUUID();
db.prepare(
  "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at,description,grading_mode) SELECT ?,school_id,teacher_id,?,stage,subject,class_name,due_at,status,?,'','bank' FROM assignments WHERE id=?",
).run(b, "浏览器作业 B", "2026-01-01T00:00:00.000Z", f.assignmentId);
const questions = db
  .prepare("SELECT * FROM questions WHERE assignment_id=? ORDER BY number")
  .all(f.assignmentId);
const questionMap = new Map();
for (const q of questions) {
  const id = randomUUID();
  questionMap.set(q.id, id);
  db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,?,?)").run(
    id,
    b,
    q.number,
    `B独有题干${q.number}`,
    q.standard_answer,
    q.knowledge_id,
    q.score,
  );
}
for (const s of db
  .prepare("SELECT * FROM submissions WHERE assignment_id=?")
  .all(f.assignmentId)) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,ocr_text,analysis_json,teacher_reviewed,score,created_at,questions_json) SELECT ?,?,student_id,student_name,file_path,file_type,status,ocr_text,analysis_json,teacher_reviewed,score,created_at,questions_json FROM submissions WHERE id=?",
  ).run(id, b, s.id);
  for (const m of db
    .prepare("SELECT * FROM mistakes WHERE submission_id=?")
    .all(s.id))
    db.prepare(
      "INSERT INTO mistakes(id,submission_id,student_id,question_id,knowledge_id,reason,student_answer,correction,created_at,explanation,practice_json,mastery,question_number,prompt,standard_answer,question_score,reasoning,guidance_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      id,
      m.student_id,
      questionMap.get(m.question_id),
      m.knowledge_id,
      m.reason,
      m.student_answer,
      m.correction,
      m.created_at,
      m.explanation,
      m.practice_json,
      m.mastery,
      m.question_number,
      m.prompt,
      m.standard_answer,
      m.question_score,
      m.reasoning,
      m.guidance_json,
    );
}
// Give every fixture an actual protected PNG attachment. No student data is real.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
for (const s of db.prepare("SELECT id FROM submissions").all()) {
  const file = path.join(data, "uploads", s.id + ".png");
  fs.writeFileSync(file, png);
  db.prepare(
    "UPDATE submissions SET file_path=?,file_type='image/png' WHERE id=?",
  ).run(file, s.id);
}
db.close();
// All outbound model calls are intercepted inside this fixture-only process.
// A prompt outside the supported test flows fails closed instead of networking.
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  const content = request.messages[0].content;
  const prompt = Array.isArray(content) ? content[0].text : content;
  let result;
  if (prompt.startsWith("学校作业 OCR")) {
    const q = JSON.parse(
      prompt.split("教师已经录入的正式题目=")[1].split("。\n")[0],
    );
    result = {
      ocrText: "BROWSER_MOCK_OCR",
      items: q.map((x) => ({
        questionId: x.id,
        knowledgeId: x.knowledge_id,
        studentAnswer: "mock answer",
        isCorrect: false,
        score: 0,
        reason: "计算错误",
        correction: x.standard_answer,
        explanation: "mock explanation",
        confidence: 0.95,
        reasoning: "mock reasoning: 对照参考答案判定学生这一步正确。",
        practiceQuestions: [
          { prompt: "1+1=?", answer: "2", explanation: "addition" },
        ],
        guidance: {
          keyQuestion: "先想一想这道题用到哪个知识点？",
          hints: ["回顾定义", "检查代入", "验算结果"],
          selfCheck: ["结果合理吗？"],
        },
      })),
    };
  } else if (prompt.includes("请严格批改过关练习")) {
    const answers = JSON.parse(prompt.split("学生答案=")[1].split("。语义")[0]);
    result = {
      results: answers.map(() => ({
        correct: true,
        feedback: "mock accepted",
      })),
      passed: true,
    };
  } else if (prompt.startsWith("为学生生成过关练习")) {
    result = {
      questions: [{ prompt: "1+1=?", answer: "2", explanation: "addition" }],
    };
  } else if (prompt.includes("教研组长")) {
    result = {
      brief: "MOCK_CLASS_PLAN",
      keyFindings: [
        { title: "mock finding", detail: "fixture only", action: "review" },
      ],
    };
  } else if (prompt.includes("个别化诊断")) {
    result = { brief: "MOCK_STUDENT_PLAN", diagnosis: "fixture only" };
  } else {
    throw new Error(
      "Unexpected model prompt; network disabled in browser fixture",
    );
  }
  return Response.json({
    choices: [{ message: { content: JSON.stringify(result) } }],
  });
};
process.on("exit", () => {
  try {
    fs.rmSync(data, { recursive: true, force: true });
  } catch {}
});
await import("../../server/index.mjs");
