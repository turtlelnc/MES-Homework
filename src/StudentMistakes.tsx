import { useEffect, useState } from "react";
import { FileText, Lightbulb, RefreshCw, Sparkles } from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";

// 引导式错题本：先思考 → 逐条提示 → 重做原题 → 对照参考答案/解析 → 同类过关练习。
// 学生视图由服务端白名单保证（拿不到 correction/explanation/standard_answer），
// 只有 attempt 判定“已掌握”或连续 3 次失败兜底时才返回 reveal 参考答案。

type Guidance = { keyQuestion: string; hints: string[] };
type MistakeProgress = {
  hintsUsed: number;
  attempts: number;
  solved: number;
  revealed: number;
};
type PracticeQuestion = { prompt: string };
type StudentMistake = {
  id: string;
  knowledge_title: string;
  prompt: string;
  student_answer: string;
  reason: string;
  mastery: number;
  practiceQuestions: PracticeQuestion[];
  guidance: Guidance;
  progress: MistakeProgress;
  created_at: string;
};
type Reveal = {
  standardAnswer: string;
  correction: string;
  explanation: string;
  reasoning: string;
};
type AttemptResult = {
  correct: boolean;
  feedback: string;
  reveal?: Reveal;
};
type PracticeResult = {
  passed: boolean;
  results: { correct: boolean; feedback: string }[];
};
type GuideResponse = {
  guidance: { keyQuestion: string; hints: string[]; selfCheck: string[] };
  canRevealAnswer: boolean;
  reveal?: Reveal;
};

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rc4-empty">
      <FileText />
      <p>{text}</p>
    </div>
  );
}

export function StudentMistakes({
  notify,
}: {
  notify: (s: string) => void;
}) {
  const [items, setItems] = useState<StudentMistake[]>([]);
  const [attemptAnswers, setAttemptAnswers] = useState<
    Record<string, string>
  >({});
  const [attemptResults, setAttemptResults] = useState<
    Record<string, AttemptResult>
  >({});
  const [practiceAnswers, setPracticeAnswers] = useState<
    Record<string, string[]>
  >({});
  const [practiceResults, setPracticeResults] = useState<
    Record<string, PracticeResult>
  >({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setItems(await api<StudentMistake[]>("/mistakes"));
      setError("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const hint = async (id: string) => {
    setBusy(`${id}:hint`);
    try {
      await api(`/mistakes/${id}/hint`, json("POST", {}));
      await load();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const attempt = async (id: string) => {
    const answer = (attemptAnswers[id] || "").trim();
    if (!answer) {
      notify("先独立写出你的重做过程，再提交。");
      return;
    }
    setBusy(`${id}:attempt`);
    try {
      const result = await api<AttemptResult>(
        `/mistakes/${id}/attempt`,
        json("POST", { answer }),
      );
      setAttemptResults((current) => ({ ...current, [id]: result }));
      await load();
      notify(
        result.correct
          ? "这次重做已经掌握本题，可以对照参考答案了。"
          : result.feedback || "还差一点，看看提示再改改。",
      );
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const revealSaved = async (id: string) => {
    setBusy(`${id}:reveal`);
    try {
      const guide = await api<GuideResponse>(`/mistakes/${id}/guide`);
      if (guide.reveal)
        setAttemptResults((current) => ({
          ...current,
          [id]: { correct: true, feedback: "", reveal: guide.reveal },
        }));
      else notify("参考答案还没有解锁，先完成一次重做。");
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const generate = async (id: string) => {
    setBusy(`${id}:generate`);
    try {
      await api(`/mistakes/${id}/practice/generate`, json("POST", {}));
      setPracticeAnswers((current) => ({ ...current, [id]: [] }));
      setPracticeResults((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      await load();
      notify("已生成一组新的同类型练习。");
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const submitPractice = async (id: string) => {
    setBusy(`${id}:submit`);
    try {
      const result = await api<PracticeResult>(
        `/mistakes/${id}/practice/submit`,
        json("POST", { answers: practiceAnswers[id] || [] }),
      );
      setPracticeResults((current) => ({ ...current, [id]: result }));
      await load();
      notify(result.passed ? "练习已过关。" : "已完成批改，请继续订正。");
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  const setPracticeAnswer = (id: string, index: number, value: string) =>
    setPracticeAnswers((current) => {
      const next = [...(current[id] || [])];
      next[index] = value;
      return { ...current, [id]: next };
    });

  const card = (item: StudentMistake) => {
    const solved = item.progress.solved === 1;
    const reveal = attemptResults[item.id]?.reveal;
    const canCompare =
      solved || item.progress.revealed === 1 || item.mastery === 1;
    const practiceUnlocked =
      canCompare || item.practiceQuestions.length > 0;
    return (
      <section className="rc4-panel mistake-real" key={item.id}>
        <div>
          <strong>{item.knowledge_title || "自动归纳知识点"}</strong>
          <span className={solved || item.mastery ? "mastered" : "learning"}>
            {solved
              ? "重做已掌握"
              : item.mastery
                ? "练习已过关"
                : "待过关"}
          </span>
        </div>
        <h2>{item.prompt || "（题目内容待补充）"}</h2>
        <div className="answer-grid">
          <p>
            <b>我的答案</b>
            {item.student_answer || "（未作答）"}
          </p>
          <p>
            <b>错因提示</b>
            {item.reason || "待分析"}
          </p>
        </div>

        <div className="auto-explanation">
          <strong>先想一想</strong>
          <p>{item.guidance.keyQuestion}</p>
          {item.guidance.hints.length > 0 && (
            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {item.guidance.hints.map((text, index) => (
                <p key={index}>
                  <b>提示 {index + 1}</b>
                  {text}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="form-actions" style={{ marginBottom: 14 }}>
          <Button
            type="button"
            variant="outline"
            disabled={busy === `${item.id}:hint`}
            onClick={() => hint(item.id)}
          >
            <Lightbulb />{" "}
            {busy === `${item.id}:hint`
              ? "正在解锁…"
              : item.guidance.hints.length
                ? "再给我一个提示"
                : "给我一个提示"}
          </Button>
        </div>

        {reveal ? (
          <div className="auto-explanation">
            <strong>对照参考答案</strong>
            <div className="answer-grid" style={{ marginTop: 10 }}>
              <p>
                <b>参考答案</b>
                {reveal.standardAnswer || "（暂无参考答案）"}
              </p>
              <p>
                <b>订正答案</b>
                {reveal.correction || "（暂无订正）"}
              </p>
            </div>
            <p>
              <b>分步解析</b>
              {reveal.explanation || "（暂无解析）"}
            </p>
            <p>
              <b>AI 判分依据</b>
              {reveal.reasoning || "（暂无判分依据）"}
            </p>
            {attemptResults[item.id]?.feedback && (
              <p className="pass-result">{attemptResults[item.id].feedback}</p>
            )}
          </div>
        ) : (
          <>
            <label className="field">
              <span>重做原题（写完整过程，AI 判断掌握后才会显示参考答案）</span>
              <textarea
                rows={3}
                value={attemptAnswers[item.id] || ""}
                onChange={(event) =>
                  setAttemptAnswers((current) => ({
                    ...current,
                    [item.id]: event.target.value,
                  }))
                }
                placeholder="独立写出你的解题过程…"
              />
            </label>
            <div className="form-actions" style={{ marginBottom: 14 }}>
              {canCompare && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy === `${item.id}:reveal`}
                  onClick={() => revealSaved(item.id)}
                >
                  查看参考答案
                </Button>
              )}
              <Button
                type="button"
                disabled={busy === `${item.id}:attempt`}
                onClick={() => attempt(item.id)}
              >
                {busy === `${item.id}:attempt` ? "AI 判分中…" : "提交重做"}
              </Button>
            </div>
            {attemptResults[item.id] && (
              <p
                className={
                  attemptResults[item.id].correct
                    ? "pass-result"
                    : "retry-result"
                }
              >
                {attemptResults[item.id].feedback ||
                  "还差一点，看看提示再改改。"}
              </p>
            )}
          </>
        )}

        {practiceUnlocked && (
          <div className="practice-set">
            <div className="practice-heading">
              <strong>同类型过关练习</strong>
              <span>全部答对即过关</span>
            </div>
            {item.practiceQuestions.length ? (
              <>
                {item.practiceQuestions.map((question, index) => (
                  <label className="practice-question" key={index}>
                    <span>
                      {index + 1}. {question.prompt}
                    </span>
                    <input
                      value={practiceAnswers[item.id]?.[index] || ""}
                      onChange={(event) =>
                        setPracticeAnswer(item.id, index, event.target.value)
                      }
                      placeholder="填写答案"
                    />
                    {practiceResults[item.id]?.results?.[index] && (
                      <small
                        className={
                          practiceResults[item.id].results[index].correct
                            ? "correct"
                            : "incorrect"
                        }
                      >
                        {practiceResults[item.id].results[index].feedback}
                      </small>
                    )}
                  </label>
                ))}
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy === `${item.id}:generate`}
                    onClick={() => generate(item.id)}
                  >
                    <RefreshCw /> 换一组同类题
                  </Button>
                  <Button
                    type="button"
                    disabled={busy === `${item.id}:submit`}
                    onClick={() => submitPractice(item.id)}
                  >
                    {busy === `${item.id}:submit` ? "自动批改中…" : "提交过关"}
                  </Button>
                </div>
                {practiceResults[item.id] && (
                  <p
                    className={
                      practiceResults[item.id].passed
                        ? "pass-result"
                        : "retry-result"
                    }
                  >
                    {practiceResults[item.id].passed
                      ? "本知识点已过关。"
                      : "还有题目需要订正，完成后可以再次提交。"}
                  </p>
                )}
              </>
            ) : (
              <Button
                type="button"
                disabled={busy === `${item.id}:generate`}
                onClick={() => generate(item.id)}
              >
                <Sparkles />{" "}
                {busy === `${item.id}:generate`
                  ? "正在生成…"
                  : "生成同类型过关练习"}
              </Button>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <>
      <div className="rc4-title">
        <div>
          <span className="eyebrow">GUIDED REVIEW</span>
          <h1>我的错题</h1>
          <p>
            先想一想，再看提示，独立重做原题；AI 判断你已经掌握后，才会显示参考答案与解析。
          </p>
        </div>
      </div>
      {error && <p style={{ color: "#b45a4c", marginBottom: 14 }}>{error}</p>}
      {items.length ? (
        items.map(card)
      ) : (
        <EmptyState text="暂时没有已复核错题。教师复核后，属于你的错题会出现在这里。" />
      )}
    </>
  );
}
