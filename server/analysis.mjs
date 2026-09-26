// 作业分析引擎：把教师复核后的错题数据，换算成可讲评、可跟进、可统计的学情结论。
// 这一层完全基于已复核数据做确定性统计，AI 只负责把结论转写成课堂语言，
// 因此即使模型不可用，教学分析面板的核心数字依然可信。

export const reasonTypes = [
  {
    id: "unreadable",
    label: "无法辨认",
    short: "卷面/扫描不可辨",
    color: "#8b93a3",
    hint: "图片模糊或该题不在上传页内，不能据此判定学生掌握情况。",
    keywords: [
      "无法辨认",
      "未能辨认",
      "辨认不出",
      "不可辨认",
      "字迹不清",
      "模糊",
      "未在提供的答卷",
      "未呈现",
      "不在提供的",
      "暂不能判定",
      "无法识别",
      "识别不清",
    ],
  },
  {
    id: "blank",
    label: "未作答",
    short: "空题、漏题",
    color: "#5b7fb8",
    hint: "空题不等于不会，先分清是时间不够、漏看题号还是真的不会。",
    keywords: ["未作答", "未填写", "未提供", "空白", "没有作答", "漏做", "未答"],
  },
  {
    id: "careless",
    label: "计算粗心",
    short: "会做但算错",
    color: "#d99a52",
    hint: "改流程不改知识：草稿规范、结果回代、单位与量级自检。",
    keywords: [
      "粗心",
      "算错",
      "计算错误",
      "计算失误",
      "笔误",
      "抄错",
      "看错数字",
      "计算过程有误",
      "运算有误",
      "算成了",
    ],
  },
  {
    id: "reading",
    label: "审题偏差",
    short: "没看清条件",
    color: "#4b8bd6",
    hint: "训练读题动作：圈条件、标单位、把问句改写成一句自己的话。",
    keywords: [
      "审题",
      "没有看清",
      "未看清",
      "看错题",
      "误读",
      "漏看",
      "忽略了条件",
      "忽视条件",
      "未注意",
      "没有注意",
      "理解题意",
      "读题",
    ],
  },
  {
    id: "concept",
    label: "概念混淆",
    short: "概念、规律记混",
    color: "#8d7ad1",
    hint: "用对比表把易混概念并排呈现，让学生说出区别而不是背定义。",
    keywords: [
      "概念",
      "混淆",
      "混为",
      "记混",
      "分不清",
      "判断错误",
      "误认为",
      "误以为",
      "理解错误",
      "理解偏差",
      "不理解",
      "没有理解",
      "错误地认为",
      "错把",
    ],
  },
  {
    id: "formula",
    label: "公式记忆不牢",
    short: "公式、定理记错",
    color: "#c96f86",
    hint: "公式不是背下来的，让学生会推一遍再记，并写清适用条件。",
    keywords: [
      "公式",
      "定理",
      "定律",
      "法则",
      "定义式",
      "单位换算出错",
      "记忆不牢",
      "记错",
      "用错公式",
      "套错公式",
      "公式用错",
    ],
  },
  {
    id: "steps",
    label: "步骤缺失",
    short: "跳步、丢过程",
    color: "#5aa38c",
    hint: "给分点前置：先写公式、再代入、后结论，按步骤自评分。",
    keywords: [
      "步骤",
      "跳步",
      "过程不完整",
      "缺少过程",
      "未写过程",
      "没有写出",
      "缺少必要的",
      "不完整",
      "未说明理由",
      "缺少说明",
      "未体现",
      "推导",
    ],
  },
  {
    id: "condition",
    label: "条件遗漏",
    short: "忽略范围、前提",
    color: "#c2903f",
    hint: "把适用条件写进解题模板，形成“先判条件再动手”的固定动作。",
    keywords: [
      "定义域",
      "取值范围",
      "边界条件",
      "前提条件",
      "适用条件",
      "范围",
      "遗漏了",
      "忽略了",
      "未考虑",
      "没有考虑",
      "漏考虑",
    ],
  },
  {
    id: "method",
    label: "方法选择不当",
    short: "思路偏、方法远",
    color: "#6b7f9b",
    hint: "同题多解对比，让学生比较哪种方法更快、更不容易错。",
    keywords: [
      "方法",
      "思路",
      "解法",
      "模型",
      "策略",
      "选择不当",
      "方向错误",
      "思路错误",
      "想复杂",
      "绕远",
    ],
  },
  {
    id: "expression",
    label: "表达不规范",
    short: "表述、格式扣分",
    color: "#9aa35a",
    hint: "给规范答案做样板，让学生对照自批并圈出自查点。",
    keywords: [
      "不规范",
      "格式",
      "表述",
      "书写",
      "未化简",
      "未约分",
      "未写单位",
      "漏写单位",
      "单位错",
      "没有作答完整",
      "答题不完整",
      "作图不规范",
      "未标注",
    ],
  },
  {
    id: "guess",
    label: "作答随意",
    short: "蒙猜、凭感觉",
    color: "#a4917a",
    hint: "先要求说出理由再给分，用“为什么”追问打断蒙猜习惯。",
    keywords: ["蒙", "猜的", "凭感觉", "乱选", "随便"],
  },
  {
    id: "other",
    label: "其他",
    short: "需要教师人工归类",
    color: "#b6bec9",
    hint: "这类错因建议教师复核时手动改写，便于后续统计。",
    keywords: [],
  },
];

const reasonTypeById = new Map(reasonTypes.map((item) => [item.id, item]));

export function reasonType(id) {
  return reasonTypeById.get(id) || reasonTypeById.get("other");
}

// 归因优先级：先排除“不是学生问题”的情况，再按最具体的错因归类。
const classifyOrder = [
  "unreadable",
  "blank",
  "careless",
  "reading",
  "concept",
  "formula",
  "condition",
  "steps",
  "expression",
  "method",
  "guess",
];

const blankAnswerPattern = /^(未作答|未填写|未提供|未答|空白|无|没有作答|没写|—|-|\/|n\/a)$/i;

export function isBlankAnswer(answer) {
  const text = String(answer || "").trim();
  return !text || blankAnswerPattern.test(text);
}

export function classifyReason(reason, { studentAnswer = "" } = {}) {
  const text = String(reason || "").trim();
  const rawAnswer = String(studentAnswer ?? "").trim();
  if (!text) {
    // 复核时没写错因：只能靠学生答案判断是空题还是无法辨认，其余交回教师归类。
    if (rawAnswer && isBlankAnswer(rawAnswer)) return reasonType("blank");
    if (/无法辨认|辨认不清|模糊|看不清/.test(rawAnswer))
      return reasonType("unreadable");
    return reasonType("other");
  }
  for (const id of classifyOrder) {
    const type = reasonTypeById.get(id);
    if (type.keywords.some((keyword) => text.includes(keyword))) return type;
  }
  // 错因文本没写清时：只有确实看到学生留空才归为空题，否则保留“其他”。
  if (rawAnswer && isBlankAnswer(rawAnswer)) return reasonType("blank");
  return reasonType("other");
}

const number = (value) => Number(value) || 0;
const rate = (part, total) => (total > 0 ? part / total : 0);

// 同一个错因的稳定优先级：并列时按归因体系顺序取更“前置”的错因，避免结果随行序浮动。
const reasonPriority = new Map(
  ["unreadable", ...classifyOrder, "other"].map((id, index) => [id, index]),
);

/**
 * 把错题按“题号”严格划分错因：一道题上的错题只归入条数最多的那个错因，
 * 并列时按归因体系顺序决定，保证同一份数据永远得到同一份统计。
 */
function partitionByQuestion(rows) {
  const byQuestion = new Map();
  for (const row of rows) {
    const entry = byQuestion.get(row.number) || { total: 0, ranked: [] };
    entry.total += 1;
    const existing = entry.ranked.find((candidate) => candidate.id === row.type.id);
    if (existing) existing.count += 1;
    else entry.ranked.push({ id: row.type.id, count: 1 });
    byQuestion.set(row.number, entry);
  }
  for (const entry of byQuestion.values()) {
    entry.ranked.sort(
      (a, b) =>
        b.count - a.count ||
        (reasonPriority.get(a.id) ?? 99) - (reasonPriority.get(b.id) ?? 99),
    );
    entry.reasonId = entry.ranked[0].id;
  }
  return byQuestion;
}

function withQuestionMeta(byQuestion, rows) {
  const promptByNumber = new Map();
  for (const row of rows)
    if (!promptByNumber.has(row.number))
      promptByNumber.set(row.number, truncate(row.prompt, 80));
  return new Map(
    [...byQuestion].map(([number, entry]) => [
      number,
      { ...entry, prompt: promptByNumber.get(number) || "" },
    ]),
  );
}

/**
 * 汇总错因分布。rows 里每项形如 { number, type, reason, prompt, studentName }，
 * 且只包含教师已复核的错题；type.id 为 "unreadable" 的记录单列，不参与错因占比。
 */
function partitionReasonItems(rows) {
  const answerableRows = rows.filter((row) => row.type.id !== "unreadable");
  const unreadableCount = rows.length - answerableRows.length;
  const denominator = rows.length || 1;
  const byQuestion = partitionByQuestion(answerableRows);
  const metaById = new Map();
  for (const row of answerableRows)
    if (!metaById.has(row.type.id)) metaById.set(row.type.id, row.type);
  const countByReason = new Map();
  const questionsByReason = new Map();
  for (const [number, entry] of byQuestion) {
    countByReason.set(
      entry.reasonId,
      (countByReason.get(entry.reasonId) || 0) + entry.total,
    );
    const list = questionsByReason.get(entry.reasonId) || [];
    list.push({ number, count: entry.total, prompt: entry.prompt });
    questionsByReason.set(entry.reasonId, list);
  }
  const distribution = [...countByReason.entries()]
    .map(([id, count]) => {
      const meta = metaById.get(id) || reasonType(id);
      return {
        id,
        label: meta.label,
        short: meta.short,
        color: meta.color,
        hint: meta.hint,
        count,
        ratio: rate(count, denominator),
        samples: [
          ...new Set(
            answerableRows
              .filter((row) => row.type.id === id && row.reason)
              .map((row) => truncate(row.reason, 130)),
          ),
        ].slice(0, 3),
        questions: (questionsByReason.get(id) || []).sort(
          (a, b) => b.count - a.count || a.number - b.number,
        ),
      };
    })
    .sort((a, b) => b.count - a.count);
  if (unreadableCount > 0) {
    const meta = reasonType("unreadable");
    distribution.push({
      id: "unreadable",
      label: meta.label,
      short: meta.short,
      color: meta.color,
      hint: meta.hint,
      count: unreadableCount,
      ratio: rate(unreadableCount, denominator),
      samples: [],
      questions: [],
    });
  }
  return distribution;
}

/**
 * 归因润色：模型可以对具体题号给出比关键词更准确的错因，但错题总量保持不变。
 * 约定：错因统计按“题号”归属，因此每道错题只会被计入一个错因。
 * 模型明确指出的题号以模型为准，其余题号沿用关键词归因。
 */
export function mergeReasonTypes(items, aiReasonTypes) {
  if (!Array.isArray(aiReasonTypes) || !aiReasonTypes.length) return items;
  const denominator =
    items.reduce((sum, item) => sum + item.count, 0) || 1;
  // 依据现有分布还原“每道题的错题数与原始归因”
  const byQuestion = new Map();
  for (const item of items) {
    for (const question of item.questions || []) {
      const entry = byQuestion.get(question.number) || { total: 0, ranked: [] };
      entry.total += question.count;
      const existing = entry.ranked.find((candidate) => candidate.id === item.id);
      if (existing) existing.count += question.count;
      else entry.ranked.push({ id: item.id, count: question.count });
      byQuestion.set(question.number, entry);
    }
  }
  for (const entry of byQuestion.values()) {
    entry.ranked.sort(
      (a, b) =>
        b.count - a.count ||
        (reasonPriority.get(a.id) ?? 99) - (reasonPriority.get(b.id) ?? 99),
    );
    entry.reasonId = entry.ranked[0].id;
  }
  const aiByQuestion = new Map();
  for (const ai of aiReasonTypes) {
    const id = reasonTypeById.has(ai?.id) ? ai.id : null;
    if (!id || id === "unreadable") continue;
    const numbers = Array.isArray(ai.questionNumbers)
      ? ai.questionNumbers.map(Number).filter(Number.isFinite)
      : [];
    for (const number of numbers)
      if (byQuestion.has(number)) aiByQuestion.set(number, id);
  }
  const countByReason = new Map();
  const questionsByReason = new Map();
  for (const [number, entry] of byQuestion) {
    const id = aiByQuestion.get(number) || entry.reasonId;
    countByReason.set(id, (countByReason.get(id) || 0) + entry.total);
    const list = questionsByReason.get(id) || [];
    list.push({ number, count: entry.total, prompt: "" });
    questionsByReason.set(id, list);
  }
  const promptByNumber = new Map();
  for (const item of items)
    for (const question of item.questions || [])
      if (!promptByNumber.has(question.number))
        promptByNumber.set(question.number, question.prompt || "");
  const build = (id, base = {}) => {
    const type = reasonType(id);
    const count = countByReason.get(id) || 0;
    return {
      ...base,
      ...type,
      id,
      count,
      questions: (questionsByReason.get(id) || [])
        .map((question) => ({
          ...question,
          prompt: promptByNumber.get(question.number) || question.prompt || "",
        }))
        .sort((a, b) => b.count - a.count || a.number - b.number),
      ratio: rate(count, denominator),
    };
  };
  // 原有错因（可能被清空，保留 0 值便于前端显示“已改判”）+ 模型新引入的错因
  const merged = items
    .filter((item) => item.id !== "unreadable")
    .map((item) => build(item.id, item));
  for (const id of countByReason.keys())
    if (!merged.some((item) => item.id === id)) merged.push(build(id));
  // “无法辨认”不是错因，原样保留，只按新的分母更新占比
  const unreadable = items.find((item) => item.id === "unreadable");
  if (unreadable)
    merged.push({
      ...unreadable,
      ratio: rate(unreadable.count, denominator),
    });
  return merged.sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[index];
}

function truncate(value, length = 160) {
  const text = String(value || "").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function questionKey(row) {
  return row.question_id || `q${row.number}`;
}

/**
 * 拉取一份作业下全部已复核的错题明细（含题干、知识点、学生答案）。
 * 调用方必须传入 teacherId 或 schoolId，保证数据按身份隔离。
 */
export function loadAssignmentData(db, { teacherId, schoolId, assignmentId }) {
  const scoped = teacherId
    ? "a.teacher_id=?"
    : "a.school_id=?";
  const assignment = db
    .prepare(
      `SELECT a.*,u.name teacher_name FROM assignments a LEFT JOIN users u ON u.id=a.teacher_id WHERE a.id=? AND ${scoped}`,
    )
    .get(assignmentId, teacherId || schoolId);
  if (!assignment) return null;
  const questions = db
    .prepare(
      "SELECT q.*,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE q.assignment_id=? ORDER BY q.number",
    )
    .all(assignment.id);
  const submissions = db
    .prepare(
      "SELECT id,student_id,student_name,status,teacher_reviewed,score,created_at FROM submissions WHERE assignment_id=? ORDER BY created_at",
    )
    .all(assignment.id);
  const reviewed = submissions.filter((item) => item.teacher_reviewed);
  const mistakes = db
    .prepare(
      `SELECT m.*,s.student_name,q.number,q.prompt,q.standard_answer,q.score question_score,k.title knowledge_title
       FROM mistakes m
       JOIN submissions s ON s.id=m.submission_id
       JOIN questions q ON q.id=m.question_id
       LEFT JOIN knowledge k ON k.id=m.knowledge_id
       WHERE s.assignment_id=?
       ORDER BY q.number, s.created_at, s.id`,
    )
    .all(assignment.id);
  return { assignment, questions, submissions, reviewed, mistakes };
}

export function buildAssignmentStats({ assignment, questions, submissions, reviewed, mistakes }) {
  const reviewedIds = new Set(reviewed.map((item) => item.id));
  // 只有教师确认过的错题才进入统计口径；未复核的行留作“待复核”计数。
  const reviewedMistakes = mistakes.filter(
    (item) =>
      reviewedIds.has(item.submission_id) && item.teacher_reviewed !== 0,
  );
  const pendingMistakes = mistakes.length - reviewedMistakes.length;
  const submissionCount = reviewed.length;
  const totalScore = questions.reduce(
    (sum, question) => sum + number(question.score),
    0,
  );
  const earnedByStudent = new Map();
  for (const submission of reviewed) {
    const lost = reviewedMistakes
      .filter((item) => item.submission_id === submission.id)
      .reduce((sum, item) => sum + number(item.question_score), 0);
    const earned =
      submission.score === null || submission.score === undefined
        ? Math.max(0, totalScore - lost)
        : number(submission.score);
    earnedByStudent.set(submission.id, {
      studentId: submission.student_id,
      name: submission.student_name,
      earned: Math.max(0, Math.min(earned, totalScore || earned)),
    });
  }
  const earnedList = [...earnedByStudent.values()];
  const scoreRates = earnedList.map((item) =>
    rate(item.earned, totalScore || 1),
  );
  const scoreDenominator = submissionCount * totalScore;

  const knowledgeMap = new Map();
  const reasonRows = [];
  const questionMap = new Map();
  const studentMap = new Map();

  for (const row of reviewedMistakes) {
    const knowledgeKey = row.knowledge_id || "pending";
    const type = classifyReason(row.reason, {
      studentAnswer: row.student_answer,
    });
    // 无法辨认的题同样入列（用于计数与提醒），但不参与错因占比
    reasonRows.push({
      number: row.number,
      type,
      reason: row.reason,
      prompt: row.prompt,
      studentName: row.student_name,
    });
    const knowledgeEntry = knowledgeMap.get(knowledgeKey) || {
      id: knowledgeKey,
      title: row.knowledge_title || "待补充知识点",
      questionNumbers: [],
      errorCount: 0,
      students: new Set(),
    };
    if (!knowledgeEntry.questionNumbers.includes(row.number))
      knowledgeEntry.questionNumbers.push(row.number);
    knowledgeEntry.errorCount += 1;
    if (row.student_name) knowledgeEntry.students.add(row.student_name);
    knowledgeMap.set(knowledgeKey, knowledgeEntry);

    const qKey = questionKey(row);
    const questionEntry = questionMap.get(qKey) || {
      id: qKey,
      number: row.number,
      prompt: row.prompt,
      standardAnswer: row.standard_answer,
      knowledgeId: row.knowledge_id || "",
      knowledgeTitle: row.knowledge_title || "待补充知识点",
      score: number(row.question_score),
      wrongCount: 0,
      students: [],
      reasons: [],
      corrections: [],
      explanations: [],
      practice: [],
    };
    questionEntry.wrongCount += 1;
    if (row.student_name) {
      questionEntry.studentCounts = questionEntry.studentCounts || {};
      questionEntry.studentCounts[row.student_name] =
        (questionEntry.studentCounts[row.student_name] || 0) + 1;
      if (!questionEntry.students.includes(row.student_name))
        questionEntry.students.push(row.student_name);
    }
    if (row.reason) questionEntry.reasons.push(truncate(row.reason, 200));
    if (row.correction)
      questionEntry.corrections.push(truncate(row.correction, 200));
    if (row.explanation)
      questionEntry.explanations.push(truncate(row.explanation, 400));
    const practice = row.practice_json ? safeParse(row.practice_json, []) : [];
    for (const item of Array.isArray(practice) ? practice : []) {
      if (item?.prompt && questionEntry.practice.length < 2)
        questionEntry.practice.push({
          prompt: String(item.prompt),
          answer: String(item.answer || ""),
          explanation: String(item.explanation || ""),
        });
    }
    questionMap.set(qKey, questionEntry);

    if (row.student_name) {
      const studentKey = row.student_id || `name:${row.student_name}`;
      const studentEntry = studentMap.get(studentKey) || {
        studentId: row.student_id || "",
        name: row.student_name,
        mistakeCount: 0,
        questionNumbers: [],
        knowledgeIds: [],
        reasons: [],
        missingWork: 0,
      };
      studentEntry.mistakeCount += 1;
      if (!studentEntry.questionNumbers.includes(row.number))
        studentEntry.questionNumbers.push(row.number);
      if (!studentEntry.knowledgeIds.includes(knowledgeKey))
        studentEntry.knowledgeIds.push(knowledgeKey);
      if (studentEntry.reasons.length < 6) studentEntry.reasons.push(type.id);
      if (type.id === "blank") studentEntry.missingWork += 1;
      studentMap.set(studentKey, studentEntry);
    }
  }

  const knowledgePoints = [...knowledgeMap.values()]
    .map((entry) => {
      const total = submissionCount * entry.questionNumbers.length;
      return {
        id: entry.id,
        title: entry.title,
        questionNumbers: entry.questionNumbers.sort((a, b) => a - b),
        errorCount: entry.errorCount,
        students: [...entry.students],
        total,
        correctRate: total > 0 ? rate(total - entry.errorCount, total) : 1,
      };
    })
    .sort((a, b) => a.correctRate - b.correctRate || b.errorCount - a.errorCount);

  const unreadableCount = reasonRows.filter(
    (row) => row.type.id === "unreadable",
  ).length;
  // 错因统计按题号严格划分，保证占比之和为 100% 且与错题数一致
  const reasonDistribution = partitionReasonItems(reasonRows);

  const highFrequencyQuestions = [...questionMap.values()]
    .map((entry) => ({
      ...entry,
      // 该题最终归属的错因，与错因统计口径保持一致
      reasonTypeId:
        reasonRows.find((row) => row.number === entry.number)?.type.id || "",
      errorRate: rate(entry.wrongCount, submissionCount),
      reasons: [...new Set(entry.reasons)].slice(0, 3),
      corrections: [...new Set(entry.corrections)].slice(0, 2),
      explanations: [...new Set(entry.explanations)].slice(0, 2),
    }))
    .sort(
      (a, b) => b.wrongCount - a.wrongCount || a.number - b.number,
    );

  const students = [...studentMap.values()]
    .map((entry) => {
      const ownSubmissions = reviewed.filter(
        (item) =>
          (entry.studentId && item.student_id === entry.studentId) ||
          item.student_name === entry.name,
      ).length;
      const answerSlots = ownSubmissions * questions.length;
      return {
        ...entry,
        submissionCount: ownSubmissions,
        answerSlots,
        knowledgeTitles: entry.knowledgeIds
          .map((id) => knowledgeMap.get(id)?.title)
          .filter(Boolean),
        // 同一名学生多次提交时，未作答数可能大于题量，因此用“答题格数”做分母。
        errorRate: rate(
          entry.mistakeCount,
          answerSlots || questions.length || 1,
        ),
        score:
          [...earnedByStudent.values()].find(
            (item) => item.studentId && item.studentId === entry.studentId,
          )?.earned ?? null,
        dominantReason:
          dominantReasonFromRows(reasonRows, entry.name) ||
          dominantReason(entry.reasons),
      };
    })
    .sort(
      (a, b) => b.mistakeCount - a.mistakeCount || a.name.localeCompare(b.name),
    );

  return {
    assignment: {
      id: assignment.id,
      title: assignment.title,
      stage: assignment.stage,
      subject: assignment.subject,
      className: assignment.class_name,
      createdAt: assignment.created_at,
      questionCount: questions.length,
      totalScore,
    },
    overview: {
      submissionCount,
      studentCount: students.length,
      reviewedCount: submissionCount,
      pendingCount: submissions.length - submissionCount,
      submissionTotal: submissions.length,
      questionCount: questions.length,
      totalScore,
      mistakeCount: reviewedMistakes.length,
      answerSlots: submissionCount * questions.length,
      errorRate: rate(reviewedMistakes.length, submissionCount * questions.length),
      scoreRate: rate(
        earnedList.reduce((sum, item) => sum + item.earned, 0),
        scoreDenominator,
      ),
      averageScore: submissionCount
        ? Math.round(
            (earnedList.reduce((sum, item) => sum + item.earned, 0) /
              submissionCount) *
              10,
          ) / 10
        : 0,
      medianScoreRate: percentile(scoreRates, 0.5),
      lowestScoreRate: scoreRates.length ? Math.min(...scoreRates) : 0,
      unreadableCount,
      usefulMistakeCount: reviewedMistakes.length - unreadableCount,
      pendingMistakeCount: pendingMistakes,
      multipleSubmissions: students.some(
        (entry) =>
          reviewed.filter((item) => item.student_name === entry.name).length > 1,
      ),
    },
    knowledgePoints,
    reasonDistribution,
    highFrequencyQuestions,
    students,
    // 供个别化诊断按学生重新划分错因时复用，避免重复读取数据库
    reasonRows: reasonRows.map((row) => ({
      number: row.number,
      studentName: row.studentName,
      type: { id: row.type.id },
    })),
    resources: buildResources(highFrequencyQuestions),
  };
}

function dominantReason(reasonIds) {
  if (!reasonIds.length) return null;
  const counts = new Map();
  for (const id of reasonIds) counts.set(id, (counts.get(id) || 0) + 1);
  const [id] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const type = reasonType(id);
  return { id, label: type.label, color: type.color };
}

function dominantReasonFromRows(reasonRows, studentName) {
  const own = reasonRows.filter((row) => row.studentName === studentName);
  if (!own.length) return null;
  const counts = new Map();
  for (const row of own)
    counts.set(row.type.id, (counts.get(row.type.id) || 0) + 1);
  const [id] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const type = reasonType(id);
  return { id, label: type.label, color: type.color };
}

function buildResources(highFrequencyQuestions) {
  const knowledge = [];
  for (const question of highFrequencyQuestions) {
    let target = knowledge.find(
      (item) => item.knowledgeId === question.knowledgeId,
    );
    if (!target) {
      target = {
        knowledgeId: question.knowledgeId,
        title: question.knowledgeTitle,
        questionNumbers: [],
        explanations: [],
        practice: [],
      };
      knowledge.push(target);
    }
    if (!target.questionNumbers.includes(question.number))
      target.questionNumbers.push(question.number);
    for (const text of question.explanations)
      if (target.explanations.length < 3 && !target.explanations.includes(text))
        target.explanations.push(text);
    for (const item of question.practice)
      if (target.practice.length < 3) target.practice.push(item);
  }
  return {
    knowledgePoints: knowledge.filter(
      (item) => item.explanations.length || item.practice.length,
    ),
    totalPractice: knowledge.reduce((sum, item) => sum + item.practice.length, 0),
  };
}

/**
 * 单份作业下的学生个体学情（用于教师跟进与分层）。
 * 错因按该生自己的错题重新划分，避免把同题其他学生的错因算到他头上。
 */
export function buildStudentStats(stats, studentId) {
  const student = stats.students.find(
    (item) => item.studentId === studentId || item.name === studentId,
  );
  if (!student) return null;
  const questions = stats.highFrequencyQuestions
    .filter((question) => question.students.includes(student.name))
    .sort((a, b) => a.number - b.number);
  const knowledgePoints = stats.knowledgePoints.filter((point) =>
    point.students.includes(student.name),
  );
  const ownRows = (stats.reasonRows || []).filter(
    (row) => row.studentName === student.name,
  );
  const reasons = partitionReasonItems(
    ownRows.map((row) => ({
      number: row.number,
      type: reasonType(row.type.id),
      reason: "",
      prompt: "",
    })),
  );
  return {
    student,
    questions,
    knowledgePoints,
    reasons,
  };
}

export function safeParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 把统计结论压缩成给模型的输入，避免把整张错题表塞进提示词。
 */
export function promptPayload(stats, { student = null, knowledgeLabels = [] } = {}) {
  const scope = student
    ? {
        scope: "individual",
        student: {
          name: student.name,
          mistakeCount: student.mistakeCount,
          submissionCount: student.submissionCount,
          answerSlots: student.answerSlots,
          questionNumbers: student.questionNumbers,
          knowledgeTitles: student.knowledgeTitles,
          score: student.score,
          blankCount: student.missingWork,
          dominantReason: student.dominantReason?.label || "待判定",
        },
        questions: stats.highFrequencyQuestions
          .filter((question) => question.students.includes(student.name))
          .map((question) => ({
            number: question.number,
            prompt: truncate(question.prompt, 220),
            knowledge: question.knowledgeTitle,
            studentsAnswerWrong: question.wrongCount,
            reason: question.reasons[0] || "",
            correction: question.corrections[0] || "",
            explanation: question.explanations[0] || "",
          })),
        knowledgePoints: stats.knowledgePoints
          .filter((point) => point.students.includes(student.name))
          .map((point) => ({
            title: point.title,
            questionNumbers: point.questionNumbers,
            classCorrectRate: Number(point.correctRate.toFixed(3)),
          })),
        reasonDistribution: stats.reasonDistribution
          .filter((item) => item.count > 0)
          .map((item) => ({
            id: item.id,
            label: item.label,
            classCount: item.count,
            questions: item.questions.map((question) => question.number),
          })),
      }
    : {
        scope: "class",
        assignment: stats.assignment,
        overview: {
          ...stats.overview,
          scoreRate: Number(stats.overview.scoreRate.toFixed(3)),
          errorRate: Number(stats.overview.errorRate.toFixed(3)),
          medianScoreRate: Number(stats.overview.medianScoreRate.toFixed(3)),
          lowestScoreRate: Number(stats.overview.lowestScoreRate.toFixed(3)),
        },
        knowledgePoints: stats.knowledgePoints.map((point) => ({
          title: point.title,
          questionNumbers: point.questionNumbers,
          errorCount: point.errorCount,
          correctRate: Number(point.correctRate.toFixed(3)),
          students: point.students,
        })),
        reasonDistribution: stats.reasonDistribution.map((item) => ({
          id: item.id,
          label: item.label,
          count: item.count,
          ratio: Number(item.ratio.toFixed(3)),
          samples: item.samples,
          questions: item.questions.map((question) => ({
            number: question.number,
            count: question.count,
            prompt: truncate(question.prompt, 100),
          })),
        })),
        highFrequencyQuestions: stats.highFrequencyQuestions
          .slice(0, 10)
          .map((question) => ({
            number: question.number,
            prompt: truncate(question.prompt, 260),
            knowledge: question.knowledgeTitle,
            wrongCount: question.wrongCount,
            errorRate: Number(question.errorRate.toFixed(3)),
            students: question.students,
            reason: question.reasons[0] || "",
            correction: question.corrections[0] || "",
            explanation: question.explanations[0] || "",
          })),
        students: stats.students.map((item) => ({
          name: item.name,
          mistakeCount: item.mistakeCount,
          questionNumbers: item.questionNumbers,
          knowledgeTitles: item.knowledgeTitles,
          blankCount: item.missingWork,
          dominantReason: item.dominantReason?.label || "",
          score: item.score,
        })),
        schoolKnowledgeBase: knowledgeLabels.slice(0, 40),
      };
  return scope;
}

export const reasonTypeIds = reasonTypes.map((item) => item.id);

/** 供模型使用的错因体系（id + 中文名称），避免模型猜测英文 id 的含义。 */
export const reasonTypeCatalog = reasonTypes.map((item) => ({
  id: item.id,
  label: item.label,
  meaning: item.hint,
}));
