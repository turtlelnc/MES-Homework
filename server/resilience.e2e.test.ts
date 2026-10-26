import { beforeAll, afterAll, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createCanvas } from "@napi-rs/canvas";
import { seedTeachingFixture } from "./analysis.fixture.mjs";

let dir: string, base: string, db: DatabaseSync, f: any;
let child: ReturnType<typeof spawn>,
  teacher: string,
  student: string,
  peer: string;
const root = path.resolve(import.meta.dirname, "..");
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean) {
  for (let i = 0; i < 120; i++) {
    if (check()) return;
    await pause(20);
  }
  expect(check()).toBe(true);
}
const count = (table: string) =>
  Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
async function api(
  route: string,
  cookie = student,
  method = "GET",
  body?: unknown,
) {
  return fetch(base + route, {
    method,
    headers: {
      cookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const image = () => createCanvas(100, 100).toBuffer("image/jpeg");
async function upload(cookie = student) {
  const form = new FormData();
  form.set("files", new Blob([image()], { type: "image/jpeg" }), "test.jpg");
  return fetch(`${base}/api/assignments/${f.assignmentId}/submissions`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}
function partial(
  cookie: string,
  route = `/api/assignments/${f.assignmentId}/submissions`,
  raw = false,
) {
  const prefix = raw
    ? image().subarray(0, 100)
    : Buffer.from(
        '--fault\r\nContent-Disposition: form-data; name="files"; filename="test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
      );
  const request = http.request(base + route, {
    method: raw ? "PUT" : "POST",
    headers: {
      cookie,
      "content-length": "1000000",
      "content-type": raw
        ? "image/jpeg"
        : "multipart/form-data; boundary=fault",
      ...(raw
        ? {
            "x-content-sha256": createHash("sha256")
              .update(image())
              .digest("hex"),
          }
        : {}),
    },
  });
  request.on("response", (r) => r.resume());
  request.on("error", () => {});
  request.write(prefix);
  return request;
}
function mode(value: string) {
  fs.writeFileSync(path.join(dir, "mode"), value);
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-resilience-"));
  fs.mkdirSync(path.join(dir, "uploads"));
  db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  f = seedTeachingFixture(db);
  // v0.2.1：老师分开模式才允许教师配置自己的模型凭证（与旧测试假设一致）。
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES(?,?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode,updated_at=excluded.updated_at",
  ).run(f.schoolId, "teacher_class", new Date().toISOString());
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((r) => listener.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  mode("good");
  const preload = path.join(dir, "mock.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';import dns from 'node:dns';import {Writable} from 'node:stream';
  dns.promises.lookup=async()=>[{address:'1.1.1.1',family:4}];
  const mode=()=>fs.readFileSync(${JSON.stringify(path.join(dir, "mode"))},'utf8');
  const original=fs.createWriteStream;
  fs.createWriteStream=(...args)=>mode()==='diskfull'?new Writable({write(_c,_e,cb){cb(Object.assign(new Error('simulated disk full'),{code:'ENOSPC'}));}}):original(...args);
  globalThis.fetch=async(_url,options)=>{
    fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))},'call\\n');
    const m=mode();
    if(m==='headers')return new Promise((_r,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    if(m==='stall')return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"incomplete":'));},cancel(){fs.appendFileSync(${JSON.stringify(path.join(dir, "cancelled"))},'cancel\\n');}}));
    if(m==='large')return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(512));}}));
    const payload=JSON.parse(options.body);const text=payload.messages[0].content[0].text;
    const questions=JSON.parse(text.split('教师已经录入的正式题目=')[1].split('。\\n')[0]);
    return Response.json({usage:{prompt_tokens:1500,completion_tokens:100},choices:[{message:{content:JSON.stringify({ocrText:'RECOVERED',items:questions.map(q=>({questionId:q.id,isCorrect:true,score:q.score,studentAnswer:'2',confidence:.9}))})}}]});
  };`,
  );
  child = spawn(
    process.execPath,
    [
      "--max-old-space-size=256",
      "--import",
      pathToFileURL(preload).href,
      "server/index.mjs",
    ],
    {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        DATA_DIR: dir,
        NODE_ENV: "test",
        SYSTEM_PRESSURE_ENABLED: "0",
        APP_SECRET: "resilience-tests-only-never-a-real-secret",
        CLIENT_TILING_ENABLED: "1",
        DEEPSEEK_FILES_ENABLED: "0",
        MODEL_USER_DAILY_MICRO_CNY: "100000000",
        MODEL_SCHOOL_DAILY_MICRO_CNY: "200000000",
        MODEL_COST_RATES_JSON: JSON.stringify({
          "deepseek/deepseek-flash": {
            input: 1000000,
            output: 2000000,
            imageTokens: 1024,
          },
        }),
        UPLOAD_CONCURRENCY: "2",
        UPLOAD_TOTAL_MB: "10",
        UPLOAD_IDLE_TIMEOUT_MS: "350",
        UPLOAD_TIMEOUT_MS: "1200",
        UPLOAD_USER_DAILY_LIMIT: "1000",
        UPLOAD_SCHOOL_DAILY_LIMIT: "5000",
        UPLOAD_USER_HOURLY_PARTS: "1000",
        MODEL_GLOBAL_CONCURRENCY: "2",
        MODEL_SCHOOL_CONCURRENCY: "2",
        MODEL_RESPONSE_MAX_BYTES: "4096",
        MODEL_RESPONSE_IDLE_MS: "100",
        MODEL_REQUEST_TIMEOUT_MS: "350",
      },
    },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await api("/api/health", "")).ok) break;
    } catch {}
    await pause(50);
  }
  async function login(email: string) {
    const r = await api("/api/auth/login", "", "POST", {
      email,
      password: "ChangeMe123!",
    });
    expect(r.status).toBe(200);
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  teacher = await login("teacher@fixture.test");
  student = await login("lin@fixture.test");
  peer = await login("qing@fixture.test");
  expect(
    (
      await api("/api/settings/provider", teacher, "PUT", {
        provider: "deepseek",
        apiKey: "mock-only",
      })
    ).status,
  ).toBe(200);
}, 20000);
afterAll(async () => {
  if (child?.exitCode === null) {
    const done = once(child, "exit");
    child.kill();
    await done;
  }
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it("rejects a burst while writers are occupied, keeps reads responsive, and recovers without restarting", async () => {
  const first = partial(student),
    second = partial(peer);
  try {
    await until(() => count("upload_writers") === 2);
    // Send enough progress to hold both slots while checking overloaded admission.
    const drip = setInterval(() => {
      first.write(Buffer.alloc(100));
      second.write(Buffer.alloc(100));
    }, 100);
    try {
      const readings: number[] = [];
      const pid = child.pid;
      const rejected = await Promise.all(
        Array.from({ length: 40 }, () =>
          upload(teacher).then(
            (r) => r.status,
            () => 0,
          ),
        ),
      );
      // The earlier upload gate returns 429; the global request gate may
      // reject a burst with 503 before upload admission is reached.
      expect(rejected.every((s) => s === 429 || s === 503 || s === 0)).toBe(true);
      await Promise.all(
        Array.from({ length: 30 }, async () => {
          const start = performance.now();
          const r = await api(`/api/assignments/${f.assignmentId}`);
          expect(r.status).toBe(200);
          await r.arrayBuffer();
          readings.push(performance.now() - start);
        }),
      );
      readings.sort((a, b) => a - b);
      const rssKB = Number(
        fs
          .readFileSync(`/proc/${pid}/status`, "utf8")
          .match(/^VmRSS:\s+(\d+)/m)![1],
      );
      expect(rssKB).toBeLessThan(512 * 1024);
      expect(readings[Math.floor(readings.length * 0.95)]).toBeLessThan(2000);
      fs.writeFileSync(
        path.join(os.tmpdir(), "mes-resilience-results.json"),
        JSON.stringify({
          rejected: rejected.length,
          returned429: rejected.filter((s) => s === 429).length,
          resetConnections: rejected.filter((s) => s === 0).length,
          reads: readings.length,
          readP95Ms: Math.round(readings[Math.floor(readings.length * 0.95)]),
          sampledRssMiB: Math.round(rssKB / 1024),
        }),
      );
    } finally {
      clearInterval(drip);
    }
  } finally {
    first.destroy();
    second.destroy();
  }
  await until(
    () =>
      count("upload_writers") === 0 && count("upload_temporary_files") === 0,
  );
  expect(fs.readdirSync(path.join(dir, "uploads"))).toHaveLength(0);
  const recovered = await upload();
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  await recovered.arrayBuffer();
  expect(child.exitCode).toBeNull();
}, 10000);

it("reclaims partial multipart uploads after idle timeout and total deadline", async () => {
  const idle = partial(student);
  await until(() => count("upload_writers") === 1);
  await until(
    () =>
      count("upload_writers") === 0 && count("upload_temporary_files") === 0,
  );
  await until(() => idle.destroyed);
  const slow = partial(student);
  const drip = setInterval(() => slow.write(Buffer.alloc(100)), 70);
  try {
    await until(() => count("upload_writers") === 1);
    await until(
      () =>
        count("upload_writers") === 0 && count("upload_temporary_files") === 0,
    );
    await until(() => slow.destroyed);
  } finally {
    clearInterval(drip);
    slow.destroy();
  }
  expect((await api("/api/health", "")).status).toBe(200);
}, 10000);

it("reclaims raw tile uploads after disconnect or idle timeout and accepts retry", async () => {
  const r = await api(
    `/api/assignments/${f.assignmentId}/upload-sessions`,
    student,
    "POST",
    { pages: [{ name: "original.jpg", width: 100, height: 100 }] },
  );
  expect(r.status).toBe(201);
  const session = await r.json();
  const route = `/api/upload-sessions/${session.id}/parts/0`;
  for (const disconnect of [true, false]) {
    const req = partial(student, route, true);
    await until(() => count("upload_writers") === 1);
    if (disconnect) req.destroy();
    await until(() => count("upload_writers") === 0);
    expect(
      db
        .prepare(
          "SELECT status FROM upload_parts WHERE session_id=? AND index_no=0",
        )
        .get(session.id)!.status,
    ).toBe("empty");
  }
  const body = image();
  const retry = await fetch(base + route, {
    method: "PUT",
    headers: {
      cookie: student,
      "content-type": "image/jpeg",
      "x-content-sha256": createHash("sha256").update(body).digest("hex"),
    },
    body,
  });
  expect(retry.status).toBe(200);
  expect(
    (await api(`/api/upload-sessions/${session.id}`, student, "DELETE")).status,
  ).toBe(200);
});

it("survives disk write errors and subsequently accepts an ordinary upload", async () => {
  mode("diskfull");
  const failure = await upload();
  expect(failure.status).toBe(507);
  await failure.arrayBuffer();
  await until(
    () =>
      count("upload_writers") === 0 && count("upload_temporary_files") === 0,
  );
  mode("good");
  const success = await upload();
  expect(success.status).toBe(200);
  await success.arrayBuffer();
  expect((await api("/api/health", "")).status).toBe(200);
});

it("cancels stalled/oversized model responses, releases leases, and recognizes the next submission", async () => {
  mode("good");
  const submitted = await (await upload()).json();
  const id = submitted[0].id;
  for (const fault of ["headers", "stall", "large"]) {
    mode(fault);
    const r = await api(`/api/submissions/${id}/recognize`, teacher, "POST");
    expect(r.status).toBe(502);
    await r.arrayBuffer();
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM model_usage WHERE finished_at IS NULL")
        .get()!.n,
    ).toBe(0);
    expect((await api("/api/health", "")).status).toBe(200);
    await pause(50); // Wait for the isolated file parser's exit event.
  }
  expect(fs.readFileSync(path.join(dir, "cancelled"), "utf8")).toContain(
    "cancel",
  );
  mode("good");
  const recovered = await api(
    `/api/submissions/${id}/recognize`,
    teacher,
    "POST",
  );
  expect(recovered.status, await recovered.clone().text()).toBe(200);
  expect((await recovered.json()).ocrText).toBe("RECOVERED");
  expect(child.exitCode).toBeNull();
}, 10000);

it("cancels a synchronous model call when its client disconnects", async () => {
  mode("good");
  const submitted = await (await upload()).json();
  mode("headers");
  const req = http.request(
    `${base}/api/submissions/${submitted[0].id}/recognize`,
    {
      method: "POST",
      headers: { cookie: teacher },
    },
  );
  req.on("error", () => {});
  req.on("response", (r) => r.resume());
  req.end();
  await until(
    () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) n FROM model_costs WHERE status='dispatched'",
          )
          .get()!.n,
      ) === 1,
  );
  req.destroy();
  await until(
    () =>
      Number(
        db
          .prepare(
            "SELECT COUNT(*) n FROM model_usage WHERE finished_at IS NULL",
          )
          .get()!.n,
      ) === 0,
  );
  expect(
    Number(
      db
        .prepare("SELECT COUNT(*) n FROM model_costs WHERE status='unknown'")
        .get()!.n,
    ),
  ).toBeGreaterThan(0);
  mode("good");
  expect((await api("/api/health", "")).status).toBe(200);
});

it("streams two 8 MiB uploads while authenticated reads remain available", async () => {
  mode("good");
  const size = 8 * 1024 * 1024;
  const jpg = image();
  // Admission intentionally checks headers, not full image integrity.
  const payload = Buffer.concat([jpg, Buffer.alloc(size - jpg.length)]);
  const prefix = Buffer.from(
    '--stream\r\nContent-Disposition: form-data; name="files"; filename="large.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
  );
  const suffix = Buffer.from("\r\n--stream--\r\n");
  async function send(cookie: string) {
    const body = Readable.from(
      (async function* () {
        yield prefix;
        for (let start = 0; start < payload.length; start += 256 * 1024) {
          yield payload.subarray(start, start + 256 * 1024);
          await pause(3);
        }
        yield suffix;
      })(),
    );
    const r = await fetch(
      `${base}/api/assignments/${f.assignmentId}/submissions`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "multipart/form-data; boundary=stream",
          "content-length": String(
            prefix.length + payload.length + suffix.length,
          ),
        },
        body,
        duplex: "half",
      } as any,
    );
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  }
  const transfers = Promise.all([send(student), send(peer)]);
  const reads = [],
    samples = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const r = await api(`/api/assignments/${f.assignmentId}`);
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    reads.push(performance.now() - start);
    samples.push(
      Number(
        fs
          .readFileSync(`/proc/${child.pid}/status`, "utf8")
          .match(/^VmRSS:\s+(\d+)/m)![1],
      ) / 1024,
    );
    await pause(10);
  }
  await transfers;
  const p95 = reads.sort((a, b) => a - b)[Math.floor(reads.length * 0.95)];
  expect(p95).toBeLessThan(2000);
  expect(Math.max(...samples)).toBeLessThan(512);
  const reportPath = path.join(os.tmpdir(), "mes-resilience-results.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.streaming = {
    uploadedMiB: 16,
    concurrency: 2,
    readP95Ms: Math.round(p95),
    peakSampledRssMiB: Math.round(Math.max(...samples)),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));
}, 10000);

it("imports a CSV roster with compatible password hashes while reads continue", async () => {
  mode("good");
  const csv =
    "\uFEFF姓名,邮箱,初始密码,学段,班级\n" +
    Array.from(
      { length: 8 },
      (_, i) => `测试${i},roster${i}@fixture.test,ChangeMe123!,初中,测试班`,
    ).join("\n");
  const form = new FormData();
  form.set("file", new Blob([csv], { type: "text/csv" }), "students.csv");
  let completed = false;
  const importing = fetch(base + "/api/students/import", {
    method: "POST",
    headers: { cookie: teacher },
    body: form,
  }).then(async (r) => {
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.created).toHaveLength(8);
    expect(body.errors).toEqual([]);
    completed = true;
  });
  let checks = 0;
  while (!completed && checks < 50) {
    expect((await api(`/api/assignments/${f.assignmentId}`)).status).toBe(200);
    checks++;
    await pause(20);
  }
  await importing;
  expect(checks).toBeGreaterThan(1);
  const login = await api("/api/auth/login", "", "POST", {
    email: "roster0@fixture.test",
    password: "ChangeMe123!",
  });
  expect(login.status).toBe(200);
  await until(() => count("upload_temporary_files") === 0);
}, 10000);
