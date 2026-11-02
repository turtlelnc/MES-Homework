/** Unified per-question mastery scale. Numerical scores remain available for teacher review. */
export function questionGrade(score: unknown, maximum: unknown): string {
  if (score === "" || maximum === "") return "待评定";
  if (
    score === null ||
    score === undefined ||
    maximum === null ||
    maximum === undefined
  )
    return "待评定";
  const earned = Number(score),
    total = Number(maximum);
  if (
    !Number.isFinite(earned) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    earned < 0 ||
    earned > total
  )
    return "待评定";
  const rate = earned / total;
  return rate >= 0.95
    ? "A+"
    : rate >= 0.85
      ? "A"
      : rate >= 0.75
        ? "B+"
        : rate >= 0.6
          ? "B"
          : "C";
}
