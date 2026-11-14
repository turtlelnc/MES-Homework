import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  locations,
  prepareConfig,
} from "../../tools/installer/runtime/config.mjs";

export const packageRoot = path.resolve(import.meta.dirname, "../..");
export const appPaths = locations("local");

const settingsFile = () => path.join(appPaths.base, "msh.json");

export function readSettings() {
  try {
    const stat = fs.lstatSync(settingsFile());
    if (!stat.isFile() || stat.size > 64 * 1024) return {};
    return JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(appPaths.base, { recursive: true, mode: 0o700 });
  const temp = `${settingsFile()}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, settingsFile());
  return next;
}

/** 与 installer 共用同一份配置：APP_SECRET / DATA_DIR / HOST / PORT / NODE_ENV。 */
export function loadConfig() {
  const config = prepareConfig("local", appPaths);
  const stored = readSettings();
  return {
    ...config,
    CLI_LANGUAGE: stored.cliLanguage || "zh",
    SERVER_LANGUAGE: stored.serverLanguage || stored.cliLanguage || "zh",
  };
}

/** 修改配置文件中已有或新增的键，保留其余行与注释顺序。 */
export function updateConfig(patch) {
  const file = appPaths.config;
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = original.split(/\r?\n/);
  const pending = new Map(Object.entries(patch));
  const next = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim());
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return value === undefined ? line : `${match[1]}=${value}`;
  });
  for (const [key, value] of pending)
    if (value !== undefined) next.push(`${key}=${value}`);
  const content =
    next.filter((line, index) => line !== "" || index < next.length - 1).join("\n") + "\n";
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function databasePath(config) {
  return path.join(config.DATA_DIR, "smart-campus.sqlite");
}

export function openDatabase(config) {
  const file = databasePath(config);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=2000");
  return db;
}

export function serverKey(config) {
  return createHash("sha256")
    .update(config.APP_SECRET || "development-only-change-me")
    .digest();
}

export function encryptSecret(config, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", serverKey(config), iv);
  const body = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]);
  return [body.toString("base64"), iv.toString("base64")];
}

export function instanceState() {
  try {
    const stat = fs.lstatSync(path.join(appPaths.base, "instance.json"));
    if (!stat.isFile() || stat.size > 4096) return null;
    return JSON.parse(
      fs.readFileSync(path.join(appPaths.base, "instance.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function runningInstance() {
  const state = instanceState();
  return state && isProcessAlive(state.pid) ? state : null;
}

export const launcherEntry = path.join(
  packageRoot,
  "tools/installer/runtime/launch.mjs",
);

/** 前台启动（stdio 继承），Ctrl+C 由 launch.mjs 处理正常停机。 */
export function spawnLauncher(args, env = {}) {
  const child = spawn(process.execPath, [launcherEntry, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return child;
}

export function openBrowser(url) {
  const program =
    process.platform === "win32"
      ? "explorer.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const child = spawn(program, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

// 单一 stdin 读取器：交互终端与管道（printf "\\n\\n" | msh --code）都能工作。
// readline 的 rl.close() 会结束整个 stdin，多个连续提问会卡住，因此自己按行分发。
const input = { started: false, buffer: "", lines: [], waiters: [], raw: false };

function startInput() {
  if (input.started) return;
  input.started = true;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (input.raw) return;
    input.buffer += chunk;
    let index;
    while ((index = input.buffer.indexOf("\n")) >= 0) {
      const line = input.buffer.slice(0, index).replace(/\r$/, "");
      input.buffer = input.buffer.slice(index + 1);
      if (input.waiters.length) input.waiters.shift()(line);
      else input.lines.push(line);
    }
  });
  process.stdin.on("end", () => {
    while (input.waiters.length) input.waiters.shift()("");
  });
  process.stdin.resume();
}

function readLine() {
  startInput();
  if (input.lines.length) return Promise.resolve(input.lines.shift());
  return new Promise((resolve) => input.waiters.push(resolve));
}

function readSecret(question) {
  startInput();
  return new Promise((resolve) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      readLine().then((value) => resolve(value));
      return;
    }
    input.raw = true;
    process.stdin.setRawMode(true);
    let value = "";
    const finish = (result) => {
      input.raw = false;
      process.stdin.setRawMode(false);
      process.stdin.off("data", onData);
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

export async function prompt(question, { secret = false } = {}) {
  if (secret) return String(await readSecret(question)).trim();
  process.stdout.write(question);
  const value = await readLine();
  if (!process.stdin.isTTY && !value) process.stdout.write("\n");
  return String(value).trim();
}

export async function choose(options, { title }) {
  if (!options.length) return null;
  if (options.length === 1) return options[0].value;
  process.stdout.write(`${title}\n`);
  options.forEach((option, index) =>
    process.stdout.write(`  ${index + 1}) ${option.label}\n`),
  );
  for (;;) {
    const answer = await prompt("> ");
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && options[index]) return options[index].value;
    if (answer === "") return options[0].value;
    process.stdout.write(`${translate("api.chooseInvalid")}\n`);
  }
}

let activeTranslate = (key) => key;
export function setTranslator(fn) {
  activeTranslate = fn;
}
function translate(key) {
  return activeTranslate(key);
}
