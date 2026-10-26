import { useCapabilities } from "./capabilities";
import { useState } from "react";
import type { FormEvent, InputHTMLAttributes, ReactNode } from "react";
import {
  BookOpen,
  BrainCircuit,
  GraduationCap,
  Library,
  School,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";

type Role = "school" | "teacher" | "student" | "parent";
type Mode = "login" | "register";

const relations = ["父亲", "母亲", "其他监护人"];

const roleOptions: {
  id: Role;
  label: string;
  icon: ReactNode;
  desc: string;
}[] = [
  {
    id: "school",
    label: "学校",
    icon: <School size={16} />,
    desc: "创建学校空间与首位学校管理员账户。",
  },
  {
    id: "teacher",
    label: "老师",
    icon: <GraduationCap size={16} />,
    desc: "使用学校代码加入已有学校，创建任课教师账户。",
  },
  {
    id: "student",
    label: "学生",
    icon: <UserRound size={16} />,
    desc: "使用学校代码创建学生账户，学段与班级由自己选择。",
  },
  {
    id: "parent",
    label: "家长",
    icon: <Users size={16} />,
    desc: "绑定孩子的账号后，查看已复核作业与 AI 学情分析。",
  },
];

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
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AuthPage({ onDone }: { onDone: () => void }) {
  const { stages, publicRegistration } = useCapabilities();
  const [mode, setMode] = useState<Mode>("login");
  const [role, setRole] = useState<Role>("school");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    schoolCode: string;
    schoolName: string;
  } | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setCreated(null);
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api("/auth/login", json("POST", values));
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await api<{
        ok: boolean;
        schoolCode?: string;
        schoolName?: string;
        studentName?: string;
      }>("/auth/register", json("POST", { ...values, role }));
      if (role === "school" && result.schoolCode) {
        setCreated({
          schoolCode: result.schoolCode,
          schoolName: result.schoolName || String(values.schoolName || ""),
        });
        form.reset();
      } else {
        onDone();
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const activeRole = roleOptions.find((option) => option.id === role)!;

  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="rc4-brand">
          <span>
            <BookOpen />
          </span>
          <div>
            校园作业分析<small>SMART CAMPUS · v0.2.1-rc4</small>
          </div>
        </div>
        <div>
          <p className="eyebrow">SCHOOL READY WORKFLOW</p>
          <h1>
            从真实作业开始，
            <br />
            把每一步学习看清楚。
          </h1>
          <p>
            学校、老师、学生、家长四种账户各自隔离；家长绑定孩子后，只能查看教师已复核的
            作业与 AI 学情分析，数据按学校与家庭边界过滤。
          </p>
        </div>
        <div className="auth-features">
          <span>
            <School />
            学校注册
          </span>
          <span>
            <BrainCircuit />
            AI 学情分析
          </span>
          <span>
            <Library />
            家长可读
          </span>
        </div>
      </section>
      <section className="auth-form-wrap">
        {created ? (
          <div className="auth-form">
            <div>
              <span className="eyebrow">SCHOOL CREATED</span>
              <h2>{created.schoolName}已创建</h2>
              <p>把学校代码发给老师和学生，他们可以在注册时填写它加入学校。</p>
            </div>
            <div className="readonly">
              <span>学校代码</span>
              <code>{created.schoolCode}</code>
            </div>
            <Button className="full" onClick={onDone}>
              进入学校工作台
            </Button>
          </div>
        ) : mode === "login" ? (
          <form className="auth-form" onSubmit={login}>
            <div>
              <span className="eyebrow">WELCOME BACK</span>
              <h2>登录工作空间</h2>
              <p>使用账号名或邮箱登录，学校、老师、学生、家长共用入口。</p>
            </div>
            <Field
              name="account"
              label="账号名（或邮箱）"
              autoComplete="username"
              placeholder="例如 teacher01 或 teacher@example.com"
              required
            />
            <Field
              name="password"
              label="密码"
              type="password"
              autoComplete="current-password"
              minLength={8}
              placeholder="至少 8 位"
              required
            />
            {error && <p className="form-error">{error}</p>}
            <Button className="full" disabled={busy}>
              {busy ? "正在登录…" : "登录"}
            </Button>
            <div className="auth-links">
              <span />
              <button
                type="button"
                className="switch-auth"
                onClick={() => switchMode("register")}
              >
                {publicRegistration ? "还没有账户？注册" : "创建学校空间"}
              </button>
            </div>
          </form>
        ) : (
          <form className="auth-form" onSubmit={register}>
            <div>
              <span className="eyebrow">CREATE ACCOUNT</span>
              <h2>注册账户</h2>
              <p>
                {publicRegistration
                  ? "先选择身份，再填写对应的注册信息。"
                  : "公开加入已关闭；仍可创建独立学校空间。加入已有学校请联系管理员。"}
              </p>
            </div>
            <div className="role-pills" role="tablist" aria-label="注册身份">
              {roleOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  disabled={!publicRegistration && option.id !== "school"}
                  aria-selected={role === option.id}
                  className={role === option.id ? "active" : ""}
                  onClick={() => {
                    setRole(option.id);
                    setError("");
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {option.icon}
                    {option.label}
                  </span>
                </button>
              ))}
            </div>
            <p className="panel-intro" style={{ marginBottom: 16 }}>
              {activeRole.desc}
            </p>
            {role === "school" && (
              <Field
                name="schoolName"
                label="学校名称"
                placeholder="例如 海沙实验中学"
                required
              />
            )}
            <Field
              name="name"
              label={role === "school" ? "管理员姓名" : "姓名"}
              autoComplete="name"
              required
            />
            <Field
              name="username"
              label="账号名"
              autoComplete="username"
              placeholder="2–32 位字母、数字、下划线或中文"
              minLength={2}
              maxLength={32}
              required
            />
            <Field
              name="password"
              label="密码"
              type="password"
              autoComplete="new-password"
              minLength={8}
              placeholder="至少 8 位"
              required
            />
            {role !== "school" && (
              <Field
                name="schoolCode"
                label="学校代码"
                placeholder="向学校管理员索取，可填完整代码或前 8 位"
                required
              />
            )}
            {(role === "teacher" || role === "student") && (
              <div className="field-row">
                <Select
                  name="stage"
                  label="学段"
                  options={stages}
                  defaultValue={undefined}
                />
                <Field
                  name="className"
                  label="班级"
                  placeholder="例如 八年级（1）班"
                  required
                />
              </div>
            )}
            {role === "teacher" && (
              <Field
                name="subject"
                label="任教学科"
                placeholder="例如 物理"
                required
              />
            )}
            {role === "parent" && (
              <>
                <div className="field-row">
                  <Field
                    name="childUsername"
                    label="孩子账号名"
                    placeholder="孩子的登录账号（或邮箱）"
                    required
                  />
                  <Field
                    name="childPassword"
                    label="孩子密码"
                    type="password"
                    autoComplete="off"
                    placeholder="用于验证亲子关系"
                    required
                  />
                </div>
                <Select
                  name="relation"
                  label="与孩子的关系"
                  options={relations}
                  defaultValue="母亲"
                />
              </>
            )}
            {error && <p className="form-error">{error}</p>}
            <Button className="full" disabled={busy}>
              {busy
                ? "正在注册…"
                : role === "school"
                  ? "注册学校并进入"
                  : "注册并进入"}
            </Button>
            <div className="auth-links">
              <button
                type="button"
                className="switch-auth"
                onClick={() => switchMode("login")}
              >
                已有账户？返回登录
              </button>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  gap: 5,
                  color: "#98a2b2",
                  fontSize: 12,
                }}
              >
                <ShieldCheck size={14} /> 密码只在服务端加密存储
              </span>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
