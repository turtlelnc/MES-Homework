import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appPaths, launcherEntry } from "./runtime.mjs";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "MESHomework";
const UNIT = "mes-homework-msh.service";
const PLIST = path.join(os.homedir(), "Library/LaunchAgents/org.mes-homework.msh.plist");

function windowsRunner() {
  const file = path.join(appPaths.base, "msh-autostart.cmd");
  fs.mkdirSync(appPaths.base, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    `@echo off\r\n"${process.execPath}" "${launcherEntry}" --headless\r\n`,
    { mode: 0o600 },
  );
  return file;
}

function unitFile() {
  return path.join(os.homedir(), ".config/systemd/user", UNIT);
}

function systemctl(args) {
  return spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
}

function plistBody() {
  const xml = (value) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.mes-homework.msh</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(launcherEntry)}</string><string>--headless</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer></dict></plist>`;
}

export function powerState() {
  if (process.platform === "win32") {
    const result = spawnSync("reg", ["query", RUN_KEY, "/v", RUN_VALUE], {
      encoding: "utf8",
    });
    return result.status === 0;
  }
  if (process.platform === "darwin") return fs.existsSync(PLIST);
  const result = systemctl(["is-enabled", UNIT]);
  return result.stdout?.trim() === "enabled";
}

export function enablePower(t) {
  if (process.platform === "win32") {
    const file = windowsRunner();
    const result = spawnSync(
      "reg",
      ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", `"${file}"`, "/f"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr || "注册开机自启动失败");
    return t("power.enabled", { kind: "HKCU Run" });
  }
  if (process.platform === "darwin") {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PLIST, plistBody(), { mode: 0o600 });
    spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, PLIST], {
      stdio: "ignore",
    });
    return t("power.enabled", { kind: "LaunchAgent" });
  }
  const file = unitFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    [
      "[Unit]",
      "Description=MES-Homework portable server",
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${process.execPath} ${launcherEntry} --headless`,
      "Restart=on-failure",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  systemctl(["daemon-reload"]);
  const result = systemctl(["enable", "--now", UNIT]);
  if (result.status !== 0) throw new Error(result.stderr || "启用 systemd 用户服务失败");
  return t("power.enabled", { kind: "systemd --user" });
}

export function disablePower(t) {
  if (process.platform === "win32") {
    spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"], {
      encoding: "utf8",
    });
    fs.rmSync(path.join(appPaths.base, "msh-autostart.cmd"), { force: true });
  } else if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}`, PLIST], {
      stdio: "ignore",
    });
    fs.rmSync(PLIST, { force: true });
  } else {
    systemctl(["disable", "--now", UNIT]);
    fs.rmSync(unitFile(), { force: true });
    systemctl(["daemon-reload"]);
  }
  return t("power.disabled");
}

export function togglePower(t, explicit) {
  if (!["win32", "darwin", "linux"].includes(process.platform))
    return t("power.unsupported", { platform: process.platform });
  const desired =
    explicit === "on" ? true : explicit === "off" ? false : !powerState();
  return desired ? enablePower(t) : disablePower(t);
}
