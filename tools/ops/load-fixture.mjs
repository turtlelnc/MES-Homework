// Disposable load fixture. No production data and no outbound model traffic.
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { seedTeachingFixture } from "../../server/analysis.fixture.mjs";

if (process.env.MES_DISPOSABLE_LOAD_TEST !== "1")
  throw new Error("This entrypoint only runs in the disposable load harness");
const dir = "/run/load";
fs.writeFileSync(
  path.join(dir, "limits.json"),
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuMax: fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      memoryMax: fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
      swapMax: fs.readFileSync("/sys/fs/cgroup/memory.swap.max", "utf8").trim(),
    },
    null,
    2,
  ),
);
const data = path.join(dir, "data");
fs.mkdirSync(path.join(data, "uploads"), { recursive: true });
Object.assign(process.env, {
  DATA_DIR: data,
  HOST: "0.0.0.0",
  PORT: "8787",
  NODE_ENV: "test",
  APP_SECRET: "synthetic-load-test-only-never-a-production-secret",
  SYSTEM_PRESSURE_ENABLED: "1",
  CLIENT_TILING_ENABLED: "0",
  DEEPSEEK_FILES_ENABLED: "0",
  TRUST_PROXY_HOPS: "1",
});
dns.promises.lookup = async () => [{ address: "1.1.1.1", family: 4 }];
let modelActive = 0,
  modelPeakActive = 0;
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body);
  if (request.stream !== false)
    throw new Error("Load fixture requires explicit non-streaming responses");
  const content = request.messages[0].content;
  const text = Array.isArray(content) ? content[0].text : content;
  if (!text.startsWith("学校作业 OCR"))
    throw new Error("Unsupported mock: outbound traffic disabled");
  modelActive++;
  modelPeakActive = Math.max(modelPeakActive, modelActive);
  try {
    await pause(Number(process.env.LOAD_MODEL_DELAY_MS || 2000), undefined, {
      signal: options.signal,
    });
    const questions = JSON.parse(
      text.split("教师已经录入的正式题目=")[1].split("。\n")[0],
    );
    return Response.json({
      usage: { prompt_tokens: 1500, completion_tokens: 100 },
      choices: [
        {
          message: {
            content: JSON.stringify({
              ocrText: "SYNTHETIC",
              items: questions.map((q) => ({
                questionId: q.id,
                knowledgeId: q.knowledge_id,
                studentAnswer: "synthetic",
                isCorrect: true,
                score: q.score,
                confidence: 0.95,
              })),
            }),
          },
        },
      ],
    });
  } finally {
    modelActive--;
  }
};
const db = new DatabaseSync(path.join(data, "smart-campus.sqlite"));
db.exec(
  fs.readFileSync(new URL("../../server/schema.sql", import.meta.url), "utf8"),
);
const f = seedTeachingFixture(db);
const template = db.prepare("SELECT * FROM users WHERE id=?").get(f.teacherId);
const questions = db
  .prepare("SELECT * FROM questions WHERE assignment_id=?")
  .all(f.assignmentId);
const insertUser = db.prepare(
  "INSERT INTO users(id,school_id,role,name,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
);
const insertSession = db.prepare("INSERT INTO sessions VALUES(?,?,?)");
const manifest = { teachers: [], students: [], submissions: [] };
function session(id) {
  const token = randomUUID();
  insertSession.run(token, id, "2099-01-01T00:00:00.000Z");
  return `sc_session=${token}`;
}
const admin = db.prepare("SELECT id FROM users WHERE is_school_admin=1").get();
manifest.admin = session(admin.id);
const image = path.join(dir, "image.jpg");
const now = new Date().toISOString();
db.exec("BEGIN");
for (let t = 0; t < 100; t++) {
  const teacher = randomUUID(),
    assignment = randomUUID(),
    className = `Load class ${t}`;
  insertUser.run(
    teacher,
    f.schoolId,
    "teacher",
    `Teacher ${t}`,
    `teacher${t}@load.test`,
    template.password_hash,
    template.salt,
    "初中",
    "物理",
    className,
    now,
    0,
  );
  const cookie = session(teacher);
  db.prepare(
    "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    assignment,
    f.schoolId,
    teacher,
    `Load assignment ${t}`,
    "初中",
    "物理",
    className,
    null,
    "published",
    now,
  );
  for (const q of questions)
    db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,?,?)").run(
      randomUUID(),
      assignment,
      q.number,
      q.prompt,
      q.standard_answer,
      q.knowledge_id,
      q.score,
    );
  manifest.teachers.push({
    cookie,
    assignment,
    email: `teacher${t}@load.test`,
  });
  for (let s = 0; s < 100; s++) {
    const student = randomUUID(),
      submission = randomUUID();
    insertUser.run(
      student,
      f.schoolId,
      "student",
      `Student ${t}-${s}`,
      `student${t}-${s}@load.test`,
      template.password_hash,
      template.salt,
      "初中",
      null,
      className,
      now,
      0,
    );
    manifest.students.push({
      cookie: session(student),
      assignment,
      submission,
    });
    db.prepare(
      "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      submission,
      assignment,
      student,
      `Student ${t}-${s}`,
      image,
      "image/jpeg",
      "uploaded",
      now,
    );
    manifest.submissions.push({ id: submission, cookie });
  }
}
db.exec("COMMIT");
// Dummy key is encrypted by the real API after startup, never a real provider key.
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), {
  mode: 0o600,
});
db.close();
await import("../../server/index.mjs");
// The managed executor and Docker daemon use different network namespaces.
// A separate bounded-backpressure Unix/TCP relay exposes ONLY this fixture.
spawn(
  process.execPath,
  [
    "-e",
    `const net=require('net');net.createServer(a=>{
 const b=net.connect(8787,'127.0.0.1');a.pipe(b);b.pipe(a);
 a.on('error',()=>b.destroy());b.on('error',()=>a.destroy());
 a.on('close',()=>b.destroy());b.on('close',()=>a.destroy());
}).listen('/run/load/service.sock');`,
  ],
  { stdio: "ignore" },
);
const metricsDb = new DatabaseSync(path.join(data, "smart-campus.sqlite"));
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
let pending = false;
setInterval(async () => {
  if (pending) return;
  pending = true;
  try {
    const files = [
      "memory.current",
      "memory.peak",
      "memory.events",
      "cpu.stat",
      "memory.swap.current",
    ];
    const values = await Promise.all(
      files.map((f) => fs.promises.readFile(`/sys/fs/cgroup/${f}`, "utf8")),
    );
    const jobs = metricsDb
      .prepare(
        "SELECT status,COUNT(*) n,MIN(created_at) oldest FROM recognition_jobs GROUP BY status",
      )
      .all();
    const sample = {
      at: Date.now(),
      rssMiB: process.memoryUsage.rss() / 1024 ** 2,
      lagP95Ms: delay.percentile(95) / 1e6,
      lagMaxMs: delay.max / 1e6,
      modelActive,
      modelPeakActive,
      cgroup: Object.fromEntries(files.map((f, i) => [f, values[i].trim()])),
      jobs,
    };
    delay.reset();
    await fs.promises.appendFile(
      path.join(dir, "samples.jsonl"),
      JSON.stringify(sample) + "\n",
    );
  } catch (e) {
    console.error("load sampling failed", e.message);
  } finally {
    pending = false;
  }
}, 1000).unref();
