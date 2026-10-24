import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedTeachingFixture } from "./analysis.fixture.mjs";
it("keeps login and authorized reads available while real Linux admission blocks new heavy work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-http-"));
  const root = path.resolve(import.meta.dirname, "..");
  const db = new DatabaseSync(path.join(dir, "smart-campus.sqlite"));
  db.exec(fs.readFileSync(path.join(root, "server/schema.sql"), "utf8"));
  const fixture = seedTeachingFixture(db);
  // v0.2.1：老师分开模式才允许教师配置自己的模型凭证（与旧测试假设一致）。
  db.prepare(
    "INSERT INTO school_settings(school_id,model_mode,updated_at) VALUES(?,?,?) ON CONFLICT(school_id) DO UPDATE SET model_mode=excluded.model_mode,updated_at=excluded.updated_at",
  ).run(fixture.schoolId, "teacher_class", new Date().toISOString());
  const mem = path.join(dir, "memory");
  fs.writeFileSync(mem, "MemTotal: 4194304 kB\nMemAvailable: 2097152 kB\n");
  const psi = path.join(dir, "psi");
  fs.writeFileSync(psi, "some avg10=0.00\nfull avg10=0.00\n");
  const preload = path.join(dir, "mock.mjs");
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';import dns from 'node:dns';dns.promises.lookup=async()=>[{address:'1.1.1.1',family:4}];
  const open=fs.promises.open;
  fs.promises.open=(file,...args)=>open(file==='/proc/meminfo'?${JSON.stringify(mem)}:String(file).endsWith('.pressure')?${JSON.stringify(psi)}:file,...args);
  globalThis.fetch=async()=>{fs.writeFileSync(${JSON.stringify(path.join(dir, "outbound"))},'unexpected');throw new Error('network disabled');};`,
  );
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as any).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=256", "--import", pathToFileURL(preload).href, "server/index.mjs"],
    {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        DATA_DIR: dir,
        HOST: "127.0.0.1",
        PORT: String(port),
        NODE_ENV: "test",
        SYSTEM_PRESSURE_ENABLED: "1",
        APP_SECRET: "adaptive-tests-only-not-a-production-key",
        CLIENT_TILING_ENABLED: "0",
        DEEPSEEK_FILES_ENABLED: "0",
        MODEL_USER_DAILY_MICRO_CNY: "0",
        MODEL_SCHOOL_DAILY_MICRO_CNY: "0",
      },
    },
  );
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function login() {
    return fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "teacher@fixture.test",
        password: "ChangeMe123!",
      }),
    });
  }
  try {
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) break;
      } catch {}
      await pause(50);
    }
    const logged = await login();
    expect(logged.status).toBe(200);
    const cookie = logged.headers.get("set-cookie")!.split(";")[0];
    const headers = { cookie, "content-type": "application/json" };
    expect(
      (
        await fetch(base + "/api/settings/provider", {
          method: "PUT",
          headers,
          body: JSON.stringify({ provider: "deepseek", apiKey: "mock-only" }),
        })
      ).status,
    ).toBe(200);
    const original = db
      .prepare("SELECT * FROM submissions WHERE assignment_id=? LIMIT 1")
      .get(fixture.assignmentId)!;
    fs.writeFileSync(mem, "MemTotal: 4194304 kB\nMemAvailable: 102400 kB\n");
    let state: any;
    for (let i = 0; i < 150; i++) {
      try {
        state = JSON.parse(
          fs.readFileSync(path.join(dir, ".resource-pressure.json"), "utf8"),
        );
        if (state.level === "critical") break;
      } catch {}
      await pause(50);
    }
    expect(state.level).toBe("critical");
    expect(
      (
        await fetch(base + `/api/assignments/${fixture.assignmentId}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(200);
    expect((await login()).status).toBe(200);
    expect(
      (
        await fetch(base + `/api/submissions/${original.id}/recognize`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(503);
    expect(
      db.prepare("SELECT * FROM submissions WHERE id=?").get(original.id),
    ).toEqual(original);
    const body = new FormData();
    body.set("files", new Blob(["fake"], { type: "image/jpeg" }), "test.jpg");
    expect(
      (
        await fetch(
          base + `/api/assignments/${fixture.assignmentId}/submissions`,
          { method: "POST", headers: { cookie }, body },
        )
      ).status,
    ).toBe(503);
    expect(fs.existsSync(path.join(dir, "outbound"))).toBe(false);
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
