import { useEffect, useState } from "react";
import { api } from "./api";
type Detail = {
  title: string;
  description: string;
  grading_mode: string;
  questions: {
    id: string;
    number: number;
    prompt: string;
    score: number;
    standard_answer?: string;
  }[];
};
export function AssignmentDetails({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setError("");
    if (id)
      void api<Detail>(`/assignments/${id}`, { signal: controller.signal })
        .then((v) => {
          if (!controller.signal.aborted) setDetail(v);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    return () => controller.abort();
  }, [id]);
  if (!id) return null;
  return (
    <section className="rc4-panel">
      <h2>{detail?.title || "作业详情"}</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : !detail ? (
        <p>正在读取题目…</p>
      ) : (
        <>
          <p>{detail.description}</p>
          {detail.grading_mode === "direct" ? (
            <p>此作业按答卷直接批改，无预先录入的题库。</p>
          ) : (
            detail.questions.map((q) => (
              <article key={q.id}>
                <strong>
                  第 {q.number} 题 · {q.score} 分
                </strong>
                <p>{q.prompt}</p>
                {q.standard_answer !== undefined && (
                  <details>
                    <summary>教师参考答案</summary>
                    {q.standard_answer}
                  </details>
                )}
              </article>
            ))
          )}
        </>
      )}
    </section>
  );
}
