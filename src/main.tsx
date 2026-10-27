import { ReviewHistory } from "./ReviewHistory";
import { AssignmentDetails } from "./AssignmentDetails";
import { CapabilitiesProvider, useCapabilities } from "./capabilities";
import { uploadTiledSubmission } from "./tiled-upload";
import React, { useEffect, useRef, useState } from "react";
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
import { api, json, ApiError } from "./api";
import {
  changeReviewGrade,
  createReviewGuard,
  normalizeReviewDetail,
  reviewRows,
  reviewScoreError,
  type ReviewItem,
} from "./review-state";
import { Button } from "./components/ui/button";
import { TeachingAnalysis } from "./TeachingAnalysis";
import { AuthPage } from "./AuthPage";
import { ParentDashboard } from "./ParentDashboard";
import { ProviderSettings } from "./ProviderSettings";
import { SchoolModelPanel } from "./SchoolModelPanel";
import { StudentMistakes } from "./StudentMistakes";
import { VERSION_LABEL } from "./version";
import { WorkflowPage, type SectionRequest } from "./WorkflowPage";
import { printRegion } from "./print-region";
import "./styles.css";
type User = {
  id: string;
  school_id: string;
  role: "teacher" | "student" | "parent";
  name: string;
  username?: string;
  email?: string;
  stage: string;
  subject: string;
  class_name: string;
  is_school_admin: number;
  review_mode?: "all" | "uncertain" | "none";
  model_auth_mode?: "api_key" | "oauth";
  oauth_provider?: string | null;
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
  grading_mode?: "bank" | "direct";
  assignment_description?: string;
};
type Student = {
  id: string;
  name: string;
  username?: string;
  email?: string;
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
const teacherNav = [
  ["work", "教学工作台", BookOpen],
  ["settings", "设置", Settings],
] as const;
const adminNav = [
  ["school", "学校管理", School],
  ["settings", "账户设置", Settings],
] as const;
const studentNav = [
  ["learning", "学习工作台", BookOpen],
  ["settings", "账户设置", Settings],
] as const;
const parentNav = [
  ["parent", "孩子看板", BarChart3],
  ["settings", "账户设置", Settings],
] as const;
function App() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("work"),
    [toast, setToast] = useState("");
  const [sessionError, setSessionError] = useState("");
  const [sectionRequest, setSectionRequest] = useState<SectionRequest>(null);
  const navigationTicket = useRef(0);
  const navigate = (destination: string) => {
    const groups: Record<string, string> = {
      overview: "work",
      assignments: "work",
      review: "work",
      teaching: "work",
      students: "work",
      knowledge: "work",
      papers: "work",
    };
    setView(groups[destination] || destination);
    const firstSection: Record<string, string> = {
      work: "overview",
      learning: "assignments",
    };
    setSectionRequest({
      id: firstSection[destination] || destination,
      ticket: ++navigationTicket.current,
    });
  };
  const refreshGeneration = useRef(0);
  const refresh = async (expectSession = false, preserveView = false) => {
    const generation = ++refreshGeneration.current;
    try {
      const u = await api<User>("/me");
      if (generation !== refreshGeneration.current) return;
      setSessionError("");
      setUser(u);
      if (!preserveView) {
        setView(
          u.is_school_admin
            ? "school"
            : u.role === "teacher"
              ? "work"
              : u.role === "parent"
                ? "parent"
                : "learning",
        );
        setSectionRequest({
          id: u.is_school_admin
            ? "school"
            : u.role === "teacher"
              ? "overview"
              : u.role === "student"
                ? "assignments"
                : "parent",
          ticket: ++navigationTicket.current,
        });
      }
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setSessionError(
          expectSession
            ? "登录响应成功，但浏览器未能保持会话。请检查 Cookie 和 HTTPS 配置后重试。"
            : "",
        );
      } else {
        setSessionError(`暂时无法读取登录状态：${(error as Error).message}`);
      }
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  };
  const logout = async () => {
    const generation = ++refreshGeneration.current;
    try {
      await api("/auth/logout", { method: "POST" });
      if (generation !== refreshGeneration.current) return;
      setUser(null);
      setSessionError("");
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
        setSessionError("");
      } else setToast(`退出未完成：${(error as Error).message}，请重试。`);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [view]);
  // OAuth 回调会带 ?oauth_status=connected|error|denied 返回单页应用。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("oauth_status");
    if (!status) return;
    const provider = params.get("oauth_provider") || "";
    const labels: Record<string, string> = {
      connected: `OAuth 授权成功（${provider}），可在设置中选择使用。`,
      denied: "已取消 OAuth 授权。",
      error: "OAuth 授权未完成，请重试或改用 API Key。",
    };
    setToast(labels[status] || "OAuth 授权状态已更新。");
    params.delete("oauth_status");
    params.delete("oauth_provider");
    params.delete("oauth_reason");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
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
  if (!user && sessionError)
    return (
      <div className="auth-shell">
        <p role="alert">{sessionError}</p>
        <Button
          onClick={() => {
            setLoading(true);
            void refresh();
          }}
        >
          重试登录状态
        </Button>
      </div>
    );
  if (!user)
    return (
      <AuthPage
        onDone={() => {
          void refresh(true);
        }}
      />
    );
  const nav = user.is_school_admin
    ? adminNav
    : user.role === "teacher"
      ? teacherNav
      : user.role === "parent"
        ? parentNav
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
                : user.role === "teacher"
                  ? `教师 · ${user.stage} · ${user.class_name}`
                  : user.role === "parent"
                    ? "家长"
                    : `学生 · ${user.stage} · ${user.class_name}`}
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
              <small>学校编号 {user.school_id.slice(0, 8)}…</small>
            </div>
          </div>
          <nav>
            {nav.map(([id, label, Icon]) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => navigate(id)}
              >
                <Icon size={19} />
                {label}
                <ChevronRight size={15} />
              </button>
            ))}
          </nav>
          <button
            className="logout"
            onClick={() => {
              void logout();
            }}
          >
            <LogOut size={18} />
            退出登录
          </button>
        </aside>
        <main className="rc4-main">
          {sessionError && (
            <div role="alert">
              {sessionError}{" "}
              <Button
                onClick={() => {
                  void refresh();
                }}
              >
                重试登录状态
              </Button>
            </div>
          )}
          {view === "school" && (
            <SchoolWorkspace
              user={user}
              notify={setToast}
              request={sectionRequest}
            />
          )}{" "}
          {view === "work" &&
            user.role === "teacher" &&
            !user.is_school_admin && (
              <TeacherWorkspace
                user={user}
                notify={setToast}
                navigate={navigate}
                request={sectionRequest}
              />
            )}
          {view === "parent" && (
            <ParentDashboard user={user} notify={setToast} />
          )}{" "}
          {view === "learning" &&
            user.role === "student" &&
            !user.is_school_admin && (
              <WorkflowPage
                id="learning"
                label="学习工作台"
                request={sectionRequest}
                sections={[
                  {
                    id: "assignments",
                    label: "我的作业",
                    content: <Assignments user={user} notify={setToast} />,
                  },
                  {
                    id: "mistakes",
                    label: "我的错题",
                    content: <StudentMistakes notify={setToast} />,
                  },
                ]}
              />
            )}
          {view === "settings" && (
            <AccountSettings
              user={user}
              refresh={() => void refresh(false, true)}
              notify={setToast}
            />
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
function TeacherWorkspace({
  user,
  notify,
  navigate,
  request,
}: {
  user: User;
  notify: (message: string) => void;
  navigate: (view: string) => void;
  request: SectionRequest;
}) {
  const [revision, setRevision] = useState(0);
  const [reviewTarget, setReviewTarget] = useState<{
    id: string;
    ticket: number;
  } | null>(null);
  const [analysisTarget, setAnalysisTarget] = useState<{
    id: string;
    ticket: number;
  } | null>(null);
  const [assignmentTarget, setAssignmentTarget] = useState<{
    id: string;
    ticket: number;
  } | null>(null);
  const [section, setSection] = useState(request);
  const ticket = useRef(0);
  useEffect(() => setSection(request), [request]);
  const changed = () => setRevision((value) => value + 1);
  return (
    <WorkflowPage
      id="teaching"
      label="教学工作台"
      request={section}
      sections={[
        {
          id: "overview",
          label: "总览",
          content: (
            <Overview user={user} navigate={navigate} revision={revision} />
          ),
        },
        {
          id: "assignments",
          label: "作业与上传",
          content: (
            <Assignments
              user={user}
              notify={notify}
              revision={revision}
              preferred={assignmentTarget}
              onSubmitted={(id) => {
                changed();
                setReviewTarget({ id, ticket: ++ticket.current });
                setSection({ id: "review", ticket: -ticket.current });
              }}
            />
          ),
        },
        {
          id: "review",
          label: "识别与复核",
          content: (
            <Review
              notify={notify}
              revision={revision}
              preferred={reviewTarget}
              onReviewed={(id, bank) => {
                changed();
                if (bank) setAnalysisTarget({ id, ticket: ++ticket.current });
              }}
            />
          ),
        },
        {
          id: "teaching",
          label: "AI 教学分析",
          content: (
            <TeachingAnalysis
              notify={notify}
              refreshVersion={revision}
              preferred={analysisTarget}
              onAssignmentCreated={(id) => {
                changed();
                setAssignmentTarget({ id, ticket: ++ticket.current });
                setSection({ id: "assignments", ticket: -ticket.current });
              }}
            />
          ),
        },
        {
          id: "students",
          label: "学生管理",
          content: (
            <StudentsPage user={user} notify={notify} onChanged={changed} />
          ),
        },
        {
          id: "knowledge",
          label: "知识库",
          content: (
            <KnowledgeBase user={user} notify={notify} onChanged={changed} />
          ),
        },
        {
          id: "papers",
          label: "错题组卷",
          content: <Papers notify={notify} />,
        },
      ]}
    />
  );
}

function SchoolWorkspace({
  user,
  notify,
  request,
}: {
  user: User;
  notify: (message: string) => void;
  request: SectionRequest;
}) {
  const [revision, setRevision] = useState(0);
  return (
    <WorkflowPage
      id="school"
      label="学校管理"
      request={request}
      sections={[
        {
          id: "school",
          label: "学校仪表盘",
          content: (
            <SchoolDashboard user={user} notify={notify} revision={revision} />
          ),
        },
        {
          id: "students",
          label: "学生管理",
          content: (
            <StudentsPage
              user={user}
              notify={notify}
              onChanged={() => setRevision((value) => value + 1)}
            />
          ),
        },
      ]}
    />
  );
}

function Brand() {
  return (
    <div className="rc4-brand">
      <span>
        <BookOpen />
      </span>
      <div>
        校园作业分析<small>SMART CAMPUS · {VERSION_LABEL}</small>
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
  options?: string[];
  defaultValue?: string;
}) {
  const { stages } = useCapabilities();
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue}>
        {(options || stages).map((v) => (
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
function SchoolDashboard({
  user,
  notify,
  revision = 0,
}: {
  user: User;
  notify: (s: string) => void;
  revision?: number;
}) {
  const [summary, setSummary] = useState<any>(null);
  const [operations, setOperations] = useState<any>(null);
  const [teachers, setTeachers] = useState<TeacherAccount[]>([]);
  const loadGeneration = useRef(0);
  const load = () => {
    const generation = ++loadGeneration.current;
    return Promise.all([
      api<any>("/school/summary"),
      api<TeacherAccount[]>("/teachers"),
      api<any>("/operations"),
    ]).then(([schoolSummary, teacherRows, status]) => {
      if (generation !== loadGeneration.current) return;
      setOperations(status);
      setSummary(schoolSummary);
      setTeachers(teacherRows);
    });
  };
  useEffect(() => {
    void load().catch((error) => notify(error.message));
  }, [revision]);
  useEffect(
    () => () => {
      ++loadGeneration.current;
    },
    [],
  );
  const addTeacher = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(
        "/teachers",
        json("POST", Object.fromEntries(new FormData(form))),
      );
      form.reset();
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
        desc={`学校账户管理组织、成员与模型调用模式，不直接参与作业复核。学校编号：${user.school_id}`}
      />
      <div className="metric-grid">
        {[
          ["教师账户", summary?.teachers || 0, "人"],
          ["学生账户", summary?.students || 0, "人"],
          ["家长账户", summary?.parents || 0, "人"],
          ["全校作业", summary?.assignments || 0, "份"],
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
      <section className="rc4-panel">
        <div className="detail-head">
          <h2>本校任务运行状态</h2>
          <Button
            onClick={() => void load().catch((error) => notify(error.message))}
          >
            刷新状态
          </Button>
        </div>
        {operations ? (
          <>
            <p>
              近 24 小时模型调用 {operations.modelUsage.callsLastDay} 次，近 1
              小时 {operations.modelUsage.callsLastHour} 次，当前调用{" "}
              {operations.modelUsage.active} 个。失败调用也计入用量。
            </p>
            {operations.resources && (
              <p>
                服务资源状态：
                {operations.resources.level === "critical"
                  ? "暂停新增上传和识别"
                  : operations.resources.level === "limited"
                    ? "降载运行"
                    : "正常"}
                。应用内存约 {operations.resources.rssMiB} MiB。
                {operations.resources.systemSupported
                  ? `可用内存预算约 ${operations.resources.availableMiB} MiB。`
                  : "系统指标不可用，仍保留进程内存保护。"}
              </p>
            )}
            {operations.runtime && (
              <p>
                实际 CPU 配额 {operations.runtime.cpuCapacity} 核，有效内存预算{" "}
                {operations.runtime.memoryMiB} MiB；主堆预算{" "}
                {operations.runtime.heapMiB} MiB，模型并发{" "}
                {operations.runtime.modelConcurrency}，后台并发{" "}
                {operations.runtime.ocrConcurrency}。
                {operations.resources?.diskFreeMiB !== null &&
                  `文件系统剩余 ${operations.resources.diskFreeMiB} MiB，保留 ${operations.resources.diskReserveMiB} MiB。`}
              </p>
            )}
            {operations.costBudget?.enabled && (
              <p>
                费用预算已用或预留{" "}
                {(operations.costBudget.exposureMicroCny / 1000000).toFixed(4)}{" "}
                元 /{" "}
                {(operations.costBudget.schoolLimitMicroCny / 1000000).toFixed(
                  2,
                )}{" "}
                元；待核实用量 {operations.costBudget.uncertain} 笔。
                {operations.costBudget.requiresReview &&
                  "恢复后账本待管理员确认，模型调用已暂停。"}
              </p>
            )}
            <p>
              近 15 分钟请求 {operations.requestsLast15Minutes.requests}{" "}
              次，服务端错误 {operations.requestsLast15Minutes.serverErrors}{" "}
              次，平均响应 {operations.requestsLast15Minutes.averageMs}{" "}
              毫秒。此统计在服务重启后重新计数。
            </p>
            <p>
              {["queued", "running", "succeeded", "failed"]
                .map(
                  (status) =>
                    `${({ queued: "排队", running: "处理", succeeded: "成功", failed: "失败" } as Record<string, string>)[status]}：${operations.jobs.find((job: any) => job.status === status)?.count || 0}`,
                )
                .join(" · ")}
            </p>
          </>
        ) : (
          <p>正在加载运行状态…</p>
        )}
      </section>
      <div className="two-col">
        <form className="rc4-panel" onSubmit={addTeacher}>
          <h2>
            <UserPlus size={19} /> 注册教师
          </h2>
          <Field name="name" label="教师姓名" required />
          <Field
            name="username"
            label="登录账号名"
            required
            minLength={2}
            maxLength={32}
            placeholder="2–32 位字母/数字/下划线/中文"
          />
          <Field
            name="password"
            label="初始密码"
            type="password"
            minLength={8}
            required
          />
          <div className="field-row">
            <Select name="stage" label="任教学段" options={undefined} />
            <Field name="subject" label="任教学科" required />
          </div>
          <Field name="className" label="默认班级 / 班主任班级" required />
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
                    <small>
                      {teacherAccount.username
                        ? `账号名：${teacherAccount.username}`
                        : teacherAccount.email}
                    </small>
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
  revision = 0,
}: {
  user: User;
  navigate: (v: string) => void;
  revision?: number;
}) {
  const [a, setA] = useState<Assignment[]>([]),
    [s, setS] = useState<Submission[]>([]),
    [k, setK] = useState<Knowledge[]>([]),
    [students, setStudents] = useState<Student[]>([]);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Assignment[]>("/assignments"),
      api<Submission[]>("/submissions"),
      api<Knowledge[]>("/knowledge"),
      api<Student[]>("/students"),
    ]).then(([aa, ss, kk, uu]) => {
      if (!active) return;
      setA(aa);
      setS(ss);
      setK(kk);
      setStudents(uu);
    });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <>
      <Title
        eyebrow="TEACHING WORKSPACE"
        title={`${user.name}老师，今天从真实作业开始。`}
        desc={`${user.stage} · ${user.subject} · ${user.class_name}。在本页完成作业上传、识别复核与教学分析。`}
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
            AI
            教学分析把已复核的错题换算成班级知识点掌握率、错因占比、高频错题讲评脚本、
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
  revision = 0,
  preferred = null,
  onSubmitted,
}: {
  user: User;
  notify: (s: string) => void;
  revision?: number;
  preferred?: { id: string; ticket: number } | null;
  onSubmitted?: (id: string) => void;
}) {
  const [items, setItems] = useState<Assignment[]>([]),
    [knowledge, setKnowledge] = useState<Knowledge[]>([]),
    [students, setStudents] = useState<Student[]>([]),
    [creating, setCreating] = useState(false),
    [selected, setSelected] = useState(""),
    [files, setFiles] = useState<FileList | null>(null),
    [studentId, setStudentId] = useState(""),
    [tilingAvailable, setTilingAvailable] = useState(false),
    [useTiling, setUseTiling] = useState(false),
    [uploading, setUploading] = useState(false),
    [uploadProgress, setUploadProgress] = useState("");
  const uploadController = useRef<AbortController | null>(null);
  const uploadSession = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  const load = () => {
    const generation = ++loadGeneration.current;
    return Promise.all([
      api<Assignment[]>("/assignments"),
      api<Knowledge[]>("/knowledge"),
      user.role === "teacher"
        ? api<Student[]>("/students")
        : Promise.resolve([]),
    ]).then(([aa, kk, ss]) => {
      if (generation !== loadGeneration.current) return;
      setItems(aa);
      setKnowledge(kk);
      setStudents(ss);
      setSelected((v) => v || aa[0]?.id || "");
    });
  };
  useEffect(() => {
    void load().catch((error) => notify(error.message));
  }, [revision]);
  useEffect(() => {
    if (preferred) setSelected(preferred.id);
  }, [preferred?.ticket]);
  useEffect(() => {
    let active = true;
    void api<{ clientTiling: boolean }>("/upload-capabilities")
      .then((c) => {
        if (active) setTilingAvailable(c.clientTiling);
      })
      .catch(() => {});
    return () => {
      active = false;
      ++loadGeneration.current;
      uploadController.current?.abort();
    };
  }, []);
  const cancelUpload = async () => {
    uploadController.current?.abort();
    const id = uploadSession.current;
    if (id) await api(`/upload-sessions/${id}`, { method: "DELETE" });
    uploadSession.current = null;
    setUploadProgress("");
  };
  const create = async (payload: {
    title: string;
    dueAt: string;
    gradingMode?: "bank" | "direct";
    description?: string;
    stage?: string;
    subject?: string;
    className?: string;
    questions?: DraftQuestion[];
  }) => {
    const created = await api<{ id: string }>(
      "/assignments",
      json("POST", payload),
    );
    setCreating(false);
    notify(
      payload.gradingMode === "direct"
        ? "已发布「无需原题 · AI 直接批改」作业，学生上传答卷后即可批改。"
        : "作业已发布。",
    );
    await load();
    setSelected(created.id);
  };
  const send = async () => {
    if (!selected) {
      setCreating(true);
      notify("请先新增并发布一份作业，再上传学生答卷。");
      return;
    }
    if (!files?.length) return;
    if (uploading) return;
    setUploading(true);
    const controller = new AbortController();
    uploadController.current = controller;
    try {
      let submittedId = "";
      if (useTiling) {
        const uploaded = await uploadTiledSubmission(
          Array.from(files),
          selected,
          studentId,
          {
            signal: controller.signal,
            progress: setUploadProgress,
            sessionId: uploadSession.current,
            remember: (id) => {
              uploadSession.current = id;
            },
          },
        );
        submittedId = uploaded.id || "";
      } else {
        setUploadProgress("正在上传原件…");
        const body = new FormData();
        Array.from(files).forEach((file) => body.append("files", file));
        if (studentId) body.append("studentId", studentId);
        const uploaded = await api<{ id: string }[]>(
          `/assignments/${selected}/submissions`,
          {
            method: "POST",
            body,
            signal: controller.signal,
          },
        );
        submittedId = uploaded[0]?.id || "";
      }
      uploadSession.current = null;
      notify(
        user.role === "teacher"
          ? "原件已上传，可在本页下方识别与复核。"
          : "作业已提交。",
      );
      setFiles(null);
      if (fileInput.current) fileInput.current.value = "";
      setUploadProgress("");
      if (submittedId) onSubmitted?.(submittedId);
    } finally {
      setUploading(false);
    }
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
      <AssignmentDetails id={selected} />
      {creating && (
        <AssignmentForm
          user={user}
          knowledge={knowledge}
          onSave={create}
          notify={notify}
        />
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
                  disabled={uploading || !!uploadSession.current}
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
              disabled={uploading || !!uploadSession.current}
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
                disabled={uploading || !!uploadSession.current}
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
                ? `同一份答卷：已选择 ${files.length} 个文件`
                : "选择真实作业原件"}
            </strong>
            <span>请按页序选择同一位学生的全部答卷文件，再由教师开始 OCR</span>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf,.docx,.doc,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              disabled={uploading || !!uploadSession.current}
              onChange={(e) => setFiles(e.target.files)}
            />
          </label>
          {tilingAvailable && (
            <label className="check">
              <input
                type="checkbox"
                checked={useTiling}
                disabled={uploading || !!uploadSession.current}
                onChange={(e) => setUseTiling(e.target.checked)}
              />
              在设备上切分照片（保留原图，仅支持 JPG/PNG/WebP）
            </label>
          )}
          {uploadProgress && <p role="status">{uploadProgress}</p>}
          {(uploading || uploadSession.current) && (
            <Button
              onClick={() =>
                void cancelUpload().catch((e) => notify(e.message))
              }
            >
              取消本次上传
            </Button>
          )}
          <Button
            className="full"
            disabled={
              uploading ||
              !files?.length ||
              (user.role === "teacher" && !studentId)
            }
            onClick={() => send().catch((e) => notify(e.message))}
          >
            {uploading
              ? "正在处理上传…"
              : uploadSession.current
                ? "重试未完成的上传"
                : selected
                  ? "保存并进入识别队列"
                  : "先创建正式作业"}
          </Button>
        </section>
      </div>
    </>
  );
}
function AssignmentForm({
  user,
  knowledge,
  onSave,
  notify,
}: {
  user: User;
  knowledge: Knowledge[];
  onSave: (x: {
    title: string;
    dueAt: string;
    gradingMode?: "bank" | "direct";
    description?: string;
    stage?: string;
    subject?: string;
    className?: string;
    questions?: DraftQuestion[];
  }) => Promise<void>;
  notify: (s: string) => void;
}) {
  const blank = (): DraftQuestion => ({
    prompt: "",
    standardAnswer: "",
    score: 0,
    knowledgeId: "",
  });
  const { stages } = useCapabilities();
  const [mode, setMode] = useState<"bank" | "direct">("bank"),
    [title, setTitle] = useState(""),
    [dueAt, setDueAt] = useState(""),
    [stage, setStage] = useState(user.stage || stages[0]),
    [subject, setSubject] = useState(user.subject || ""),
    [className, setClassName] = useState(user.class_name || ""),
    [description, setDescription] = useState(""),
    [questions, setQuestions] = useState<DraftQuestion[]>([blank()]),
    [busy, setBusy] = useState(false),
    [submitting, setSubmitting] = useState(false),
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
      setMode("bank");
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
    if (submitting) return;
    if (!title.trim()) return notify("请填写作业名称。");
    if (mode === "direct") {
      setSubmitting(true);
      try {
        await onSave({
          title,
          dueAt,
          gradingMode: "direct",
          description,
          stage,
          subject,
          className,
        });
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (questions.some((q) => !q.prompt.trim()))
      return notify("每道题都必须有题干。");
    if (questions.some((q) => !q.standardAnswer.trim()))
      return notify("请补全标准答案或评分要点后再发布。");
    if (questions.some((q) => !q.knowledgeId))
      return notify("请为每道题确认知识点。");
    setSubmitting(true);
    try {
      await onSave({ title, dueAt, questions, stage, subject, className });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="rc4-panel assignment-form" onSubmit={submit}>
      <div
        className="field-row"
        style={{
          gap: 8,
          marginBottom: 12,
          gridTemplateColumns: "1fr 1fr",
        }}
      >
        {[
          ["bank", "按原题批改（先上传/录入题目）"],
          ["direct", "无需原题 · AI 直接批改"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={mode === id ? "btn" : "btn btn-outline"}
            onClick={() => setMode(id as "bank" | "direct")}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "bank" ? (
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
      ) : (
        <p className="panel-intro">
          不用上传原题。发布后学生直接提交答卷，AI
          会按卷面切题、给出参考答案与评分要点、逐题批改并说明判断逻辑；
          下方「作业内容描述」可选填，用于告诉 AI
          这次作业的范围、题量和重点（例如“第 3 章课后练习 1–10
          题，重点考查串联电路计算”）。
        </p>
      )}
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
      <div className="field-row">
        <label className="field">
          <span>学段</span>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {stages.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <Field
          label="学科"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
        <Field
          label="班级"
          value={className}
          onChange={(e) => setClassName(e.target.value)}
        />
      </div>
      {mode === "direct" ? (
        <label className="field">
          <span>作业内容描述（非必填）</span>
          <textarea
            rows={4}
            maxLength={2000}
            placeholder="例如：第 3 章课后练习 1–10 题，重点考查串联电路计算；第 8 题是附加题。"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      ) : (
        questions.map((q, i) => (
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
        ))
      )}
      <div className="form-actions">
        {mode === "bank" && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setQuestions((q) => [...q, blank()])}
          >
            <Plus />
            增加题目
          </Button>
        )}
        <Button disabled={submitting}>
          {submitting ? "正在发布…" : "核对完成并发布"}
        </Button>
      </div>
    </form>
  );
}

function StudentsPage({
  user,
  notify,
  onChanged,
}: {
  user: User;
  notify: (s: string) => void;
  onChanged?: () => void;
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
    const form = e.currentTarget;
    try {
      await api(
        "/students",
        json("POST", Object.fromEntries(new FormData(form))),
      );
      form.reset();
      notify("学生账户已注册。");
      load();
      onChanged?.();
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
      onChanged?.();
    } catch (err) {
      notify((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = () => {
    const csv = "姓名,账号名,初始密码,学段,班级\r\n";
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
        desc={`学校编号：${user.school_id}。支持单个注册与 CSV/XLSX 批量导入。`}
      />
      <div className="two-col">
        <form className="rc4-panel" onSubmit={register}>
          <h2>
            <UserPlus size={19} /> 注册单个学生
          </h2>
          <Field name="name" label="姓名" required />
          <Field
            name="username"
            label="账号名"
            required
            minLength={2}
            maxLength={32}
            placeholder="2–32 位字母/数字/下划线/中文"
          />
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
              options={undefined}
              defaultValue={user.stage || undefined}
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
            表头：姓名、账号名、初始密码、学段、班级。账号名留空时自动生成，密码留空时自动生成，并仅在本次结果中显示。
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
                  {x.name} · 账号名 <code>{x.username}</code> · 初始密码{" "}
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
              <b>账号名</b>
              <b>学段</b>
              <b>班级</b>
            </div>
            {students.map((s) => (
              <div key={s.id}>
                <span>{s.name}</span>
                <span>{s.username || s.email || "—"}</span>
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
function Review({
  notify,
  revision = 0,
  preferred = null,
  onReviewed,
}: {
  notify: (s: string) => void;
  revision?: number;
  preferred?: { id: string; ticket: number } | null;
  onReviewed?: (assignmentId: string, bank: boolean) => void;
}) {
  const [items, setItems] = useState<Submission[]>([]),
    [detail, setDetail] = useState<any>(null),
    [busy, setBusy] = useState<Record<string, string>>({}),
    [loading, setLoading] = useState(false),
    [attentionOnly, setAttentionOnly] = useState(false),
    [reviewMode, setReviewMode] = useState<"all" | "uncertain" | "none">("all"),
    [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const guard = useRef(createReviewGuard()).current;
  const listGeneration = useRef(0);
  const modeRef = useRef<"all" | "uncertain" | "none">("all");
  useEffect(() => {
    api<{ mode: "all" | "uncertain" | "none" }>("/settings/review-mode")
      .then((result) => {
        modeRef.current = result.mode;
        setReviewMode(result.mode);
      })
      .catch(() => undefined);
  }, []);
  const suspect = (item: ReviewItem) =>
    item.suspect === true ||
    (item.suspect === undefined &&
      (!Number.isFinite(item.confidence) ||
        Number(item.confidence) < 0.8 ||
        Boolean(item.studentAnswer?.includes("无法辨认"))));
  const load = async () => {
    const generation = ++listGeneration.current;
    try {
      const result = await api<Submission[]>("/submissions");
      if (generation === listGeneration.current) setItems(result);
      return 2000;
    } catch (e) {
      if (generation === listGeneration.current) notify((e as Error).message);
      return Math.max(2000, e instanceof ApiError ? e.retryAfterMs : 0);
    }
  };
  useEffect(() => {
    void load();
  }, [revision]);
  useEffect(
    () => () => {
      guard.select(null);
      ++listGeneration.current;
    },
    [],
  );
  const select = async (id: string) => {
    const ticket = guard.select(id);
    setAttentionOnly(modeRef.current === "uncertain");
    setConfirmed({});
    setDetail(null);
    setLoading(true);
    try {
      const result = await api<any>(`/submissions/${id}`);
      if (guard.isCurrent(ticket)) setDetail(normalizeReviewDetail(result));
    } catch (e) {
      if (guard.isCurrent(ticket)) notify((e as Error).message);
    } finally {
      if (guard.isCurrent(ticket)) setLoading(false);
    }
  };
  useEffect(() => {
    if (preferred) void select(preferred.id);
  }, [preferred?.ticket]);
  // Poll only active jobs. Selection tickets prevent a late response replacing another draft.
  useEffect(() => {
    if (!items.some((item) => ["queued", "recognizing"].includes(item.status)))
      return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const delay = await load();
      if (!stopped) timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [items]);
  useEffect(() => {
    if (!detail || !["queued", "recognizing"].includes(detail.status)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const ticket = guard.current();
    const poll = async () => {
      let delay = 2000;
      try {
        const result = await api<any>(`/submissions/${ticket.id}`);
        if (cancelled || !guard.isCurrent(ticket)) return;
        setDetail(normalizeReviewDetail(result));
        if (!["queued", "recognizing"].includes(result.status)) {
          void load();
          if (result.teacher_reviewed && result.assignment_id)
            onReviewed?.(
              result.assignment_id,
              result.grading_mode !== "direct",
            );
          return;
        }
      } catch (error) {
        delay = Math.max(
          delay,
          error instanceof ApiError ? error.retryAfterMs : 0,
        );
      }
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [detail?.id, detail?.status]);
  const finish = (
    ticket: NonNullable<ReturnType<typeof guard.startOperation>>,
  ) => {
    if (!guard.finishOperation(ticket)) return;
    setBusy((state) => {
      const next = { ...state };
      delete next[ticket.id!];
      return next;
    });
    void load();
  };
  const recognize = async (id: string) => {
    const operation = guard.startOperation(id);
    if (!operation) return;
    setBusy((state) => ({ ...state, [id]: "recognize" }));
    try {
      await api(`/submissions/${id}/recognition-jobs`, { method: "POST" });
      // Reload canonical status and scores instead of merging a result into another draft.
      if (guard.current().id === id) {
        // A fresh generation also supersedes a pending GET from reselecting A.
        await select(id);
        if (guard.current().id === id)
          notify("已加入后台识别队列，可切换答卷或稍后回来查看。");
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      finish(operation);
    }
  };
  const update = (questionId: string, key: string, value: any) => {
    setConfirmed((state) => ({ ...state, [questionId]: true }));
    setDetail((d: any) => {
      if (!d || busy[d.id] || d.status !== "review") return d;
      const question = d.questions?.find((q: any) => q.id === questionId);
      if (!question) return d;
      return {
        ...d,
        analysis: {
          ...d.analysis,
          items: d.analysis.items.map((item: ReviewItem) =>
            item.questionId !== questionId
              ? item
              : key === "isCorrect"
                ? changeReviewGrade(item, question, { isCorrect: value })
                : key === "score"
                  ? changeReviewGrade(item, question, { score: value })
                  : { ...item, [key]: value },
          ),
        },
      };
    });
  };
  const approve = async () => {
    const draft = detail;
    if (!draft || draft.status !== "review") return;
    const error = reviewScoreError(
      draft.questions || [],
      draft.analysis?.items || [],
    );
    if (error) return notify(error);
    const rows = reviewRows(
      draft.questions || [],
      draft.analysis?.items || [],
    ).rows;
    if (reviewMode === "uncertain") {
      const pending = rows.filter(
        ({ item }) => suspect(item) && confirmed[item.questionId] !== true,
      );
      if (pending.length)
        return notify(
          `还有 ${pending.length} 道存疑题未核对：请逐题确认“我已核对”或直接修改判分。`,
        );
    }
    const operation = guard.startOperation(draft.id);
    if (!operation) return;
    setBusy((state) => ({ ...state, [draft.id]: "review" }));
    try {
      await api(
        `/submissions/${draft.id}/review`,
        json("POST", {
          ...draft.analysis,
          items: draft.analysis.items.map((item: ReviewItem) => ({
            ...item,
            score: Number(item.score),
            confirmed:
              !suspect(item) || confirmed[item.questionId] === true
                ? true
                : undefined,
          })),
        }),
      );
      notify("复核完成，错题已写入学生账户。");
      if (draft.assignment_id)
        onReviewed?.(draft.assignment_id, draft.grading_mode !== "direct");
      if (guard.current().id === draft.id) {
        guard.select(null);
        setDetail(null);
        setLoading(false);
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      finish(operation);
    }
  };
  const review = reviewRows(
    detail?.questions || [],
    detail?.analysis?.items || [],
  );
  const rows = review.rows.filter(
    ({ item }) => !attentionOnly || suspect(item),
  );
  const suspectCount = review.rows.filter(({ item }) => suspect(item)).length;
  const modeLabel =
    reviewMode === "all"
      ? "全部复核"
      : reviewMode === "uncertain"
        ? "仅存疑复核"
        : "不复核";
  return (
    <>
      <Title
        eyebrow="OCR & REVIEW"
        title="识别与复核"
        desc={`当前复核方式：${modeLabel}。批改结果、参考答案与 AI 判断逻辑会同时展示；学生端不会直接看到答案。`}
      />
      <div className="review-layout">
        <section className="rc4-panel">
          <h2>识别队列</h2>
          {items.length ? (
            <div className="select-list">
              {items.map((x) => (
                <button key={x.id} onClick={() => select(x.id)}>
                  <div>
                    <strong>
                      {x.student_name} · {x.assignment_title}
                    </strong>
                    <small>
                      {statusName(x.status)}{" "}
                      {x.teacher_reviewed ? "· 已复核" : ""}
                      {x.grading_mode === "direct" ? " · 无需原题直批" : ""}
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
            <Empty
              text={loading ? "正在加载答卷…" : "选择提交查看识别状态。"}
            />
          ) : (
            <>
              <div className="detail-head">
                <div>
                  <h2>{detail.student_name}</h2>
                  <p>
                    {statusName(detail.status)}
                    {detail.grading_mode === "direct"
                      ? " · 无需原题 · AI 直接批改"
                      : ""}
                    {detail.status === "completed" && detail.score !== null
                      ? ` · 得分 ${detail.score}`
                      : ""}
                  </p>
                </div>
                {(["uploaded", "failed", "completed"].includes(detail.status) ||
                  (detail.status === "review" && !!review.error)) && (
                  <Button
                    disabled={!!busy[detail.id]}
                    onClick={() => recognize(detail.id)}
                  >
                    <RefreshCw />
                    {busy[detail.id] === "recognize"
                      ? "逐页 OCR 中…"
                      : detail.status === "completed"
                        ? "重新识别（覆盖当前结果）"
                        : "开始 OCR"}
                  </Button>
                )}
              </div>
              {reviewMode === "none" && detail.status === "review" && (
                <p role="status">
                  当前为「不复核」方式：AI
                  批改结果已自动完成；若结果不完整或需要修改，请直接在此复核或重新识别。
                </p>
              )}
              {detail.assignment_description && (
                <p className="panel-intro">
                  <strong>作业内容描述：</strong>
                  {detail.assignment_description}
                </p>
              )}
              {detail.recognitionJob &&
                (["queued", "recognizing", "failed"].includes(detail.status) ||
                  detail.recognitionJob.status === "failed") && (
                  <p role="status">
                    {detail.recognitionJob.status === "failed"
                      ? "上次后台识别未完成。"
                      : detail.status === "queued"
                        ? "已排队，系统会自动处理。"
                        : statusName(detail.status)}
                    {` 已尝试 ${detail.recognitionJob.attempts} 次。`}
                    {detail.recognitionJob.error &&
                      ` ${detail.recognitionJob.error}`}
                  </p>
                )}
              {detail.files?.length > 0 && (
                <div className="field">
                  <span>答卷原件（按上传顺序）</span>
                  {detail.files.map(
                    (file: { name: string; url: string }, index: number) => (
                      <a
                        key={file.url}
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        第 {index + 1} 个附件：{file.name}
                      </a>
                    ),
                  )}
                </div>
              )}
              <ReviewHistory
                key={`${detail.id}:${detail.status}:${detail.score}`}
                submissionId={detail.id}
              />
              {detail.ocr_text && (
                <label className="field">
                  <span>OCR 原文</span>
                  <textarea rows={7} value={detail.ocr_text} readOnly />
                </label>
              )}
              {detail.analysis && review.error && (
                <p role="alert">{review.error}</p>
              )}
              {review.rows.length > 0 && (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={attentionOnly}
                    onChange={(e) => setAttentionOnly(e.target.checked)}
                  />
                  仅显示需重点复核的存疑题（{suspectCount} 题）
                </label>
              )}
              {rows.map(({ question, item: x }) => {
                const isSuspect = suspect(x);
                return (
                  <fieldset
                    className="review-item"
                    key={question.id}
                    disabled={!!busy[detail.id] || detail.status !== "review"}
                  >
                    <div>
                      <strong>
                        第 {question.number} 题 · 满分 {question.score}
                        {x.isCorrect ? " · 判为正确" : " · 判为错误"}
                        {isSuspect ? " · 存疑" : " · AI 高置信度"}
                      </strong>
                      <span
                        className={isSuspect ? "low" : ""}
                        title="AI 识别/判分置信度"
                      >
                        置信度{" "}
                        {Number.isFinite(Number(x.confidence))
                          ? `${Math.round(Number(x.confidence) * 100)}%`
                          : "未提供"}
                      </span>
                    </div>
                    <p>{question.prompt}</p>
                    {question.standard_answer && (
                      <p>教师标准答案：{question.standard_answer}</p>
                    )}
                    <p>
                      <b>AI 批改结果：</b>
                      {x.isCorrect ? "正确" : "错误"} · 得分{" "}
                      {Number.isFinite(Number(x.score)) ? x.score : "—"}
                    </p>
                    {x.reasoning && (
                      <div className="auto-explanation">
                        <strong>AI 判断逻辑</strong>
                        <p>{x.reasoning}</p>
                      </div>
                    )}
                    <label>
                      学生答案
                      <textarea
                        value={x.studentAnswer || ""}
                        onChange={(e) =>
                          update(question.id, "studentAnswer", e.target.value)
                        }
                      />
                    </label>
                    <label>
                      订正说明
                      <textarea
                        value={x.correction || ""}
                        onChange={(e) =>
                          update(question.id, "correction", e.target.value)
                        }
                      />
                    </label>
                    {x.explanation && x.explanation !== x.correction && (
                      <p>
                        <b>分步解析：</b>
                        {x.explanation}
                      </p>
                    )}
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={x.isCorrect === true}
                        onChange={(e) =>
                          update(question.id, "isCorrect", e.target.checked)
                        }
                      />
                      判为正确
                    </label>
                    <label className="field">
                      <span>得分（0–{question.score}）</span>
                      <input
                        type="number"
                        min={0}
                        max={question.score}
                        step="any"
                        value={x.score ?? ""}
                        onChange={(e) =>
                          update(question.id, "score", e.target.value)
                        }
                      />
                    </label>
                    {reviewMode === "uncertain" &&
                      isSuspect &&
                      detail.status === "review" && (
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={confirmed[question.id] === true}
                            onChange={(e) =>
                              setConfirmed((state) => ({
                                ...state,
                                [question.id]: e.target.checked,
                              }))
                            }
                          />
                          我已核对这道存疑题
                        </label>
                      )}
                  </fieldset>
                );
              })}
              {detail.status === "review" && (
                <Button
                  className="full"
                  disabled={!!busy[detail.id] || !!review.error}
                  onClick={approve}
                >
                  {busy[detail.id] === "review"
                    ? "正在保存复核…"
                    : reviewMode === "uncertain"
                      ? "确认存疑题并完成复核"
                      : "确认复核并写入错题本"}
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
      queued: "排队中",
      recognizing: "识别中",
      review: "等待复核",
      completed: "已完成",
      failed: "识别失败",
    }) as Record<string, string>
  )[s] || s;
function KnowledgeBase({
  user,
  notify,
  onChanged,
}: {
  user: User;
  notify: (s: string) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Knowledge[]>([]);
  const load = () => api<Knowledge[]>("/knowledge").then(setItems);
  useEffect(() => {
    load();
  }, []);
  const add = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api(
        "/knowledge",
        json("POST", Object.fromEntries(new FormData(form))),
      );
      form.reset();
      notify("知识点已保存。");
      await load();
      onChanged?.();
    } catch (error) {
      notify((error as Error).message);
    }
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
              options={undefined}
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
    [current, setCurrent] = useState<any>(null),
    [busy, setBusy] = useState(false);
  const load = () => api<any[]>("/papers").then(setPapers);
  useEffect(() => {
    void load().catch((e) => notify(e.message));
  }, []);
  const make = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    try {
      const result = await api("/papers/generate", json("POST", values));
      setCurrent(result);
      await load();
      notify(result.questions.length ? "试卷已生成。" : "尚无已复核错题。");
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Title
        eyebrow="MISTAKE PAPER"
        title="通过错题出试卷"
        desc="题源仅包含教师复核错题，可重新打开历史试卷。"
      />
      <div className="two-col">
        <section>
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
            <Button className="full" disabled={busy}>
              <Sparkles />
              {busy ? "正在组卷…" : "从错题组卷"}
            </Button>
          </form>
          <section className="rc4-panel">
            <h2>历史试卷（{papers.length}）</h2>
            {papers.length ? (
              papers.map((p) => (
                <Button
                  key={p.id}
                  variant="outline"
                  onClick={() => setCurrent({ ...p, questions: p.content })}
                >
                  {p.title} · {new Date(p.created_at).toLocaleString()}
                </Button>
              ))
            ) : (
              <Empty text="暂无已保存试卷。" />
            )}
          </section>
        </section>
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
            <Empty text="请选择历史试卷或创建新试卷。" />
          )}
          {!!current?.questions?.length && (
            <Button
              variant="outline"
              onClick={(event) =>
                printRegion(event.currentTarget.closest(".paper"))
              }
            >
              打印 / 保存 PDF
            </Button>
          )}
        </section>
      </div>
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
  const [modelRevision, setModelRevision] = useState(0);
  const profile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(e.currentTarget));
      await api("/me", json("PATCH", values));
      notify("账户设置已更新。");
      refresh();
    } catch (error) {
      notify((error as Error).message);
    }
  };
  const editableProfile = user.role === "teacher" && !user.is_school_admin;
  return (
    <>
      <Title
        eyebrow="ACCOUNT & SECURITY"
        title="设置"
        desc="账号名注册与登录；模型凭证按学校选择的调用模式生效。审核方式、OAuth 授权与 API Key 都集中在这里。"
      />
      {!!user.is_school_admin && (
        <SchoolModelPanel
          notify={notify}
          onChanged={() => setModelRevision((value) => value + 1)}
        />
      )}
      {(user.is_school_admin || user.role !== "student") && (
        <ProviderSettings
          configurationRevision={modelRevision}
          user={user}
          notify={notify}
        />
      )}
      <div className="two-col">
        <form className="rc4-panel" onSubmit={profile}>
          <h2>账户信息</h2>
          <Field name="name" label="姓名" defaultValue={user.name} />
          {editableProfile && (
            <>
              <Select
                name="stage"
                label="学段"
                options={undefined}
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
            <span>账号名</span>
            <code>{user.username || "（旧账号，可用邮箱登录）"}</code>
          </div>
          {user.email && (
            <div className="readonly">
              <span>邮箱（旧登录方式）</span>
              <code>{user.email}</code>
            </div>
          )}
          <div className="readonly">
            <span>学校编号</span>
            <code>{user.school_id}</code>
          </div>
          <Button className="full">保存设置</Button>
        </form>
        {user.role === "student" ? (
          <section className="rc4-panel">
            <h2>学生账户边界</h2>
            <p className="panel-intro">
              学生只能看到匹配学校、学段和班级的作业；错题本以“先思考、再提示、重做后对照答案”的方式呈现，
              不会直接给出答案。模型调用使用学校/班主任/家长在对应模式下配置的凭证。
            </p>
          </section>
        ) : (
          <section className="rc4-panel">
            <h2>模型凭证由谁配置</h2>
            <p className="panel-intro">
              {user.is_school_admin
                ? "你是学校管理员：在本页选择全校模型调用模式、配置班主任及学校凭证。"
                : user.role === "parent"
                  ? "家长账号可在「孩子看板」查看已绑定孩子的数据；在「老师分开 + 家长单独」模式下，可在本页配置自己的 API Key 或 OAuth 连接。"
                  : "你的模型凭证是否生效取决于学校选择的调用模式：全校统一模式使用学校管理员的凭证；老师分开模式使用你自己的凭证，学生与家长使用班主任的凭证。"}
            </p>
          </section>
        )}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CapabilitiesProvider>
      <App />
    </CapabilitiesProvider>
  </React.StrictMode>,
);
