import { Readable } from "node:stream";
import { beforeAll, afterAll, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createCanvas } from "@napi-rs/canvas";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { seedTeachingFixture } from "./analysis.fixture.mjs";
let dir: string,
  base: string,
  db: DatabaseSync,
  child: ReturnType<typeof spawn>,
  f: any,
  teacher: string,
  student: string,
  peer: string;
const root = path.resolve(import.meta.dirname, "..");
async function request(
  route: string,
  cookie = teacher,
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
async function login(email: string) {
  const r = await request("/api/auth/login", "", "POST", {
    email,
    password: "ChangeMe123!",
  });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}
const jpeg = (width: number, height: number) => {
  const c = createCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "black";
  ctx.font = "32px sans-serif";
  ctx.fillText("1 + 1 = 2", 30, 60);
  return c.toBuffer("image/jpeg");
};
async function put(id: string, index: number, body: Buffer, cookie = teacher) {
  return fetch(`${base}/api/upload-sessions/${id}/parts/${index}`, {
    method: "PUT",
    headers: {
      cookie,
      "content-type": "image/jpeg",
      "x-content-sha256": createHash("sha256").update(body).digest("hex"),
    },
    body,
  });
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-tiles-"));
  fs.mkdirSync(path.join(dir, "uploads"));
  db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  f = seedTeachingFixture(db);
  // v0.2.1：老师分开模式才允许教师配置自己的模型凭证（与旧测试假设一致）。
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES(?,?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode,updated_at=excluded.updated_at",
  ).run(f.schoolId, "teacher_class", new Date().toISOString());
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((r) => listener.close(() => r()));
  base = `http://127.0.0.1:${port}`;
  const preload = path.join(dir, "mock.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';import dns from 'node:dns';import {DatabaseSync} from 'node:sqlite';
 dns.promises.lookup=async()=>[{address:'1.1.1.1',family:4}];
 let sequence=0;
 globalThis.fetch=async(url,options)=>{
   const database=new DatabaseSync(${JSON.stringify(path.join(dir, "smart-campus.sqlite"))},{readOnly:true});
   const costs=database.prepare('SELECT status FROM model_costs ORDER BY rowid DESC LIMIT 1').get();database.close();
   const log={url,method:options.method,costStatus:costs?.status};
   if(options.body instanceof FormData){
     if(options.body.get('expires_after[seconds]')!=='3600')throw new Error('TTL missing');
     log.fileName=options.body.get('file').name;
     fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))},JSON.stringify(log)+'\\n');
     return Response.json({id:'file-api-fixture-'+(++sequence)});
   }
   if(options.method==='DELETE')return Response.json({deleted:true});
   const payload=JSON.parse(options.body);log.payload=payload;
   fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))},JSON.stringify(log)+'\\n');
   const mode=${JSON.stringify(path.join(dir, "mode"))};
   if(fs.existsSync(mode)&&fs.readFileSync(mode,'utf8')==='unknown')throw new Error('simulated lost response');
   const text=payload.messages[0].content[0].text;
   const questions=JSON.parse(text.split('教师已经录入的正式题目=')[1].split('。\\n')[0]);
   return Response.json({usage:{prompt_tokens:2200,completion_tokens:50},choices:[{message:{content:JSON.stringify({ocrText:'TILED_MOCK',items:questions.map(q=>({questionId:q.id,isCorrect:true,score:q.score,studentAnswer:'2',confidence:.95}))})}}]});
 };
 `,
  );
  child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "server/index.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dir,
      NODE_ENV: "test",
      SYSTEM_PRESSURE_ENABLED: "0",
      APP_SECRET: "tiling-test-only-not-a-real-production-key",
      CLIENT_TILING_ENABLED: "1",
      DEEPSEEK_FILES_ENABLED: "1",
      MODEL_SCHOOL_DAILY_MICRO_CNY: "200000000",
      MODEL_USER_DAILY_MICRO_CNY: "100000000",
      MODEL_MAX_OUTPUT_TOKENS: "2048",
      MODEL_COST_RATES_JSON: JSON.stringify({
        "deepseek/deepseek-flash": { input: 1000000, output: 2000000 },
      }),
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await request("/api/health", "")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  teacher = await login("teacher@fixture.test");
  student = await login("lin@fixture.test");
  peer = await login("qing@fixture.test");
  expect(
    (
      await request("/api/settings/provider", teacher, "PUT", {
        provider: "deepseek",
        apiKey: "mock-only",
      })
    ).status,
  ).toBe(200);
}, 20000);
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
it("uploads overlapping tiles idempotently, preserves originals and uses budgeted Files API", async () => {
  const create = await request(
    `/api/assignments/${f.assignmentId}/upload-sessions`,
    teacher,
    "POST",
    {
      studentId: f.students[0].id,
      pages: [{ name: "original.jpg", width: 1800, height: 1200 }],
    },
  );
  expect(create.status).toBe(201);
  const session = await create.json();
  expect(session.parts).toHaveLength(3);
  expect(
    (await request(`/api/upload-sessions/${session.id}`, peer)).status,
  ).toBe(404);
  expect(
    (
      await request(
        `/api/upload-sessions/${session.id}/finalize`,
        teacher,
        "POST",
      )
    ).status,
  ).toBe(409);
  const original = jpeg(1800, 1200),
    tile = jpeg(1300, 1200);
  expect((await put(session.id, 0, original)).status).toBe(200);
  expect(
    (await (await put(session.id, 0, original)).json()).alreadyReceived,
  ).toBe(true);
  expect((await put(session.id, 0, jpeg(1801, 1200))).status).toBe(409);
  expect((await put(session.id, 1, tile, peer)).status).toBe(404);
  expect((await put(session.id, 1, jpeg(20, 20))).status).toBe(400);
  const chunked = await fetch(
    `${base}/api/upload-sessions/${session.id}/parts/1`,
    {
      method: "PUT",
      headers: {
        cookie: teacher,
        "content-type": "image/jpeg",
        "x-content-sha256": createHash("sha256").update(tile).digest("hex"),
      },
      body: Readable.from([tile.subarray(0, 200), tile.subarray(200)]),
      duplex: "half",
    } as any,
  );
  expect(chunked.status).toBe(200);
  expect((await put(session.id, 2, tile)).status).toBe(200); // identical content at different positions is allowed
  const finalized = await request(
    `/api/upload-sessions/${session.id}/finalize`,
    teacher,
    "POST",
  );
  expect(finalized.status).toBe(200);
  const { id } = await finalized.json();
  expect(
    (
      await (
        await request(
          `/api/upload-sessions/${session.id}/finalize`,
          teacher,
          "POST",
        )
      ).json()
    ).id,
  ).toBe(id);
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM submission_tiles WHERE submission_id=?")
      .get(id)!.n,
  ).toBe(2);
  expect(
    (await request(`/api/submissions/${id}/recognition-jobs`, teacher, "POST"))
      .status,
  ).toBe(202);
  let detail: any;
  for (let i = 0; i < 80; i++) {
    detail = await (await request(`/api/submissions/${id}`)).json();
    if (!["queued", "recognizing"].includes(detail.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(detail.status).toBe("review");
  expect(detail.ocr_text).toBe("TILED_MOCK");
  expect(detail.files).toHaveLength(1);
  const raw = await fetch(base + detail.files[0].url, {
    headers: { cookie: student },
  });
  expect(Buffer.from(await raw.arrayBuffer())).toEqual(original);
  expect(
    (await (await request(`/api/submissions/${id}`, student)).json()).analysis,
  ).toBeNull();
  const calls = fs
    .readFileSync(path.join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  expect(calls.filter((c) => c.url.endsWith("/files"))).toHaveLength(2);
  expect(
    calls
      .filter((c) => c.url.endsWith("/files"))
      .every((c) => c.costStatus === "reserved"),
  ).toBe(true);
  const chat = calls.find((c) => c.url.endsWith("/chat/completions"));
  expect(chat.costStatus).toBe("dispatched");
  expect(chat.payload.max_tokens).toBe(2048);
  expect(
    chat.payload.messages[0].content.filter((c: any) => c.type === "file"),
  ).toHaveLength(2);
  expect(
    db
      .prepare(
        "SELECT charged,status FROM model_costs ORDER BY rowid DESC LIMIT 1",
      )
      .get(),
  ).toMatchObject({ charged: 2300, status: "settled" });
  for (let i = 0; i < 40; i++) {
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM provider_files WHERE status!='deleted'",
        )
        .get()!.n === 0
    )
      break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(
    db
      .prepare("SELECT COUNT(*) n FROM provider_files WHERE status!='deleted'")
      .get()!.n,
  ).toBe(0);
});
it("bounds manifests, raw requests and cancellation before any model call", async () => {
  const before = fs.existsSync(path.join(dir, "calls.jsonl"))
    ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8")
    : "";
  expect(
    (
      await request(
        `/api/assignments/${f.assignmentId}/upload-sessions`,
        teacher,
        "POST",
        { pages: [{ width: 8000, height: 8000 }] },
      )
    ).status,
  ).toBe(400);
  const response = await request(
    `/api/assignments/${f.assignmentId}/upload-sessions`,
    student,
    "POST",
    { pages: [{ width: 100, height: 100 }] },
  );
  expect(response.status).toBe(201);
  const session = await response.json();
  const forged = await fetch(
    `${base}/api/upload-sessions/${session.id}/parts/999`,
    {
      method: "PUT",
      headers: { cookie: student, "content-type": "image/jpeg" },
      body: jpeg(100, 100),
    },
  );
  expect(forged.status).toBe(400);
  expect(
    (await request(`/api/upload-sessions/${session.id}`, student, "DELETE"))
      .status,
  ).toBe(200);
  expect((await put(session.id, 0, jpeg(100, 100), student)).status).toBe(409);
  expect(fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8")).toBe(before);
});

it("does not discard reviewed grades or contact a provider when money cannot be reserved", async () => {
  const row = db
    .prepare("SELECT submission_id FROM submission_tiles LIMIT 1")
    .get()!;
  const id = String(row.submission_id);
  const questions = db
    .prepare("SELECT id,score FROM questions WHERE assignment_id=?")
    .all(f.assignmentId);
  expect(
    (
      await request(`/api/submissions/${id}/review`, teacher, "POST", {
        items: questions.map((q) => ({
          questionId: q.id,
          isCorrect: true,
          score: q.score,
        })),
      })
    ).status,
  ).toBe(200);
  const before = db
    .prepare(
      "SELECT status,teacher_reviewed,score,analysis_json FROM submissions WHERE id=?",
    )
    .get(id);
  const calls = fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8");
  const time = Date.now();
  db.prepare(
    "INSERT INTO model_costs VALUES('force-budget',?,?, 'deepseek','deepseek-flash','unknown',200000000,200000000,0,0,1000000,2000000,?,?)",
  ).run(f.teacherId, f.schoolId, time, time);
  try {
    expect(
      (await request(`/api/submissions/${id}/recognize`, teacher, "POST"))
        .status,
    ).toBe(429);
    expect(
      db
        .prepare(
          "SELECT status,teacher_reviewed,score,analysis_json FROM submissions WHERE id=?",
        )
        .get(id),
    ).toEqual(before);
    expect(
      (
        await request(
          `/api/submissions/${id}/recognition-jobs`,
          teacher,
          "POST",
        )
      ).status,
    ).toBe(202);
    let detail: any;
    for (let i = 0; i < 80; i++) {
      detail = await (await request(`/api/submissions/${id}`)).json();
      if (detail.recognitionJob?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(detail.recognitionJob.status).toBe("failed");
    expect(
      db
        .prepare(
          "SELECT status,teacher_reviewed,score,analysis_json FROM submissions WHERE id=?",
        )
        .get(id),
    ).toEqual(before);
    expect(fs.readFileSync(path.join(dir, "calls.jsonl"), "utf8")).toBe(calls);
  } finally {
    db.prepare("DELETE FROM model_costs WHERE id='force-budget'").run();
  }
});
