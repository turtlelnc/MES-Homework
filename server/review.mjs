// 复核三模式：全部复核 / 仅存疑复核 / 不复核。
//
// 本模块只做“该不该让教师复核”的判定和“教师确认后如何一致地落库”，
// 题目归一化仍由 grading.mjs（题库模式）或 direct-grading.mjs（无原题直批）负责：
// 调用方传入的 items 已经是 normalizeReview / normalizeDirectReview 的产物。

export const REVIEW_MODES = [
  {
    id: "all",
    label: "全部复核",
    desc: "每道题都由教师确认后才写入错题本。",
  },
  {
    id: "uncertain",
    label: "仅存疑复核",
    desc: "AI 高置信度的判分自动通过，教师只复核存疑题。",
  },
  {
    id: "none",
    label: "不复核",
    desc: "AI 批改后直接完成；教师可随时重新识别覆盖。",
  },
];

const REVIEW_MODE_IDS = new Set(REVIEW_MODES.map((mode) => mode.id));
const SUSPECT_CONFIDENCE = 0.8;

function text(value, max = 4000) {
  return String(value ?? "").slice(0, max);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function normalizeReviewMode(value) {
  const mode = typeof value === "string" ? value.trim() : "";
  if (!REVIEW_MODE_IDS.has(mode))
    throw new Error("复核方式无效，请选择全部复核、仅存疑复核或不复核");
  return mode;
}

// 一道题是否需要教师多看一眼：模型没把握、答案看不清、分数不合常理、
// 缺少判断逻辑，或者正误与得分互相矛盾，都算“存疑”。
export function isSuspectItem(item, question) {
  if (!item || typeof item !== "object") return true;
  const confidence = Number(item.confidence);
  if (!Number.isFinite(confidence) || confidence < SUSPECT_CONFIDENCE)
    return true;
  if (String(item.studentAnswer || "").includes("无法辨认")) return true;
  const score = Number(item.score);
  if (!Number.isFinite(score)) return true;
  if (typeof item.isCorrect !== "boolean") return true;
  const max = Number(question?.score);
  if (!Number.isFinite(max) || max < 0) return true;
  if (score < 0 || score > max) return true;
  if (item.isCorrect && score !== max) return true;
  if (!item.isCorrect && max > 0 && score >= max) return true;
  const reasoning = String(item.reasoning ?? "").trim();
  if (reasoning.length < 4) return true;
  return false;
}

export function annotateReviewItems(items, questions) {
  const byId = new Map(
    (Array.isArray(questions) ? questions : []).map((question) => [
      question?.id,
      question,
    ]),
  );
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    suspect: isSuspectItem(
      item,
      item?.questionId == null ? undefined : byId.get(item.questionId),
    ),
  }));
}

export function suspectItems(items, questions) {
  return annotateReviewItems(items, questions).filter((item) => item.suspect);
}

// 返回空字符串表示该复核模式已满足；返回中文错误文案表示还有事没做完。
export function assertReviewModeComplete(mode, items, questions) {
  let normalized;
  try {
    normalized = normalizeReviewMode(mode);
  } catch {
    return "复核方式无效";
  }
  if (normalized !== "uncertain") return "";
  const pending = annotateReviewItems(items, questions).filter(
    (item) => item.suspect && item.confirmed !== true,
  );
  return pending.length ? `还有 ${pending.length} 道存疑题未核对完整` : "";
}

// 把教师确认后的逐题结果落库：错题快照 + 提交状态 + 复核审计。
// 调用方只需传入已归一化的 items 与题目数组；本函数不再做模型归一化，
// 只做长度 / 题号 / 分数范围的一致性校验，任何不一致直接抛错（由路由回 400）。
export function commitReview(
  ctx,
  { submission, questions, items, actorId, reviewMode, auto } = {},
) {
  if (!ctx || !ctx.db) throw new Error("复核保存缺少数据库上下文");
  const { db } = ctx;
  const uid = typeof ctx.uid === "function" ? ctx.uid : () => randomId();
  const iso = typeof ctx.iso === "function" ? ctx.iso : () => new Date().toISOString();
  if (!submission || typeof submission !== "object" || !submission.id)
    throw new Error("复核提交无效");
  if (!submission.assignment_id) throw new Error("复核提交缺少作业信息");
  if (!Array.isArray(questions) || !Array.isArray(items))
    throw new Error("复核题目与提交不一致");
  if (questions.length !== items.length)
    throw new Error("复核题目必须与本作业一致且不重复");
  const mode = reviewMode == null ? "all" : normalizeReviewMode(reviewMode);

  const assignment = db
    .prepare(
      "SELECT id,school_id,teacher_id,grading_mode FROM assignments WHERE id=?",
    )
    .get(submission.assignment_id);
  if (!assignment) throw new Error("作业不存在");
  const direct =
    assignment.grading_mode === "direct" || submission.grading_mode === "direct";

  const questionIds = items.map((item) => item?.questionId);
  if (
    questionIds.some((id) => id === undefined || id === null) ||
    new Set(questionIds).size !== items.length
  )
    throw new Error("复核题目必须与本作业一致且不重复");

  // 题库模式以数据库中的正式题目为权威快照；直批模式没有题目行，用解析快照。
  const bankQuestions = direct
    ? new Map()
    : new Map(
        db
          .prepare(
            "SELECT q.*,k.title knowledge_title FROM questions q LEFT JOIN knowledge k ON k.id=q.knowledge_id WHERE q.assignment_id=?",
          )
          .all(assignment.id)
          .map((question) => [question.id, question]),
      );

  const normalized = items.map((item, index) => {
    const provided = questions.find(
      (question) => question?.id === item.questionId,
    );
    if (!provided) throw new Error("复核题目或正误标记无效");
    if (typeof item.isCorrect !== "boolean")
      throw new Error("复核题目或正误标记无效");
    const snapshot = direct
      ? provided
      : { ...provided, ...(bankQuestions.get(item.questionId) || {}) };
    const max = Number(snapshot.score);
    if (!Number.isFinite(max) || max < 0) throw new Error("题目满分无效");
    const score = item.score === undefined ? max : item.score;
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > max
    )
      throw new Error("逐题得分须在满分范围内");
    const number = Number(
      snapshot.number ?? snapshot.questionNumber ?? index + 1,
    );
    const guidance =
      item.guidance && typeof item.guidance === "object" && !Array.isArray(item.guidance)
        ? item.guidance
        : null;
    const hasGuidance =
      guidance &&
      (String(guidance.keyQuestion || "").trim() ||
        (Array.isArray(guidance.hints) && guidance.hints.length));
    return {
      ...item,
      questionId: item.questionId,
      questionNumber: Number.isInteger(number) && number > 0 ? number : index + 1,
      prompt: text(snapshot.prompt, 4000),
      standardAnswer: text(
        snapshot.standardAnswer ?? snapshot.standard_answer,
        4000,
      ),
      questionScore: max,
      knowledgeId:
        snapshot.knowledgeId ??
        snapshot.knowledge_id ??
        item.knowledgeId ??
        null,
      score,
      reasoning: text(item.reasoning, 4000),
      guidance: hasGuidance ? guidance : null,
    };
  });

  const total =
    Math.round(normalized.reduce((sum, item) => sum + item.score, 0) * 1e8) /
    1e8;
  const wrong = normalized.filter((item) => !item.isCorrect);
  const previousAnalysis = parseJsonObject(submission.analysis_json);
  const previousItems = Array.isArray(previousAnalysis.items)
    ? previousAnalysis.items
    : [];
  const before = {
    status: submission.status ?? null,
    reviewed: submission.teacher_reviewed ?? 0,
    score: submission.score ?? null,
  };
  const after = {
    status: "completed",
    reviewed: 1,
    score: total,
    reviewMode: mode,
    changes: normalized.map((item) => {
      const previous = previousItems.find(
        (candidate) => candidate?.questionId === item.questionId,
      );
      return {
        questionId: item.questionId,
        beforeScore: previous?.score ?? null,
        afterScore: item.score,
        answerChanged: previous?.studentAnswer !== item.studentAnswer,
        verdictChanged: previous?.isCorrect !== item.isCorrect,
      };
    }),
  };

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM mistakes WHERE submission_id=?").run(submission.id);
    const insert = db.prepare(
      `INSERT INTO mistakes(id,submission_id,student_id,question_id,knowledge_id,reason,student_answer,correction,created_at,explanation,practice_json,mastery,question_number,prompt,standard_answer,question_score,reasoning,guidance_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const item of wrong)
      insert.run(
        uid(),
        submission.id,
        submission.student_id ?? null,
        direct ? null : item.questionId,
        item.knowledgeId ?? null,
        text(item.reason || "待归因", 1000),
        text(item.studentAnswer, 4000),
        text(item.correction, 4000),
        iso(),
        text(item.explanation || item.correction, 4000),
        JSON.stringify(
          Array.isArray(item.practiceQuestions) ? item.practiceQuestions : [],
        ),
        0,
        item.questionNumber,
        item.prompt,
        item.standardAnswer,
        item.questionScore,
        item.reasoning,
        item.guidance ? JSON.stringify(item.guidance) : null,
      );
    db.prepare(
      "UPDATE submissions SET analysis_json=?,teacher_reviewed=1,status='completed',score=? WHERE id=?",
    ).run(
      JSON.stringify({ ...previousAnalysis, items: normalized, score: total }),
      total,
      submission.id,
    );
    db.prepare("INSERT INTO review_audit VALUES(?,?,?,?,?,?,?,?)").run(
      uid(),
      submission.id,
      assignment.school_id,
      String(actorId || ""),
      auto ? "auto_review_saved" : "review_saved",
      JSON.stringify(before),
      JSON.stringify(after),
      iso(),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 回滚失败时保留原始错误，交给调用方决定如何提示。
    }
    throw error;
  }
  return { score: total, items: normalized };
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() || `id_${Date.now()}_${Math.random()}`;
}

export function registerReviewRoutes(app, ctx) {
  const { db, auth } = ctx;
  app.get("/api/settings/review-mode", auth, (req, res) => {
    const stored = req.user?.review_mode;
    res.json({
      mode: REVIEW_MODE_IDS.has(stored) ? stored : "all",
      modes: REVIEW_MODES,
    });
  });
  app.put("/api/settings/review-mode", auth, (req, res) => {
    if (req.user?.role !== "teacher")
      return res.status(403).json({ error: "仅教师可设置作业复核方式" });
    if (req.user.is_school_admin)
      return res.status(403).json({ error: "学校管理员不参与作业复核" });
    let mode;
    try {
      mode = normalizeReviewMode(req.body?.mode);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    db.prepare("UPDATE users SET review_mode=? WHERE id=? AND school_id=?").run(
      mode,
      req.user.id,
      req.user.school_id,
    );
    res.json({ ok: true, mode });
  });
}
