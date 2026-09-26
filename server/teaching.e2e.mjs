// 教学分析端到端校验：生成夹具数据库 → 启动隔离服务 → 校验全部读写接口与权限边界。
// 只覆盖确定性逻辑，不调用付费模型接口。
// 用法：npm run verify:teaching
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedTeachingFixture } from "./analysis.fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, ".tmp-teaching-verify");
const port = Number(process.env.VERIFY_PORT || 8799);
const base = `http://127.0.0.1:${port}/api`;
let cookie = "";
let failed = 0;
let server = null;

async function call(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
  });
  for (const c of res.headers.getSetCookie?.() || []) cookie = c.split(";")[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 300);
  }
  return { status: res.status, data };
}
const ok = (label, cond, extra = "") => {
  if (!cond) failed += 1;
  console.log(`${cond ? "PASS" : "FAIL"} · ${label}${extra ? " · " + extra : ""}`);
};

function prepareDatabase() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dataDir, "uploads"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "smart-campus.sqlite"));
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  const fixture = seedTeachingFixture(db);
  db.close();
  return fixture;
}

async function startServer() {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      APP_SECRET: process.env.APP_SECRET || "verify-only-secret-at-least-32-characters",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return child;
    } catch {
      /* 服务尚未就绪 */
    }
  }
  child.kill();
  throw new Error(`校验服务未能在 ${port} 端口启动`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

function removeDataDir() {
  // Windows 下数据库句柄释放略有延迟，重试几次即可
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

async function cleanup() {
  await stopServer();
  removeDataDir();
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

prepareDatabase();
server = await startServer();
console.log(`教学分析端到端校验（端口 ${port}）\n`);

const teacher = { email: "teacher@fixture.test", password: "ChangeMe123!" };

const health = await call("/health");
ok("health reports v0.2.0-rc1", health.data?.version === "v0.2.0-rc1");

ok(
  "wrong password rejected",
  (await call("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: teacher.email, password: "nope-wrong" }),
  })).status === 401,
);
const login = await call("/auth/login", {
  method: "POST",
  body: JSON.stringify(teacher),
});
ok("teacher login", login.status === 200, JSON.stringify(login.data));
ok(
  "unauthenticated teaching list blocked",
  (await (async () => {
    const saved = cookie;
    cookie = "";
    const res = await call("/teaching/assignments");
    cookie = saved;
    return res;
  })()).status === 401,
);

const list = await call("/teaching/assignments");
ok(
  "assignment list with mistake count",
  list.status === 200 &&
    list.data.length === 1 &&
    list.data[0].mistake_count === 9 &&
    list.data[0].question_count === 8,
  `mistakes=${list.data?.[0]?.mistake_count} questions=${list.data?.[0]?.question_count}`,
);
const assignmentId = list.data[0].id;

const detail = await call(`/teaching/assignments/${assignmentId}`);
const stats = detail.data?.stats;
ok(
  "class stats: reviewed-only mistakes",
  detail.status === 200 &&
    stats.overview.mistakeCount === 8 &&
    stats.overview.pendingMistakeCount === 1,
  JSON.stringify(stats?.overview),
);
ok(
  "class stats: score rate and average",
  stats.overview.scoreRate > 0 && stats.overview.scoreRate < 1,
  `scoreRate=${stats.overview.scoreRate.toFixed(3)} average=${stats.overview.averageScore}`,
);
ok(
  "class stats: knowledge mastery sorted ascending",
  (() => {
    const rates = stats.knowledgePoints.map((point) => point.correctRate);
    return rates.every((rate, index) => index === 0 || rates[index - 1] <= rate);
  })(),
  `${stats.knowledgePoints.length} knowledge points`,
);
ok(
  "class stats: reason ratios sum to 1",
  Math.abs(
    stats.reasonDistribution.reduce((sum, item) => sum + item.ratio, 0) - 1,
  ) < 1e-6,
  stats.reasonDistribution.map((r) => `${r.label}:${r.count}`).join(","),
);
ok(
  "class stats: unreadable listed separately",
  stats.reasonDistribution.some((item) => item.id === "unreadable"),
);
ok(
  "class stats: high-frequency questions ranked",
  stats.highFrequencyQuestions.every(
    (question, index, arr) =>
      index === 0 || arr[index - 1].wrongCount >= question.wrongCount,
  ) && stats.highFrequencyQuestions[0].wrongCount === 2,
);
ok(
  "class stats: students aggregated with dominant reason",
  stats.students.length === 2 &&
    stats.students.every((student) => student.dominantReason?.label),
  JSON.stringify(
    stats.students.map((s) => `${s.name}:${s.mistakeCount}:${s.dominantReason?.label}`),
  ),
);
ok(
  "class stats: reusable resources from review output",
  stats.resources.totalPractice > 0,
  `${stats.resources.knowledgePoints.length} knowledge points / ${stats.resources.totalPractice} practices`,
);

const lin = stats.students.find((student) => student.name === "林一");
const linDetail = await call(
  `/teaching/assignments/${assignmentId}/students/${lin.studentId}`,
);
ok(
  "student detail only contains that student's questions",
  linDetail.status === 200 &&
    linDetail.data.questions.length === lin.questionNumbers.length &&
    linDetail.data.questions.every((question) =>
      question.students.includes("林一"),
    ),
  `questions=${linDetail.data?.questions?.length}`,
);
ok(
  "student reason table recomputed per student",
  (() => {
    const unreadable = linDetail.data.reasons.find(
      (item) => item.id === "unreadable",
    );
    const answerable = linDetail.data.reasons.filter(
      (item) => item.id !== "unreadable",
    );
    const answerableTotal = answerable.reduce(
      (sum, item) => sum + item.count,
      0,
    );
    const reviewedTotal = answerableTotal + (unreadable?.count || 0);
    // 该生的错因统计必须与“教师已复核的错题数”对齐，且占比以错题总数为分母
    return (
      reviewedTotal === lin.mistakeCount &&
      answerable.every(
        (item) => Math.abs(item.ratio - item.count / lin.mistakeCount) < 1e-6,
      )
    );
  })(),
  linDetail.data.reasons
    .map((item) => `${item.label}:${item.count}`)
    .join(","),
);
const missingStudent = await call(
  `/teaching/assignments/${assignmentId}/students/not-a-student`,
);
ok("unknown student 404", missingStudent.status === 404);

const focus = await call(
  `/teaching/assignments/${assignmentId}/focus/${lin.studentId}`,
  { method: "PUT", body: JSON.stringify({ level: "priority", note: "面批" }) },
);
ok("focus mark saved", focus.status === 200 && focus.data.level === "priority");
const detail2 = await call(`/teaching/assignments/${assignmentId}`);
ok(
  "focus persisted",
  detail2.data.focus.some((item) => item.level === "priority"),
);
const focusOff = await call(
  `/teaching/assignments/${assignmentId}/focus/${lin.studentId}`,
  { method: "PUT", body: JSON.stringify({ level: "none" }) },
);
ok("focus mark removed", focusOff.data.level === null);

const reAssign = await call(
  `/teaching/assignments/${assignmentId}/mistakes-to-assignment`,
  { method: "POST", body: JSON.stringify({ numbers: [1, 3, 6] }) },
);
ok(
  "re-practice assignment created from high-frequency questions",
  reAssign.status === 200 && reAssign.data.questionCount === 3,
  JSON.stringify(reAssign.data),
);
const reList = await call("/teaching/assignments");
ok("new assignment appears in list", reList.data.length === 2);
const reDetail = await call(`/teaching/assignments/${reAssign.data.id}`);
ok(
  "new assignment starts with zero reviewed mistakes",
  reDetail.data.stats.overview.mistakeCount === 0,
);

const noKeyAnalysis = await call(
  `/teaching/assignments/${assignmentId}/analyze`,
  { method: "POST" },
);
ok(
  "ai analysis without api key fails with a clear message",
  noKeyAnalysis.status === 502 &&
    /API Key|模型/.test(noKeyAnalysis.data?.error || ""),
  `status=${noKeyAnalysis.status} error=${noKeyAnalysis.data?.error}`,
);
const noKeyReasons = await call(
  `/teaching/assignments/${assignmentId}/reasons`,
  { method: "POST" },
);
ok(
  "ai reason refine without api key fails cleanly",
  noKeyReasons.status === 502,
  `status=${noKeyReasons.status}`,
);

// 越权：另一位教师不能读取或写入这份作业
await call("/auth/logout", { method: "POST" });
const otherLogin = await call("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "lin@fixture.test", password: "ChangeMe123!" }),
});
ok("student login", otherLogin.status === 200);
const studentRead = await call(`/teaching/assignments/${assignmentId}`);
ok(
  "student cannot read class teaching stats",
  studentRead.status === 403 || studentRead.status === 404,
  `status=${studentRead.status}`,
);
const studentWrite = await call(
  `/teaching/assignments/${assignmentId}/analyze`,
  { method: "POST" },
);
ok("student cannot trigger ai analysis", studentWrite.status === 403);

await call("/auth/logout", { method: "POST" });
cookie = "";
await call("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "teacher@fixture.test", password: "ChangeMe123!" }),
});
const missingAssignment = await call("/teaching/assignments/nope");
ok("unknown assignment 404 for teacher", missingAssignment.status === 404);

// 学校管理员可以只读查看本校教学分析，但不能触发需要模型的生成动作
await call("/auth/logout", { method: "POST" });
cookie = "";
await call("/auth/login", {
  method: "POST",
  body: JSON.stringify({ email: "admin@fixture.test", password: "ChangeMe123!" }),
});
const adminRead = await call(`/teaching/assignments/${assignmentId}`);
ok(
  "school admin can read school-scoped analysis",
  adminRead.status === 200 &&
    adminRead.data.stats.overview.mistakeCount === stats.overview.mistakeCount,
  `status=${adminRead.status}`,
);
const adminWrite = await call(`/teaching/assignments/${assignmentId}/analyze`, {
  method: "POST",
});
ok(
  "school admin cannot trigger ai generation",
  adminWrite.status === 403,
  `status=${adminWrite.status}`,
);

console.log(
  failed
    ? `\n${failed} check(s) FAILED`
    : "\nall teaching-analysis API checks passed",
);
await cleanup();
process.exit(failed ? 1 : 0);
