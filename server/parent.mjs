// v0.2.1 家长端：绑定孩子、确定性看板、已复核答卷明细、AI 学情分析。
// 所有查询都按 parent_students 绑定关系 + school_id 双重过滤；模型输出先白名单归一化再落库。
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { classifyReason, safeParse } from "./analysis.mjs";

const INSIGHT_FIELDS = {
  summary: 2000,
  encouragement: 2000,
};
const MAX_ARRAY = 12;
const INSIGHT_TTL_MS = 30_000;
const REVIEW_WINDOW = 200;

const newId = (ctx) => (ctx.uid ? ctx.uid() : randomUUID());
const nowIso = (ctx) => (ctx.iso ? ctx.iso() : new Date().toISOString());
const parseJson = (ctx, value, fallback) =>
  (ctx.safeParse || safeParse)(value, fallback);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clampRate(value) {
  return round(Math.min(1, Math.max(0, Number(value) || 0)));
}

function percent(rate) {
  return `${Math.round(clampRate(rate) * 100)}%`;
}

function relationOf(value) {
  const relation = text(value);
  return ["父亲", "母亲", "其他监护人"].includes(relation) ? relation : "家长";
}

function sumQuestionScores(value) {
  const list = typeof value === "string" ? safeParse(value, []) : value;
  if (!Array.isArray(list)) return null;
  let total = 0;
  let seen = false;
  for (const question of list) {
    const score = finiteNumber(question?.score);
    if (score !== null) {
      total += score;
      seen = true;
    }
  }
  return seen && total > 0 ? total : null;
}

// 总分优先级：analysis_json.scoreTotal（bank）> 题库/快照分值（direct）> 最终得分兜底。
function resolveScore(row) {
  const score = finiteNumber(row?.score);
  const analysis =
    row?.analysis && typeof row.analysis === "object" ? row.analysis : null;
  const totalScore =
    positiveNumber(row?.totalScore) ??
    positiveNumber(analysis?.scoreTotal) ??
    positiveNumber(row?.questionsTotal) ??
    sumQuestionScores(row?.questionsJson);
  if (score !== null && totalScore !== null)
    return {
      score,
      totalScore,
      scoreRate: clampRate(score / totalScore),
      unknownTotal: false,
    };
  if (score !== null)
    // 拿不到总分时不能用 0 分档误伤学生：正分按满分率兜底，0 分仍是 0。
    return {
      score,
      totalScore: null,
      scoreRate: score > 0 ? 1 : 0,
      unknownTotal: true,
    };
  return {
    score: null,
    totalScore: totalScore,
    scoreRate: 0,
    unknownTotal: true,
  };
}

function normalizeMistakes(row) {
  return (Array.isArray(row?.mistakes) ? row.mistakes : []).map(
    (mistake, index) => ({
      index,
      number: finiteNumber(
        mistake?.number ?? mistake?.questionNumber ?? mistake?.question_number,
      ),
      knowledgeTitle: text(
        mistake?.knowledgeTitle ??
          mistake?.knowledge_title ??
          mistake?.knowledge,
      ),
      reason: text(mistake?.reason),
      studentAnswer: text(mistake?.studentAnswer ?? mistake?.student_answer),
      mastery: Number(mistake?.mastery) === 1,
    }),
  );
}

function normalizeItems(row) {
  return (Array.isArray(row?.items) ? row.items : []).map((item, index) => ({
    index,
    number: finiteNumber(item?.number),
    isCorrect: item?.isCorrect === true,
    knowledgeTitle: text(
      item?.knowledgeTitle ?? item?.knowledge_title ?? item?.knowledge,
    ),
    reason: text(item?.reason),
    studentAnswer: text(item?.studentAnswer ?? item?.student_answer),
  }));
}

function mistakeCountOf(row) {
  const mistakes = normalizeMistakes(row);
  const wrongItems = normalizeItems(row).filter((item) => !item.isCorrect);
  return Math.max(mistakes.length, wrongItems.length);
}

function knowledgeEntries(row) {
  const mistakes = normalizeMistakes(row);
  if (mistakes.length)
    return mistakes.map((mistake) => ({
      title: mistake.knowledgeTitle,
      number: mistake.number,
    }));
  return normalizeItems(row)
    .filter((item) => !item.isCorrect)
    .map((item) => ({ title: item.knowledgeTitle, number: item.number }));
}

function reasonEntries(row) {
  const mistakes = normalizeMistakes(row);
  if (mistakes.length)
    return mistakes.map((mistake) => ({
      reason: mistake.reason,
      studentAnswer: mistake.studentAnswer,
    }));
  return normalizeItems(row)
    .filter((item) => !item.isCorrect)
    .map((item) => ({
      reason: item.reason,
      studentAnswer: item.studentAnswer,
    }));
}

function shareRows(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (!total) return [];
  const parts = entries.map((entry) => {
    const exact = (entry.count / total) * 100;
    return {
      ...entry,
      share: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });
  let remaining = 100 - parts.reduce((sum, part) => sum + part.share, 0);
  const ranked = [...parts].sort(
    (a, b) =>
      b.remainder - a.remainder ||
      b.count - a.count ||
      a.label.localeCompare(b.label, "zh-CN"),
  );
  for (let index = 0; index < remaining; index += 1)
    ranked[index % ranked.length].share += 1;
  return parts
    .sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"),
    )
    .map((entry) => ({
      label: entry.label,
      count: entry.count,
      share: entry.share,
    }));
}

/**
 * 看板纯函数（可直接单测）。
 * rows（仅已复核提交）：
 *   { id, assignmentId, assignmentTitle, subject, reviewedAt, score,
 *     analysis?, totalScore?, questionsTotal?, questionsJson?,
 *     items?: [{number,isCorrect,knowledgeTitle,reason,studentAnswer}],
 *     mistakes?: [{number,knowledgeTitle,reason,studentAnswer,mastery}] }
 * student 可选：{id,name,stage,class_name}，传入时输出 student 字段。
 */
export function buildParentDashboard(rows, student = null) {
  const list = Array.isArray(rows) ? rows : [];
  const reviewed = list.map((row) => {
    const detail = resolveScore(row);
    const mistakes = normalizeMistakes(row);
    const items = normalizeItems(row);
    return {
      row,
      score: detail.score,
      totalScore: detail.totalScore,
      scoreRate: detail.scoreRate,
      mistakes,
      items,
      mistakeCount: Math.max(
        mistakes.length,
        items.filter((item) => !item.isCorrect).length,
      ),
      reviewedAt: String(
        row?.reviewedAt ??
          row?.reviewed_at ??
          row?.createdAt ??
          row?.created_at ??
          "",
      ),
      assignmentId: String(
        row?.assignmentId ?? row?.assignment_id ?? row?.id ?? "",
      ),
      assignmentTitle: text(row?.assignmentTitle ?? row?.assignment_title),
      subject: text(row?.subject),
    };
  });

  const rates = reviewed.map((entry) => entry.scoreRate);
  let mistakeCount = 0;
  let masteredCount = 0;
  for (const entry of reviewed) {
    mistakeCount += entry.mistakeCount;
    masteredCount += entry.mistakes.filter((mistake) => mistake.mastery).length;
  }
  masteredCount = Math.min(masteredCount, mistakeCount);

  const subjectMap = new Map();
  for (const entry of reviewed) {
    const subject = entry.subject || "未标注学科";
    const group = subjectMap.get(subject) || {
      subject,
      rates: [],
      reviewedSubmissions: 0,
      mistakeCount: 0,
    };
    group.rates.push(entry.scoreRate);
    group.reviewedSubmissions += 1;
    group.mistakeCount += entry.mistakeCount;
    subjectMap.set(subject, group);
  }
  const subjects = [...subjectMap.values()]
    .map((group) => ({
      subject: group.subject,
      reviewedSubmissions: group.reviewedSubmissions,
      averageScoreRate: round(mean(group.rates)),
      mistakeCount: group.mistakeCount,
    }))
    .sort(
      (a, b) =>
        b.reviewedSubmissions - a.reviewedSubmissions ||
        a.subject.localeCompare(b.subject, "zh-CN"),
    );

  const byReviewedDesc = [...reviewed].sort((a, b) =>
    b.reviewedAt.localeCompare(a.reviewedAt),
  );
  const recent = byReviewedDesc.slice(0, 10).map((entry) => ({
    submissionId: String(entry.row?.id ?? entry.assignmentId),
    assignmentTitle: entry.assignmentTitle,
    subject: entry.subject,
    score: entry.score,
    totalScore: entry.totalScore,
    scoreRate: entry.scoreRate,
    reviewedAt: entry.reviewedAt,
  }));
  const trend = [...reviewed]
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
    .slice(-MAX_ARRAY)
    .map((entry) => ({
      submissionId: String(entry.row?.id ?? entry.assignmentId),
      title: entry.assignmentTitle,
      scoreRate: entry.scoreRate,
      reviewedAt: entry.reviewedAt,
    }));

  const knowledgeMap = new Map();
  for (const entry of reviewed) {
    for (const item of knowledgeEntries(entry.row)) {
      const title = item.title || "未标注知识点";
      const group = knowledgeMap.get(title) || {
        title,
        subject: entry.subject,
        mistakeCount: 0,
        numbers: new Set(),
      };
      group.mistakeCount += 1;
      if (item.number !== null) group.numbers.add(item.number);
      knowledgeMap.set(title, group);
    }
  }
  const knowledge = [...knowledgeMap.values()]
    .map((group) => ({
      title: group.title,
      subject: group.subject,
      mistakeCount: group.mistakeCount,
      questionNumbers: [...group.numbers].sort((a, b) => a - b),
    }))
    .sort(
      (a, b) =>
        b.mistakeCount - a.mistakeCount ||
        a.title.localeCompare(b.title, "zh-CN"),
    );

  const reasonMap = new Map();
  for (const entry of reviewed) {
    for (const item of reasonEntries(entry.row)) {
      const type = classifyReason(item.reason, {
        studentAnswer: item.studentAnswer,
      });
      reasonMap.set(type.label, (reasonMap.get(type.label) || 0) + 1);
    }
  }
  const reasons = shareRows(
    [...reasonMap.entries()].map(([label, count]) => ({ label, count })),
  );

  return {
    ...(student
      ? {
          student: {
            id: student.id,
            name: student.name,
            stage: student.stage,
            class_name: student.class_name,
          },
        }
      : {}),
    summary: {
      assignments: new Set(reviewed.map((entry) => entry.assignmentId)).size,
      reviewedSubmissions: reviewed.length,
      averageScoreRate: round(mean(rates)),
      mistakeCount,
      masteredCount,
      masteryRate: mistakeCount ? round(masteredCount / mistakeCount) : 0,
    },
    subjects,
    recent,
    knowledge,
    reasons,
    trend,
  };
}

function clippedText(value, length = 2000) {
  return typeof value === "string" ? value.trim().slice(0, length) : "";
}

function clippedArray(value) {
  return Array.isArray(value) ? value.slice(0, MAX_ARRAY) : [];
}

/** 白名单归一化 AI 学情分析：裁类型、裁长度、裁数量，缺字段给空值。 */
export function normalizeStudentInsight(raw) {
  let value = raw;
  if (typeof value === "string") value = safeParse(value, null);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("模型返回的学情分析格式无效，请重试");
  const strengths = clippedArray(value.strengths)
    .map((item) => clippedText(item))
    .filter(Boolean);
  const weaknesses = clippedArray(value.weaknesses)
    .map((item) => ({
      knowledge: clippedText(item?.knowledge),
      evidence: clippedText(item?.evidence),
      suggestion: clippedText(item?.suggestion),
    }))
    .filter((item) => item.knowledge || item.evidence || item.suggestion);
  const subjectAnalysis = clippedArray(value.subjectAnalysis)
    .map((item) => {
      const level = clippedText(item?.level, 20);
      return {
        subject: clippedText(item?.subject),
        level: ["优势", "稳定", "薄弱"].includes(level) ? level : "稳定",
        detail: clippedText(item?.detail),
      };
    })
    .filter((item) => item.subject || item.detail);
  const studyHabits = clippedArray(value.studyHabits)
    .map((item) => clippedText(item))
    .filter(Boolean);
  const homeActions = clippedArray(value.homeActions)
    .map((item) => ({
      action: clippedText(item?.action),
      how: clippedText(item?.how),
      frequency: clippedText(item?.frequency),
    }))
    .filter((item) => item.action || item.how || item.frequency);
  return {
    summary: clippedText(value.summary, INSIGHT_FIELDS.summary),
    strengths,
    weaknesses,
    subjectAnalysis,
    studyHabits,
    homeActions,
    encouragement: clippedText(
      value.encouragement,
      INSIGHT_FIELDS.encouragement,
    ),
  };
}

function boundStudent(db, parent, studentId) {
  if (!parent || parent.role !== "parent") return null;
  return (
    db
      .prepare(
        "SELECT u.id,u.name,u.stage,u.class_name,u.school_id FROM parent_students ps JOIN users u ON u.id=ps.student_id WHERE ps.parent_id=? AND ps.student_id=? AND ps.school_id=? AND u.school_id=? AND u.role='student'",
      )
      .get(
        parent.id,
        String(studentId || ""),
        parent.school_id,
        parent.school_id,
      ) || null
  );
}

async function verifyChildPassword(ctx, password, student) {
  try {
    const normalizer =
      ctx.pass ||
      ((value, salt) => scryptSync(value, salt, 64).toString("hex"));
    const provided = Buffer.from(
      await normalizer(password, student.salt),
      "hex",
    );
    const expected = Buffer.from(String(student.password_hash || ""), "hex");
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  } catch {
    return false;
  }
}

function loadReviewedRows(ctx, studentId, schoolId, limit = REVIEW_WINDOW) {
  const db = ctx.db;
  const rows = db
    .prepare(
      `SELECT s.id,s.assignment_id,s.score,s.analysis_json,s.questions_json,s.created_at,
              a.title assignment_title,a.subject,
              (SELECT COALESCE(SUM(q.score),0) FROM questions q WHERE q.assignment_id=a.id) questions_total
       FROM submissions s JOIN assignments a ON a.id=s.assignment_id
       WHERE s.student_id=? AND a.school_id=? AND s.teacher_reviewed=1
       ORDER BY s.created_at DESC,s.rowid DESC LIMIT ?`,
    )
    .all(studentId, schoolId, limit);
  const mistakeStatement = db.prepare(
    "SELECT m.*,k.title knowledge_title FROM mistakes m LEFT JOIN knowledge k ON k.id=m.knowledge_id WHERE m.submission_id=? ORDER BY COALESCE(m.question_number,9999),m.created_at",
  );
  return rows.map((row) => {
    const analysis = parseJson(ctx, row.analysis_json, {}) || {};
    return {
      id: row.id,
      assignmentId: row.assignment_id,
      assignmentTitle: row.assignment_title,
      subject: row.subject,
      reviewedAt: row.created_at,
      score: row.score,
      analysis,
      questionsTotal: row.questions_total,
      questionsJson: row.questions_json,
      items: Array.isArray(analysis.items) ? analysis.items : [],
      mistakes: mistakeStatement.all(row.id).map((mistake) => ({
        number: mistake.question_number,
        knowledgeTitle: mistake.knowledge_title || "",
        reason: mistake.reason || "",
        studentAnswer: mistake.student_answer || "",
        mastery: mistake.mastery,
      })),
    };
  });
}

function itemOf(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function detailItemOf({ item, index, question, direct, mistake }) {
  const entry = itemOf(item) || {};
  const number =
    finiteNumber(entry.number) ??
    finiteNumber(question?.number) ??
    finiteNumber(direct?.number) ??
    finiteNumber(mistake?.question_number) ??
    index + 1;
  const maxScore =
    finiteNumber(entry.maxScore) ??
    finiteNumber(question?.score) ??
    finiteNumber(direct?.score) ??
    finiteNumber(mistake?.question_score);
  const isCorrect =
    typeof entry.isCorrect === "boolean"
      ? entry.isCorrect
      : mistake
        ? false
        : maxScore !== null && maxScore > 0
          ? finiteNumber(entry.score) === maxScore
          : false;
  const score = finiteNumber(entry.score) ?? (isCorrect ? (maxScore ?? 0) : 0);
  return {
    number,
    prompt:
      text(entry.prompt) ||
      text(direct?.prompt) ||
      text(question?.prompt) ||
      text(mistake?.prompt),
    studentAnswer:
      text(entry.studentAnswer ?? entry.student_answer) ||
      text(mistake?.student_answer),
    isCorrect,
    score,
    maxScore: maxScore ?? null,
    correction: text(entry.correction) || text(mistake?.correction),
    standardAnswer:
      text(
        entry.standardAnswer ?? entry.standard_answer ?? entry.referenceAnswer,
      ) ||
      text(
        direct?.standardAnswer ??
          direct?.standard_answer ??
          direct?.referenceAnswer,
      ) ||
      text(question?.standard_answer) ||
      text(mistake?.standard_answer),
    reasoning: text(entry.reasoning) || text(mistake?.reasoning),
    explanation: text(entry.explanation) || text(mistake?.explanation),
    reason: text(entry.reason) || text(mistake?.reason),
  };
}

function buildSubmissionDetail(ctx, student, submissionId) {
  const db = ctx.db;
  const row = db
    .prepare(
      `SELECT s.*,a.title assignment_title,a.subject
       FROM submissions s JOIN assignments a ON a.id=s.assignment_id
       WHERE s.id=? AND s.student_id=? AND a.school_id=? AND s.teacher_reviewed=1`,
    )
    .get(String(submissionId || ""), student.id, student.school_id);
  if (!row) return null;
  const questions = db
    .prepare(
      "SELECT q.id,q.number,q.prompt,q.standard_answer,q.score,q.knowledge_id,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE q.assignment_id=? ORDER BY q.number",
    )
    .all(row.assignment_id);
  const mistakes = db
    .prepare(
      "SELECT m.*,k.title knowledge_title FROM mistakes m LEFT JOIN knowledge k ON k.id=m.knowledge_id WHERE m.submission_id=? ORDER BY COALESCE(m.question_number,9999),m.created_at",
    )
    .all(row.id);
  const analysis = parseJson(ctx, row.analysis_json, {}) || {};
  const analysisItems = Array.isArray(analysis.items) ? analysis.items : [];
  const analysisQuestions = Array.isArray(analysis.questions)
    ? analysis.questions
    : [];
  const questionById = new Map(
    questions.map((question) => [String(question.id), question]),
  );
  const questionByNumber = new Map(
    questions.map((question) => [Number(question.number), question]),
  );
  const directById = new Map();
  const directByNumber = new Map();
  for (const question of analysisQuestions) {
    const key = String(question?.id ?? question?.questionId ?? "");
    if (key) directById.set(key, question);
    const number = Number(question?.number);
    if (Number.isFinite(number)) directByNumber.set(number, question);
  }
  const mistakeById = new Map();
  const mistakeByNumber = new Map();
  for (const mistake of mistakes) {
    if (mistake.question_id)
      mistakeById.set(String(mistake.question_id), mistake);
    const number = Number(mistake.question_number);
    if (Number.isFinite(number)) mistakeByNumber.set(number, mistake);
  }
  const detail = resolveScore({
    score: row.score,
    analysis,
    questionsTotal: questions.reduce(
      (sum, question) => sum + (Number(question.score) || 0),
      0,
    ),
    questionsJson: row.questions_json,
  });
  const build = (item, index) => {
    const entry = itemOf(item) || {};
    const questionId = String(entry.questionId ?? entry.question_id ?? "");
    const direct =
      directById.get(questionId) ||
      directByNumber.get(Number(entry.number)) ||
      undefined;
    const number = finiteNumber(entry.number) ?? finiteNumber(direct?.number);
    const question =
      questionById.get(questionId) ||
      (number !== null ? questionByNumber.get(number) : undefined);
    const mistake =
      mistakeById.get(questionId) ||
      (number !== null ? mistakeByNumber.get(number) : undefined);
    return detailItemOf({ item, index, question, direct, mistake });
  };
  const items = (
    analysisItems.length
      ? analysisItems.map(build)
      : mistakes.map((mistake, index) =>
          detailItemOf({
            item: { questionId: mistake.question_id, isCorrect: false },
            index,
            question:
              questionById.get(String(mistake.question_id || "")) ||
              questionByNumber.get(Number(mistake.question_number)),
            direct:
              directById.get(String(mistake.question_id || "")) ||
              directByNumber.get(Number(mistake.question_number)),
            mistake,
          }),
        )
  ).sort((a, b) => a.number - b.number);
  return {
    id: row.id,
    title: row.assignment_title,
    subject: row.subject,
    reviewedAt: row.created_at,
    score: detail.score,
    totalScore: detail.totalScore,
    items,
  };
}

function modelNameOf(ctx, user) {
  try {
    const route =
      typeof ctx.resolveModelRoute === "function"
        ? ctx.resolveModelRoute(user)
        : null;
    const candidates = [
      route?.model,
      route?.modelName,
      route?.config?.model,
      route?.owner?.model,
    ];
    const found = candidates.find(
      (value) => typeof value === "string" && value.trim(),
    );
    return found ? found.trim().slice(0, 200) : "";
  } catch {
    return "";
  }
}

function insightPrompt(student, dashboard) {
  const summary = dashboard.summary;
  const subjectLines =
    dashboard.subjects
      .map(
        (subject) =>
          `- ${subject.subject}：已复核 ${subject.reviewedSubmissions} 份，平均得分率 ${percent(subject.averageScoreRate)}，错题 ${subject.mistakeCount} 道`,
      )
      .join("\n") || "- 暂无";
  const knowledgeLines =
    dashboard.knowledge
      .slice(0, 8)
      .map(
        (point) =>
          `- ${point.title}：错题 ${point.mistakeCount} 道（题号 ${point.questionNumbers.join("、") || "未知"}）`,
      )
      .join("\n") || "- 暂无";
  const reasonLines =
    dashboard.reasons
      .map(
        (reason) => `- ${reason.label}：${reason.count} 道（${reason.share}%）`,
      )
      .join("\n") || "- 暂无";
  const recentLines =
    dashboard.recent
      .slice(0, 6)
      .map(
        (item) =>
          `- ${item.assignmentTitle || "未命名作业"}（${item.subject || "未标注学科"}）：得分率 ${percent(item.scoreRate)}`,
      )
      .join("\n") || "- 暂无";
  return `你是一名经验丰富的班主任，正在向家长说明孩子近期的学习情况。下面的统计数字已经由系统算好，禁止修改、禁止编造任何数字。

学生：${student.name}（${student.stage || "学段未标注"} · ${student.class_name || "班级未标注"}）
统计范围：最近 ${summary.reviewedSubmissions} 份已复核作业（共 ${summary.assignments} 份作业）

【确定性统计】
- 已复核作业：${summary.reviewedSubmissions} 份
- 平均得分率：${percent(summary.averageScoreRate)}
- 错题数：${summary.mistakeCount} 道
- 已掌握错题：${summary.masteredCount} 道（掌握率 ${percent(summary.masteryRate)}）

【学科表现】
${subjectLines}

【薄弱知识点】
${knowledgeLines}

【错因分布】
${reasonLines}

【近期成绩】
${recentLines}

请输出一个 JSON 对象（不要输出 JSON 之外的任何内容），字段必须完整：
{"summary":"总体学情（150 字以内）","strengths":["优势，2-4 条"],"weaknesses":[{"knowledge":"知识点","evidence":"依据（题号/次数/得分率）","suggestion":"具体建议"}],"subjectAnalysis":[{"subject":"学科","level":"优势/稳定/薄弱","detail":"说明"}],"studyHabits":["学习习惯观察"],"homeActions":[{"action":"家长在家可以做的事","how":"怎么做","frequency":"频率"}],"encouragement":"给孩子的一句话"}

要求：只引用上面统计里出现的数字；语气对家长友好、具体、可执行；不要编造学生没有的表现。`;
}

export function registerParentRoutes(app, ctx) {
  const db = ctx.db;
  const { auth } = ctx;
  const parentOnly = (req, res, next) =>
    req.user?.role === "parent"
      ? next()
      : res.status(403).json({ error: "仅家长账户可访问" });
  const modelErrorStatus =
    typeof ctx.modelErrorStatus === "function"
      ? ctx.modelErrorStatus
      : (error) => (error?.status === 429 ? 429 : 502);

  app.get("/api/parent/children", auth, parentOnly, (req, res) => {
    res.json(
      db
        .prepare(
          "SELECT u.id,u.name,u.stage,u.class_name,ps.relation,s.name school_name FROM parent_students ps JOIN users u ON u.id=ps.student_id JOIN schools s ON s.id=u.school_id WHERE ps.parent_id=? AND ps.school_id=? AND u.school_id=? ORDER BY u.name",
        )
        .all(req.user.id, req.user.school_id, req.user.school_id),
    );
  });

  // 已绑定家长用孩子账号 + 密码追加绑定；账号或密码错误统一文案。
  app.post("/api/parent/children/bind", auth, parentOnly, async (req, res) => {
    const body = req.body || {};
    const childUsername = text(body.childUsername ?? body.child_username);
    const childPassword = body.childPassword ?? body.child_password;
    if (!childUsername || typeof childPassword !== "string" || !childPassword)
      return res.status(400).json({ error: "孩子账号或密码错误" });
    const compact = childUsername.replace(/\s+/g, "").toLowerCase();
    const student =
      db
        .prepare(
          "SELECT * FROM users WHERE school_id=? AND role='student' AND username=?",
        )
        .get(req.user.school_id, compact) ||
      db
        .prepare(
          "SELECT * FROM users WHERE school_id=? AND role='student' AND email=?",
        )
        .get(req.user.school_id, childUsername.toLowerCase());
    if (!student || !(await verifyChildPassword(ctx, childPassword, student)))
      return res.status(400).json({ error: "孩子账号或密码错误" });
    const existing = db
      .prepare(
        "SELECT * FROM parent_students WHERE parent_id=? AND student_id=?",
      )
      .get(req.user.id, student.id);
    if (existing)
      return res.json({
        ok: true,
        studentName: student.name,
        alreadyBound: true,
      });
    db.prepare(
      "INSERT INTO parent_students(id,parent_id,student_id,school_id,relation,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      newId(ctx),
      req.user.id,
      student.id,
      req.user.school_id,
      relationOf(body.relation),
      nowIso(ctx),
    );
    res.json({ ok: true, studentName: student.name, id: student.id });
  });

  app.get(
    "/api/parent/children/:studentId/dashboard",
    auth,
    parentOnly,
    (req, res) => {
      const student = boundStudent(db, req.user, req.params.studentId);
      if (!student)
        return res.status(404).json({ error: "孩子不存在或未绑定" });
      const rows = loadReviewedRows(ctx, student.id, student.school_id);
      res.json(buildParentDashboard(rows, student));
    },
  );

  app.get(
    "/api/parent/children/:studentId/submissions/:submissionId",
    auth,
    parentOnly,
    (req, res) => {
      const student = boundStudent(db, req.user, req.params.studentId);
      if (!student)
        return res.status(404).json({ error: "孩子不存在或未绑定" });
      const detail = buildSubmissionDetail(
        ctx,
        student,
        req.params.submissionId,
      );
      if (!detail)
        return res.status(404).json({ error: "答卷不存在或尚未复核" });
      res.json(detail);
    },
  );

  app.get(
    "/api/parent/children/:studentId/insights",
    auth,
    parentOnly,
    (req, res) => {
      const student = boundStudent(db, req.user, req.params.studentId);
      if (!student)
        return res.status(404).json({ error: "孩子不存在或未绑定" });
      const row = db
        .prepare(
          "SELECT id,model,created_at,payload_json FROM student_insights WHERE student_id=? AND school_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(student.id, student.school_id);
      if (!row) return res.json(null);
      res.json({
        id: row.id,
        model: row.model,
        created_at: row.created_at,
        content: parseJson(ctx, row.payload_json, {}),
      });
    },
  );

  app.post(
    "/api/parent/children/:studentId/insights/analyze",
    auth,
    parentOnly,
    async (req, res) => {
      const student = boundStudent(db, req.user, req.params.studentId);
      if (!student)
        return res.status(404).json({ error: "孩子不存在或未绑定" });
      const rows = loadReviewedRows(ctx, student.id, student.school_id, 10);
      if (!rows.length)
        return res
          .status(400)
          .json({ error: "孩子还没有已复核的作业，暂不能生成学情分析" });
      const latest = db
        .prepare(
          "SELECT created_at FROM student_insights WHERE student_id=? AND school_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(student.id, student.school_id);
      if (latest) {
        const elapsed = Date.now() - Date.parse(latest.created_at);
        if (Number.isFinite(elapsed) && elapsed < INSIGHT_TTL_MS) {
          const retryAfter = Math.ceil((INSIGHT_TTL_MS - elapsed) / 1000);
          res.setHeader("Retry-After", String(retryAfter));
          return res.status(429).json({
            error: `学情分析生成过于频繁，请 ${retryAfter} 秒后再试`,
          });
        }
      }
      const dashboard = buildParentDashboard(rows, student);
      try {
        const raw = await ctx.callModel(
          req.user,
          insightPrompt(student, dashboard),
        );
        const content = normalizeStudentInsight(raw);
        const insight = {
          id: newId(ctx),
          model: modelNameOf(ctx, req.user),
          created_at: nowIso(ctx),
          content,
        };
        db.prepare(
          "INSERT INTO student_insights(id,student_id,school_id,created_by,model,payload_json,stats_json,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          insight.id,
          student.id,
          student.school_id,
          req.user.id,
          insight.model,
          JSON.stringify(content),
          JSON.stringify(dashboard),
          insight.created_at,
        );
        res.json({ insight, stats: dashboard });
      } catch (error) {
        res.status(modelErrorStatus(error)).json({
          error: String(error?.message || "生成学情分析失败"),
        });
      }
    },
  );
}
