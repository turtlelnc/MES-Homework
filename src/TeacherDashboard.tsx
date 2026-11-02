import { useEffect, useState } from "react";
import { api } from "./api";
export function TeacherDashboard({ revision = 0 }: { revision?: number }) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<any>("/teacher/dashboard", { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [revision]);
  return (
    <section className="rc4-panel">
      <h2>教学数据看板</h2>
      <p className="panel-intro">
        按作业查看提交、批改进度和班级平均得分率；仅统计你负责的作业。
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>正在加载…</p>
      ) : (
        <>
          <div className="metric-grid">
            {[
              ["作业", data.assignments],
              ["答卷", data.submissions],
              ["待处理", data.pending],
              ["未绑定学生", data.unlinked],
            ].map(([label, value]) => (
              <div className="metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          {data.rows.length ? (
            <div className="data-table">
              <div>
                <b>作业</b>
                <b>班级</b>
                <b>批改 / 提交</b>
                <b>平均得分率</b>
              </div>
              {data.rows.map((row: any) => (
                <div key={row.id}>
                  <span>{row.title}</span>
                  <span>{row.class_name}</span>
                  <span>
                    {row.completed} / {row.submissions}
                  </span>
                  <span>
                    {row.averageRate === null
                      ? "暂无数据"
                      : `${Math.round(row.averageRate * 100)}%`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p>发布第一份作业后，这里会自动汇总数据。</p>
          )}
        </>
      )}
    </section>
  );
}
