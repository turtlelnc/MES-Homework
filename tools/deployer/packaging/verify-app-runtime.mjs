import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

// Start the assembled runtime, not the source checkout. Only disposable data
// and public read-only endpoints are used; no login or model request is sent.
export async function verifyAppRuntime(root) {
  for (const entry of [
    "app/shared/tile-plan.mjs",
    "app/shared/image-header.mjs",
    "app/tools/ops/supervise.mjs",
  ])
    if (!fs.existsSync(path.join(root, entry)))
      throw new Error(`Missing runtime entry: ${entry}`);
  const metadata = JSON.parse(
    fs.readFileSync(path.join(root, "bundle.json"), "utf8"),
  );
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mes-runtime-check-"));
  let child;
  try {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    const envFile = path.join(scratch, ".env");
    fs.writeFileSync(
      envFile,
      `APP_SECRET=${randomBytes(48).toString("hex")}\nDATA_DIR=${JSON.stringify(path.join(scratch, "data").replaceAll("\\", "/"))}\nHOST=127.0.0.1\nPORT=${port}\nNODE_ENV=production\nALLOW_PUBLIC_REGISTRATION=0\n`,
      { mode: 0o600 },
    );
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^(APP_|DATA_|MODEL_|OCR_|OAUTH_|BACKUP_|UPLOAD_|DEEPSEEK_|SERVICE_|HTTP_|PARSER_|PASSWORD_|SYSTEM_PRESSURE_|SQLITE_|CLIENT_TILING_|ALLOW_PUBLIC_|TRUST_PROXY_|DISK_)/.test(
          key,
        ) ||
        ["PORT", "HOST", "NODE_ENV", "NODE_OPTIONS"].includes(key)
      )
        delete env[key];
    let stderr = "",
      exited = false;
    child = spawn(
      path.join(
        root,
        "runtime",
        process.platform === "win32" ? "node.exe" : "node",
      ),
      ["--env-file=" + envFile, path.join(root, "app/server/index.mjs")],
      { cwd: path.join(root, "app"), env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let spawnError;
    const exit = once(child, "exit").then(
      () => {
        exited = true;
      },
      (error) => {
        spawnError = error;
        exited = true;
      },
    );
    child.once("error", (error) => {
      spawnError = error;
      exited = true;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    let health;
    for (let i = 0; i < 100; i++) {
      if (exited)
        throw new Error(
          `Runtime startup failed: ${spawnError?.message || stderr || child.exitCode}`,
        );
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {}
      await pause(100);
    }
    if (
      !health ||
      health.version !== metadata.version ||
      String(health.build) !== String(metadata.build)
    )
      throw new Error("Runtime health/version check failed");
    const capabilities = await fetch(
      `http://127.0.0.1:${port}/api/capabilities`,
      { signal: AbortSignal.timeout(2000) },
    ).then((r) => r.json());
    if (
      capabilities.publicRegistration !== false ||
      !capabilities.stages?.length
    )
      throw new Error("Runtime environment/database capabilities check failed");
    child.kill("SIGTERM");
    await Promise.race([exit, pause(5000)]);
    return {
      version: health.version,
      build: health.build,
      started: true,
      environmentLoaded: true,
      databaseReady: true,
    };
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([once(child, "exit").catch(() => {}), pause(2000)]);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
