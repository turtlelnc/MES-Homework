import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { supervise } from "../tools/ops/supervise.mjs";
it("terminates an unresponsive API automatically and signals service-manager restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-"));
  try {
    const entry = path.join(dir, "blocked.mjs");
    fs.writeFileSync(
      entry,
      "process.once('SIGTERM',()=>{});process.send({type:'heartbeat'});setTimeout(()=>{while(true){}},50);",
    );
    let pid: number | undefined;
    const exitCode = await new Promise((resolve) => {
      const { child } = supervise(entry, {
        timeoutMs: 1000,
        graceMs: 50,
        intervalMs: 50,
        onExit: resolve,
      });
      pid = child.pid;
    });
    expect(exitCode).toBe(1);
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 5000);

it("requests graceful shutdown through private IPC before forcing termination", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-ipc-"));
  try {
    const entry = path.join(dir, "api.mjs");
    fs.writeFileSync(
      entry,
      "process.on('message',m=>{if(m.type==='shutdown')process.exit(0)});process.send({type:'heartbeat'});",
    );
    const exitCode = await new Promise((resolve) => {
      const worker = supervise(entry, { onExit: resolve });
      worker.child.once("message", () => worker.stop());
    });
    expect(exitCode).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
