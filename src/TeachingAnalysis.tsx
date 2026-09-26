import React, { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  BookOpenCheck,
  CheckCircle2,
  ClipboardList,
  Download,
  GraduationCap,
  Layers,
  Lightbulb,
  ListChecks,
  MessageSquareQuote,
  Printer,
  RefreshCw,
  ScanEye,
  Sparkles,
  Target,
  UserRound,
  Users,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  ClassAnalysis,
  FocusEntry,
  KnowledgeEntry,
  StudentAnalysis,
  StudentDetail,
  StudentEntry,
  TeachingStats,
  TeachingAssignment,
  focusLevels,
  generateClassAnalysis,
  generateStudentAnalysis,
  listTeachingAssignments,
  loadStudentAnalysis,
  loadTeachingAnalysis,
  mistakesToAssignment,
  refineReasonTypes,
  saveFocus,
} from "./analysis-api";

type Notify = (message: string) => void;

const percent = (value: number) => `${Math.round((Number(value) || 0) * 100)}%`;

const plainText = (value?: string) => String(value || "").trim();

const rateTone = (value: number) =>
  value >= 0.8 ? "good" : value >= 0.5 ? "warn" : "bad";

const stamp = (value?: string) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "";

function RateBar({
  value,
  label,
  right,
  tone,
}: {
  value: number;
  label: React.ReactNode;
  right?: React.ReactNode;
  tone?: string;
}) {
  const clamped = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div className="ta-rate">
      <div>
        {label}
        {right}
      </div>
      <span className="ta-track">
        <i
          className={`ta-fill ${tone || rateTone(clamped)}`}
          style={{ width: `${Math.round(clamped * 100)}%` }}
        />
      </span>
    </div>
  );
}

function Section({
  eyebrow,
  title,
  desc,
  action,
  children,
}: {
  eyebrow: string;
  title: string;
  desc?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rc4-panel ta-section">
      <div className="ta-section-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          {desc && <p>{desc}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function AiBlock({
  children,
  empty,
  onGenerate,
  busy,
  label = "生成 AI 教学方案",
}: {
  children?: React.ReactNode;
  empty?: string;
  onGenerate: () => void;
  busy: boolean;
  label?: string;
}) {
  if (children) return <>{children}</>;
  return (
    <div className="ta-ai-empty">
      <Sparkles size={20} />
      <strong>还没有 AI 教学方案</strong>
      <p>
        {empty ||
          "点击生成：AI 会读取已复核的错题、知识点与错因，输出可直接上课使用的讲评方案。"}
      </p>
      <Button disabled={busy} onClick={onGenerate}>
        <Sparkles />
        {busy ? "AI 正在分析…" : label}
      </Button>
    </div>
  );
}

/* ----------------------------- 班级教学分析 ----------------------------- */

export function TeachingAnalysis({
  notify,
}: {
  notify: Notify;
}) {
  const [assignments, setAssignments] = useState<TeachingAssignment[]>([]);
  const [selected, setSelected] = useState("");
  const [stats, setStats] = useState<TeachingStats | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [focus, setFocus] = useState<FocusEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [openQuestion, setOpenQuestion] = useState<number | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [student, setStudent] = useState<StudentEntry | null>(null);

  useEffect(() => {
    listTeachingAssignments()
      .then((rows) => {
        setAssignments(rows);
        setSelected((current) => current || rows[0]?.id || "");
      })
      .catch((error) => notify((error as Error).message));
  }, []);

  const reload = (id: string) => {
    setLoading(true);
    return loadTeachingAnalysis(id)
      .then((data) => {
        setStats(data.stats);
        setAnalysis(data.analysis);
        setFocus(data.focus || []);
        setPicked([]);
        setOpenQuestion(data.stats.highFrequencyQuestions[0]?.number ?? null);
      })
      .catch((error) => {
        setStats(null);
        setAnalysis(null);
        notify((error as Error).message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (selected) reload(selected);
  }, [selected]);

  const runAnalysis = async () => {
    if (!selected) return;
    setAnalyzing(true);
    try {
      const result = await generateClassAnalysis(selected);
      setAnalysis(result.analysis);
      setStats(result.stats);
      notify("AI 教学方案已生成，可直接用于课堂讲评。");
      listTeachingAssignments().then(setAssignments).catch(() => {});
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const runRefine = async () => {
    if (!selected || !stats) return;
    setRefining(true);
    try {
      const result = await refineReasonTypes(selected);
      setStats({ ...stats, reasonDistribution: result.reasonDistribution });
      notify("已用 AI 重新归因，错因统计已更新。");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setRefining(false);
    }
  };

  const setFocusLevel = async (studentId: string, level: string) => {
    try {
      const result = await saveFocus(selected, studentId, { level });
      setFocus((current) => {
        const rest = current.filter((item) => item.student_id !== studentId);
        if (!result.level) return rest;
        const previous = current.find((item) => item.student_id === studentId);
        return [
          ...rest,
          {
            student_id: studentId,
            level: result.level as FocusEntry["level"],
            note: previous?.note || "",
          },
        ];
      });
      notify(result.level ? "已更新跟进名单。" : "已从跟进名单移除。");
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const togglePick = (number: number) =>
    setPicked((current) =>
      current.includes(number)
        ? current.filter((item) => item !== number)
        : [...current, number],
    );

  const reAssign = async () => {
    const numbers = picked.length
      ? picked
      : (stats?.highFrequencyQuestions || [])
          .slice(0, 5)
          .map((question) => question.number);
    if (!numbers.length) return notify("没有可重新布置的错题。");
    try {
      const result = await mistakesToAssignment(selected, { numbers });
      notify(
        `已生成新的重练作业《${result.title}》，覆盖 ${result.knowledgePoints.length} 个知识点。`,
      );
      listTeachingAssignments().then(setAssignments).catch(() => {});
    } catch (error) {
      notify((error as Error).message);
    }
  };

  const overview = stats?.overview;
  const focusMap = useMemo(
    () => new Map(focus.map((item) => [item.student_id, item])),
    [focus],
  );

  return (
    <>
      <div className="ta-head">
        <div>
          <span className="eyebrow">AI TEACHING ANALYSIS</span>
          <h1>AI 教学分析</h1>
          <p>
            把教师复核后的错题直接换算成课堂讲评方案、班级学情画像和课后重练作业，
            批改结果不用再手工统计。
          </p>
        </div>
        <div className="ta-head-actions">
          <label className="field">
            <span>选择作业</span>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">请选择一份已复核作业</option>
              {assignments.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {item.class_name} · 错题 {item.mistake_count}
                </option>
              ))}
            </select>
          </label>
          <Button disabled={!selected || analyzing} onClick={runAnalysis}>
            <Sparkles />
            {analyzing ? "AI 正在分析…" : "生成 AI 教学方案"}
          </Button>
        </div>
      </div>

      {loading && (
        <div className="rc4-panel ta-loading">
          <div className="loading-ring" />
          <p>正在统计复核数据…</p>
        </div>
      )}

      {!loading && !assignments.length && (
        <section className="rc4-panel">
          <div className="rc4-empty">
            <BarChart3 />
            <p>还没有作业。先在“作业与上传”发布作业，再上传并复核学生答卷。</p>
          </div>
        </section>
      )}

      {!loading && stats && !overview?.mistakeCount && (
        <section className="rc4-panel">
          <div className="rc4-empty">
            <ScanEye />
            <p>
              《{stats.assignment.title}》暂无已复核错题。先到“识别与复核”完成 OCR
              与教师复核，这里会自动生成班级学情统计。
            </p>
          </div>
        </section>
      )}

      {!loading && stats && overview && overview.mistakeCount > 0 && (
        <>
          <div className="ta-metrics">
            {[
              {
                label: "已复核学生",
                value: overview.studentCount,
                unit: "人",
                foot: `共提交 ${overview.submissionTotal} 份${overview.pendingCount ? ` · 待复核 ${overview.pendingCount} 份` : ""}`,
                icon: Users,
                tone: "blue",
              },
              {
                label: "班级得分率",
                value: `${Math.round(overview.scoreRate * 100)}`,
                unit: "%",
                foot: `平均 ${overview.averageScore} / ${overview.totalScore} 分`,
                icon: Target,
                tone: "green",
              },
              {
                label: "错题数",
                value: overview.mistakeCount,
                unit: "道",
                foot: `占全部答题 ${percent(overview.errorRate)} · 可用于分析 ${overview.usefulMistakeCount} 道${
                  overview.pendingMistakeCount
                    ? ` · 另有 ${overview.pendingMistakeCount} 道待复核未计入`
                    : ""
                }`,
                icon: AlertCircle,
                tone: "orange",
              },
              {
                label: "排查隐患",
                value: overview.unreadableCount,
                unit: "道",
                foot: overview.unreadableCount
                  ? "无法辨认，需重新上传或人工核对"
                  : "无需重新识别的题目",
                icon: ScanEye,
                tone: "purple",
              },
            ].map((item) => (
              <div className="ta-metric" key={item.label}>
                <div className="ta-metric-top">
                  <span>{item.label}</span>
                  <i className={item.tone}>
                    <item.icon size={16} />
                  </i>
                </div>
                <strong>
                  {item.value}
                  <small>{item.unit}</small>
                </strong>
                <em>{item.foot}</em>
              </div>
            ))}
          </div>

          <Section
            eyebrow="CLASS INSIGHT"
            title="AI 教学结论"
            desc={
              analysis
                ? `生成于 ${stamp(analysis.created_at)}${analysis.model ? ` · ${analysis.model}` : ""}`
                : "基于已复核错题的确定性统计 + 模型转写"
            }
            action={
              <div className="ta-head-actions">
                {analysis && (
                  <Button variant="outline" onClick={() => window.print()}>
                    <Printer />
                    打印讲评单
                  </Button>
                )}
                {analysis && (
                  <Button
                    variant="outline"
                    onClick={() => downloadMarkdown(stats, analysis.content)}
                  >
                    <Download />
                    导出 Markdown
                  </Button>
                )}
                {analysis && (
                  <Button disabled={analyzing} onClick={runAnalysis}>
                    <RefreshCw />
                    {analyzing ? "重新分析中…" : "重新生成"}
                  </Button>
                )}
              </div>
            }
          >
            <AiBlock busy={analyzing} onGenerate={runAnalysis}>
              {analysis?.content ? (
                <div className="ta-brief">
                  <MessageSquareQuote size={20} />
                  <p>{analysis.content.brief || "模型未返回总结。"}</p>
                </div>
              ) : undefined}
            </AiBlock>

            {analysis?.content?.keyFindings?.length ? (
              <div className="ta-findings">
                {analysis.content.keyFindings.map((item: any, index: number) => (
                  <div key={index}>
                    <b>{String(index + 1).padStart(2, "0")}</b>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    {item.action && (
                      <span>
                        <CheckCircle2 size={14} />
                        {item.action}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}

            {analysis?.content?.teacherScript && (
              <div className="ta-script">
                <strong>课堂开场稿（可直接照读）</strong>
                <p>{analysis.content.teacherScript}</p>
              </div>
            )}
          </Section>

          <div className="ta-two-col">
            <Section
              eyebrow="KNOWLEDGE MASTERY"
              title="知识点掌握情况"
              desc="按正确率从低到高排序，红色代表本节课必须先补的漏洞。"
            >
              <div className="ta-rate-list">
                {stats.knowledgePoints.slice(0, 10).map((point) => (
                  <RateBar
                    key={point.id}
                    value={point.correctRate}
                    label={
                      <strong title={point.title}>
                        {point.title}
                        <small>
                          第 {point.questionNumbers.join("、")} 题
                        </small>
                      </strong>
                    }
                    right={
                      <em>
                        {percent(point.correctRate)}
                        <small>
                          {point.students.length} 人错 {point.errorCount} 次
                        </small>
                      </em>
                    }
                  />
                ))}
              </div>
              {stats.knowledgePoints.length > 10 && (
                <p className="ta-more">
                  还有 {stats.knowledgePoints.length - 10} 个知识点掌握良好，未在此列出。
                </p>
              )}
            </Section>

            <Section
              eyebrow="ERROR CAUSES"
              title="错因归因分析"
              desc="先由关键词规则确定性归类，可用 AI 结合题干重新判定。"
              action={
                <Button
                  variant="outline"
                  disabled={refining}
                  onClick={runRefine}
                >
                  <Sparkles />
                  {refining ? "AI 归因中…" : "AI 重新归因"}
                </Button>
              }
            >
              <div className="ta-reasons">
                {stats.reasonDistribution.map((reason) => (
                  <div key={reason.id} className="ta-reason">
                    <div className="ta-reason-head">
                      <i style={{ background: reason.color }} />
                      <strong>{reason.label}</strong>
                      <span>
                        {reason.count} 道 · {percent(reason.ratio)}
                      </span>
                    </div>
                    <span className="ta-track">
                      <i
                        className="ta-fill"
                        style={{
                          width: `${Math.max(4, Math.round(reason.ratio * 100))}%`,
                          background: reason.color,
                        }}
                      />
                    </span>
                    <p>{reason.hint}</p>
                    {reason.questions.length > 0 && (
                      <small>
                        集中在第{" "}
                        {reason.questions
                          .slice(0, 6)
                          .map((question) => question.number)
                          .join("、")}{" "}
                        题
                      </small>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          </div>

          <Section
            eyebrow="REVIEW SCRIPT"
            title="高频错题讲评单"
            desc="按出错人数排序，点开即可看到错因、订正与讲评脚本。"
            action={
              <div className="ta-head-actions">
                <Button variant="outline" onClick={reAssign}>
                  <ClipboardList />
                  {picked.length
                    ? `把选中的 ${picked.length} 题重新布置`
                    : "一键生成重练作业"}
                </Button>
              </div>
            }
          >
            <div className="ta-questions">
              {stats.highFrequencyQuestions.map((question, index) => {
                const open = openQuestion === question.number;
                const insight = analysis?.content?.questionReviews?.find(
                  (item: any) => Number(item.number) === question.number,
                );
                return (
                  <div
                    key={question.id}
                    className={`ta-question ${open ? "open" : ""}`}
                  >
                    <div className="ta-question-head">
                      <label className="ta-pick">
                        <input
                          type="checkbox"
                          checked={picked.includes(question.number)}
                          onChange={() => togglePick(question.number)}
                        />
                      </label>
                      <button
                        className="ta-question-toggle"
                        onClick={() =>
                          setOpenQuestion(open ? null : question.number)
                        }
                      >
                        <b>{index + 1}</b>
                        <div>
                          <strong>第 {question.number} 题</strong>
                          <small>
                            {question.knowledgeTitle} · {question.students.length}{" "}
                            人出错（{percent(question.errorRate)}）
                          </small>
                        </div>
                        <span className={`ta-chip ${rateTone(1 - question.errorRate)}`}>
                          {question.reasons.length
                            ? question.reasons[0]
                            : "错因待补充"}
                        </span>
                      </button>
                    </div>
                    <p className="ta-question-prompt">{question.prompt}</p>
                    {open && (
                      <div className="ta-question-body">
                        <div className="ta-question-grid">
                          <div>
                            <b>出错学生</b>
                            <p>{question.students.join("、") || "—"}</p>
                          </div>
                          <div>
                            <b>参考答案</b>
                            <p>{question.corrections[0] || question.standardAnswer}</p>
                          </div>
                        </div>
                        {question.explanations.length > 0 && (
                          <div className="ta-explain">
                            <b>AI 分步解析</b>
                            {question.explanations.map((text, i) => (
                              <p key={i}>{text}</p>
                            ))}
                          </div>
                        )}
                        {insight ? (
                          <div className="ta-insight">
                            <div>
                              <b>讲给学生听</b>
                              <p>{insight.explainToStudents}</p>
                            </div>
                            <div>
                              <b>板书演示</b>
                              <p>{insight.boardWork}</p>
                            </div>
                            <div className="ta-quick-check">
                              <Lightbulb size={15} />
                              <span>
                                <b>讲完立刻检查</b>
                                {insight.quickCheck}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <p className="ta-hint">
                            生成 AI 教学方案后，这里会出现可直接照读的讲解与板书演示。
                          </p>
                        )}
                        {question.practice.length > 0 && (
                          <div className="ta-practice">
                            <b>同类巩固练习（可用于课堂小测）</b>
                            {question.practice.map((item, i) => (
                              <details key={i}>
                                <summary>{item.prompt}</summary>
                                <p>
                                  <em>答案：</em>
                                  {item.answer}
                                </p>
                                {item.explanation && (
                                  <p>
                                    <em>解析：</em>
                                    {item.explanation}
                                  </p>
                                )}
                              </details>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section
            eyebrow="LESSON PLAN"
            title="课堂讲评课方案"
            desc="时间轴 + 板书设计，可直接照着上这节课。"
          >
            {analysis?.content?.boardPlan ? (
              <div className="ta-lesson">
                <div className="ta-lesson-meta">
                  <div>
                    <span className="eyebrow">THEME</span>
                    <strong>{analysis.content.boardPlan.title}</strong>
                  </div>
                  <div>
                    <span className="eyebrow">TIME</span>
                    <strong>{analysis.content.boardPlan.duration}</strong>
                  </div>
                  <div>
                    <span className="eyebrow">GOAL</span>
                    <strong>{analysis.content.boardPlan.goal}</strong>
                  </div>
                </div>
                <div className="ta-timeline">
                  {(analysis.content.boardPlan.steps || []).map(
                    (step: any, index: number) => (
                      <div key={index}>
                        <span className="ta-minutes">{step.minutes}′</span>
                        <div>
                          <strong>{step.title}</strong>
                          <p>
                            <em>教师</em>
                            {step.teacher}
                          </p>
                          <p>
                            <em>学生</em>
                            {step.students}
                          </p>
                        </div>
                      </div>
                    ),
                  )}
                </div>
                {analysis.content.boardPlan.blackboard?.length ? (
                  <div className="ta-board">
                    <div className="ta-board-head">
                      <Layers size={16} />
                      板书设计
                    </div>
                    {analysis.content.boardPlan.blackboard.map(
                      (line: string, index: number) => (
                        <p key={index}>{line}</p>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <AiBlock busy={analyzing} onGenerate={runAnalysis} />
            )}
          </Section>

          {(analysis?.content?.reasonInsights?.length ||
            analysis?.content?.groups?.length) && (
            <div className="ta-two-col">
              {analysis?.content?.reasonInsights?.length ? (
                <Section
                  eyebrow="WHY THEY FAIL"
                  title="错因诊断与课堂干预"
                  desc="每个错因配一个 5 分钟内可执行的课堂动作。"
                >
                  <div className="ta-interventions">
                    {analysis.content.reasonInsights.map(
                      (item: any, index: number) => (
                        <div key={index}>
                          <strong>{item.label}</strong>
                          <p>{item.diagnosis}</p>
                          <span>
                            <CheckCircle2 size={14} />
                            {item.teachingMove}
                          </span>
                          {item.followUp && <small>课后：{item.followUp}</small>}
                        </div>
                      ),
                    )}
                  </div>
                </Section>
              ) : null}
              {analysis?.content?.groups?.length ? (
                <Section
                  eyebrow="DIFFERENTIATION"
                  title="分层辅导计划"
                  desc="按学生实际出错情况分层，给出可直接执行的辅导策略。"
                >
                  <div className="ta-groups">
                    {analysis.content.groups.map((group: any, index: number) => (
                      <div key={index}>
                        <div>
                          <GraduationCap size={16} />
                          <strong>{group.name}</strong>
                          <span>{(group.studentNames || []).join("、")}</span>
                        </div>
                        <p>{group.strategy}</p>
                        {group.materials && <small>准备：{group.materials}</small>}
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}
            </div>
          )}

          {analysis?.content?.homework && (
            <Section
              eyebrow="HOMEWORK"
              title={analysis.content.homework.title || "课后巩固作业"}
              desc="只针对本次出错的知识点，题量少而准。"
              action={
                <Button variant="outline" onClick={reAssign}>
                  <ClipboardList />
                  按错题一键布置重练作业
                </Button>
              }
            >
              {analysis.content.homework.targets?.length ? (
                <div className="ta-targets">
                  {analysis.content.homework.targets.map((target: string, i: number) => (
                    <span key={i}>{target}</span>
                  ))}
                </div>
              ) : null}
              <ol className="ta-homework">
                {(analysis.content.homework.items || []).map(
                  (item: any, index: number) => (
                    <li key={index}>
                      <strong>
                        {item.prompt}
                        {item.difficulty && <em>{item.difficulty}</em>}
                      </strong>
                      <small>
                        来源：第 {item.source} 题 · {item.expectation}
                      </small>
                    </li>
                  ),
                )}
              </ol>
            </Section>
          )}

          {stats.reasonDistribution.some((item) => item.id === "unreadable") && (
            <div className="ta-alert">
              <AlertCircle size={18} />
              <div>
                <strong>
                  有 {overview.unreadableCount} 道题因卷面/扫描无法辨认，未计入错因统计
                </strong>
                <p>
                  这些题不能作为学生掌握情况的依据。建议重新上传更清晰的答卷，
                  或在“识别与复核”中人工补齐后再次复核。
                </p>
              </div>
            </div>
          )}

          <Section
            eyebrow="FOLLOW UP"
            title="学生跟进名单"
            desc="出错最多的学生排在前面，可直接标记观察 / 跟进 / 重点并生成个别化诊断。"
          >
            <div className="ta-student-list">
              {stats.students.map((item) => {
                const mark = focusMap.get(item.studentId);
                return (
                  <React.Fragment key={item.studentId || item.name}>
                    <div className="ta-student">
                      <span className="ta-avatar">{item.name.slice(0, 1)}</span>
                      <div className="ta-student-main">
                        <strong>
                          {item.name}
                          {mark && (
                            <em className={`ta-mark ${mark.level}`}>
                              {focusLevels.find((level) => level.id === mark.level)
                                ?.label || mark.level}
                            </em>
                          )}
                        </strong>
                        <small>
                          错题 {item.mistakeCount} 道
                          {item.submissionCount > 1
                            ? ` · 提交 ${item.submissionCount} 次`
                            : ""}
                          {item.score !== null ? ` · 得分 ${item.score}` : ""}
                        </small>
                        <div className="ta-tags">
                          <span
                            style={{
                              color: item.dominantReason?.color,
                              borderColor: `${item.dominantReason?.color}44`,
                            }}
                          >
                            主要错因：{item.dominantReason?.label || "待判定"}
                          </span>
                          {item.knowledgeTitles.slice(0, 3).map((title) => (
                            <span key={title} className="plain">
                              {title}
                            </span>
                          ))}
                          {item.knowledgeTitles.length > 3 && (
                            <span className="plain">
                              +{item.knowledgeTitles.length - 3}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="ta-student-actions">
                        <div className="ta-focus-pills">
                          {focusLevels.map((level) => (
                            <button
                              key={level.id}
                              title={level.hint}
                              className={mark?.level === level.id ? "active" : ""}
                              onClick={() =>
                                setFocusLevel(
                                  item.studentId || item.name,
                                  mark?.level === level.id ? "none" : level.id,
                                )
                              }
                            >
                              {level.label}
                            </button>
                          ))}
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => setStudent(item)}
                        >
                          <UserRound />
                          个别化诊断
                        </Button>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </Section>

          {stats.resources.knowledgePoints.length > 0 && (
            <Section
              eyebrow="REUSABLE LIBRARY"
              title="讲评与巩固资源库"
              desc={`已从复核结果中沉淀 ${stats.resources.knowledgePoints.length} 个知识点的解析与 ${stats.resources.totalPractice} 道同类练习题，可直接用于备课。`}
            >
              <div className="ta-library">
                {stats.resources.knowledgePoints.map((item) => (
                  <details key={item.knowledgeId || item.title}>
                    <summary>
                      <strong>{item.title}</strong>
                      <small>
                        第 {item.questionNumbers.join("、")} 题 ·{" "}
                        {item.practice.length} 道同类练习
                      </small>
                    </summary>
                    {item.explanations.map((text, index) => (
                      <p key={index}>{text}</p>
                    ))}
                    {item.practice.map((practice, index) => (
                      <div className="ta-library-item" key={index}>
                        <strong>{practice.prompt}</strong>
                        <small>答案：{practice.answer}</small>
                        {practice.explanation && <small>{practice.explanation}</small>}
                      </div>
                    ))}
                  </details>
                ))}
              </div>
            </Section>
          )}
        </>
      )}

      {student && stats && (
        <StudentAnalysisPanel
          assignmentId={stats.assignment.id}
          student={student}
          rating={
            focusMap.get(student.studentId)?.level || null
          }
          notify={notify}
          onClose={() => setStudent(null)}
        />
      )}
    </>
  );
}

/* ----------------------------- 学生个别化 ----------------------------- */

function StudentAnalysisPanel({
  assignmentId,
  student,
  rating,
  notify,
  onClose,
}: {
  assignmentId: string;
  student: StudentEntry;
  rating: string | null;
  notify: Notify;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setBusy(true);
    loadStudentAnalysis(assignmentId, student.studentId || student.name)
      .then(setDetail)
      .catch((error) => notify((error as Error).message))
      .finally(() => setBusy(false));
  }, [assignmentId, student.studentId]);

  const run = async () => {
    setGenerating(true);
    try {
      const result = await generateStudentAnalysis(
        assignmentId,
        student.studentId || student.name,
      );
      setDetail((current) =>
        current ? { ...current, analysis: result.analysis } : current,
      );
      notify(`${student.name} 的个别化诊断已生成。`);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const content: StudentAnalysis | undefined = detail?.analysis?.content;

  return (
    <div className="ta-drawer-mask" onClick={onClose}>
      <aside className="ta-drawer" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="eyebrow">INDIVIDUAL DIAGNOSIS</span>
            <h2>
              {student.name}
              {rating && (
                <em className={`ta-mark ${rating}`}>
                  {focusLevels.find((level) => level.id === rating)?.label}
                </em>
              )}
            </h2>
            <p>
              错题 {student.mistakeCount} 道 · 涉及 {student.knowledgeTitles.length}{" "}
              个知识点
              {student.missingWork > 0 ? ` · 其中空答 ${student.missingWork} 道` : ""}
            </p>
          </div>
          <button className="ta-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        {busy && (
          <div className="ta-loading">
            <div className="loading-ring" />
            <p>正在读取该生错题…</p>
          </div>
        )}

        {!busy && detail && (
          <>
            <div className="ta-drawer-body">
              {content ? (
                <>
                  <div className="ta-drawer-brief">{content.brief}</div>
                  {content.diagnosis && (
                    <div className="ta-drawer-block">
                      <b>学情诊断</b>
                      <p>{content.diagnosis}</p>
                    </div>
                  )}
                  {content.weakKnowledge?.length ? (
                    <div className="ta-drawer-block">
                      <b>薄弱知识点</b>
                      {content.weakKnowledge.map((item, index) => (
                        <div className="ta-weak" key={index}>
                          <strong>
                            {item.title}
                            <em>
                              第 {(item.questionNumbers || []).join("、")} 题
                            </em>
                          </strong>
                          <p>{item.evidence}</p>
                          <small>{item.mastery}</small>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {content.causes?.length ? (
                    <div className="ta-drawer-block">
                      <b>错因剖析</b>
                      {content.causes.map((item, index) => (
                        <div className="ta-cause" key={index}>
                          <strong>{item.label}</strong>
                          <p>{item.detail}</p>
                          <span>
                            <CheckCircle2 size={14} />
                            {item.fix}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {content.actions?.length ? (
                    <div className="ta-drawer-block">
                      <b>补强动作</b>
                      <div className="ta-actions">
                        {content.actions.map((item, index) => (
                          <div key={index}>
                            <em>{item.when}</em>
                            <strong>{item.what}</strong>
                            <small>
                              {item.who}
                              {item.check ? ` · 检验：${item.check}` : ""}
                            </small>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {content.encouragement && (
                    <div className="ta-encourage">
                      <MessageSquareQuote size={16} />
                      {content.encouragement}
                    </div>
                  )}
                  {content.parentNote && (
                    <div className="ta-drawer-block">
                      <b>可发给家长的说明</b>
                      <p>{content.parentNote}</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="ta-ai-empty">
                  <Sparkles size={20} />
                  <strong>还没有个别化诊断</strong>
                  <p>
                    AI 会结合这位学生的错题、知识点和错因，给出课堂与课后的补强动作。
                  </p>
                  <Button disabled={generating} onClick={run}>
                    <Sparkles />
                    {generating ? "AI 正在诊断…" : "生成个别化诊断"}
                  </Button>
                </div>
              )}

              {content?.practice?.length ? (
                <div className="ta-drawer-block">
                  <b>针对性练习</b>
                  <ol className="ta-homework">
                    {content.practice.map((item, index) => (
                      <li key={index}>
                        <strong>
                          {item.prompt}
                          {item.difficulty && <em>{item.difficulty}</em>}
                        </strong>
                        <small>
                          {item.knowledge} · 答案要点：{item.answer}
                        </small>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              <div className="ta-drawer-block">
                <b>该生本次错题明细（{detail.questions.length} 道）</b>
                {detail.questions.map((question) => (
                  <div className="ta-mini-question" key={question.id}>
                    <strong>
                      第 {question.number} 题
                      <em>{question.knowledgeTitle}</em>
                    </strong>
                    <p>{question.prompt}</p>
                    {question.reasons[0] && <small>错因：{question.reasons[0]}</small>}
                  </div>
                ))}
              </div>
            </div>

            <footer className="ta-drawer-foot">
              <Button variant="outline" onClick={() => window.print()}>
                <Printer />
                打印诊断单
              </Button>
              <Button disabled={generating} onClick={run}>
                <RefreshCw />
                {content
                  ? generating
                    ? "重新诊断中…"
                    : "重新生成"
                  : "生成个别化诊断"}
              </Button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

/* ----------------------------- 导出 ----------------------------- */

function downloadMarkdown(stats: TeachingStats, content: ClassAnalysis) {
  const lines: string[] = [];
  lines.push(`# ${stats.assignment.title} · 课堂讲评单`);
  lines.push(
    `> ${stats.assignment.stage} · ${stats.assignment.subject} · ${stats.assignment.className}｜已复核 ${stats.overview.submissionCount} 份答卷｜错题 ${stats.overview.mistakeCount} 道｜班级得分率 ${percent(stats.overview.scoreRate)}`,
  );
  lines.push("");
  if (content.brief) lines.push(`**核心结论**：${content.brief}`, "");
  if (content.keyFindings?.length) {
    lines.push("## 关键结论");
    content.keyFindings.forEach((item, index) =>
      lines.push(
        `${index + 1}. **${item.title}** — ${item.detail}${item.action ? `（教师动作：${item.action}）` : ""}`,
      ),
    );
    lines.push("");
  }
  if (stats.knowledgePoints.length) {
    lines.push("## 知识点掌握情况");
    lines.push("| 知识点 | 涉及题号 | 正确率 | 出错次数 |");
    lines.push("| --- | --- | --- | --- |");
    stats.knowledgePoints.forEach((point) =>
      lines.push(
        `| ${point.title} | ${point.questionNumbers.join("、")} | ${percent(point.correctRate)} | ${point.errorCount} |`,
      ),
    );
    lines.push("");
  }
  if (stats.reasonDistribution.length) {
    lines.push("## 错因归因");
    stats.reasonDistribution.forEach((reason) =>
      lines.push(
        `- **${reason.label}**：${reason.count} 道（${percent(reason.ratio)}）${reason.questions.length ? ` — 第 ${reason.questions.map((question) => question.number).join("、")} 题` : ""}`,
      ),
    );
    lines.push("");
  }
  if (content.boardPlan) {
    lines.push(`## 讲评课：${content.boardPlan.title || "课堂讲评"}`);
    if (content.boardPlan.duration) lines.push(`课时：${content.boardPlan.duration}`);
    if (content.boardPlan.goal) lines.push(`目标：${content.boardPlan.goal}`);
    lines.push("");
    (content.boardPlan.steps || []).forEach((step) =>
      lines.push(
        `- **${step.minutes}′ ${step.title}**｜教师：${step.teacher}｜学生：${step.students}`,
      ),
    );
    lines.push("");
    if (content.boardPlan.blackboard?.length) {
      lines.push("### 板书设计");
      lines.push("```");
      content.boardPlan.blackboard.forEach((line) => lines.push(line));
      lines.push("```", "");
    }
  }
  if (content.questionReviews?.length) {
    lines.push("## 高频错题讲评");
    content.questionReviews.forEach((item) => {
      lines.push(`### 第 ${item.number} 题（${item.knowledge}）`);
      lines.push(`- 为什么错：${item.whyWrong}`);
      lines.push(`- 讲给学生听：${item.explainToStudents}`);
      if (item.boardWork) lines.push(`- 板书演示：${item.boardWork}`);
      if (item.quickCheck) lines.push(`- 讲完检查：${item.quickCheck}`);
      if (item.wrongStudents?.length)
        lines.push(`- 需要点名：${item.wrongStudents.join("、")}`);
      lines.push("");
    });
  }
  const detailed = stats.highFrequencyQuestions.filter(
    (question) =>
      !content.questionReviews?.some(
        (item) => Number(item.number) === question.number,
      ),
  );
  if (detailed.length) {
    lines.push("## 其他错题（复核结果原文）");
    detailed.forEach((question) => {
      lines.push(
        `- **第 ${question.number} 题**（${question.knowledgeTitle}，${question.students.length} 人错）：${question.corrections[0] || question.standardAnswer}`,
      );
    });
    lines.push("");
  }
  if (content.reasonInsights?.length) {
    lines.push("## 错因干预");
    content.reasonInsights.forEach((item) => {
      lines.push(`- **${item.label}**：${item.diagnosis}`);
      lines.push(`  - 课堂动作：${item.teachingMove}`);
      if (item.followUp) lines.push(`  - 课后巩固：${item.followUp}`);
    });
    lines.push("");
  }
  if (content.groups?.length) {
    lines.push("## 分层辅导");
    content.groups.forEach((group) =>
      lines.push(
        `- **${group.name}**（${(group.studentNames || []).join("、")}）：${group.strategy}${group.materials ? `｜准备：${group.materials}` : ""}`,
      ),
    );
    lines.push("");
  }
  if (content.homework?.items?.length) {
    lines.push(`## 课后作业：${content.homework.title || "巩固练习"}`);
    if (content.homework.targets?.length)
      lines.push(`覆盖知识点：${content.homework.targets.join("、")}`);
    content.homework.items.forEach((item, index) =>
      lines.push(
        `${index + 1}. ${item.prompt}（来源第 ${item.source} 题，${item.difficulty}，期望：${item.expectation}）`,
      ),
    );
    lines.push("");
  }
  if (content.teacherScript) {
    lines.push("## 课堂开场稿", content.teacherScript, "");
  }
  if (stats.students.length) {
    lines.push("## 学生跟进名单");
    lines.push("| 学生 | 错题数 | 得分 | 主要错因 | 薄弱知识点 |");
    lines.push("| --- | --- | --- | --- | --- |");
    stats.students.forEach((item) =>
      lines.push(
        `| ${item.name} | ${item.mistakeCount} | ${item.score ?? "—"} | ${item.dominantReason?.label || "—"} | ${item.knowledgeTitles.join("、")} |`,
      ),
    );
    lines.push("");
  }
  lines.push(
    `---`,
    `由校园作业分析 v0.2.0-rc1 生成 · 数据来源：教师已复核的 ${stats.overview.mistakeCount} 道错题`,
  );
  const blob = new Blob([lines.join("\n")], {
    type: "text/markdown;charset=utf-8",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${stats.assignment.title}·课堂讲评单.md`;
  link.click();
  URL.revokeObjectURL(link.href);
}
