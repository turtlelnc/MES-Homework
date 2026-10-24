// 引导式错题本：学生端先思考、再逐条看提示、重做原题，AI 判断“已掌握”后才
// 展示参考答案与解析；连续 3 次没掌握则兜底展示，避免死循环。
//
// 安全边界：学生视图一律走白名单，永不返回 correction / explanation /
// standard_answer / practice 参考答案；只有 attempt 判定 correct 或达到兜底次数时，
// 由 reveal 字段显式返回参考答案。

import { practiceGrade } from "./grading.mjs";

const HINT_MAX = 500;
const ANSWER_MAX = 4000;
const MAX_REVEAL_ATTEMPTS = 3;

function text(value, max = ANSWER_MAX) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeGuidanceShape(raw) {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    keyQuestion: text(source.keyQuestion, HINT_MAX),
    hints: (Array.isArray(source.hints) ? source.hints : [])
      .slice(0, 5)
      .map((hint) => text(hint, HINT_MAX))
      .filter(Boolean),
    selfCheck: (Array.isArray(source.selfCheck) ? source.selfCheck : [])
      .slice(0, 6)
      .map((question) => text(question, HINT_MAX))
      .filter(Boolean),
  };
}

// 没有 AI guidance 时，用错因与知识点生成三条稳定、可预期的本地提示。
export function fallbackGuidance(mistake) {
  const knowledge = text(
    mistake?.knowledge_title ?? mistake?.knowledgeTitle,
    80,
  );
  const reason = text(mistake?.reason, 200);
  const prompt = text(mistake?.prompt, 120);
  return {
    keyQuestion: knowledge
      ? `这道题考查「${knowledge}」，你还记得它的关键条件和解题入口吗？`
      : "先别急着看答案：这道题考查哪个知识点，关键条件是什么？",
    hints: [
      knowledge
        ? `先回忆「${knowledge}」的定义、公式或方法，再逐条对照题目条件，找出你当时漏掉的那一点。`
        : "先回忆这道题涉及的定义、公式或方法，再把题目条件逐条标出来，看看哪一条没有用上。",
      reason
        ? `你当时的错误是「${reason}」。想想看：换一种思路重新走一遍，第一步应该写什么？`
        : "把解题过程拆成几步：第一步写什么、第二步算什么、最后要回答什么，先列提纲再动笔。",
      prompt
        ? `回到题目「${prompt}…」重新读一遍，独立重做并写完整步骤，做完检查单位、符号和结果是否合理。`
        : "独立把这道题重做一遍并写完整步骤，做完后检查单位、符号和结果是否合理。",
    ],
    selfCheck: [
      "我写清楚每一步的依据了吗？",
      "我的答案和题目问的是同一件事吗？",
      "把结果代回题目检验过吗？",
    ],
  };
}

// 逐条解锁：hints_used=0 时只给关键问题，之后每点一次提示多看一条。
export function visibleGuidance(guidance, hintsUsed) {
  const source = normalizeGuidanceShape(guidance);
  const used = Math.min(toCount(hintsUsed), source.hints.length);
  return {
    keyQuestion: source.keyQuestion,
    hints: source.hints.slice(0, used),
  };
}

function guidanceForMistake(row) {
  const fallback = fallbackGuidance(row);
  const stored = normalizeGuidanceShape(parseJson(row?.guidance_json, null));
  return {
    keyQuestion: stored.keyQuestion || fallback.keyQuestion,
    hints: stored.hints.length ? stored.hints : fallback.hints,
    selfCheck: stored.selfCheck.length ? stored.selfCheck : fallback.selfCheck,
  };
}

function practiceQuestionsOf(row) {
  const practice = parseJson(row?.practice_json, []);
  return (Array.isArray(practice) ? practice : [])
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, 5)
    .map((item) => ({ prompt: text(item.prompt, 2000) }))
    .filter((item) => item.prompt);
}

// 学生视图白名单：绝不出现 correction / explanation / standard_answer /
// reasoning（AI 判分依据可能直接点破答案）/ 练习参考答案。
export function studentMistakeView(row, progress) {
  const hintsUsed = toCount(progress?.hints_used);
  const guidance = guidanceForMistake(row);
  const visible = visibleGuidance(guidance, hintsUsed);
  return {
    id: text(row?.id, 100),
    knowledge_title: text(row?.knowledge_title, 120),
    prompt: text(row?.prompt, ANSWER_MAX),
    student_answer: text(row?.student_answer, ANSWER_MAX),
    reason: text(row?.reason, 1000),
    mastery: Number(row?.mastery) === 1 ? 1 : 0,
    practiceQuestions: practiceQuestionsOf(row),
    guidance: {
      keyQuestion: visible.keyQuestion,
      hints: visible.hints,
    },
    progress: {
      hintsUsed,
      attempts: toCount(progress?.attempts),
      solved: Number(progress?.solved) === 1 ? 1 : 0,
      revealed: Number(progress?.revealed) === 1 ? 1 : 0,
    },
    created_at: text(row?.created_at, 40),
  };
}

export function normalizeAttemptGrade(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.correct !== "boolean")
    throw new Error("模型批改结果格式无效，请重试");
  return { correct: raw.correct, feedback: text(raw.feedback, 2000) };
}

function revealFields(mistake) {
  const correction = text(mistake?.correction, ANSWER_MAX);
  return {
    standardAnswer: text(mistake?.standard_answer, ANSWER_MAX),
    correction,
    explanation: text(mistake?.explanation || correction, ANSWER_MAX),
    reasoning: text(mistake?.reasoning, ANSWER_MAX),
  };
}

function buildHintPrompt(mistake) {
  return `你是耐心的一线教师，正在引导学生自己订正错题。绝对不能直接给出最终答案、订正答案或完整解题过程。
学段=${text(mistake?.stage, 20)}，学科=${text(mistake?.subject, 20)}，知识点=${text(mistake?.knowledge_title, 120) || "未标注"}。
题目=${text(mistake?.prompt, 2000)}
学生的错误答案=${text(mistake?.student_answer, 2000)}
错误原因=${text(mistake?.reason, 500)}
请给出引导式脚手架：1 个只点方向的关键问题（不给答案）、3-5 条逐级递进的提示（第一条只点方向，最后一条点到关键一步但仍不给最终答案）、2-3 个让学生自查的问题。
只返回 JSON：{"keyQuestion":"...","hints":["..."],"selfCheck":["..."]}`;
}

function buildAttemptPrompt(mistake, answer) {
  const reference =
    text(mistake?.standard_answer, 4000) ||
    text(mistake?.correction, 4000) ||
    "（暂无参考答案，请按学科常识判断核心是否掌握）";
  return `你是老师，正在引导学生自己订正错题。题目=${text(mistake?.prompt, 4000)}，参考答案/评分要点=${reference}（已知此答案正确），学生本次作答=${text(answer, 10000)}。判断学生本次作答是否已经掌握本题核心（语义等价/关键步骤正确即可，不要求和参考答案字面一致）。只返回 JSON：{"correct":true,"feedback":"先肯定+指出还差什么（不给最终答案除非 correct=true）"}`;
}

function buildPracticePrompt(mistake) {
  return `为学生生成过关练习。学段=${text(mistake?.stage, 20)}，学科=${text(mistake?.subject, 20)}，知识点=${text(mistake?.knowledge_title, 120) || "未标注"}。原题=${text(mistake?.prompt, 2000)}，标准答案=${text(mistake?.standard_answer, 2000)}，学生错误=${text(mistake?.student_answer, 2000)}，错误原因=${text(mistake?.reason, 500)}。生成3道同知识点、同题型但数值或情境不同的题，难度逐步提高，不得照抄原题。只返回JSON：{"questions":[{"prompt":"题目","answer":"标准答案","explanation":"分步解析"}]}`;
}

function buildPracticeGradingPrompt(questions, answers) {
  return `请严格批改过关练习。题目与参考答案=${JSON.stringify(questions)}。学生答案=${JSON.stringify(answers)}。语义等价或计算过程正确可判正确；不要因表达形式不同误判。只返回JSON：{"results":[{"correct":true,"feedback":"简短反馈"}],"passed":true}。passed 仅在全部题目正确时为 true。`;
}

function loadProgress(db, mistakeId, studentId) {
  return (
    db
      .prepare(
        "SELECT * FROM mistake_progress WHERE mistake_id=? AND student_id=?",
      )
      .get(mistakeId, studentId) || null
  );
}

function saveProgress(
  db,
  { mistakeId, studentId, hintsUsed, attempts, solved, revealed, feedback, at },
) {
  db.prepare(
    `INSERT INTO mistake_progress(mistake_id,student_id,hints_used,attempts,solved,revealed,last_feedback,updated_at)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(mistake_id,student_id) DO UPDATE SET
       hints_used=excluded.hints_used,attempts=excluded.attempts,solved=excluded.solved,
       revealed=excluded.revealed,last_feedback=excluded.last_feedback,updated_at=excluded.updated_at`,
  ).run(
    mistakeId,
    studentId,
    hintsUsed,
    attempts,
    solved,
    revealed,
    text(feedback, 2000),
    at,
  );
}

function progressView(progress) {
  return {
    hintsUsed: toCount(progress?.hints_used),
    attempts: toCount(progress?.attempts),
    solved: Number(progress?.solved) === 1 ? 1 : 0,
    revealed: Number(progress?.revealed) === 1 ? 1 : 0,
  };
}

// 兼容 direct 模式：题目/答案快照优先取 questions 行，没有题目行时用 mistakes 快照
// （question_id 为 NULL 的直批错题）——统一用 COALESCE + LEFT JOIN。
const MISTAKE_SELECT = `SELECT m.id,m.submission_id,m.student_id,m.question_id,m.knowledge_id,
  m.reason,m.student_answer,m.correction,m.created_at,m.explanation,m.practice_json,m.mastery,
  m.reasoning,m.guidance_json,
  COALESCE(q.prompt,m.prompt,'') AS prompt,
  COALESCE(q.number,m.question_number) AS question_number,
  COALESCE(q.standard_answer,m.standard_answer,'') AS standard_answer,
  COALESCE(q.score,m.question_score) AS question_score,
  k.title AS knowledge_title,a.stage,a.subject
  FROM mistakes m
  JOIN submissions s ON s.id=m.submission_id
  JOIN assignments a ON a.id=s.assignment_id
  LEFT JOIN questions q ON q.id=m.question_id
  LEFT JOIN knowledge k ON k.id=m.knowledge_id`;

function ownedMistakeSql(scope) {
  return `${MISTAKE_SELECT} WHERE ${scope}`;
}

const STUDENT_OWNED =
  "m.id=? AND m.student_id=? AND s.teacher_reviewed=1 AND a.school_id=?";

export function registerMistakeRoutes(app, ctx) {
  const { db, auth } = ctx;
  const iso =
    typeof ctx.iso === "function" ? ctx.iso : () => new Date().toISOString();
  const callModel = ctx.callModel;
  const modelErrorStatus =
    typeof ctx.modelErrorStatus === "function"
      ? ctx.modelErrorStatus
      : (error) => Number(error?.status) || 500;
  const publicPractice =
    typeof ctx.publicPractice === "function"
      ? ctx.publicPractice
      : (questions) =>
          (Array.isArray(questions) ? questions : []).map((question) => ({
            prompt: String(question?.prompt || ""),
          }));
  const safeParse =
    typeof ctx.safeParse === "function"
      ? ctx.safeParse
      : (value, fallback) => parseJson(value, fallback);
  const loadOwnedMistake = (id, studentId, schoolId) =>
    db.prepare(ownedMistakeSql(STUDENT_OWNED)).get(id, studentId, schoolId);

  app.get("/api/mistakes", auth, (req, res) => {
    const role = req.user?.role;
    if (role === "student") {
      const rows = db
        .prepare(
          `${MISTAKE_SELECT} WHERE a.school_id=? AND m.student_id=? AND s.teacher_reviewed=1 ORDER BY m.created_at DESC`,
        )
        .all(req.user.school_id, req.user.id);
      const progress = new Map(
        db
          .prepare("SELECT * FROM mistake_progress WHERE student_id=?")
          .all(req.user.id)
          .map((row) => [row.mistake_id, row]),
      );
      return res.json(
        rows.map((row) => studentMistakeView(row, progress.get(row.id))),
      );
    }
    if (role === "teacher") {
      const rows = db
        .prepare(
          `${MISTAKE_SELECT} WHERE a.school_id=? AND a.teacher_id=? AND s.teacher_reviewed=1 ORDER BY m.created_at DESC`,
        )
        .all(req.user.school_id, req.user.id);
      return res.json(
        rows.map((row) => ({
          ...row,
          practiceQuestions: safeParse(row.practice_json, []),
          practice_json: undefined,
        })),
      );
    }
    return res
      .status(403)
      .json({ error: "仅教师或学生可查看错题，家长请从孩子看板查看学情" });
  });

  app.get("/api/mistakes/:id/guide", auth, (req, res) => {
    if (req.user?.role !== "student")
      return res.status(403).json({ error: "仅学生可查看错题引导" });
    const mistake = loadOwnedMistake(
      req.params.id,
      req.user.id,
      req.user.school_id,
    );
    if (!mistake) return res.status(404).json({ error: "错题不存在" });
    const progress = loadProgress(db, mistake.id, req.user.id);
    const guidance = guidanceForMistake(mistake);
    const visible = visibleGuidance(guidance, toCount(progress?.hints_used));
    const solved = Number(progress?.solved) === 1;
    const revealed = Number(progress?.revealed) === 1;
    const body = {
      id: mistake.id,
      prompt: text(mistake.prompt, 4000),
      myAnswer: text(mistake.student_answer, 4000),
      knowledgeTitle: text(mistake.knowledge_title, 120),
      reason: text(mistake.reason, 1000),
      guidance: {
        keyQuestion: visible.keyQuestion,
        hints: visible.hints,
        selfCheck: guidance.selfCheck,
      },
      progress: progressView(progress),
      canRevealAnswer: solved || revealed,
    };
    // 已经掌握或已用尽尝试后，允许重新加载时继续对照答案。
    if (body.canRevealAnswer) body.reveal = revealFields(mistake);
    res.json(body);
  });

  app.post("/api/mistakes/:id/hint", auth, async (req, res) => {
    if (req.user?.role !== "student")
      return res.status(403).json({ error: "仅学生可查看错题提示" });
    const mistake = loadOwnedMistake(
      req.params.id,
      req.user.id,
      req.user.school_id,
    );
    if (!mistake) return res.status(404).json({ error: "错题不存在" });
    const progress = loadProgress(db, mistake.id, req.user.id);
    let guidance = guidanceForMistake(mistake);
    const stored = parseJson(mistake.guidance_json, null);
    const hasStoredHints =
      stored &&
      typeof stored === "object" &&
      Array.isArray(stored.hints) &&
      stored.hints.length > 0;
    // 没有 AI 引导时按需生成一次并落库；模型失败/未配置则退回本地提示，不向学生报 500。
    if (!hasStoredHints) {
      try {
        if (typeof callModel !== "function") throw new Error("模型未配置");
        const generated = normalizeGuidanceShape(
          await callModel(req.user, buildHintPrompt(mistake)),
        );
        if (generated.hints.length) {
          guidance = {
            keyQuestion: generated.keyQuestion || guidance.keyQuestion,
            hints: generated.hints,
            selfCheck: generated.selfCheck.length
              ? generated.selfCheck
              : guidance.selfCheck,
          };
          db.prepare("UPDATE mistakes SET guidance_json=? WHERE id=?").run(
            JSON.stringify(guidance),
            mistake.id,
          );
        }
      } catch {
        // 静默兜底：学生只看到提示，不看到模型错误的内部细节。
      }
    }
    const progressBefore = progressView(progress);
    const totalHints = guidance.hints.length;
    const hintsUsed = Math.min(progressBefore.hintsUsed + 1, totalHints);
    if (hintsUsed !== progressBefore.hintsUsed && totalHints > 0)
      saveProgress(db, {
        mistakeId: mistake.id,
        studentId: req.user.id,
        hintsUsed,
        attempts: progressBefore.attempts,
        solved: progressBefore.solved,
        revealed: progressBefore.revealed,
        feedback: progress?.last_feedback || "",
        at: iso(),
      });
    const hint =
      totalHints > 0
        ? guidance.hints[Math.min(hintsUsed, totalHints) - 1]
        : "";
    res.json({
      hint,
      hintsUsed,
      totalHints,
      exhausted: hintsUsed >= totalHints,
    });
  });

  app.post("/api/mistakes/:id/attempt", auth, async (req, res) => {
    if (req.user?.role !== "student")
      return res.status(403).json({ error: "仅学生可重做错题" });
    const mistake = loadOwnedMistake(
      req.params.id,
      req.user.id,
      req.user.school_id,
    );
    if (!mistake) return res.status(404).json({ error: "错题不存在" });
    const answer =
      typeof req.body?.answer === "string" ? req.body.answer.trim() : "";
    if (!answer || answer.length > 10000)
      return res.status(400).json({ error: "请填写你的作答（1–10000 字）" });
    if (typeof callModel !== "function")
      return res.status(500).json({ error: "模型未配置，暂不能批改，请稍后再试" });
    const progress = loadProgress(db, mistake.id, req.user.id);
    const attempts = toCount(progress?.attempts) + 1;
    let graded;
    try {
      graded = normalizeAttemptGrade(
        await callModel(req.user, buildAttemptPrompt(mistake, answer)),
      );
    } catch (error) {
      return res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "批改失败，请稍后再试" });
    }
    const correct = graded.correct === true;
    const wasSolved = Number(progress?.solved) === 1;
    const wasRevealed = Number(progress?.revealed) === 1;
    const solved = correct || wasSolved ? 1 : 0;
    // 连续第 3 次仍未掌握也展示参考答案，避免学生陷入死循环。
    const revealed =
      correct || wasRevealed || attempts >= MAX_REVEAL_ATTEMPTS ? 1 : 0;
    let feedback = graded.feedback;
    if (!correct && revealed && !wasRevealed)
      feedback = `已经尝试 ${MAX_REVEAL_ATTEMPTS} 次，先看参考答案，再自己重做一遍。${
        feedback ? ` ${feedback}` : ""
      }`;
    saveProgress(db, {
      mistakeId: mistake.id,
      studentId: req.user.id,
      hintsUsed: toCount(progress?.hints_used),
      attempts,
      solved,
      revealed,
      feedback,
      at: iso(),
    });
    const body = {
      correct,
      feedback,
      progress: {
        hintsUsed: toCount(progress?.hints_used),
        attempts,
        solved,
        revealed,
      },
    };
    if (revealed) body.reveal = revealFields(mistake);
    res.json(body);
  });

  app.post("/api/mistakes/:id/practice/generate", auth, async (req, res) => {
    if (req.user?.role !== "student")
      return res.status(403).json({ error: "仅学生可生成过关练习" });
    const mistake = loadOwnedMistake(
      req.params.id,
      req.user.id,
      req.user.school_id,
    );
    if (!mistake) return res.status(404).json({ error: "错题不存在" });
    try {
      if (typeof callModel !== "function") throw new Error("模型未配置");
      const generated = await callModel(req.user, buildPracticePrompt(mistake));
      const rawQuestions = Array.isArray(generated?.questions)
        ? generated.questions
        : [];
      const questions = rawQuestions
        .slice(0, 5)
        .filter(
          (question) =>
            question && typeof question === "object" && !Array.isArray(question),
        )
        .map((question) => ({
          prompt: text(question.prompt, 2000),
          answer: text(question.answer, 2000),
          explanation: text(question.explanation, 2000),
        }))
        .filter((question) => question.prompt);
      if (!questions.length) throw new Error("模型没有生成练习题");
      const changed = db
        .prepare(
          "UPDATE mistakes SET practice_json=?,mastery=0 WHERE id=? AND practice_json IS ? AND EXISTS(SELECT 1 FROM submissions WHERE id=mistakes.submission_id AND teacher_reviewed=1)",
        )
        .run(JSON.stringify(questions), mistake.id, mistake.practice_json);
      if (!changed.changes)
        return res
          .status(409)
          .json({ error: "题目或复核状态已变化，请刷新后重试" });
      res.json({ questions: publicPractice(questions) });
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "练习生成失败" });
    }
  });

  app.post("/api/mistakes/:id/practice/submit", auth, async (req, res) => {
    if (req.user?.role !== "student")
      return res.status(403).json({ error: "仅学生可提交过关练习" });
    const mistake = db
      .prepare(
        "SELECT m.* FROM mistakes m JOIN submissions s ON s.id=m.submission_id JOIN assignments a ON a.id=s.assignment_id WHERE m.id=? AND m.student_id=? AND s.teacher_reviewed=1 AND a.school_id=?",
      )
      .get(req.params.id, req.user.id, req.user.school_id);
    if (!mistake) return res.status(404).json({ error: "错题不存在" });
    const questions = parseJson(mistake.practice_json, []);
    if (!Array.isArray(questions) || !questions.length)
      return res.status(400).json({ error: "请先生成同类练习" });
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : null;
    if (
      !answers ||
      answers.length !== questions.length ||
      answers.some(
        (answer) =>
          typeof answer !== "string" || !answer.trim() || answer.length > 10000,
      )
    )
      return res.status(400).json({ error: "请完整填写每道练习的答案" });
    try {
      if (typeof callModel !== "function") throw new Error("模型未配置");
      const graded = await callModel(
        req.user,
        buildPracticeGradingPrompt(questions, answers),
      );
      const result = practiceGrade(graded, questions.length);
      const changed = db
        .prepare(
          "UPDATE mistakes SET mastery=? WHERE id=? AND practice_json=? AND EXISTS(SELECT 1 FROM submissions WHERE id=mistakes.submission_id AND teacher_reviewed=1)",
        )
        .run(result.passed ? 1 : 0, mistake.id, mistake.practice_json);
      if (!changed.changes)
        return res
          .status(409)
          .json({ error: "题目或复核状态已变化，请刷新后重试" });
      res.json(result);
    } catch (error) {
      res
        .status(modelErrorStatus(error))
        .json({ error: error.message || "练习批改失败" });
    }
  });
}
