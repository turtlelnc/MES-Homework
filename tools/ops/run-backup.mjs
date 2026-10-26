import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeProfile } from "../../server/runtime-profile.mjs";
const child = fork(
  fileURLToPath(new URL("./backup.mjs", import.meta.url)),
  process.argv.slice(2),
  {
    execArgv: [`--max-old-space-size=${runtimeProfile().heapMiB}`],
    stdio: "inherit",
  },
);
child.once("error", () => process.exit(1));
child.once("exit", (code) => process.exit(code ?? 1));
process.once("SIGTERM", () => child.kill("SIGTERM"));
process.once("SIGINT", () => child.kill("SIGINT"));
