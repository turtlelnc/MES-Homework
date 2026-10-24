// 无原题直批：教师不上传原题，只上传学生答卷（图片/PDF/Word），
// 由模型按学生卷面切分题目、给出参考答案与评分要点，再逐题判分。
// 这一层负责：提示词、模型 JSON 的强校验归一化、知识点落库关联。

const INVALID_FORMAT = "模型返回的批改结果格式无效，请重试";
const MAX_QUESTIONS = 200;
const MAX_WARNINGS = 50;

function text(value, max = 4000) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildGuidancePromptLines() {
  return [
    "1. 按学生卷面顺序切分题目；题号尽量按卷面，原卷没有题号时按顺序编号。",
    "2. 每题给出可判分的参考答案与评分要点；无法确定答案时写“参考要点：…”，不得编造分数。",
    "3. 逐题判分，并用 reasoning 具体说明判断依据（对照了哪些答案要素、为什么对/错），不能只写“答案正确/错误”。",
    "4. 错题要给 reason（错因）、correction（订正答案）、explanation（分步解析）、2 道同类练习、guidance（引导思考，不给最终答案）。",
    "5. 无法辨认的作答写 [无法辨认]，并把 confidence 降到 0.5 以下。",
    "6. 只返回 JSON，不要输出 JSON 之外的解释。",
  ].join("\n");
}

export function buildDirectGradingPrompt({
  assignment,
  documentText,
  imageCount,
} = {}) {
  const item = assignment && typeof assignment === "object" ? assignment : {};
  const title = text(item.title, 120) || "未命名作业";
  const stage = text(item.stage, 20) || "未提供";
  const subject = text(item.subject, 20) || "未提供";
  const className = text(item.class_name ?? item.className, 40) || "未提供";
  const description = text(item.description, 2000);
  const pages = Math.max(0, Math.floor(numberValue(imageCount) ?? 0));
  const contentText = String(documentText ?? "").trim();
  const source = contentText
    ? `答卷文字（按附件顺序）：\n${contentText}`
    : pages > 0
      ? `学生答卷共 ${pages} 页，页面已附在消息中。`
      : "学生答卷页面已附在消息中。";
  return `你是一线学科教师，直接批改学生上交的作业（教师没有预先上传原题，你需要根据学生卷面独立还原题目与评分要点）。
作业信息：学段=${stage}，学科=${subject}，班级=${className}，作业名称=${title}。
教师对作业内容的简单描述：${description || "（教师没有填写描述，请完全依据卷面内容判断）"}
${source}
批改要求：
${buildGuidancePromptLines()}
只返回 JSON：{"ocrText":"整份答卷识别原文","questions":[{"number":1,"prompt":"题干（含学生作答上下文；原卷无题干时按学生答案推断并标注[推断]）","referenceAnswer":"参考答案/评分要点","score":10,"knowledgeTitle":"知识点"}],"items":[{"number":1,"studentAnswer":"学生答案","isCorrect":false,"score":0,"reason":"错误原因（错因归类文案）","correction":"订正答案","explanation":"分步解析","reasoning":"判断依据：对照答案要素、为什么对/错","confidence":0.9,"practiceQuestions":[{"prompt":"同类题","answer":"答案","explanation":"解析"}],"guidance":{"keyQuestion":"引导思考的关键问题（不给答案）","hints":["提示1（思路）","提示2（步骤）","提示3（关键一步）"],"selfCheck":["自检问题"]}}],"warnings":["需要教师注意的问题"]}`;
}

function normalizePracticeQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 5)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      prompt: text(item.prompt, 2000),
      answer: text(item.answer, 2000),
      explanation: text(item.explanation, 2000),
    }))
    .filter((item) => item.prompt);
}

function normalizeGuidance(value) {
  const source =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hints = Array.isArray(source.hints) ? source.hints : [];
  const selfCheck = Array.isArray(source.selfCheck) ? source.selfCheck : [];
  return {
    keyQuestion: text(source.keyQuestion, 500),
    hints: hints
      .slice(0, 5)
      .map((hint) => text(hint, 500))
      .filter(Boolean),
    selfCheck: selfCheck
      .slice(0, 6)
      .map((question) => text(question, 500))
      .filter(Boolean),
  };
}

function defaultItem(question) {
  return {
    questionId: question.id,
    studentAnswer: "",
    isCorrect: false,
    score: 0,
    reason: "",
    correction: "",
    explanation: "",
    reasoning: "",
    // 缺题由调用方补齐：confidence=0 同样会触发“存疑复核”。
    confidence: 0,
    practiceQuestions: [],
    guidance: { keyQuestion: "", hints: [], selfCheck: [] },
  };
}

// 把模型输出白名单化为可直接落库的结构：
// - 题号按数组顺序重排为 1..N（同一份答卷内唯一）
// - items 按题号对齐 questions，缺题补全并记录 warning
// - 所有字符串按模块上限截断，分数夹到 [0, question.score]
export function normalizeDirectGrading(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(INVALID_FORMAT);
  const rawQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
  if (!rawQuestions.length) throw new Error(INVALID_FORMAT);

  const warnings = [];
  const pushWarning = (message) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(text(message, 500));
  };
  if (rawQuestions.length > MAX_QUESTIONS)
    pushWarning(`模型返回题目超过 ${MAX_QUESTIONS} 道，已截断为前 ${MAX_QUESTIONS} 道。`);
  const listed = rawQuestions.slice(0, MAX_QUESTIONS);

  const questions = listed.map((raw, index) => {
    const source =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const number = index + 1;
    const prompt = text(source.prompt, 4000);
    if (!prompt) pushWarning(`第 ${number} 题缺少题干，已标记为待补充。`);
    let score = 0;
    const rawScore = numberValue(source.score);
    if (rawScore !== null && rawScore >= 0 && rawScore <= 1000) score = rawScore;
    else if (rawScore !== null)
      pushWarning(`第 ${number} 题分值超出 0–1000 范围，已按 0 分处理。`);
    return {
      id: `dq${number}`,
      number,
      prompt: prompt || `（第 ${number} 题题干缺失，待教师补充）`,
      standardAnswer: text(
        source.referenceAnswer ?? source.standardAnswer ?? source.standard_answer,
        4000,
      ),
      score,
      knowledgeTitle: text(
        source.knowledgeTitle ?? source.knowledge_title,
        120,
      ),
    };
  });

  // 题号 → 题目：既接受模型原始题号，也接受重排后的 1..N，
  // 这样即使模型题号缺失/重复，items 仍能按顺序对上。
  const byNumber = new Map();
  questions.forEach((question, index) => {
    const sourceNumber = numberValue(listed[index]?.number);
    if (
      sourceNumber !== null &&
      Number.isInteger(sourceNumber) &&
      sourceNumber >= 1 &&
      !byNumber.has(sourceNumber)
    )
      byNumber.set(sourceNumber, question);
  });
  for (const question of questions)
    if (!byNumber.has(question.number))
      byNumber.set(question.number, question);
  const byId = new Map(questions.map((question) => [question.id, question]));

  const items = questions.map((question) => defaultItem(question));
  const assigned = new Set();
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  if (parsed.items !== undefined && !Array.isArray(parsed.items))
    pushWarning("模型返回的逐题判分格式无效，已按未判分处理。");

  rawItems.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      pushWarning(`模型返回的第 ${index + 1} 项判分格式无效，已忽略。`);
      return;
    }
    const rawNumber = numberValue(raw.number);
    let question = null;
    if (rawNumber !== null && Number.isInteger(rawNumber)) {
      question = byNumber.get(rawNumber) || null;
      if (!question) {
        pushWarning(`模型判分里的第 ${rawNumber} 题找不到对应题目，已忽略。`);
        return;
      }
      if (assigned.has(question.number)) {
        pushWarning(`第 ${question.number} 题重复判分，已忽略重复项。`);
        return;
      }
    } else {
      const byQuestionId =
        typeof raw.questionId === "string" ? byId.get(raw.questionId) : null;
      question =
        byQuestionId && !assigned.has(byQuestionId.number)
          ? byQuestionId
          : questions[index] && !assigned.has(questions[index].number)
            ? questions[index]
            : null;
      if (!question) {
        pushWarning(`模型返回了多余的判分（第 ${index + 1} 项），已忽略。`);
        return;
      }
    }
    assigned.add(question.number);
    const target = items[question.number - 1];
    const isCorrect = raw.isCorrect === true;
    if (typeof raw.isCorrect !== "boolean")
      pushWarning(`第 ${question.number} 题缺少有效正误标记，已按错误处理。`);
    let score = numberValue(raw.score);
    if (score === null) score = isCorrect ? question.score : 0;
    score = Math.min(question.score, Math.max(0, score));
    // 与复核用的 normalizeDirectReview 保持同一套不变量：判对必须满分，
    // 判错不能拿满分，否则整份直批结果会因“分数与正误矛盾”被拒绝。
    if (isCorrect) score = question.score;
    else if (question.score > 0 && score >= question.score)
      score = Math.max(0, question.score - 0.5);
    const confidence = numberValue(raw.confidence);
    target.studentAnswer = text(raw.studentAnswer ?? raw.answer, 4000);
    target.isCorrect = isCorrect;
    target.score = score;
    target.reason = text(raw.reason, 1000);
    target.correction = text(raw.correction, 4000);
    target.explanation = text(raw.explanation, 4000);
    target.reasoning = text(raw.reasoning, 4000);
    target.confidence =
      confidence === null ? -1 : Math.min(1, Math.max(0, confidence));
    target.practiceQuestions = normalizePracticeQuestions(raw.practiceQuestions);
    target.guidance = normalizeGuidance(raw.guidance);
  });

  for (const question of questions)
    if (!assigned.has(question.number))
      pushWarning(`第 ${question.number} 题缺少模型判分，已按未答/错误处理。`);

  const modelWarnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  for (const warning of modelWarnings.slice(0, 10)) {
    const line = text(warning, 500);
    if (line) pushWarning(line);
  }

  return {
    ocrText: String(parsed.ocrText ?? "").slice(0, 20000),
    questions,
    items,
    warnings,
  };
}

function makeUid(ctx) {
  if (typeof ctx?.uid === "function") return ctx.uid();
  return (
    globalThis.crypto?.randomUUID?.() ||
    `kb_${Date.now()}_${Math.random().toString(16).slice(2)}`
  );
}

function makeIso(ctx) {
  if (typeof ctx?.iso === "function") return ctx.iso();
  return new Date().toISOString();
}

// 把模型给出的知识点标题映射到校本 knowledge 表：已有的复用，没有的自动创建。
// direct 模式没有 questions 行，题目 id 用 dq<number>，knowledgeId 直接写进错题快照。
export function linkQuestions(ctx, { assignment, questions, teacherId } = {}) {
  if (!ctx || !ctx.db) throw new Error("知识点关联缺少数据库上下文");
  if (!Array.isArray(questions)) return [];
  const { db } = ctx;
  let target =
    assignment && typeof assignment === "object" ? { ...assignment } : {};
  if ((!target.school_id || !target.stage || !target.subject) && target.id) {
    const row = db
      .prepare("SELECT * FROM assignments WHERE id=?")
      .get(target.id);
    if (row) target = { ...row, ...target };
  }
  const schoolId = String(target.school_id || "");
  const stage = String(target.stage || "");
  const subject = String(target.subject || "");
  const creator = String(teacherId || target.teacher_id || "");
  const now = makeIso(ctx);
  const knowledgeByTitle = new Map();
  if (schoolId && stage && subject) {
    for (const row of db
      .prepare(
        "SELECT id,title FROM knowledge WHERE school_id=? AND stage=? AND subject=?",
      )
      .all(schoolId, stage, subject))
      if (!knowledgeByTitle.has(String(row.title)))
        knowledgeByTitle.set(String(row.title), String(row.id));
  }
  return questions.map((question) => {
    const item =
      question && typeof question === "object" ? { ...question } : {};
    const title = text(
      item.knowledgeTitle ?? item.knowledge_title,
      120,
    );
    let knowledgeId = null;
    if (schoolId && title) {
      knowledgeId = knowledgeByTitle.get(title) || null;
      if (!knowledgeId) {
        knowledgeId = makeUid(ctx);
        db.prepare("INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?)").run(
          knowledgeId,
          schoolId,
          stage,
          subject,
          title,
          "由无原题直批自动创建，教师可在知识库中补充说明与边界。",
          creator,
          now,
        );
        knowledgeByTitle.set(title, knowledgeId);
      }
    } else if (schoolId && item.knowledgeId) {
      // 不接受模型/前端直接指定的跨校知识点 id。
      const row = db
        .prepare("SELECT id FROM knowledge WHERE id=? AND school_id=?")
        .get(String(item.knowledgeId), schoolId);
      knowledgeId = row ? String(row.id) : null;
    }
    return { ...item, knowledgeId };
  });
}
