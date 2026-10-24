export type ReviewQuestion = {
  id: string;
  number: number;
  prompt: string;
  score: number;
  standard_answer?: string;
};
export type ReviewItem = {
  questionId: string;
  studentAnswer?: string;
  correction?: string;
  explanation?: string;
  reason?: string;
  reasoning?: string;
  confidence?: number;
  isCorrect?: boolean;
  score?: number | string;
  suspect?: boolean;
  confirmed?: boolean;
};
type Ticket = { id: string | null; generation: number };

// A result belongs to the selection that started it, even when A is selected again.
export function createReviewGuard() {
  let generation = 0;
  let selection: Ticket = { id: null, generation };
  const operations = new Map<string, Ticket>();
  return {
    select(id: string | null) {
      selection = { id, generation: ++generation };
      return selection;
    },
    current() {
      return selection;
    },
    isCurrent(ticket: Ticket) {
      return (
        ticket.id === selection.id && ticket.generation === selection.generation
      );
    },
    startOperation(id: string) {
      if (operations.has(id)) return null;
      const ticket = { id, generation: ++generation };
      operations.set(id, ticket);
      return ticket;
    },
    finishOperation(ticket: Ticket) {
      if (!ticket.id || operations.get(ticket.id) !== ticket) return false;
      operations.delete(ticket.id);
      return true;
    },
  };
}

export function reviewRows(questions: ReviewQuestion[], items: ReviewItem[]) {
  if (
    !Array.isArray(questions) ||
    !Array.isArray(items) ||
    questions.some((q) => !q || typeof q !== "object") ||
    items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.questionId !== "string",
    )
  )
    return { rows: [], error: "识别题目与作业不匹配，请重新识别后再复核。" };
  const byId = new Map(items.map((item) => [item.questionId, item]));
  if (
    !questions.length ||
    byId.size !== items.length ||
    new Set(questions.map((q) => q.id)).size !== questions.length ||
    questions.length !== items.length ||
    questions.some(
      (q) => !byId.has(q.id) || !Number.isFinite(q.score) || q.score < 0,
    )
  )
    return { rows: [], error: "识别题目与作业不匹配，请重新识别后再复核。" };
  return {
    rows: [...questions]
      .sort((a, b) => a.number - b.number)
      .map((question) => ({ question, item: byId.get(question.id)! })),
    error: "",
  };
}

export function changeReviewGrade(
  item: ReviewItem,
  question: ReviewQuestion,
  change: { isCorrect: boolean } | { score: string },
): ReviewItem {
  if ("isCorrect" in change) {
    const score = Number(item.score);
    return {
      ...item,
      isCorrect: change.isCorrect,
      score: change.isCorrect
        ? question.score
        : Number.isFinite(score) && score >= 0 && score < question.score
          ? score
          : 0,
    };
  }
  const score = change.score === "" ? NaN : Number(change.score);
  return {
    ...item,
    score: change.score,
    isCorrect:
      question.score === 0
        ? item.isCorrect === true
        : Number.isFinite(score) && score === question.score,
  };
}

export function reviewScoreError(
  questions: ReviewQuestion[],
  items: ReviewItem[],
) {
  const result = reviewRows(questions, items);
  if (result.error) return result.error;
  for (const { question, item } of result.rows) {
    const score =
      item.score === "" || item.score == null ? NaN : Number(item.score);
    if (
      !Number.isFinite(score) ||
      score < 0 ||
      score > question.score ||
      typeof item.isCorrect !== "boolean" ||
      (item.isCorrect && score !== question.score) ||
      (!item.isCorrect && question.score > 0 && score >= question.score)
    ) {
      return `请检查第 ${question.number} 题得分（0–${question.score}）及正误判断。`;
    }
  }
  return "";
}

export function normalizeReviewDetail<
  T extends {
    questions?: ReviewQuestion[];
    analysis?: { items?: ReviewItem[] } | null;
  },
>(detail: T): T {
  if (!detail.analysis) return detail;
  if (
    !Array.isArray(detail.analysis.items) ||
    detail.analysis.items.some((item) => !item || typeof item !== "object")
  )
    return { ...detail, analysis: { ...detail.analysis, items: [] } };
  const questions = new Map((detail.questions || []).map((q) => [q.id, q]));
  return {
    ...detail,
    analysis: {
      ...detail.analysis,
      items: detail.analysis.items.map((item) => {
        const question = questions.get(item.questionId);
        if (!question) return item;
        const score = Number(item.score);
        const isCorrect = item.isCorrect === true;
        return {
          ...item,
          isCorrect,
          score: isCorrect
            ? question.score
            : Number.isFinite(score) && score >= 0 && score < question.score
              ? score
              : 0,
        };
      }),
    },
  };
}
