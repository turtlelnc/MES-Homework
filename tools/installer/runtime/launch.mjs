#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { fork, spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { Writable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { locations, prepareConfig } from "./config.mjs";

const args = process.argv.slice(2),
  mode = args.includes("--service") ? "service" : "local";
const paths = locations(mode),
  stateFile = path.join(paths.base, "instance.json");
const app = path.resolve(import.meta.dirname, "../../..");
const browser = (url) => {
  if (args.includes("--headless") || args.includes("--no-browser")) return;
  const program =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const child = spawn(program, [url], { stdio: "ignore", detached: true });
  child.on("error", () =>
    console.error("Open the local application URL shown in instance.json"),
  );
  child.unref();
};
function readState() {
  try {
    const s = fs.lstatSync(stateFile);
    if (!s.isFile() || s.size > 4096) throw new Error();
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}
function control(state, command) {
  return new Promise((resolve, reject) => {
    if (
      !Number.isInteger(state?.controlPort) ||
      !/^[a-f0-9]{64}$/.test(state?.token || "")
    )
      return reject(new Error("Application is still starting; retry shortly"));
    const socket = net.connect({ host: "127.0.0.1", port: state.controlPort });
    let bytes = 0,
      reply = "";
    socket.setTimeout(3000, () =>
      socket.destroy(new Error("Application control timed out")),
    );
    socket.on("connect", () =>
      socket.end(JSON.stringify({ token: state.token, command }) + "\n"),
    );
    socket.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4096) socket.destroy(new Error("Invalid control response"));
      else reply += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(reply));
      } catch {
        reject(new Error("Application control unavailable"));
      }
    });
  });
}
async function unusedPort(port, host) {
  const probe = net.createServer();
  probe.listen(port, host);
  await once(probe, "listening");
  const actual = probe.address().port;
  await new Promise((r, j) => probe.close((e) => (e ? j(e) : r())));
  return actual;
}

async function main() {
  if (args.includes("--prepare")) {
    prepareConfig(mode, paths);
    return;
  }
  if (args.includes("--install-agent")) {
    if (process.platform !== "darwin")
      throw new Error("LaunchAgent installation is macOS-only");
    const root = path.resolve(app, ".."),
      plist = path.join(
        os.homedir(),
        "Library/LaunchAgents/org.mes-homework.server.plist",
      );
    const xml = (v) =>
      v
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll('"', "&quot;");
    const exe = path.join(root, "runtime/node"),
      entry = path.join(app, "tools/installer/runtime/launch.mjs");
    prepareConfig("service", locations("service"));
    fs.mkdirSync(path.dirname(plist), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.mes-homework.server</string><key>ProgramArguments</key><array><string>${xml(exe)}</string><string>${xml(entry)}</string><string>--service</string><string>--headless</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer></dict></plist>`,
      { mode: 0o600 },
    );
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], {
      stdio: "inherit",
    });
    return;
  }
  if (args.includes("--stop")) {
    if (mode !== "local")
      throw new Error(
        "Stop service mode through the operating system service manager",
      );
    const result = await control(readState(), "stop");
    if (!result.ok) throw new Error("Stop was not accepted");
    return;
  }
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  const lockFile = path.join(paths.base, "instance.sqlite");
  if (fs.existsSync(lockFile) && !fs.lstatSync(lockFile).isFile())
    throw new Error("Invalid instance lock");
  const lock = new DatabaseSync(lockFile);
  fs.chmodSync(lockFile, 0o600);
  try {
    lock.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS instance_lock(id INTEGER); BEGIN IMMEDIATE",
    );
  } catch (error) {
    lock.close();
    if (![5, 6].includes(error.errcode & 255)) throw error;
    if (mode !== "local")
      throw new Error(
        "Another service instance already owns the data directory",
      );
    for (let i = 0; i < 120; i++) {
      try {
        const status = await control(readState(), "status");
        if (status.ready) {
          browser(status.url);
          return;
        }
      } catch {}
      await pause(250);
    }
    throw new Error(
      "Existing instance is not ready; inspect its application.log",
    );
  }
  let child,
    server,
    stopping = false,
    force,
    ready = false,
    logFd;
  const token = randomBytes(32).toString("hex");
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server?.close();
    if (child?.connected) child.send({ type: "shutdown" }, () => {});
    else child?.kill("SIGTERM");
    force = setTimeout(() => child?.kill("SIGKILL"), 15000);
    force.unref();
  };
  try {
    const config = prepareConfig(mode, paths);
    let port = Number(config.PORT);
    try {
      port = await unusedPort(port, config.HOST);
    } catch (error) {
      if (mode !== "local" || error.code !== "EADDRINUSE") throw error;
      port = await unusedPort(0, "127.0.0.1");
    }
    const url = `http://127.0.0.1:${port}`;
    server = net.createServer((socket) => {
      socket.setTimeout(2000, () => socket.destroy());
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (Buffer.byteLength(data) > 1024) socket.destroy();
      });
      socket.on("error", () => {});
      socket.on("end", () => {
        try {
          const x = JSON.parse(data);
          if (
            !/^[a-f0-9]{64}$/.test(x.token || "") ||
            !timingSafeEqual(Buffer.from(x.token), Buffer.from(token))
          )
            return socket.end();
          socket.end(JSON.stringify({ ok: true, ready, url }) + "\n");
          if (x.command === "stop") stop();
        } catch {
          socket.end();
        }
      });
    });
    server.maxConnections = 4;
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        pid: process.pid,
        controlPort: server.address().port,
        token,
        url,
      }),
      { mode: 0o600 },
    );
    const log = path.join(paths.base, "application.log"),
      limit = 5 * 1024 ** 2;
    if (fs.existsSync(log) && !fs.lstatSync(log).isFile())
      throw new Error("Invalid application log");
    if (fs.existsSync(log) && fs.statSync(log).size >= limit)
      fs.truncateSync(log, 0);
    logFd = fs.openSync(log, "a", 0o600);
    let written = fs.fstatSync(logFd).size;
    const sink = new Writable({
      write(chunk, encoding, done) {
        const bytes = chunk.subarray(0, Math.max(0, limit - written));
        written += bytes.length;
        if (!bytes.length) return done();
        fs.write(logFd, bytes, 0, bytes.length, null, (error) =>
          done(error || undefined),
        );
      },
    });
    sink.on("error", stop);
    child = fork(path.join(app, "tools/ops/supervise.mjs"), [], {
      env: { ...process.env, ...config, PORT: String(port) },
      execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.pipe(sink, { end: false });
    child.stderr.pipe(sink, { end: false });
    const exited = once(child, "close");
    void exited.catch(() => {});
    let ended = false;
    child.once("error", () => {
      ended = true;
      server.close();
    });
    child.once("exit", () => {
      ended = true;
      server.close();
    });
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    process.stdin.setEncoding("utf8");
    let stdin = "";
    process.stdin.on("data", (chunk) => {
      stdin = (stdin + chunk).slice(-1024);
      if (stdin.includes("stop\n")) stop();
    });
    for (let i = 0; i < 240 && !ready; i++) {
      if (stopping) break;
      if (ended)
        throw new Error(
          "Application exited during startup; inspect application.log",
        );
      try {
        const r = await fetch(url + "/api/health", {
          signal: AbortSignal.timeout(500),
        });
        if (r.ok) {
          const h = await r.json();
          ready = h.ok === true && typeof h.version === "string";
        }
      } catch {}
      if (!ready) await pause(250);
    }
    if (!ready && !stopping)
      throw new Error("Application startup timed out; inspect application.log");
    if (ready && mode === "local") browser(url);
    const [code] = await exited;
    if (code && !stopping)
      throw new Error(
        "Application stopped unexpectedly; inspect application.log",
      );
    await new Promise((resolve) => sink.end(resolve));
  } finally {
    clearTimeout(force);
    server?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      stop();
      await Promise.race([once(child, "exit"), pause(16000)]);
    }
    process.stdin.pause();
    if (logFd !== undefined) fs.closeSync(logFd);
    fs.rmSync(stateFile, { force: true });
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
