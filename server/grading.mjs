// Persist only assignment-aligned verdicts and derive totals from bounded item scores.
export function normalizeReview(items, questions) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (
    !Array.isArray(items) ||
    items.length !== questions.length ||
    new Set(items.map((item) => item?.questionId)).size !== questions.length
  )
    throw new Error("复核题目必须与本作业一致且不重复");
  const normalized = items.map((item) => {
    const question = byId.get(item?.questionId);
    if (!question || typeof item.isCorrect !== "boolean")
      throw new Error("复核题目或正误标记无效");
    const max = Number(question.score);
    const score =
      item.score === undefined ? (item.isCorrect ? max : 0) : item.score;
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > max ||
      (item.isCorrect && score !== max) ||
      (!item.isCorrect && max > 0 && score === max)
    )
      throw new Error("逐题得分须在满分范围内并与正误一致");
    return { ...item, knowledgeId: question.knowledge_id || null, score };
  });
  const score =
    Math.round(normalized.reduce((sum, item) => sum + item.score, 0) * 1e8) /
    1e8;
  return { items: normalized, score };
}

// Direct grading ("no original questions") has no question-bank rows to join.
// The review endpoint still validates the teacher-confirmed verdicts against the
// parsed question snapshot, so the same invariants apply: one verdict per
// question, unique questionId, and a bounded score consistent with the verdict.
export function normalizeDirectReview(items, questions) {
  const list = Array.isArray(questions) ? questions : [];
  const byId = new Map(list.map((question) => [question.id, question]));
  if (
    !Array.isArray(items) ||
    items.length !== list.length ||
    new Set(items.map((item) => item?.questionId)).size !== list.length
  )
    throw new Error("复核题目必须与本作业一致且不重复");
  const normalized = items.map((item) => {
    const question = byId.get(item?.questionId);
    if (!question || typeof item.isCorrect !== "boolean")
      throw new Error("复核题目或正误标记无效");
    const max = Number(question.score);
    if (!Number.isFinite(max) || max < 0)
      throw new Error("复核题目或正误标记无效");
    const score =
      item.score === undefined ? (item.isCorrect ? max : 0) : item.score;
    if (
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > max ||
      (item.isCorrect && score !== max) ||
      (!item.isCorrect && max > 0 && score === max)
    )
      throw new Error("逐题得分须在满分范围内并与正误一致");
    return { ...item, knowledgeId: question.knowledgeId || null, score };
  });
  const score =
    Math.round(normalized.reduce((sum, item) => sum + item.score, 0) * 1e8) /
    1e8;
  return { items: normalized, score };
}

export const publicPractice = (questions) =>
  (Array.isArray(questions) ? questions : []).map((question) => ({
    prompt: String(question?.prompt || ""),
  }));

export function studentAnalysis(analysis) {
  if (!analysis || typeof analysis !== "object") return null;
  return {
    ...analysis,
    items: Array.isArray(analysis.items)
      ? analysis.items.map((item) => ({
          ...item,
          practiceQuestions: publicPractice(item.practiceQuestions),
        }))
      : [],
  };
}

export function practiceGrade(graded, count) {
  if (
    typeof graded?.passed !== "boolean" ||
    !Array.isArray(graded.results) ||
    graded.results.length !== count ||
    graded.results.some((item) => typeof item?.correct !== "boolean")
  )
    throw new Error("模型批改结果格式无效，请重试");
  const results = graded.results.map((item) => ({
    correct: item.correct,
    feedback: String(item.feedback || "").slice(0, 2000),
  }));
  return {
    results,
    passed:
      graded.passed === true && results.every((item) => item.correct === true),
  };
}
