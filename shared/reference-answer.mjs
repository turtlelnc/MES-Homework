// Only remove explicit marking sections for objective questions. Keep explanations
// and all subjective rubrics intact; never infer type from the answer text alone.
export function referenceAnswer(answer, prompt = "", type = "") {
  const value = typeof answer === "string" ? answer.trim() : "";
  if (
    !/^(choice|fill|选择题|填空题)$/.test(type) &&
    !/(选择题|填空题|[（(]单选[）)]|[（(]多选[）)])/.test(prompt)
  )
    return value;
  return value
    .split(
      /(?:\r?\n|[；;])\s*(?:#{1,4}\s*)?(?:\*\*)?(?:评分要点|评分标准|给分点|赋分标准)\s*[:：]/,
    )[0]
    .trim();
}
