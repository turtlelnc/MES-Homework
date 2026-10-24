import React, { useEffect, useState } from "react";
import { GraduationCap, RefreshCw, School, Users } from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";

type ModeInfo = { id: string; label: string; desc: string };
type TeacherRow = {
  id: string;
  name: string;
  subject?: string | null;
  class_name?: string | null;
};
type ClassRow = {
  className: string;
  studentCount: number;
  headTeacher: { id: string; name: string } | null;
  subjectTeachers: { id: string; name: string; subject: string | null }[];
};
type ModePayload = {
  mode: string;
  modes: ModeInfo[];
  classes: ClassRow[];
  teachers?: TeacherRow[];
};

const FALLBACK_MODES: ModeInfo[] = [
  {
    id: "school",
    label: "全校统一模式",
    desc: "仅学校管理员配置 API Key / OAuth，全校教师、学生、家长统一使用学校凭证。",
  },
  {
    id: "teacher_class",
    label: "老师分开 + 班费模式",
    desc: "每位老师配置自己的凭证；学生与家长使用本班班主任的凭证。",
  },
  {
    id: "teacher_parent",
    label: "老师分开 + 家长单独模式",
    desc: "老师配置自己的凭证；家长配置自己与孩子的凭证，学生使用其绑定家长的凭证。",
  },
];

export function SchoolModelPanel({ notify }: { notify: (s: string) => void }) {
  const [mode, setMode] = useState("school");
  const [modes, setModes] = useState<ModeInfo[]>(FALLBACK_MODES);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const data = await api<ModePayload>("/school/model-mode");
      setMode(data.mode);
      if (data.modes && data.modes.length) setModes(data.modes);
      const rows = data.classes || [];
      setClasses(rows);
      setDrafts(
        Object.fromEntries(
          rows.map((row) => [row.className, row.headTeacher?.id || ""]),
        ),
      );
      if (Array.isArray(data.teachers)) {
        setTeachers(data.teachers);
      } else {
        const fallback = await api<TeacherRow[]>("/teachers").catch(() => []);
        setTeachers(fallback);
      }
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const switchMode = async (next: ModeInfo) => {
    if (next.id === mode) return;
    const confirmed = window.confirm(
      `切换为「${next.label}」后立即生效，确定切换？`,
    );
    if (!confirmed) return;
    setBusy(`mode-${next.id}`);
    try {
      await api("/school/model-mode", json("PUT", { mode: next.id }));
      setMode(next.id);
      notify(`模型调用模式已切换为「${next.label}」。`);
      await load();
    } catch (error) {
      notify(`切换失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const saveHeadTeacher = async (row: ClassRow) => {
    const teacherId = drafts[row.className] ?? "";
    setBusy(`head-${row.className}`);
    try {
      await api(
        `/school/classes/${encodeURIComponent(row.className)}/head-teacher`,
        json("PUT", { teacherId: teacherId || null }),
      );
      const teacher = teachers.find((item) => item.id === teacherId);
      notify(
        teacherId
          ? `已将 ${teacher?.name || teacherId} 设为「${row.className}」的班主任。`
          : `已清除「${row.className}」的班主任设置。`,
      );
      await load();
    } catch (error) {
      notify(`保存班主任失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="rc4-title">
        <div>
          <span className="eyebrow">SCHOOL MODEL MODE</span>
          <h1>模型调用模式</h1>
          <p>
            决定全校师生调用模型时使用谁的凭证。切换后立即生效，并影响之后的每一次
            AI 调用；已保存的 API Key / OAuth 连接不会被删除，可随时切回。
          </p>
        </div>
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          disabled={loading}
        >
          <RefreshCw /> {loading ? "读取中…" : "刷新"}
        </Button>
      </div>

      <section className="rc4-panel">
        <h2>
          <School /> 选择模型调用模式
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 14,
          }}
        >
          {modes.map((item) => {
            const active = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void switchMode(item)}
                disabled={loading || busy === `mode-${item.id}`}
                style={{
                  textAlign: "left",
                  borderRadius: 11,
                  padding: 18,
                  display: "grid",
                  gap: 8,
                  cursor: active ? "default" : "pointer",
                  border: active ? "2px solid #1168c9" : "1px solid #e4e8ee",
                  background: active ? "#eef5ff" : "#fff",
                  color: "#26364a",
                }}
              >
                <strong style={{ color: active ? "#1168c9" : "#26364a" }}>
                  {active ? "✓ " : ""}
                  {item.label}
                </strong>
                <small style={{ color: "#7c8796", lineHeight: 1.6 }}>
                  {item.desc}
                </small>
                <small style={{ color: "#939eac" }}>
                  {active
                    ? "当前生效"
                    : busy === `mode-${item.id}`
                      ? "正在切换…"
                      : "点击切换（需确认）"}
                </small>
              </button>
            );
          })}
        </div>
        <p className="panel-intro" style={{ marginTop: 16, marginBottom: 0 }}>
          三种模式说明：
          {modes.map((item) => `「${item.label}」${item.desc}`).join(" ")}
        </p>
      </section>

      <section className="rc4-panel" style={{ marginTop: 20 }}>
        <h2>
          <GraduationCap /> 班级与班主任
        </h2>
        <p className="panel-intro">
          「老师分开 + 班费模式」下，学生与家长使用本班班主任的凭证； 「老师分开
          +
          家长单独模式」下，学生优先使用绑定家长的凭证，没有绑定家长时回退到班主任。
          每个班级只能有一位班主任；未指定时回退到学校管理员凭证。
        </p>
        {classes.length === 0 ? (
          <div className="rc4-empty">
            <Users />
            <p>
              {loading
                ? "正在读取班级…"
                : "还没有班级数据，请先创建教师与学生账户。"}
            </p>
          </div>
        ) : (
          <div className="data-table">
            <div>
              <span>班级 / 任课教师</span>
              <span>班主任</span>
              <span>学生人数</span>
              <span>操作</span>
            </div>
            {classes.map((row) => {
              const busyRow = busy === `head-${row.className}`;
              return (
                <div key={row.className} style={{ alignItems: "center" }}>
                  <span>
                    <strong>{row.className}</strong>
                    {row.subjectTeachers.length > 0 && (
                      <small
                        style={{
                          display: "block",
                          color: "#939eac",
                          marginTop: 4,
                        }}
                      >
                        任课：
                        {row.subjectTeachers
                          .map(
                            (teacher) =>
                              `${teacher.name}${teacher.subject ? `（${teacher.subject}）` : ""}`,
                          )
                          .join("、")}
                      </small>
                    )}
                  </span>
                  <span>
                    <select
                      value={drafts[row.className] ?? ""}
                      onChange={(e) =>
                        setDrafts((current) => ({
                          ...current,
                          [row.className]: e.target.value,
                        }))
                      }
                      disabled={busyRow}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        border: "1px solid #dbe2ea",
                        borderRadius: 7,
                        background: "#fff",
                        color: "#26364a",
                      }}
                    >
                      <option value="">未指定（回退学校管理员）</option>
                      {teachers.map((teacher) => (
                        <option value={teacher.id} key={teacher.id}>
                          {teacher.name}
                          {teacher.subject ? ` · ${teacher.subject}` : ""}
                        </option>
                      ))}
                    </select>
                  </span>
                  <span style={{ color: "#596a80" }}>
                    {row.studentCount} 人
                  </span>
                  <span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void saveHeadTeacher(row)}
                      disabled={busyRow}
                    >
                      {busyRow ? "保存中…" : "保存"}
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
