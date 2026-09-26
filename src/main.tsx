import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BarChart3,
  BookOpen,
  BrainCircuit,
  ChevronRight,
  ClipboardCheck,
  Download,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Library,
  LogOut,
  Plus,
  RefreshCw,
  School,
  Settings,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  UserPlus,
  Users,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";
import { TeachingAnalysis } from "./TeachingAnalysis";
import "./styles.css";
type User = {
  id: string;
  school_id: string;
  role: "teacher" | "student";
  name: string;
  email: string;
  stage: string;
  subject: string;
  class_name: string;
  is_school_admin: number;
};
type Knowledge = {
  id: string;
  title: string;
  description: string;
  stage: string;
  subject: string;
};
type Assignment = {
  id: string;
  title: string;
  stage: string;
  subject: string;
  class_name: string;
  question_count: number;
};
type Submission = {
  id: string;
  student_name: string;
  status: string;
  teacher_reviewed: number;
  assignment_title: string;
  score?: number;
};
type Student = {
  id: string;
  name: string;
  email: string;
  stage: string;
  class_name: string;
  created_at: string;
};
type TeacherAccount = Student & { subject: string };
type Provider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  vision: boolean;
};
type DraftQuestion = {
  prompt: string;
  standardAnswer: string;
  score: number;
  knowledgeId: string;
  knowledgeTitle?: string;
  answerGenerated?: boolean;
  knowledgeGenerated?: boolean;
};
const stages = ["小学", "初中", "高中"];
const teacherNav = [
  ["overview", "总览", BookOpen],
  ["teaching", "AI 教学分析", BarChart3],
  ["assignments", "作业与上传", FilePlus2],
  ["review", "识别与复核", ClipboardCheck],
  ["students", "学生管理", Users],
  ["knowledge", "知识库", Library],
  ["papers", "错题组卷", FileText],
  ["settings", "设置", Settings],
] as const;
const adminNav = [
  ["school", "学校仪表盘", School],
  ["students", "学生管理", Users],
  ["settings", "账户设置", Settings],
] as const;
const studentNav = [
  ["assignments", "我的作业", FilePlus2],
  ["mistakes", "我的错题", ClipboardCheck],
  ["settings", "账户设置", Settings],
] as const;
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("overview"),
    [toast, setToast] = useState("");
  const refresh = () =>
    api<User>("/me")
      .then((u) => {
        setUser(u);
        setView(
          u.is_school_admin
            ? "school"
            : u.role === "teacher"
              ? "overview"
              : "assignments",
        );
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  useEffect(() => {
    refresh();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  if (loading)
    return (
      <div className="auth-shell">
        <div className="loading-ring" />
        <p>正在连接校园作业分析服务…</p>
      </div>
    );
  if (!user) return <Auth onDone={refresh} />;
  const nav = user.is_school_admin
    ? adminNav
    : user.role === "teacher"
      ? teacherNav
      : studentNav;
  return (
    <div className="rc4">
      <header className="rc4-header">
        <Brand />
        <div className="account-chip">
          <div>
            <strong>{user.name}</strong>
            <small>
              {user.is_school_admin
                ? "学校管理员"
                : `${user.role === "teacher" ? "教师" : "学生"} · ${user.stage} · ${user.class_name}`}
            </small>
          </div>
          <span>{user.name.slice(0, 1)}</span>
        </div>
      </header>
      <div className="rc4-body">
        <aside className="rc4-sidebar">
          <div className="school-card">
            <ShieldCheck />
            <div>
              <strong>学校空间</strong>
              <small>注册码 {user.school_id.slice(0, 8)}…</small>
            </div>
          </div>
          <nav>
            {nav.map(([id, label, Icon]) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => setView(id)}
              >
                <Icon size={19} />
                {label}
                <ChevronRight size={15} />
              </button>
            ))}
          </nav>
          <button
            className="logout"
            onClick={() =>
              api("/auth/logout", { method: "POST" }).finally(() =>
                setUser(null),
              )
            }
          >
            <LogOut size={18} />
            退出登录
          </button>
        </aside>
        <main className="rc4-main">
          {view === "school" && (
            <SchoolDashboard user={user} notify={setToast} />
          )}{" "}
          {view === "overview" && <Overview user={user} navigate={setView} />}{" "}
          {view === "teaching" && <TeachingAnalysis notify={setToast} />}{" "}
          {view === "assignments" && (
            <Assignments user={user} notify={setToast} />
          )}{" "}
          {view === "review" && <Review notify={setToast} />}{" "}
          {view === "students" && (
            <StudentsPage user={user} notify={setToast} />
          )}{" "}
          {view === "knowledge" && (
            <KnowledgeBase user={user} notify={setToast} />
          )}{" "}
          {view === "papers" && <Papers notify={setToast} />}{" "}
          {view === "mistakes" && <Mistakes notify={setToast} />}{" "}
          {view === "settings" && (
            <AccountSettings user={user} refresh={refresh} notify={setToast} />
          )}
        </main>
      </div>
      {toast && (
        <div className="toast">
          <ShieldCheck size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="rc4-brand">
      <span>
        <BookOpen />
      </span>
      <div>
        校园作业分析<small>SMART CAMPUS · v0.2.0-rc1</small>
      </div>
    </div>
  );
}
function Field(
  p: React.InputHTMLAttributes<HTMLInputElement> & { label: string },
) {
  return (
    <label className="field">
      <span>{p.label}</span>
      <input {...p} />
    </label>
  );
}
function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: string[];
  defaultValue?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue}>
        {options.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </label>
  );
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
  action?: React.ReactNode;
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
function Empty({ text }: { text: string }) {
  return (
    <div className="rc4-empty">
      <FileText />
      <p>{text}</p>
    </div>
  );
}
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "register" | "school">("login"),
    [role, setRole] = useState<"teacher" | "student">("teacher"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(
        mode === "school" ? "/schools/register" : `/auth/${mode}`,
        json("POST", { ...data, role }),
      );
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-page">
      <section className="auth-story">
        <Brand />
        <div>
          <p className="eyebrow">SCHOOL READY WORKFLOW</p>
          <h1>
            从真实作业开始，
            <br />
            把每一步学习看清楚。
          </h1>
          <p>
            作业原件逐页
            OCR，题目与知识点由教师复核。学校、教师、学生账户各自隔离。
          </p>
        </div>
        <div className="auth-features">
          <span>
            <School />
            学校注册
          </span>
          <span>
            <BrainCircuit />
            真实 OCR
          </span>
          <span>
            <Library />
            校本知识库
          </span>
        </div>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <span className="eyebrow">
              {mode === "login"
                ? "WELCOME BACK"
                : mode === "school"
                  ? "REGISTER SCHOOL"
                  : "CREATE ACCOUNT"}
            </span>
            <h2>
              {mode === "login"
                ? "登录工作空间"
                : mode === "school"
                  ? "注册学校"
                  : "加入学校"}
            </h2>
            <p>
              {mode === "school"
                ? "创建学校空间与首位教师管理员账户。"
                : "使用学校账户安全访问数据。"}
            </p>
          </div>
          {mode === "register" && (
            <div className="role-pills">
              <button
                type="button"
                className={role === "teacher" ? "active" : ""}
                onClick={() => setRole("teacher")}
              >
                教师
              </button>
              <button
                type="button"
                className={role === "student" ? "active" : ""}
                onClick={() => setRole("student")}
              >
                学生
              </button>
            </div>
          )}
          {mode !== "login" && (
            <Field
              name="name"
              label={mode === "school" ? "管理员姓名" : "姓名"}
              required
            />
          )}
          {mode === "school" && (
            <Field name="schoolName" label="学校名称" required />
          )}
          {mode === "register" && (
            <Field
              name="schoolCode"
              label="学校注册码"
              required
              placeholder="由学校管理员提供"
            />
          )}
          <Field name="email" label="邮箱" required type="email" />
          <Field
            name="password"
            label="密码"
            required
            type="password"
            minLength={8}
            placeholder="至少 8 位"
          />
          {mode === "register" && (
            <>
              <div className="field-row">
                <Select name="stage" label="学段" options={stages} />
                {role === "teacher" && (
                  <Field name="subject" label="任教学科" required />
                )}
              </div>
              <Field name="className" label="默认班级" required />
            </>
          )}
          {error && <p className="form-error">{error}</p>}
          <Button disabled={busy} className="full">
            {busy
              ? "正在处理…"
              : mode === "login"
                ? "登录"
                : mode === "school"
                  ? "注册学校并进入"
                  : "注册并加入"}
          </Button>
          <div className="auth-links">
            <button
              type="button"
              className="switch-auth"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError("");
              }}
            >
              {mode === "login" ? "教师或学生加入学校" : "已有账户？返回登录"}
            </button>
            <button
              type="button"
              className="switch-auth"
              onClick={() => {
                setMode("school");
                setRole("teacher");
                setError("");
              }}
            >
              注册新学校
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
function SchoolDashboard({
  user,
  notify,
}: {
  user: User;
  notify: (s: string) => void;
}) {
  const [summary, setSummary] = useState<any>(null);
  const [teachers, setTeachers] = useState<TeacherAccount[]>([]);
  const load = () =>
    Promise.all([
      api<any>("/school/summary"),
      api<TeacherAccount[]>("/teachers"),
    ]).then(([schoolSummary, teacherRows]) => {
      setSummary(schoolSummary);
      setTeachers(teacherRows);
    });
  useEffect(() => {
    load();
  }, []);
  const addTeacher = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      await api(
        "/teachers",
        json("POST", Object.fromEntries(new FormData(event.currentTarget))),
      );
      event.currentTarget.reset();
      notify("教师账户已创建。");
      load();
    } catch (error) {
      notify((error as Error).message);
    }
  };
  return (
    <>
      <Title
        eyebrow="SCHOOL ADMINISTRATION"
        title={summary?.school?.name || "学校仪表盘"}
        desc={`学校账户只管理组织与成员，不设置班级、学段或学科。注册码：${user.school_id}`}
      />
      <div className="metric-grid">
        {[
          ["教师账户", summary?.teachers || 0, "人"],
          ["学生账户", summary?.students || 0, "人"],
          ["全校作业", summary?.assignments || 0, "份"],
          ["学校空间", 1, "个"],
        ].map((item) => (
          <div className="metric" key={String(item[0])}>
            <span>{item[0]}</span>
            <strong>
              {String(item[1]).padStart(2, "0")}
              <small>{item[2]}</small>
            </strong>
          </div>
        ))}
      </div>
      <div className="two-col">
        <form className="rc4-panel" onSubmit={addTeacher}>
          <h2>
            <UserPlus size={19} /> 注册教师
          </h2>
          <Field name="name" label="教师姓名" required />
          <Field name="email" label="登录邮箱" type="email" required />
          <Field
            name="password"
            label="初始密码"
            type="password"
            minLength={8}
            required
          />
          <div className="field-row">
            <Select name="stage" label="任教学段" options={stages} />
            <Field name="subject" label="任教学科" required />
          </div>
          <Field name="className" label="默认班级" required />
          <Button className="full">创建教师账户</Button>
        </form>
        <section className="rc4-panel">
          <h2>本校教师（{teachers.length}）</h2>
          {teachers.length ? (
            <div className="knowledge-list">
              {teachers.map((teacherAccount) => (
                <div key={teacherAccount.id}>
                  <span>
                    <Users />
                  </span>
                  <div>
                    <strong>{teacherAccount.name}</strong>
                    <small>{teacherAccount.email}</small>
                    <p>
                      {teacherAccount.stage} · {teacherAccount.subject} ·{" "}
                      {teacherAccount.class_name}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="尚未创建教师账户。" />
          )}
        </section>
      </div>
    </>
  );
}
function Overview({
  user,
  navigate,
}: {
  user: User;
  navigate: (v: string) => void;
}) {
  const [a, setA] = useState<Assignment[]>([]),
    [s, setS] = useState<Submission[]>([]),
    [k, setK] = useState<Knowledge[]>([]),
    [students, setStudents] = useState<Student[]>([]);
  useEffect(() => {
    Promise.all([
      api<Assignment[]>("/assignments"),
      api<Submission[]>("/submissions"),
      api<Knowledge[]>("/knowledge"),
      api<Student[]>("/students"),
    ]).then(([aa, ss, kk, uu]) => {
      setA(aa);
      setS(ss);
      setK(kk);
      setStudents(uu);
    });
  }, []);
  return (
    <>
      <Title
        eyebrow="TEACHING WORKSPACE"
        title={`${user.name}老师，今天从真实作业开始。`}
        desc={`${user.stage} · ${user.subject} · ${user.class_name}。复核完成后到「AI 教学分析」生成讲评方案与跟进名单。`}
      />
      <div className="metric-grid">
        {[
          ["已发布作业", a.length, "份"],
          [
            "待 OCR / 复核",
            s.filter((x) => x.status !== "completed").length,
            "份",
          ],
          ["学生账户", students.length, "人"],
          ["校本知识点", k.length, "个"],
        ].map((x) => (
          <div className="metric" key={String(x[0])}>
            <span>{x[0]}</span>
            <strong>
              {String(x[1]).padStart(2, "0")}
              <small>{x[2]}</small>
            </strong>
          </div>
        ))}
      </div>
      <section className="real-flow">
        {[
          ["01", "导入学生", "注册或导入真实学生账户", "students"],
          ["02", "生成作业", "上传原件生成可编辑题目", "assignments"],
          ["03", "逐页 OCR", "图片与 PDF 进入识别队列", "review"],
          ["04", "教师复核", "确认后写入学生错题本", "review"],
          ["05", "教学分析", "AI 生成讲评方案与跟进名单", "teaching"],
        ].map((x) => (
          <div key={x[0]}>
            <span>{x[0]}</span>
            <strong>{x[1]}</strong>
            <p>{x[2]}</p>
            <button onClick={() => navigate(x[3])}>打开工作区</button>
          </div>
        ))}
      </section>
      <section className="rc4-panel overview-teaching">
        <div>
          <span className="eyebrow">AI TEACHING ANALYSIS</span>
          <h2>复核完成后，直接得到能上课的讲评方案</h2>
          <p>
            AI 教学分析把已复核的错题换算成班级知识点掌握率、错因占比、高频错题讲评脚本、
            分层辅导名单与课后重练作业，不用再手工统计。
          </p>
        </div>
        <Button onClick={() => navigate("teaching")}>
          <Sparkles />
          打开 AI 教学分析
        </Button>
      </section>
    </>
  );
}
function Assignments({
  user,
  notify,
}: {
  user: User;
  notify: (s: string) => void;
}) {
  const [items, setItems] = useState<Assignment[]>([]),
    [knowledge, setKnowledge] = useState<Knowledge[]>([]),
    [students, setStudents] = useState<Student[]>([]),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState(""),
    [files, setFiles] = useState<FileList | null>(null),
    [studentId, setStudentId] = useState("");
  const load = () =>
    Promise.all([
      api<Assignment[]>("/assignments"),
      api<Knowledge[]>("/knowledge"),
      user.role === "teacher"
        ? api<Student[]>("/students")
        : Promise.resolve([]),
    ]).then(([aa, kk, ss]) => {
      setItems(aa);
      setKnowledge(kk);
      setStudents(ss);
      setSelected((v) => v || aa[0]?.id || "");
    });
  useEffect(() => {
    load();
  }, []);
  const create = async (payload: {
    title: string;
    dueAt: string;
    questions: DraftQuestion[];
  }) => {
    await api("/assignments", json("POST", payload));
    setCreating(false);
    notify("作业已发布。");
    load();
  };
  const send = async () => {
    if (!selected) {
      setCreating(true);
      notify("请先新增并发布一份作业，再上传学生答卷。");
      return;
    }
    if (!files?.length) return;
    const body = new FormData();
    Array.from(files).forEach((file) => body.append("files", file));
    if (studentId) body.append("studentId", studentId);
    await api(`/assignments/${selected}/submissions`, { method: "POST", body });
    notify("原件已上传，可前往识别与复核开始 OCR。");
    setFiles(null);
  };
  return (
    <>
      <Title
        eyebrow="ASSIGNMENTS"
        title={user.role === "teacher" ? "作业与上传" : "我的作业"}
        desc={
          user.role === "teacher"
            ? "上传试卷或作业图片生成草稿，教师核对后发布。"
            : "仅显示与你学校、学段和班级匹配的作业。"
        }
        action={
          user.role === "teacher" ? (
            <Button onClick={() => setCreating(!creating)}>
              <Plus />
              新增作业
            </Button>
          ) : undefined
        }
      />
      {creating && (
        <AssignmentForm knowledge={knowledge} onSave={create} notify={notify} />
      )}
      <div className="two-col">
        <section className="rc4-panel">
          <h2>已发布作业</h2>
          {items.length ? (
            <div className="select-list">
              {items.map((x) => (
                <button
                  key={x.id}
                  className={selected === x.id ? "active" : ""}
                  onClick={() => setSelected(x.id)}
                >
                  <div>
                    <strong>{x.title}</strong>
                    <small>
                      {x.stage} · {x.subject} · {x.class_name}
                    </small>
                  </div>
                  <span>{x.question_count} 题</span>
                </button>
              ))}
            </div>
          ) : (
            <Empty text="暂无作业。" />
          )}
        </section>
        <section className="rc4-panel upload-real">
          <h2>{user.role === "teacher" ? "上传学生作业" : "提交我的作业"}</h2>
          <p>
            支持 JPG、PNG、WebP、PDF、DOCX、DOC，单文件 ≤ 20 MB；Word
            会提取正文、表格和可读取的内嵌图片。
          </p>
          <label className="field">
            <span>对应的正式作业</span>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">
                {items.length ? "请选择作业" : "暂无作业，请先点击新增作业"}
              </option>
              {items.map((assignment) => (
                <option value={assignment.id} key={assignment.id}>
                  {assignment.title} · {assignment.question_count} 题
                </option>
              ))}
            </select>
          </label>
          {user.role === "teacher" && (
            <label className="field">
              <span>关联学生账户</span>
              <select
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
              >
                <option value="">请选择本校学生</option>
                {students.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name} · {s.stage} · {s.class_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="upload-box">
            <UploadCloud />
            <strong>
              {files?.length
                ? `已选择 ${files.length} 个文件`
                : "选择真实作业原件"}
            </strong>
            <span>上传后由教师主动开始 OCR</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf,.docx,.doc,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              onChange={(e) => setFiles(e.target.files)}
            />
          </label>
          <Button
            className="full"
            disabled={!files?.length || (user.role === "teacher" && !studentId)}
            onClick={() => send().catch((e) => notify(e.message))}
          >
            {selected ? "保存并进入识别队列" : "先创建正式作业"}
          </Button>
        </section>
      </div>
    </>
  );
}
function AssignmentForm({
  knowledge,
  onSave,
  notify,
}: {
  knowledge: Knowledge[];
  onSave: (x: {
    title: string;
    dueAt: string;
    questions: DraftQuestion[];
  }) => Promise<void>;
  notify: (s: string) => void;
}) {
  const blank = (): DraftQuestion => ({
    prompt: "",
    standardAnswer: "",
    score: 0,
    knowledgeId: "",
  });
  const [title, setTitle] = useState(""),
    [dueAt, setDueAt] = useState(""),
    [questions, setQuestions] = useState<DraftQuestion[]>([blank()]),
    [busy, setBusy] = useState(false),
    [warnings, setWarnings] = useState<string[]>([]);
  const patch = (i: number, key: keyof DraftQuestion, value: string | number) =>
    setQuestions((list) =>
      list.map((q, n) => (n === i ? { ...q, [key]: value } : q)),
    );
  const importFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setWarnings([]);
    try {
      const body = new FormData();
      body.append("file", file);
      const d = await api<{
        title: string;
        questions: DraftQuestion[];
        warnings: string[];
        pageCount: number;
      }>("/assignments/import", { method: "POST", body });
      setTitle(d.title);
      setQuestions(d.questions);
      setWarnings(d.warnings || []);
      notify(
        `已解析 ${d.pageCount} 页、${d.questions.length} 道题，请核对后发布。`,
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (questions.some((q) => !q.prompt.trim()))
      return notify("每道题都必须有题干。");
    if (questions.some((q) => !q.standardAnswer.trim()))
      return notify("请补全标准答案或评分要点后再发布。");
    if (questions.some((q) => !q.knowledgeId))
      return notify("请为每道题确认知识点。");
    await onSave({ title, dueAt, questions });
  };
  return (
    <form className="rc4-panel assignment-form" onSubmit={submit}>
      <div className="import-strip">
        <div>
          <FilePlus2 />
          <span>
            <strong>从文件一键生成</strong>
            <small>图片、PDF 或 Word 将解析为可编辑草稿。</small>
          </span>
        </div>
        <label className="btn btn-outline">
          {busy ? "正在解析…" : "选择文件"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf,.docx,.doc,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            disabled={busy}
            onChange={(e) => importFile(e.target.files?.[0])}
          />
        </label>
      </div>
      {warnings.length > 0 && (
        <div className="warning-list">
          {warnings.map((w, i) => (
            <p key={i}>需核对：{w}</p>
          ))}
        </div>
      )}
      <div className="field-row">
        <Field
          label="作业名称"
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Field
          label="截止时间"
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
        />
      </div>
      {questions.map((q, i) => (
        <div className="question-edit" key={i}>
          <b>{i + 1}</b>
          <label className="field">
            <span>真实题干</span>
            <textarea
              rows={4}
              required
              value={q.prompt}
              onChange={(e) => patch(i, "prompt", e.target.value)}
            />
          </label>
          <label className="field">
            <span>标准答案 / 评分要点</span>
            <textarea
              rows={4}
              value={q.standardAnswer}
              onChange={(e) => patch(i, "standardAnswer", e.target.value)}
            />
            {q.answerGenerated && <small>已由模型自动推导，请抽查</small>}
          </label>
          <label className="field">
            <span>知识点</span>
            <select
              value={q.knowledgeId}
              onChange={(e) => patch(i, "knowledgeId", e.target.value)}
            >
              <option value="">请选择</option>
              {knowledge.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.title}
                </option>
              ))}
            </select>
            {q.knowledgeTitle && !q.knowledgeId && (
              <small>OCR 建议“{q.knowledgeTitle}”，校本库中未匹配</small>
            )}
            {q.knowledgeGenerated && q.knowledgeId && (
              <small>新知识点已自动加入校本知识库</small>
            )}
          </label>
          <Field
            label="分值"
            type="number"
            min="0"
            step="0.5"
            value={q.score}
            onChange={(e) => patch(i, "score", Number(e.target.value))}
          />
        </div>
      ))}
      <div className="form-actions">
        <Button
          type="button"
          variant="outline"
          onClick={() => setQuestions((q) => [...q, blank()])}
        >
          <Plus />
          增加题目
        </Button>
        <Button>核对完成并发布</Button>
      </div>
    </form>
  );
}
function StudentsPage({
  user,
  notify,
}: {
  user: User;
  notify: (s: string) => void;
}) {
  const [students, setStudents] = useState<Student[]>([]),
    [result, setResult] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const load = () => api<Student[]>("/students").then(setStudents);
  useEffect(() => {
    load();
  }, []);
  const register = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api(
        "/students",
        json("POST", Object.fromEntries(new FormData(e.currentTarget))),
      );
      e.currentTarget.reset();
      notify("学生账户已注册。");
      load();
    } catch (err) {
      notify((err as Error).message);
    }
  };
  const importStudents = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const d: any = await api("/students/import", { method: "POST", body });
      setResult(d);
      notify(
        `导入完成：成功 ${d.created.length} 人，失败 ${d.errors.length} 人。`,
      );
      load();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = () => {
    const csv =
      "姓名,邮箱,初始密码,学段,班级\r\n张三,student@example.com,ChangeMe123!,高中,高二（1）班\r\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(
      new Blob(["\ufeff" + csv], { type: "text/csv" }),
    );
    a.download = "学生导入模板.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <>
      <Title
        eyebrow="STUDENT ACCOUNTS"
        title="学生管理"
        desc={`学校注册码：${user.school_id}。支持单个注册与 CSV/XLSX 批量导入。`}
      />
      <div className="two-col">
        <form className="rc4-panel" onSubmit={register}>
          <h2>
            <UserPlus size={19} /> 注册单个学生
          </h2>
          <Field name="name" label="姓名" required />
          <Field name="email" label="登录邮箱" type="email" required />
          <Field
            name="password"
            label="初始密码"
            type="password"
            minLength={8}
            required
          />
          <div className="field-row">
            <Select
              name="stage"
              label="学段"
              options={stages}
              defaultValue={user.stage || stages[0]}
            />
            <Field
              name="className"
              label="班级"
              defaultValue={user.class_name || ""}
            />
          </div>
          <Button className="full">创建学生账户</Button>
        </form>
        <section className="rc4-panel">
          <h2>
            <FileSpreadsheet size={19} /> 批量导入学生
          </h2>
          <p className="panel-intro">
            表头：姓名、邮箱、初始密码、学段、班级。密码留空时自动生成，并仅在本次结果中显示。
          </p>
          <div className="import-actions">
            <Button type="button" variant="outline" onClick={template}>
              <Download />
              下载 CSV 模板
            </Button>
            <label className="btn btn-primary">
              {busy ? "导入中…" : "选择 CSV / XLSX"}
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                disabled={busy}
                onChange={(e) => importStudents(e.target.files?.[0])}
              />
            </label>
          </div>
          {result && (
            <div className="import-result">
              <strong>
                成功 {result.created.length}，失败 {result.errors.length}
              </strong>
              {result.created.map((x: any) => (
                <p key={x.id}>
                  {x.name} · {x.email} · 初始密码{" "}
                  <code>{x.initialPassword}</code>
                </p>
              ))}
              {result.errors.map((x: any) => (
                <p className="error-line" key={x.row}>
                  第 {x.row} 行：{x.error}
                </p>
              ))}
            </div>
          )}
        </section>
      </div>
      <section className="rc4-panel student-table">
        <h2>本校学生（{students.length}）</h2>
        {students.length ? (
          <div className="data-table">
            <div>
              <b>姓名</b>
              <b>邮箱</b>
              <b>学段</b>
              <b>班级</b>
            </div>
            {students.map((s) => (
              <div key={s.id}>
                <span>{s.name}</span>
                <span>{s.email}</span>
                <span>{s.stage}</span>
                <span>{s.class_name}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="暂无学生账户。" />
        )}
      </section>
    </>
  );
}
function Review({ notify }: { notify: (s: string) => void }) {
  const [items, setItems] = useState<Submission[]>([]),
    [detail, setDetail] = useState<any>(null),
    [busy, setBusy] = useState("");
  const load = () => api<Submission[]>("/submissions").then(setItems);
  useEffect(() => {
    load();
  }, []);
  const recognize = async (id: string) => {
    setBusy(id);
    try {
      const r: any = await api(`/submissions/${id}/recognize`, {
        method: "POST",
      });
      setDetail((d: any) => ({
        ...d,
        status: "review",
        analysis: r,
        ocr_text: r.ocrText,
      }));
      notify("逐页 OCR 完成，请逐题复核。");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
      load();
    }
  };
  const update = (i: number, key: string, value: any) =>
    setDetail((d: any) => ({
      ...d,
      analysis: {
        ...d.analysis,
        items: d.analysis.items.map((x: any, n: number) =>
          n === i ? { ...x, [key]: value } : x,
        ),
      },
    }));
  const approve = async () => {
    await api(
      `/submissions/${detail.id}/review`,
      json("POST", {
        ...detail.analysis,
        score: detail.analysis?.items?.reduce(
          (a: number, x: any) => a + (Number(x.score) || 0),
          0,
        ),
      }),
    );
    notify("复核完成，错题已写入学生账户。");
    setDetail(null);
    load();
  };
  return (
    <>
      <Title
        eyebrow="OCR & REVIEW"
        title="识别与复核"
        desc="图片和 PDF 都会逐页识别；低置信度内容必须由教师确认。"
      />
      <div className="review-layout">
        <section className="rc4-panel">
          <h2>识别队列</h2>
          {items.length ? (
            <div className="select-list">
              {items.map((x) => (
                <button
                  key={x.id}
                  onClick={() => api(`/submissions/${x.id}`).then(setDetail)}
                >
                  <div>
                    <strong>
                      {x.student_name} · {x.assignment_title}
                    </strong>
                    <small>
                      {statusName(x.status)}{" "}
                      {x.teacher_reviewed ? "· 已复核" : ""}
                    </small>
                  </div>
                  <ChevronRight />
                </button>
              ))}
            </div>
          ) : (
            <Empty text="暂无提交。" />
          )}
        </section>
        <section className="rc4-panel review-detail">
          {!detail ? (
            <Empty text="选择提交查看识别状态。" />
          ) : (
            <>
              <div className="detail-head">
                <div>
                  <h2>{detail.student_name}</h2>
                  <p>{statusName(detail.status)}</p>
                </div>
                {["uploaded", "failed"].includes(detail.status) && (
                  <Button
                    disabled={busy === detail.id}
                    onClick={() => recognize(detail.id)}
                  >
                    <RefreshCw />
                    {busy ? "逐页 OCR 中…" : "开始 OCR"}
                  </Button>
                )}
              </div>
              {detail.ocr_text && (
                <label className="field">
                  <span>OCR 原文</span>
                  <textarea rows={7} value={detail.ocr_text} readOnly />
                </label>
              )}
              {detail.analysis?.items?.map((x: any, i: number) => (
                <div className="review-item" key={i}>
                  <div>
                    <strong>第 {i + 1} 题</strong>
                    <span className={(x.confidence || 0) < 0.8 ? "low" : ""}>
                      置信度 {Math.round((x.confidence || 0) * 100)}%
                    </span>
                  </div>
                  <label>
                    学生答案
                    <textarea
                      value={x.studentAnswer || ""}
                      onChange={(e) =>
                        update(i, "studentAnswer", e.target.value)
                      }
                    />
                  </label>
                  <label>
                    订正说明
                    <textarea
                      value={x.correction || ""}
                      onChange={(e) => update(i, "correction", e.target.value)}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={!!x.isCorrect}
                      onChange={(e) => update(i, "isCorrect", e.target.checked)}
                    />
                    判为正确
                  </label>
                </div>
              ))}
              {detail.status === "review" && (
                <Button className="full" onClick={approve}>
                  确认复核并写入错题本
                </Button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
const statusName = (s: string) =>
  (
    ({
      uploaded: "等待识别",
      recognizing: "识别中",
      review: "等待复核",
      completed: "已完成",
      failed: "识别失败",
    }) as Record<string, string>
  )[s] || s;
function KnowledgeBase({
  user,
  notify,
}: {
  user: User;
  notify: (s: string) => void;
}) {
  const [items, setItems] = useState<Knowledge[]>([]);
  const load = () => api<Knowledge[]>("/knowledge").then(setItems);
  useEffect(() => {
    load();
  }, []);
  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await api(
      "/knowledge",
      json("POST", Object.fromEntries(new FormData(e.currentTarget))),
    );
    e.currentTarget.reset();
    notify("知识点已保存。");
    load();
  };
  return (
    <>
      <Title
        eyebrow="SCHOOL KNOWLEDGE BASE"
        title="校本知识库"
        desc="知识点由教师按教材与教学进度维护，OCR 只能从这里选择。"
      />
      <div className="two-col">
        <form className="rc4-panel" onSubmit={add}>
          <h2>新增知识点</h2>
          <div className="field-row">
            <Select
              name="stage"
              label="学段"
              options={stages}
              defaultValue={user.stage}
            />
            <Field
              name="subject"
              label="学科"
              required
              defaultValue={user.subject}
            />
          </div>
          <Field name="title" label="知识点名称" required />
          <label className="field">
            <span>说明与边界</span>
            <textarea name="description" rows={6} />
          </label>
          <Button className="full">
            <Plus />
            保存知识点
          </Button>
        </form>
        <section className="rc4-panel">
          <h2>已维护 {items.length} 个</h2>
          {items.length ? (
            <div className="knowledge-list">
              {items.map((k) => (
                <div key={k.id}>
                  <span>
                    <Library />
                  </span>
                  <div>
                    <strong>{k.title}</strong>
                    <small>
                      {k.stage} · {k.subject}
                    </small>
                    <p>{k.description || "暂无说明"}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="知识库为空。" />
          )}
        </section>
      </div>
    </>
  );
}
function Papers({ notify }: { notify: (s: string) => void }) {
  const [papers, setPapers] = useState<any[]>([]),
    [current, setCurrent] = useState<any>(null);
  const load = () => api<any[]>("/papers").then(setPapers);
  useEffect(() => {
    load();
  }, []);
  const make = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const p: any = await api(
      "/papers/generate",
      json("POST", Object.fromEntries(new FormData(e.currentTarget))),
    );
    setCurrent(p);
    notify(p.questions.length ? "试卷已生成。" : "尚无已复核错题。");
    load();
  };
  return (
    <>
      <Title
        eyebrow="MISTAKE PAPER"
        title="通过错题出试卷"
        desc="题源仅包含教师复核错题。"
      />
      <div className="two-col">
        <form className="rc4-panel" onSubmit={make}>
          <h2>组卷条件</h2>
          <Field
            name="title"
            label="试卷名称"
            required
            defaultValue="错题巩固卷"
          />
          <Field
            name="count"
            label="题目数量"
            type="number"
            min="1"
            max="50"
            defaultValue="10"
          />
          <Button className="full">
            <Sparkles />
            从错题组卷
          </Button>
        </form>
        <section className="rc4-panel paper">
          <h2>{current?.title || "试卷预览"}</h2>
          {current?.questions?.length ? (
            current.questions.map((q: any, i: number) => (
              <div key={q.id}>
                <strong>
                  {i + 1}. {q.prompt}
                </strong>
                <p>{q.knowledge_title || "未绑定知识点"}</p>
                <details>
                  <summary>参考答案</summary>
                  {q.standard_answer}
                </details>
              </div>
            ))
          ) : (
            <Empty text={`已保存 ${papers.length} 份试卷。`} />
          )}{" "}
          {current?.questions?.length ? (
            <Button variant="outline" onClick={() => window.print()}>
              打印 / 保存 PDF
            </Button>
          ) : null}
        </section>
      </div>
    </>
  );
}
function Mistakes({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState("");
  const load = () => api<any[]>("/mistakes").then(setItems);
  useEffect(() => {
    load();
  }, []);
  const generate = async (id: string) => {
    setBusy(id);
    try {
      await api(`/mistakes/${id}/practice/generate`, { method: "POST" });
      await load();
      notify("已生成一组新的同类型练习。");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const submit = async (id: string) => {
    setBusy(id);
    try {
      const result = await api(
        `/mistakes/${id}/practice/submit`,
        json("POST", { answers: answers[id] || [] }),
      );
      setResults((current) => ({ ...current, [id]: result }));
      await load();
      notify(result.passed ? "练习已过关。" : "已完成批改，请继续订正。");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setAnswer = (id: string, index: number, value: string) =>
    setAnswers((current) => {
      const next = [...(current[id] || [])];
      next[index] = value;
      return { ...current, [id]: next };
    });
  return (
    <>
      <Title
        eyebrow="MY REVIEW"
        title="我的错题"
        desc="仅显示教师已经复核并确认属于你的错题。"
      />
      {items.length ? (
        items.map((x) => (
          <section className="rc4-panel mistake-real" key={x.id}>
            <div>
              <strong>{x.knowledge_title || "自动归纳知识点"}</strong>
              <span className={x.mastery ? "mastered" : "learning"}>
                {x.mastery ? "已过关" : "待过关"}
              </span>
            </div>
            <h2>{x.prompt}</h2>
            <div className="answer-grid">
              <p>
                <b>我的答案</b>
                {x.student_answer}
              </p>
              <p>
                <b>教师订正</b>
                {x.correction}
              </p>
            </div>
            <div className="auto-explanation">
              <strong>自动题目解析</strong>
              <p>{x.explanation || x.reason || "等待生成解析"}</p>
            </div>
            {x.practiceQuestions?.length ? (
              <div className="practice-set">
                <div className="practice-heading">
                  <strong>同类型过关练习</strong>
                  <span>全部答对即过关</span>
                </div>
                {x.practiceQuestions.map((question: any, index: number) => (
                  <label className="practice-question" key={index}>
                    <span>
                      {index + 1}. {question.prompt}
                    </span>
                    <input
                      value={answers[x.id]?.[index] || ""}
                      onChange={(event) =>
                        setAnswer(x.id, index, event.target.value)
                      }
                      placeholder="填写答案"
                    />
                    {results[x.id]?.results?.[index] && (
                      <small
                        className={
                          results[x.id].results[index].correct
                            ? "correct"
                            : "incorrect"
                        }
                      >
                        {results[x.id].results[index].feedback}
                      </small>
                    )}
                  </label>
                ))}
                <div className="form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy === x.id}
                    onClick={() => generate(x.id)}
                  >
                    <RefreshCw /> 换一组同类题
                  </Button>
                  <Button
                    type="button"
                    disabled={busy === x.id}
                    onClick={() => submit(x.id)}
                  >
                    {busy === x.id ? "自动批改中…" : "提交过关"}
                  </Button>
                </div>
                {results[x.id] && (
                  <p
                    className={
                      results[x.id].passed ? "pass-result" : "retry-result"
                    }
                  >
                    {results[x.id].passed
                      ? "本知识点已过关。"
                      : "还有题目需要订正，完成后可以再次提交。"}
                  </p>
                )}
              </div>
            ) : (
              <Button
                type="button"
                disabled={busy === x.id}
                onClick={() => generate(x.id)}
              >
                <Sparkles />{" "}
                {busy === x.id ? "正在生成…" : "生成同类型过关练习"}
              </Button>
            )}
          </section>
        ))
      ) : (
        <Empty text="暂时没有已复核错题。" />
      )}
    </>
  );
}
function AccountSettings({
  user,
  refresh,
  notify,
}: {
  user: User;
  refresh: () => void;
  notify: (s: string) => void;
}) {
  const [providers, setProviders] = useState<Provider[]>([]),
    [saved, setSaved] = useState<any>(null),
    [providerBusy, setProviderBusy] = useState(false);
  useEffect(() => {
    api<Provider[]>("/providers").then(setProviders);
    if (user.role === "teacher") api("/settings/provider").then(setSaved);
  }, []);
  const profile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api(
        "/me",
        json("PATCH", Object.fromEntries(new FormData(e.currentTarget))),
      );
      notify("账户设置已更新。");
      refresh();
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const provider = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setProviderBusy(true);
    try {
      const values = Object.fromEntries(new FormData(form));
      const result = await api("/settings/provider", json("PUT", values));
      setSaved(result);
      notify(
        user.is_school_admin
          ? "全校默认 API Key 已加密保存。"
          : "API Key 已在服务端加密保存。",
      );
      form.reset();
    } catch (error) {
      notify(`保存失败：${(error as Error).message}`);
    } finally {
      setProviderBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="ACCOUNT & SECURITY"
        title="设置"
        desc="学段位于账户设置内；数据按学校与账户隔离。AI 教学分析与 OCR 共用同一个模型配置。"
      />
      <div className="two-col">
        <form className="rc4-panel" onSubmit={profile}>
          <h2>账户信息</h2>
          <Field name="name" label="姓名" defaultValue={user.name} />
          {!user.is_school_admin && (
            <>
              <Select
                name="stage"
                label="学段"
                options={stages}
                defaultValue={user.stage}
              />
              <Field
                name="subject"
                label="学科"
                defaultValue={user.subject || ""}
              />
              <Field
                name="className"
                label="班级"
                defaultValue={user.class_name || ""}
              />
            </>
          )}
          <div className="readonly">
            <span>学校注册码</span>
            <code>{user.school_id}</code>
          </div>
          <Button className="full">保存设置</Button>
        </form>
        {user.role === "teacher" ? (
          <form className="rc4-panel" onSubmit={provider}>
            <h2>模型与 OCR API</h2>
            <p className="panel-intro">
              {user.is_school_admin
                ? "这里配置全校默认模型，未单独配置的教师会自动继承。AI 教学分析同样使用这里的模型。"
                : "图片和 PDF OCR 请选择标记为“视觉”的厂商；AI 教学分析使用同一个模型，纯文本厂商也可用于分析。教师可覆盖学校默认配置。"}
            </p>
            <label className="field">
              <span>厂商</span>
              <select name="provider" defaultValue={saved?.provider || "qwen"}>
                {providers.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                    {p.vision ? " · 视觉" : " · 文本"}
                  </option>
                ))}
              </select>
            </label>
            <Field name="model" label="模型名称（可选覆盖）" />
            <Field name="endpoint" label="兼容接口地址（可选覆盖）" />
            <Field
              name="apiKey"
              type="password"
              label="API Key"
              required
              autoComplete="off"
            />
            <div className="provider-grid">
              {providers.map((p) => (
                <span className={p.vision ? "vision" : ""} key={p.id}>
                  {p.name}
                  <small>{p.vision ? "可用于 OCR" : "仅文本智能"}</small>
                </span>
              ))}
            </div>
            {saved?.provider && (
              <p className="save-status">
                已保存：
                {providers.find((p) => p.id === saved.provider)?.name ||
                  saved.provider}
                {saved.model ? ` · ${saved.model}` : ""}
              </p>
            )}
            <Button className="full" type="submit" disabled={providerBusy}>
              <KeyRound />
              {providerBusy ? "正在加密保存…" : "加密保存"}
            </Button>
          </form>
        ) : (
          <section className="rc4-panel">
            <h2>{user.is_school_admin ? "学校账户边界" : "学生账户边界"}</h2>
            <p className="panel-intro">
              {user.is_school_admin
                ? "学校账户用于管理教师和学生，不参与任课、作业发布或 OCR 批改。"
                : "学生只能看到匹配学校、学段和班级的作业，以及教师复核后写入自己账户的错题。"}
            </p>
          </section>
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
