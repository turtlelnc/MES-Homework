import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.ok(fs.existsSync(path.join(report.syntheticProfile, ".env")));
assert.equal(
  fs.readFileSync(
    path.join(report.syntheticProfile, "data/installer-test-sentinel.txt"),
    "utf8",
  ),
  "synthetic data must survive restart/repair/uninstall\n",
);
console.log("Native repair/removal retained synthetic configuration and data");
