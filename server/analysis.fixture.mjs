// 教学分析的测试夹具：生成一所学校、一名教师、两名学生与一份已复核作业，
// 用来在单元测试和端到端脚本中复现真实的错题归因场景（含无法辨认、未复核等边界）。

import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uid = () => randomUUID();
const iso = () => new Date().toISOString();
export const pass = (password, salt) =>
  scryptSync(password, salt, 64).toString("hex");

export const fixturePassword = "ChangeMe123!";

// 每题一条：题号、知识点、分值、两名学生的判分与错因
// 覆盖多种错因：概念混淆、空题、审题偏差、步骤缺失、无法辨认，以及答对的情况
export const fixtureQuestions = [
  {
    number: 1,
    knowledge: "电流的单位",
    score: 5,
    qing: {
      correct: true,
      answer: "A",
      correction: "A。电流的国际单位是安培。",
      explanation: "牛顿是力的单位，焦耳是能量单位，只有安培是电流单位。",
    },
    lin: {
      correct: false,
      answer: "B",
      reason: "学生误选B，把焦耳这个能量单位当成了电流单位，属于概念混淆。",
      correction: "A。电流的国际单位是安培(A)。",
      explanation: "牛顿是力的单位，焦耳是能量单位，只有安培是电流单位。",
      practice: [
        {
          prompt: "电阻的国际单位是（ ） A.欧姆 B.伏特 C.安培 D.瓦特",
          answer: "A",
          explanation: "电阻的国际单位是欧姆。",
        },
        {
          prompt: "下列物理量与其单位对应正确的是（ ） A.电流—伏特 B.电功—焦耳",
          answer: "B",
          explanation: "电功的单位是焦耳。",
        },
      ],
    },
  },
  {
    number: 2,
    knowledge: "导体和绝缘体",
    score: 5,
    qing: { correct: true, answer: "C", correction: "C。", explanation: "锡箔纸是导体。" },
    lin: {
      correct: false,
      answer: "未作答",
      reason: "学生答卷中该题未填写选项，按未作答处理。",
      correction: "C。锡箔纸属于导体。",
      explanation: "金属材料容易导电，属于导体。",
    },
  },
  {
    number: 3,
    knowledge: "串联电路和并联电路的辨别",
    score: 6,
    qing: { correct: true, answer: "串", correction: "串联。", explanation: "电流只有一条路径。" },
    lin: {
      correct: false,
      answer: "并",
      reason: "学生把串联电路判断为并联，概念混淆。",
      correction: "串联。",
      explanation: "串联电路电流只有一条路径。",
    },
  },
  {
    number: 4,
    knowledge: "电路的三种状态（短路现象分析）",
    score: 6,
    qing: {
      correct: true,
      answer: "L1不亮、L2仍亮",
      correction: "闭合S2后L1被短路。",
      explanation: "S2把L1所在支路短路。",
    },
    lin: {
      correct: false,
      answer: "两灯一直亮",
      reason: "学生选了“两灯一直亮”，未分析出闭合S2后L1被短路，忽略开关对电路的改变。",
      correction: "L1不亮、L2仍亮。",
      explanation: "S2把L1所在支路短路。",
    },
  },
  {
    number: 5,
    knowledge: "串联电路的电流规律与电流方向",
    score: 8,
    qing: { correct: true, answer: "0.3A", correction: "0.3A。", explanation: "串联电流处处相等。" },
    lin: { correct: true, answer: "0.3A", correction: "0.3A。", explanation: "串联电流处处相等。" },
  },
  {
    number: 6,
    knowledge: "电路的实物连接与电路图绘制",
    score: 10,
    qing: {
      correct: false,
      answer: "导线接在开关两端",
      reason: "实物连接存在连线错误，步骤缺失，未按电源—开关—灯泡顺序连成通路。",
      correction: "按电源、开关、灯泡顺次连接。",
      explanation: "先连主回路再接支路。",
    },
    lin: {
      correct: false,
      answer: "未作图",
      reason: "学生答卷中该题未提供作图，按未作答处理。",
      correction: "按电源、开关、灯泡顺次连接。",
      explanation: "先连主回路再接支路。",
    },
  },
  {
    number: 7,
    knowledge: "探究并联电路中电流的特点",
    score: 10,
    qing: {
      correct: false,
      answer: "该题所在页面未在提供的答卷图片中呈现",
      reason: "该题答题内容所在页面未在提供的答卷图片中呈现，无法辨认学生实际填写内容，暂不能判定正误。",
      correction: "干路电流等于各支路电流之和。",
      explanation: "并联电路干路电流等于各支路之和。",
    },
    lin: { correct: true, answer: "I=I1+I2", correction: "I=I1+I2。", explanation: "并联电流规律。" },
  },
  {
    number: 8,
    knowledge: "能量转化与蓄电池的循环寿命（信息阅读题）",
    score: 10,
    qing: { correct: true, answer: "化学能转化为电能", correction: "化学能→电能。", explanation: "放电过程化学能转化为电能。" },
    lin: {
      correct: false,
      answer: "电能转化为化学能",
      reason: "学生把放电过程的能量转化写反了，审题时未看清“放电”这一条件。",
      correction: "化学能转化为电能。",
      explanation: "放电时化学能转化为电能。",
    },
  },
];

export const fixtureStudents = [
  { key: "lin", name: "林一", email: "lin@fixture.test" },
  { key: "qing", name: "秦二", email: "qing@fixture.test" },
];

export const fixtureAssignmentTitle = "第十五章 电流和电路 阶段检测";

export function seedTeachingFixture(db) {
  const schoolId = uid();
  const teacherId = uid();
  const salt = randomBytes(16).toString("hex");
  const insertUser = db.prepare(
    "INSERT INTO users(id,school_id,role,name,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    schoolId,
    "测试中学",
    iso(),
  );
  insertUser.run(
    teacherId,
    schoolId,
    "teacher",
    "王老师",
    "teacher@fixture.test",
    pass(fixturePassword, salt),
    salt,
    "初中",
    "物理",
    "八年级（1）班",
    iso(),
    0,
  );
  const students = fixtureStudents.map((item) => {
    const id = uid();
    const studentSalt = randomBytes(16).toString("hex");
    insertUser.run(
      id,
      schoolId,
      "student",
      item.name,
      item.email,
      pass(fixturePassword, studentSalt),
      studentSalt,
      "初中",
      null,
      "八年级（1）班",
      iso(),
      0,
    );
    return { ...item, id };
  });

  // 学校管理员：只用于验证“可读不可写”的权限边界
  const adminSalt = randomBytes(16).toString("hex");
  insertUser.run(
    uid(),
    schoolId,
    "teacher",
    "校长",
    "admin@fixture.test",
    pass(fixturePassword, adminSalt),
    adminSalt,
    null,
    null,
    null,
    iso(),
    1,
  );

  const knowledgeIdByTitle = new Map();
  for (const question of fixtureQuestions) {
    if (knowledgeIdByTitle.has(question.knowledge)) continue;
    const id = uid();
    knowledgeIdByTitle.set(question.knowledge, id);
    db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)").run(
      id,
      schoolId,
      "初中",
      "物理",
      question.knowledge,
      "夹具知识点",
      teacherId,
      iso(),
    );
  }

  const assignmentId = uid();
  db.prepare("INSERT INTO assignments VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    assignmentId,
    schoolId,
    teacherId,
    fixtureAssignmentTitle,
    "初中",
    "物理",
    "八年级（1）班",
    null,
    "published",
    iso(),
  );
  const questionIdByNumber = new Map();
  const insertQuestion = db.prepare(
    "INSERT INTO questions VALUES(?,?,?,?,?,?,?)",
  );
  for (const question of fixtureQuestions) {
    const id = uid();
    questionIdByNumber.set(question.number, id);
    insertQuestion.run(
      id,
      assignmentId,
      question.number,
      `第${question.number}题：${question.knowledge}相关题目`,
      question.qing.correction || question.lin.correction || "参考答案",
      knowledgeIdByTitle.get(question.knowledge),
      question.score,
    );
  }

  const insertSubmission = db.prepare(
    "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,ocr_text,analysis_json,teacher_reviewed,score,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insertMistake = db.prepare(
    "INSERT INTO mistakes(id,submission_id,student_id,question_id,knowledge_id,reason,student_answer,correction,created_at,explanation,practice_json,mastery) VALUES(?,?,?,?,?,?,?,?,?,?,?,0)",
  );

  const insertStudentAnswers = (student, reviewed) => {
    const submissionId = uid();
    insertSubmission.run(
      submissionId,
      assignmentId,
      student.id,
      student.name,
      "/tmp/fixture.jpg",
      "image/jpeg",
      reviewed ? "completed" : "review",
      "夹具 OCR 原文",
      null,
      reviewed ? 1 : 0,
      reviewed
        ? fixtureQuestions.reduce(
            (sum, question) =>
              sum +
              ((student.key === "qing" ? question.qing : question.lin).correct
                ? question.score
                : 0),
            0,
          )
        : null,
      iso(),
    );
    for (const question of fixtureQuestions) {
      const outcome = student.key === "qing" ? question.qing : question.lin;
      if (outcome.correct) continue;
      insertMistake.run(
        uid(),
        submissionId,
        student.id,
        questionIdByNumber.get(question.number),
        knowledgeIdByTitle.get(question.knowledge),
        outcome.reason,
        outcome.answer,
        outcome.correction,
        iso(),
        outcome.explanation || outcome.correction,
        outcome.practice ? JSON.stringify(outcome.practice) : null,
      );
    }
  };

  insertStudentAnswers(students[0], true);
  insertStudentAnswers(students[1], true);

  // 未复核的错题：不应进入班级统计
  const pendingSubmissionId = uid();
  insertSubmission.run(
    pendingSubmissionId,
    assignmentId,
    students[0].id,
    students[0].name,
    "/tmp/fixture-2.jpg",
    "image/jpeg",
    "review",
    "夹具 OCR 原文（待复核）",
    null,
    0,
    null,
    iso(),
  );
  insertMistake.run(
    uid(),
    pendingSubmissionId,
    students[0].id,
    questionIdByNumber.get(1),
    knowledgeIdByTitle.get("电流的单位"),
    "待复核的错因，不应计入班级统计。",
    "C",
    "A。",
    iso(),
    "待复核解析",
    null,
  );

  return {
    schoolId,
    teacherId,
    assignmentId,
    students,
    knowledgeIdByTitle,
    questionIdByNumber,
    email: "teacher@fixture.test",
    password: fixturePassword,
  };
}

export function createFixtureDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  const fixture = seedTeachingFixture(db);
  return { db, fixture };
}
