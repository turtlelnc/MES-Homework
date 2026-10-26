// Linux/local Docker only. Disposable hard-limited service, external load driver.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const output = path.resolve(process.argv[2] || `/tmp/mes-load-${Date.now()}`);
if (process.platform !== "linux")
  throw new Error("This harness requires Linux");
// Never seed into an existing directory that might contain someone's data.
fs.mkdirSync(output, { mode: 0o700 });
const env = { ...process.env };
for (const name of [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
])
  delete env[name];
const dockerArgs = ["--host=unix:///var/run/docker.sock"];
const docker = (...args) =>
  execFileSync("docker", [...dockerArgs, ...args], {
    env,
    encoding: "utf8",
    timeout: 30000,
  });
const image = "mes-load-local:24";
try {
  docker("image", "inspect", image);
} catch {
  execFileSync("docker", [...dockerArgs, "import", "-", image], {
    env,
    input: Buffer.alloc(10240),
    timeout: 30000,
  });
}
const name = `mes-load-${process.pid}`;
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, () => {
    try {
      docker("rm", "-f", name);
    } catch {}
    fs.rmSync(path.join(output, "manifest.json"), { force: true });
    process.exit(code);
  });
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: 2048,
  maxTotalSockets: 2048,
  maxFreeSockets: 32,
});
const { createCanvas, ImageData } = await import("@napi-rs/canvas");
const canvas = createCanvas(1300, 1300);
const pixels = randomBytes(1300 * 1300 * 4);
for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
canvas
  .getContext("2d")
  .putImageData(new ImageData(new Uint8ClampedArray(pixels), 1300, 1300), 0, 0);
const jpeg = canvas.toBuffer("image/jpeg");
fs.writeFileSync(path.join(output, "image.jpg"), jpeg);
const multipart = Buffer.concat([
  Buffer.from(
    '--load\r\nContent-Disposition: form-data; name="files"; filename="load.jpg"\r\nContent-Type: image/jpeg\r\n\r\n',
  ),
  jpeg,
  Buffer.from("\r\n--load--\r\n"),
]);
const clientIPs = new Map();
function request(
  route,
  cookie,
  method = "GET",
  body,
  extra = {},
  slow = false,
) {
  return new Promise((resolve) => {
    const start = performance.now();
    let settled = false,
      timer,
      trickle;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(trickle);
      resolve({ ...value, ms: performance.now() - start });
    };
    const req = http.request(
      {
        socketPath: path.join(output, "service.sock"),
        path: route,
        agent,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(cookie && clientIPs.has(cookie)
            ? { "x-forwarded-for": clientIPs.get(cookie) }
            : {}),
          ...(body
            ? {
                "content-length": body.length,
                "content-type": "application/json",
              }
            : {}),
          ...extra,
        },
      },
      (res) => {
        let bytes = 0,
          chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes < 65536) chunks.push(chunk);
        });
        res.on("end", () =>
          done({
            status: res.statusCode,
            bytes,
            body: Buffer.concat(chunks).toString(),
          }),
        );
        res.on("error", () => done({ status: "response_error" }));
      },
    );
    req.on("error", (e) => done({ status: e.code || "network_error" }));
    timer = setTimeout(() => {
      done({ status: "timeout" });
      req.destroy();
    }, 5000);
    if (slow) {
      req.write(body.subarray(0, 16384));
      let offset = 16384;
      trickle = setInterval(() => {
        if (offset >= body.length) {
          clearInterval(trickle);
          req.end();
        } else {
          req.write(body.subarray(offset, offset + 32768));
          offset += 32768;
        }
      }, 100);
    } else req.end(body);
  });
}
const json = (x) => Buffer.from(JSON.stringify(x));
const random = (list) => list[Math.floor(Math.random() * list.length)];
const quantile = (values, p) =>
  values.length
    ? Math.round(
        values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1],
      )
    : null;
let manifest,
  sequence = 0,
  queueIndex = 0;
async function operation() {
  const n = sequence++ % 100;
  const teacher = random(manifest.teachers),
    student = random(manifest.students);
  if (n < 70) {
    const kind = n % 5;
    const route =
      kind === 0
        ? "/api/me"
        : kind === 1
          ? "/api/assignments"
          : kind === 2
            ? `/api/submissions/${student.submission}`
            : kind === 3
              ? "/api/submissions"
              : `/api/teaching/assignments/${teacher.assignment}`;
    return [
      "read",
      await request(route, kind >= 3 ? teacher.cookie : student.cookie),
    ];
  }
  if (n < 75)
    return [
      "login",
      await request(
        "/api/auth/login",
        null,
        "POST",
        json({ email: teacher.email, password: "ChangeMe123!" }),
        // Emulate distinct users behind a trusted reverse proxy; production defaults otherwise unchanged.
        {
          "x-forwarded-for": `198.18.${Math.floor(sequence / 250) % 256}.${(sequence % 250) + 1}`,
        },
      ),
    ];
  if (n < 85)
    return [
      "upload",
      await request(
        `/api/assignments/${student.assignment}/submissions`,
        student.cookie,
        "POST",
        multipart,
        { "content-type": "multipart/form-data; boundary=load" },
      ),
    ];
  if (n < 95) {
    const s = manifest.submissions[queueIndex++ % manifest.submissions.length];
    return [
      "enqueue",
      await request(
        `/api/submissions/${s.id}/recognition-jobs`,
        s.cookie,
        "POST",
      ),
    ];
  }
  return [
    "write",
    await request(
      "/api/me",
      student.cookie,
      "PATCH",
      json({ name: "Synthetic student" }),
    ),
  ];
}
const results = [];
async function stage(
  label,
  rate,
  seconds,
  cap = 512,
  custom = operation,
  stopWhen = () => false,
) {
  const start = performance.now(),
    at = Date.now(),
    pending = new Set();
  const values = {},
    stats = {
      label,
      offeredRps: rate,
      durationSeconds: seconds,
      cap,
      scheduled: 0,
      clientSkipped: 0,
      peakInflight: 0,
      byType: {},
    };
  let sent = 0;
  while (performance.now() - start < seconds * 1000 && !stopWhen()) {
    const target = Math.floor(((performance.now() - start) * rate) / 1000);
    while (sent < target) {
      sent++;
      stats.scheduled++;
      if (pending.size >= cap) {
        stats.clientSkipped++;
        continue;
      }
      const p = custom()
        .then(([type, result]) => {
          const item = (stats.byType[type] ||= {
            count: 0,
            statuses: {},
            successful: 0,
            successOver2s: 0,
            maxMs: 0,
            bytes: 0,
          });
          const times = (values[type] ||= { all: [], success: [] });
          item.count++;
          item.statuses[result.status] =
            (item.statuses[result.status] || 0) + 1;
          item.maxMs = Math.max(item.maxMs, Math.round(result.ms));
          item.bytes += result.bytes || 0;
          times.all.push(result.ms);
          if (result.status >= 200 && result.status < 300) {
            item.successful++;
            times.success.push(result.ms);
            if (result.ms > 2000) item.successOver2s++;
          }
        })
        .finally(() => pending.delete(p));
      pending.add(p);
      stats.peakInflight = Math.max(stats.peakInflight, pending.size);
    }
    await pause(10);
  }
  await Promise.all(pending);
  stats.elapsedSeconds = Number(
    ((performance.now() - start) / 1000).toFixed(2),
  );
  for (const [type, item] of Object.entries(stats.byType)) {
    item.p95Ms = quantile(values[type].all, 0.95);
    item.successP95Ms = quantile(values[type].success, 0.95);
    item.successP99Ms = quantile(values[type].success, 0.99);
    item.successRps = Number(
      (item.successful / stats.elapsedSeconds).toFixed(1),
    );
  }
  const samples = fs
    .readFileSync(path.join(output, "samples.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((s) => s.at >= at);
  stats.resources = {
    maxRssMiB: Math.round(Math.max(0, ...samples.map((s) => s.rssMiB))),
    maxCgroupMiB: Math.round(
      Math.max(
        0,
        ...samples.map((s) => Number(s.cgroup["memory.current"]) / 1024 ** 2),
      ),
    ),
    maxLagP95Ms: Math.round(Math.max(0, ...samples.map((s) => s.lagP95Ms))),
    maxLagMs: Math.round(Math.max(0, ...samples.map((s) => s.lagMaxMs))),
    maxModelActive: Math.max(0, ...samples.map((s) => s.modelPeakActive || 0)),
    maxQueued: Math.max(
      0,
      ...samples.map((s) =>
        Number(s.jobs.find((j) => j.status === "queued")?.n || 0),
      ),
    ),
    maxQueueAgeSeconds: Math.round(
      Math.max(
        0,
        ...samples.map((s) => {
          const j = s.jobs.find((j) => j.status === "queued");
          return j ? (s.at - j.oldest) / 1000 : 0;
        }),
      ),
    ),
    lastCgroup: samples.at(-1)?.cgroup,
  };
  const ops = await request("/api/operations", manifest.admin);
  if (ops.status === 200) {
    const o = JSON.parse(ops.body);
    stats.operations = {
      resources: o.resources,
      passwordWork: o.passwordWork,
      modelUsage: o.modelUsage,
      jobs: o.jobs,
      runtime: o.runtime,
    };
  }
  results.push(stats);
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        config: {
          cpu: 4,
          memoryGiB: 4,
          swapGiB: 0,
          students: 10000,
          teachers: 100,
          initialSubmissions: 10000,
          jpegBytes: jpeg.length,
          mockModelDelayMs: 2000,
          ocrConcurrency: process.env.LOAD_OCR_CONCURRENCY || "4",
          clientTimeoutMs: 5000,
          clientIPs: "distinct synthetic users behind a trusted proxy",
          transport:
            "Unix relay to real loopback TCP HTTP; relay shares service cgroup",
        },
        stages: results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(stats));
}
try {
  const ocr =
    process.env.LOAD_OCR_CONCURRENCY === "auto"
      ? null
      : Number(process.env.LOAD_OCR_CONCURRENCY || 4);
  if (ocr !== null && (!Number.isSafeInteger(ocr) || ocr < 1 || ocr > 16))
    throw new Error("Load OCR concurrency must be 1..16");
  const mounts = [
    [root, "/app"],
    [process.execPath, "/node"],
    ["/lib", "/lib"],
    ["/lib64", "/lib64"],
    ["/usr/lib", "/usr/lib"],
  ].flatMap(([src, dst]) => [
    "--mount",
    `type=bind,src=${src},dst=${dst},readonly`,
  ]);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--memory=4g",
    "--memory-swap=4g",
    "--cpus=4",
    "--pids-limit=128",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m,mode=1777",
    ...mounts,
    "--mount",
    `type=bind,src=${output},dst=/run/load`,
    "-w",
    "/app",
    "-e",
    "MES_DISPOSABLE_LOAD_TEST=1",
    "-e",
    "UV_THREADPOOL_SIZE=4",
    ...[
      "OCR_CONCURRENCY",
      "OCR_USER_CONCURRENCY",
      "MODEL_GLOBAL_CONCURRENCY",
      "MODEL_SCHOOL_CONCURRENCY",
      "MODEL_STAFF_CONCURRENCY",
    ].flatMap((key) => (ocr === null ? [] : ["-e", `${key}=${ocr}`])),
    image,
    "/node",
    "--max-old-space-size=1024",
    "tools/ops/load-fixture.mjs",
  );
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if ((await request("/api/health")).status === 200) {
      ready = true;
      break;
    }
    await pause(250);
  }
  if (!ready)
    throw new Error(
      "Fixture startup failed: " + docker("logs", name).slice(-2000),
    );
  manifest = JSON.parse(
    fs.readFileSync(path.join(output, "manifest.json"), "utf8"),
  );
  for (const [i, user] of [
    ...manifest.students,
    ...manifest.teachers,
    { cookie: manifest.admin },
  ].entries())
    clientIPs.set(
      user.cookie,
      `198.18.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    );
  const setup = await request(
    "/api/settings/provider",
    manifest.admin,
    "PUT",
    json({
      provider: "deepseek",
      apiKey: "synthetic-not-real",
      model: "deepseek-flash",
    }),
  );
  if (setup.status !== 200)
    throw new Error("Mock provider setup failed: " + setup.body);
  await pause(1500);
  if (process.env.LOAD_MODE === "roster") {
    for (const rate of [10, 25, 50]) {
      await stage(`full-school-roster-${rate}`, rate, 10, 128, async () => [
        "roster", await request("/api/students", manifest.admin),
      ]);
    }
  } else if (process.env.LOAD_MODE === "grading") {
    const jobs = manifest.submissions.slice(0, 24),
      completed = new Map();
    const started = Date.now();
    let cursor = 0;
    for (const s of jobs) {
      const response = await request(
        `/api/submissions/${s.id}/recognition-jobs`,
        s.cookie,
        "POST",
      );
      if (response.status !== 202)
        throw new Error("Grading benchmark enqueue failed");
    }
    await stage(
      "grading-with-100-reads-per-second",
      100,
      120,
      512,
      async () => {
        const s = jobs[cursor++ % jobs.length];
        const response = await request(`/api/submissions/${s.id}`, s.cookie);
        if (response.status === 200) {
          const value = JSON.parse(response.body),
            job = value.recognitionJob;
          if (job?.status === "failed") throw new Error("Mock grading failed");
          if (job?.status === "succeeded") {
            if (value.teacher_reviewed !== 0 || value.status !== "review")
              throw new Error("Grading bypassed teacher review");
            completed.set(s.id, job.updatedAt);
          }
        }
        return ["read", response];
      },
      () => completed.size === jobs.length,
    );
    if (completed.size !== jobs.length)
      throw new Error("Grading benchmark did not finish in time");
    const summary = {
      jobs: jobs.length,
      concurrency: ocr,
      completed: completed.size,
      elapsedMs: Math.max(...completed.values()) - started,
    };
    fs.writeFileSync(
      path.join(output, "grading.json"),
      JSON.stringify(summary, null, 2),
    );
    console.log(JSON.stringify(summary));
  } else {
    const rates = (process.env.LOAD_RATES || "20,100,300,600,1200,2500,5000")
      .split(",")
      .map(Number);
    const seconds = Number(process.env.LOAD_STAGE_SECONDS || 20);
    if (
      !rates.every((n) => Number.isFinite(n) && n > 0 && n <= 10000) ||
      !Number.isFinite(seconds) ||
      seconds < 1 ||
      seconds > 300
    )
      throw new Error("Invalid bounded load configuration");
    if (process.env.LOAD_FAULTS !== "0") {
      const slow = [];
      for (let i = 0; i < 16; i++) {
        const s = manifest.students[i];
        slow.push(
          request(
            `/api/assignments/${s.assignment}/submissions`,
            s.cookie,
            "POST",
            multipart,
            { "content-type": "multipart/form-data; boundary=load" },
            true,
          ),
        );
      }
      await stage("slow-uploads-plus-reads", 100, 10, 512, async () => [
        "read",
        await request("/api/assignments", random(manifest.students).cookie),
      ]);
      const slowResults = await Promise.all(slow);
      fs.writeFileSync(
        path.join(output, "slow-uploads.json"),
        JSON.stringify(
          slowResults.map(({ status, ms }) => ({ status, ms })),
          null,
          2,
        ),
      );
    }
    for (const rate of rates) {
      await stage(`mixed-${rate}`, rate, seconds, rate >= 2500 ? 1024 : 512);
      await pause(2000);
    }
    await stage("recovery", 20, 15);
    if (process.env.LOAD_FAULTS === "0") process.exitCode = 0;
    else {
      if (process.env.LOAD_FAULTS !== "quick") {
        // Real touched anonymous pages, confined to this disposable 4 GiB cgroup.
        // Leave the API room; this tests admission/recovery, not deliberate kernel OOM.
        const stressScript = `const fs=require('fs');let blocks=[];const goal=Number(process.argv[1]);
  const used=()=>Number(fs.readFileSync('/sys/fs/cgroup/memory.current','utf8'))-Number(fs.readFileSync('/sys/fs/cgroup/memory.stat','utf8').match(/^inactive_file (\\d+)/m)?.[1]||0);
  while(used()<goal){blocks.push(Buffer.alloc(16*1024*1024,1));}console.log('allocated');setTimeout(()=>{},25000);`;
        for (const mib of [3650, 3920]) {
          const pressure = spawn(
            "docker",
            [
              ...dockerArgs,
              "exec",
              name,
              "/node",
              "-e",
              stressScript,
              String(mib * 1024 ** 2),
            ],
            { env, stdio: ["ignore", "pipe", "pipe"] },
          );
          const ready = await Promise.race([
            once(pressure.stdout, "data").then(() => true),
            once(pressure, "exit").then(() => false),
            pause(15000).then(() => false),
          ]);
          if (!ready)
            throw new Error("Memory pressure helper did not become ready");
          await pause(6000);
          await stage(`memory-${mib}MiB-plus-mixed`, 100, 10);
          if (pressure.exitCode === null) await once(pressure, "exit");
          await pause(2000);
        }
        await stage("post-memory-recovery", 20, 75);
      }
      // Competing SQLite writer: actual lock contention, not a disk-speed simulation.
      const locker = spawn(
        "docker",
        [
          ...dockerArgs,
          "exec",
          name,
          "/node",
          "-e",
          `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/run/load/data/smart-campus.sqlite');d.exec('BEGIN IMMEDIATE');console.log('locked');setTimeout(()=>{d.exec('ROLLBACK');d.close()},3000);`,
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      await once(locker.stdout, "data");
      await stage("sqlite-writer-lock-plus-mixed", 100, 10);
      if (locker.exitCode === null) await once(locker, "exit");
      await stage("post-lock-recovery", 20, 10);
    }
  }
} finally {
  agent.destroy();
  try {
    fs.writeFileSync(
      path.join(output, "container-state.json"),
      docker("inspect", "--format", "{{json .State}}", name),
    );
  } catch {}
  try {
    fs.writeFileSync(path.join(output, "server.log"), docker("logs", name));
  } catch {}
  try {
    docker("rm", "-f", name);
  } catch {}
  // Session cookies are synthetic, but still keep them out of shareable results.
  fs.rmSync(path.join(output, "manifest.json"), { force: true });
  console.log(`Results: ${output}`);
}
