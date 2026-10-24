import { useEffect, useRef, useState } from "react";
import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  ChevronRight,
  ClipboardCheck,
  RefreshCw,
  Sparkles,
  TrendingUp,
  UserPlus,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";

const relations = ["父亲", "母亲", "其他监护人"];

function pct(value: unknown) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "0%";
  return `${Math.round(rate * 100)}%`;
}

function dateText(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}

function dateTimeText(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", { hour12: false });
}

function Title({
  eyebrow,
  title,
  desc,
  action,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  action?: ReactNode;
}) {
  return (
    <div className="rc4-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{desc}</p>
      </div>
      {action}
    </div>
  );
}

function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {hint && <small style={{ color: "#98a2b2", fontSize: 12 }}>{hint}</small>}
    </label>
  );
}

function BindChildForm({
  onSubmit,
  busy,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
}) {
  return (
    <form className="rc4-panel" onSubmit={onSubmit}>
      <h2>
        <UserPlus size={19} /> 绑定孩子
      </h2>
      <p className="panel-intro">
        输入孩子的登录账号名和密码完成绑定；只能绑定本校学生，重复绑定不会产生新记录。
      </p>
      <Field
        name="childUsername"
        label="孩子账号名"
        placeholder="孩子的登录账号（或邮箱）"
        autoComplete="off"
        required
      />
      <div className="field-row">
        <Field
          name="childPassword"
          label="孩子密码"
          type="password"
          autoComplete="off"
          placeholder="用于验证亲子关系"
          required
        />
        <label className="field">
          <span>与孩子的关系</span>
          <select name="relation" defaultValue="母亲">
            {relations.map((relation) => (
              <option key={relation} value={relation}>
                {relation}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Button className="full" disabled={busy}>
        {busy ? "正在绑定…" : "绑定孩子"}
      </Button>
    </form>
  );
}

function InsightContent({ content }: { content: any }) {
  const insight = content || {};
  const strengths = Array.isArray(insight.strengths) ? insight.strengths : [];
  const weaknesses = Array.isArray(insight.weaknesses)
    ? insight.weaknesses
    : [];
  const subjects = Array.isArray(insight.subjectAnalysis)
    ? insight.subjectAnalysis
    : [];
  const habits = Array.isArray(insight.studyHabits) ? insight.studyHabits : [];
  const actions = Array.isArray(insight.homeActions) ? insight.homeActions : [];
  return (
    <div style={{ display: "grid", gap: 18 }}>
      {insight.summary && (
        <div className="auto-explanation">
          <strong>总体学情</strong>
          <p>{insight.summary}</p>
        </div>
      )}
      {strengths.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>优势</h3>
          <ul style={{ display: "grid", gap: 6, paddingLeft: 20 }}>
            {strengths.map((item: string, index: number) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {weaknesses.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>薄弱点与建议</h3>
          <div style={{ display: "grid", gap: 10 }}>
            {weaknesses.map((item: any, index: number) => (
              <div
                key={index}
                style={{
                  border: "1px solid #e7ebf1",
                  borderRadius: 10,
                  padding: 14,
                }}
              >
                <strong>{item.knowledge || "待补充知识点"}</strong>
                {item.evidence && (
                  <p style={{ color: "#627187", marginTop: 6 }}>
                    依据：{item.evidence}
                  </p>
                )}
                {item.suggestion && (
                  <p style={{ color: "#2f6bb0", marginTop: 4 }}>
                    建议：{item.suggestion}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {subjects.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>学科表现</h3>
          <div className="data-table">
            <div>
              <b>学科</b>
              <b>水平</b>
              <b style={{ gridColumn: "span 2" }}>说明</b>
            </div>
            {subjects.map((item: any, index: number) => (
              <div key={index}>
                <span>{item.subject}</span>
                <span>{item.level}</span>
                <span style={{ gridColumn: "span 2" }}>{item.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {habits.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>学习习惯观察</h3>
          <ul style={{ display: "grid", gap: 6, paddingLeft: 20 }}>
            {habits.map((item: string, index: number) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {actions.length > 0 && (
        <div>
          <h3 style={{ marginBottom: 8 }}>家长在家可以做的事</h3>
          <div className="data-table">
            <div>
              <b>做什么</b>
              <b>怎么做</b>
              <b>频率</b>
              <b />
            </div>
            {actions.map((item: any, index: number) => (
              <div key={index}>
                <span>{item.action}</span>
                <span>{item.how}</span>
                <span>{item.frequency}</span>
                <span />
              </div>
            ))}
          </div>
        </div>
      )}
      {insight.encouragement && (
        <div className="save-status">
          <strong>给孩子的鼓励：</strong>
          {insight.encouragement}
        </div>
      )}
    </div>
  );
}

export function ParentDashboard({
  user,
  notify,
}: {
  user: any;
  notify: (s: string) => void;
}) {
  const [children, setChildren] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [dashboard, setDashboard] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [insight, setInsight] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [bindBusy, setBindBusy] = useState(false);
  const [showBind, setShowBind] = useState(false);
  const generation = useRef(0);

  const selected = children.find((child) => child.id === selectedId) || null;

  const loadChildData = async (studentId: string) => {
    const ticket = ++generation.current;
    const [dashboardData, insightData] = await Promise.all([
      api<any>(`/parent/children/${studentId}/dashboard`),
      api<any>(`/parent/children/${studentId}/insights`),
    ]);
    if (ticket !== generation.current) return;
    setDashboard(dashboardData);
    setInsight(insightData);
  };

  const loadChildren = async () => {
    const rows = await api<any[]>("/parent/children");
    setChildren(rows);
    const next =
      (selectedId && rows.some((row) => row.id === selectedId)
        ? selectedId
        : rows[0]?.id) || "";
    setSelectedId(next);
    return rows;
  };

  useEffect(() => {
    void loadChildren()
      .catch((error) => notify((error as Error).message))
      .finally(() => setLoading(false));
    // 只在挂载时读取一次孩子列表。
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDashboard(null);
      setInsight(null);
      setDetail(null);
      return;
    }
    setDetail(null);
    setDetailLoading(false);
    setDashboard(null);
    setInsight(null);
    void loadChildData(selectedId).catch((error) =>
      notify((error as Error).message),
    );
    // selectedId 变化时重新拉取该孩子的看板与分析。
  }, [selectedId]);

  const bindChild = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBindBusy(true);
    try {
      const result = await api<any>(
        "/parent/children/bind",
        json("POST", Object.fromEntries(new FormData(form))),
      );
      notify(`已绑定孩子：${result.studentName}`);
      form.reset();
      setShowBind(false);
      const rows = await loadChildren();
      const target =
        rows.find((row) => row.id === result.id) ||
        rows.find((row) => row.name === result.studentName);
      if (target && target.id !== selectedId) setSelectedId(target.id);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBindBusy(false);
    }
  };

  const openDetail = async (submissionId: string) => {
    if (!selectedId) return;
    setDetailLoading(true);
    try {
      setDetail(
        await api<any>(
          `/parent/children/${selectedId}/submissions/${submissionId}`,
        ),
      );
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  const analyze = async () => {
    if (!selectedId || analyzing) return;
    setAnalyzing(true);
    try {
      const result = await api<any>(
        `/parent/children/${selectedId}/insights/analyze`,
        { method: "POST" },
      );
      setInsight(result.insight);
      if (result.stats) setDashboard(result.stats);
      notify("AI 学情分析已生成。");
    } catch (error) {
      notify(`${(error as Error).message}。请到「设置」中完成模型配置后再试。`);
    } finally {
      setAnalyzing(false);
    }
  };

  const refresh = async () => {
    try {
      const rows = await loadChildren();
      const target =
        rows.find((row) => row.id === selectedId)?.id || rows[0]?.id;
      if (target && target !== selectedId) setSelectedId(target);
      else if (target) await loadChildData(target);
      notify("家长看板已刷新。");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const header = (
    <Title
      eyebrow="PARENT WORKSPACE"
      title={selected ? `${selected.name}的学习看板` : "家长看板"}
      desc={`${user?.name || "家长"}，这里只展示已绑定孩子、且教师已复核的作业数据。`}
      action={
        <Button
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw />
          刷新
        </Button>
      }
    />
  );

  if (loading)
    return (
      <>
        {header}
        <section className="rc4-panel">
          <p>正在读取孩子信息…</p>
        </section>
      </>
    );

  if (!children.length)
    return (
      <>
        {header}
        <BindChildForm onSubmit={bindChild} busy={bindBusy} />
        <section className="rc4-panel" style={{ marginTop: 20 }}>
          <h2>
            <ClipboardCheck size={19} /> 绑定后可查看
          </h2>
          <p className="panel-intro">
            已复核作业、逐题批改结果与参考答案、薄弱知识点、错因分布、成绩趋势，以及
            AI 学情分析。
          </p>
        </section>
      </>
    );

  const summary = dashboard?.summary || {
    reviewedSubmissions: 0,
    averageScoreRate: 0,
    mistakeCount: 0,
    masteredCount: 0,
    masteryRate: 0,
  };
  const metrics: [string, string, string][] = [
    ["已复核作业", String(summary.reviewedSubmissions || 0), "份"],
    ["平均得分率", pct(summary.averageScoreRate), ""],
    ["错题数", String(summary.mistakeCount || 0), "道"],
    ["已掌握率", pct(summary.masteryRate), ""],
  ];
  const subjects = Array.isArray(dashboard?.subjects) ? dashboard.subjects : [];
  const recent = Array.isArray(dashboard?.recent) ? dashboard.recent : [];
  const knowledge = Array.isArray(dashboard?.knowledge)
    ? dashboard.knowledge
    : [];
  const reasons = Array.isArray(dashboard?.reasons) ? dashboard.reasons : [];
  const trend = Array.isArray(dashboard?.trend) ? dashboard.trend : [];

  return (
    <>
      {header}
      <section className="rc4-panel" style={{ marginBottom: 20 }}>
        <div className="detail-head" style={{ marginBottom: 0 }}>
          <div>
            <h2>{selected?.name || "孩子"}</h2>
            <p>
              {selected?.stage || "学段未标注"} ·{" "}
              {selected?.class_name || "班级未标注"} · 关系：
              {selected?.relation || "家长"} · {selected?.school_name || ""}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {children.length > 1 && (
              <label className="field" style={{ marginBottom: 0 }}>
                <span>切换孩子</span>
                <select
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {children.map((child) => (
                    <option key={child.id} value={child.id}>
                      {child.name} · {child.class_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              variant="outline"
              onClick={() => setShowBind((value) => !value)}
            >
              <UserPlus />
              绑定其他孩子
            </Button>
          </div>
        </div>
      </section>
      {showBind && (
        <div style={{ marginBottom: 20 }}>
          <BindChildForm onSubmit={bindChild} busy={bindBusy} />
        </div>
      )}
      {detailLoading && (
        <section className="rc4-panel" style={{ marginBottom: 20 }}>
          <p>正在加载答卷明细…</p>
        </section>
      )}
      {detail && !detailLoading && (
        <section className="rc4-panel" style={{ marginBottom: 20 }}>
          <div className="detail-head">
            <div>
              <h2>{detail.title}</h2>
              <p>
                {detail.subject} · 得分 {detail.score ?? "—"} /{" "}
                {detail.totalScore ?? "—"} · 复核时间{" "}
                {dateText(detail.reviewedAt)}
              </p>
            </div>
            <Button variant="outline" onClick={() => setDetail(null)}>
              返回看板
            </Button>
          </div>
          {detail.items?.length ? (
            detail.items.map((item: any, index: number) => (
              <div className="review-item" key={`${item.number}-${index}`}>
                <div>
                  <strong>第 {item.number} 题</strong>
                  <span className={item.isCorrect ? "" : "low"}>
                    {item.isCorrect ? "正确" : "错误"} · {item.score ?? 0}/
                    {item.maxScore ?? "—"} 分
                  </span>
                </div>
                {item.prompt && (
                  <p style={{ marginTop: 10 }}>
                    <strong>题目：</strong>
                    {item.prompt}
                  </p>
                )}
                <div className="answer-grid" style={{ marginTop: 10 }}>
                  <p>
                    <b>学生作答</b>
                    {item.studentAnswer || "（未作答）"}
                  </p>
                  <p>
                    <b>参考答案</b>
                    {item.standardAnswer || "（未提供）"}
                  </p>
                </div>
                {item.reason && (
                  <p style={{ marginTop: 10 }}>
                    <strong>错因：</strong>
                    {item.reason}
                  </p>
                )}
                {item.reasoning && (
                  <div className="auto-explanation">
                    <strong>AI 判断逻辑</strong>
                    <p>{item.reasoning}</p>
                  </div>
                )}
                {item.correction && (
                  <p style={{ marginTop: 10 }}>
                    <strong>订正：</strong>
                    {item.correction}
                  </p>
                )}
                {item.explanation && (
                  <p style={{ marginTop: 8, color: "#627187" }}>
                    <strong>解析：</strong>
                    {item.explanation}
                  </p>
                )}
              </div>
            ))
          ) : (
            <p className="panel-intro">这份作业没有可展示的逐题明细。</p>
          )}
        </section>
      )}
      <div className="metric-grid">
        {metrics.map(([label, value, unit]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>
              {value}
              {unit && <small>{unit}</small>}
            </strong>
          </div>
        ))}
      </div>
      <div className="two-col">
        <section className="rc4-panel">
          <h2>
            <BarChart3 size={19} /> 学科表现
          </h2>
          {subjects.length ? (
            <div className="data-table">
              <div>
                <b>学科</b>
                <b>已复核</b>
                <b>平均得分率</b>
                <b>错题数</b>
              </div>
              {subjects.map((subject: any) => (
                <div key={subject.subject}>
                  <span>{subject.subject}</span>
                  <span>{subject.reviewedSubmissions} 份</span>
                  <span>{pct(subject.averageScoreRate)}</span>
                  <span>{subject.mistakeCount} 道</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-intro">还没有已复核的作业。</p>
          )}
        </section>
        <section className="rc4-panel">
          <h2>
            <ClipboardCheck size={19} /> 近期作业
          </h2>
          {recent.length ? (
            <div className="select-list">
              {recent.map((item: any) => (
                <button
                  key={item.submissionId}
                  type="button"
                  onClick={() => void openDetail(item.submissionId)}
                >
                  <div>
                    <strong>{item.assignmentTitle || "未命名作业"}</strong>
                    <small>
                      {item.subject || "未标注学科"} ·{" "}
                      {dateText(item.reviewedAt)}
                    </small>
                  </div>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {item.score ?? "—"}/{item.totalScore ?? "—"} 分 ·{" "}
                    {pct(item.scoreRate)}
                    <ChevronRight size={16} />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="panel-intro">还没有已复核的作业。</p>
          )}
        </section>
      </div>
      <div className="two-col" style={{ marginTop: 20 }}>
        <section className="rc4-panel">
          <h2>
            <BookOpen size={19} /> 薄弱知识点
          </h2>
          {knowledge.length ? (
            <div className="knowledge-list">
              {knowledge.map((point: any) => (
                <div key={point.title}>
                  <span>
                    <BookOpen size={18} />
                  </span>
                  <div>
                    <strong>{point.title}</strong>
                    <small>
                      {point.subject || "未标注学科"} · 错题{" "}
                      {point.mistakeCount} 道
                      {point.questionNumbers?.length
                        ? ` · 题号 ${point.questionNumbers.join("、")}`
                        : ""}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-intro">暂时没有错题知识点。</p>
          )}
        </section>
        <section className="rc4-panel">
          <h2>
            <BrainCircuit size={19} /> 错因分布
          </h2>
          {reasons.length ? (
            <div className="mastery-bars">
              {reasons.map((reason: any) => (
                <div className="mastery-row" key={reason.label}>
                  <div>
                    <span>{reason.label}</span>
                    <strong>
                      {reason.count} 道 · {reason.share}%
                    </strong>
                  </div>
                  <div className="bar-track">
                    <div
                      style={{
                        width: `${Math.max(2, Number(reason.share) || 0)}%`,
                        background: "linear-gradient(90deg, #4b85ce, #8bb8ea)",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="panel-intro">暂时没有错题错因数据。</p>
          )}
        </section>
      </div>
      <section className="rc4-panel" style={{ marginTop: 20 }}>
        <h2>
          <TrendingUp size={19} /> 成绩趋势
        </h2>
        {trend.length ? (
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 14,
              height: 170,
              paddingTop: 10,
            }}
          >
            {trend.map((item: any) => (
              <div
                key={item.submissionId}
                style={{
                  flex: 1,
                  display: "grid",
                  justifyItems: "center",
                  alignContent: "end",
                  gap: 6,
                  minWidth: 0,
                }}
              >
                <small style={{ color: "#6b7f9b" }}>
                  {pct(item.scoreRate)}
                </small>
                <div
                  title={`${item.title} · ${dateText(item.reviewedAt)}`}
                  style={{
                    width: "100%",
                    maxWidth: 46,
                    height: `${Math.max(4, (Number(item.scoreRate) || 0) * 120)}px`,
                    background: "linear-gradient(180deg, #4b85ce, #a9cbef)",
                    borderRadius: "6px 6px 2px 2px",
                  }}
                />
                <small
                  style={{
                    color: "#98a2b2",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "100%",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dateText(item.reviewedAt)}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <p className="panel-intro">积累更多已复核作业后可以看到成绩趋势。</p>
        )}
      </section>
      <section className="rc4-panel" style={{ marginTop: 20 }}>
        <div className="detail-head">
          <div>
            <h2>
              <Sparkles size={19} /> AI 学情分析
            </h2>
            <p>
              {insight
                ? `生成时间 ${dateTimeText(insight.created_at)}${insight.model ? ` · ${insight.model}` : ""}`
                : "基于已复核作业的确定性统计生成，不会编造数字。"}
            </p>
          </div>
          <Button onClick={() => void analyze()} disabled={analyzing}>
            <RefreshCw />
            {analyzing
              ? "正在生成…"
              : insight
                ? "重新生成"
                : "生成 AI 学情分析"}
          </Button>
        </div>
        {insight ? (
          <InsightContent content={insight.content} />
        ) : (
          <p className="panel-intro">
            还没有学情分析。点击右上角「生成 AI
            学情分析」，系统会把统计结果转换成给家长看的优势、薄弱点与家庭建议。
          </p>
        )}
      </section>
    </>
  );
}
