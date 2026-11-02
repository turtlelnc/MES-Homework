import { useState } from "react";
import { api } from "./api";
import { Button } from "./components/ui/button";
export function DirectTeachingAnalysis({
  id,
  initial,
}: {
  id: string;
  initial?: any;
}) {
  const [content, setContent] = useState(initial || null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      setContent(
        (
          await api<any>(`/submissions/${id}/teaching-analysis`, {
            method: "POST",
          })
        ).content,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rc4-panel">
      <h2>AI 答卷教学分析</h2>
      <p>根据这位学生已确认的答卷生成讲评与辅导建议。</p>
      <Button onClick={() => void generate()} disabled={busy}>
        {busy ? "正在分析…" : content ? "重新生成教学分析" : "生成教学分析"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {content && (
        <div>
          <p>{content.brief}</p>
          {content.keyFindings?.map((f: any, i: number) => (
            <article key={i}>
              <h3>{f.title}</h3>
              <p>{f.detail}</p>
              <p>建议：{f.action}</p>
            </article>
          ))}
          {content.questionReviews?.map((q: any, i: number) => (
            <article key={i}>
              <h3>
                第 {q.number} 题 · {q.knowledge}
              </h3>
              <p>{q.whyWrong}</p>
              <p>{q.explainToStudents}</p>
              <p>{q.boardWork}</p>
              <p>检查：{q.quickCheck}</p>
            </article>
          ))}
          {content.teacherScript && <p>{content.teacherScript}</p>}
        </div>
      )}
    </section>
  );
}
