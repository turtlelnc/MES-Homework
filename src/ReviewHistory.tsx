import { useEffect, useState } from "react";
import { api } from "./api";
type Entry = {
  id: string;
  action: string;
  actor_id: string;
  created_at: string;
  before_json: string;
  after_json: string;
};
const labels: Record<string, string> = {
  recognition_requested: "请求重新批改",
  review_saved: "保存教师复核",
  auto_review_saved: "自动复核",
};
const summary = (raw: string) => {
  try {
    const x = JSON.parse(raw);
    return `状态：${x.status ?? "—"}，分数：${x.score ?? "未评分"}，已复核：${x.reviewed ? "是" : "否"}`;
  } catch {
    return "记录无法解析";
  }
};
export function ReviewHistory({ submissionId }: { submissionId: string }) {
  const [rows, setRows] = useState<Entry[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setLoaded(false);
    setError("");
    void api<Entry[]>(`/submissions/${submissionId}/review-history`, {
      signal: controller.signal,
    })
      .then((v) => {
        if (!controller.signal.aborted) {
          setRows(v);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [submissionId]);
  return (
    <details className="rc4-panel">
      <summary>批改与复核历史</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : !loaded ? (
        <p>正在读取记录…</p>
      ) : !rows.length ? (
        <p>暂无复核记录。</p>
      ) : (
        rows.map((row) => (
          <article key={row.id}>
            <strong>{labels[row.action] || row.action}</strong>
            <p>
              {new Date(row.created_at).toLocaleString()} · 操作账户{" "}
              {row.actor_id}
            </p>
            <p>之前：{summary(row.before_json)}</p>
            <p>之后：{summary(row.after_json)}</p>
          </article>
        ))
      )}
    </details>
  );
}
