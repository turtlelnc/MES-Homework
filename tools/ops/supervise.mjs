import { runtimeProfile } from "../../server/runtime-profile.mjs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export function supervise(
  entry,
  {
    timeoutMs = 45000,
    graceMs = 10000,
    intervalMs = 5000,
    onExit = (code) => process.exit(code),
  } = {},
) {
  const child = fork(entry, [], {
    execArgv: [`--max-old-space-size=${runtimeProfile().heapMiB}`],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let lastHeartbeat = performance.now(),
    stopping = false,
    force;
  child.on("message", (message) => {
    if (message?.type === "heartbeat") lastHeartbeat = performance.now();
  });
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    if (child.connected) child.send({ type: "shutdown" }, () => {});
    else child.kill("SIGTERM");
    force = setTimeout(() => child.kill("SIGKILL"), graceMs);
  };
  let stalled = false;
  const timer = setInterval(() => {
    if (performance.now() - lastHeartbeat > timeoutMs && !stopping) {
      stalled = true;
      console.error(
        "API heartbeat expired; restarting through service manager",
      );
      terminate();
    }
  }, intervalMs);
  const stop = () => {
    clearInterval(timer);
    terminate();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const message = (value) => {
    if (value?.type === "shutdown") stop();
  };
  if (process.send) {
    process.on("message", message);
    process.once("disconnect", stop);
  }
  child.once("exit", (code) => {
    clearInterval(timer);
    clearTimeout(force);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("message", message);
    process.off("disconnect", stop);
    onExit(stalled ? 1 : (code ?? (stopping ? 0 : 1)));
  });
  child.once("error", () => {
    stop();
    onExit(1);
  });
  return { child, stop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  supervise(fileURLToPath(new URL("../../server/index.mjs", import.meta.url)));
}
