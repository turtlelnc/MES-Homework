import fs from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
const stateFile = process.argv[2];
if (!stateFile)
  throw new Error("Supply the synthetic service instance.json path");
let good = false;
for (let i = 0; i < 120; i++) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const response = await fetch(state.url + "/api/health", {
      signal: AbortSignal.timeout(1000),
    });
    const health = await response.json();
    assert.equal(health.ok, true);
    assert.match(health.version, /^v\d/);
    console.log(
      JSON.stringify({
        serviceReady: true,
        version: health.version,
        build: health.build,
      }),
    );
    good = true;
    break;
  } catch {}
  await pause(250);
}
if (!good) throw new Error("Native service did not become healthy");
