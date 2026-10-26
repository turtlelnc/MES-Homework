import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseEnv } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
const args = process.argv.slice(2),
  option = (name) => args[args.indexOf("--" + name) + 1];
if (!args.includes("--entry"))
  throw new Error("--entry must be the installed launcher");
const entry = path.resolve(option("entry")),
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mes-installed-check-"));
const base =
  process.platform === "win32"
    ? path.join(scratch, "MESHomework")
    : path.join(scratch, "profile");
const env = {
  ...process.env,
  LOCALAPPDATA: scratch,
  MES_HOMEWORK_HOME: base,
  SYSTEM_PRESSURE_ENABLED: "0",
};
let owner;
const start = () => spawn(entry, ["--headless"], { env, stdio: "ignore" });
async function exit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.exitCode;
  return Promise.race([
    once(child, "exit").then(([code]) => code),
    pause(45000).then(() => {
      throw new Error("Installed process did not exit");
    }),
  ]);
}
async function ready() {
  for (let i = 0; i < 200; i++) {
    if (owner.exitCode !== null)
      throw new Error("Installed launcher exited before readiness");
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(base, "instance.json"), "utf8"),
      );
      const response = await fetch(state.url + "/api/health", {
        signal: AbortSignal.timeout(500),
      });
      const health = await response.json();
      if (health.ok) return { state, health };
    } catch {}
    await pause(100);
  }
  throw new Error("Installed runtime startup timed out");
}
async function stop() {
  const stopper = spawn(entry, ["--stop", "--headless"], {
    env,
    stdio: "ignore",
  });
  assert.equal(await exit(stopper), 0);
  assert.equal(await exit(owner), 0);
  owner = undefined;
}
try {
  owner = start();
  const first = await ready();
  const config = path.join(base, ".env"),
    original = fs.readFileSync(config);
  const data = parseEnv(original.toString()).DATA_DIR;
  fs.writeFileSync(
    path.join(data, "installer-test-sentinel.txt"),
    "synthetic data must survive restart/repair/uninstall\n",
  );
  const duplicate = start();
  assert.equal(await exit(duplicate), 0);
  assert.equal(owner.exitCode, null);
  await stop();
  owner = start();
  const second = await ready();
  assert.equal(first.health.version, second.health.version);
  assert.deepEqual(fs.readFileSync(config), original);
  assert.equal(
    fs.readFileSync(path.join(data, "installer-test-sentinel.txt"), "utf8"),
    "synthetic data must survive restart/repair/uninstall\n",
  );
  await stop();
  const report = {
    version: second.health.version,
    build: second.health.build,
    start: true,
    duplicateLaunchReusedInstance: true,
    gracefulStop: true,
    restart: true,
    configurationPreserved: true,
    dataPreserved: true,
    syntheticProfile: base,
  };
  if (args.includes("--report"))
    fs.writeFileSync(
      path.resolve(option("report")),
      JSON.stringify(report, null, 2) + "\n",
    );
  console.log(JSON.stringify(report));
} finally {
  if (owner && owner.exitCode === null) {
    try {
      await stop();
    } catch {
      owner?.kill("SIGKILL");
    }
  }
  // --report retains only this synthetic profile for native repair/removal tests.
  if (!args.includes("--report"))
    fs.rmSync(scratch, { recursive: true, force: true });
}
