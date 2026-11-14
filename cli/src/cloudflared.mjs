import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appPaths, prompt } from "./runtime.mjs";

const binDir = () => path.join(appPaths.base, "bin");
export const cloudflaredConfig = () => path.join(appPaths.base, "cloudflared");

function exeName() {
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

/** 先在 PATH 里找，再找 msh 自己下载的副本。 */
export function cloudflaredPath() {
  const local = path.join(binDir(), exeName());
  if (fs.existsSync(local)) return local;
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    ["cloudflared"],
    { encoding: "utf8" },
  );
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return null;
}

function downloadUrl() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32")
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-${arch}.exe`;
  if (process.platform === "darwin")
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-${arch}.tgz`;
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body)
    throw new Error(`HTTP ${response.status}`);
  const temp = `${target}.${randomBytes(6).toString("hex")}.part`;
  const handle = await fs.promises.open(temp, "wx", 0o755);
  try {
    for await (const chunk of response.body) await handle.write(chunk);
  } finally {
    await handle.close();
  }
  return temp;
}

export async function installCloudflared(t) {
  const existing = cloudflaredPath();
  if (existing) {
    process.stdout.write(`${t("check.cfInstalled")}: ${existing}\n`);
    return existing;
  }
  process.stdout.write(`${t("cf.downloading")}\n`);
  fs.mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  const target = path.join(binDir(), exeName());
  try {
    const part = await download(downloadUrl(), target);
    if (process.platform === "darwin") {
      const result = spawnSync("tar", ["-xzf", part, "-C", binDir()], {
        stdio: "inherit",
      });
      fs.rmSync(part, { force: true });
      if (result.status !== 0) throw new Error("解压 cloudflared 失败");
    } else {
      fs.renameSync(part, target);
    }
    if (!fs.existsSync(target)) throw new Error("安装后未找到 cloudflared");
    if (process.platform !== "win32") fs.chmodSync(target, 0o755);
  } catch (error) {
    throw new Error(t("cf.downloadFailed", { error: error.message }));
  }
  process.stdout.write(`${t("cf.downloaded", { file: target })}\n`);
  return target;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)),
    );
  });
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error((result.stderr || result.stdout || "").trim() || "命令失败");
  return result.stdout;
}

/**
 * 交互式准备隧道：cloudflared login 会弹出浏览器让用户登录并授权域名，
 * 域名由用户自己输入，随后创建隧道、写绑定配置并绑定 DNS。
 */
export async function configureTunnel(t, port) {
  const binary = await installCloudflared(t);
  process.stdout.write(`${t("cf.loginHint")}\n`);
  await run(binary, ["tunnel", "login"]);
  const domain = (await prompt(`${t("cf.askDomain")}: `)).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) throw new Error(t("cf.askDomain"));
  const name = `msh-${domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`.slice(0, 60);
  let tunnelId;
  try {
    const listed = capture(binary, ["tunnel", "list", "--output", "json"]);
    const found = JSON.parse(listed || "[]").find((item) => item.name === name);
    if (found) tunnelId = found.id;
  } catch {}
  if (!tunnelId) {
    const created = capture(binary, ["tunnel", "create", "--output", "json", name]);
    tunnelId = JSON.parse(created).id;
  }
  const credentials = path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);
  fs.mkdirSync(cloudflaredConfig(), { recursive: true, mode: 0o700 });
  const file = path.join(cloudflaredConfig(), "config.yml");
  fs.writeFileSync(
    file,
    [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${credentials.replaceAll("\\", "/")}`,
      "ingress:",
      `  - hostname: ${domain}`,
      `    service: http://127.0.0.1:${port}`,
      "  - service: http_status:404",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  try {
    await run(binary, ["tunnel", "route", "dns", tunnelId, domain]);
  } catch {
    process.stderr.write(
      "DNS 绑定失败，请在 Cloudflare 控制台手动为该隧道添加 CNAME。\n",
    );
  }
  process.stdout.write(`${t("cf.tunnelReady", { name })}: https://${domain}\n`);
  return { name, tunnelId, domain, file };
}

export function tunnelConfigFile() {
  return path.join(cloudflaredConfig(), "config.yml");
}

export function readTunnelConfig() {
  const file = tunnelConfigFile();
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const domain = /-\s*hostname:\s*(\S+)/.exec(text)?.[1] || null;
  const tunnel = /^tunnel:\s*(\S+)/m.exec(text)?.[1] || null;
  return domain && tunnel ? { file, domain, tunnel } : null;
}

/** 前台运行隧道，Ctrl+C 一并结束。 */
export function startTunnel(t) {
  const binary = cloudflaredPath();
  if (!binary) throw new Error(t("cf.missing"));
  const config = readTunnelConfig();
  if (!config) throw new Error(t("cf.missing"));
  process.stdout.write(`${t("cf.startingTunnel")} (${config.domain})\n`);
  return spawn(binary, ["--config", config.file, "tunnel", "run"], {
    stdio: "inherit",
  });
}
