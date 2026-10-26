import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { APP_VERSION, BUILD_NUMBER } from "./version.mjs";
it("builds release metadata from actual bytes and refuses stale or tampered asset metadata", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-manifest-"));
  try {
    const name = "mes-homework-app-linux-x64.zip",
      asset = Buffer.from("synthetic runtime");
    fs.writeFileSync(path.join(dir, name), asset);
    fs.writeFileSync(
      path.join(dir, name + ".meta.json"),
      JSON.stringify({
        version: APP_VERSION,
        build: BUILD_NUMBER,
        asset: name,
        platform: "linux",
        arch: "x64",
        nodeVersion: process.version,
        size: asset.length,
        sha256: createHash("sha256").update(asset).digest("hex"),
      }),
    );
    const command = () =>
      spawnSync(
        process.execPath,
        ["tools/deployer/packaging/build-manifest.mjs", "--dir", dir],
        { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
      );
    expect(command().status).toBe(0);
    const result = JSON.parse(
      fs.readFileSync(path.join(dir, "mes-homework-app-manifest.json"), "utf8"),
    );
    expect(result.version).toBe(APP_VERSION);
    expect(result.entries[0].size).toBe(asset.length);
    fs.writeFileSync(path.join(dir, name), "corrupt");
    const failed = command();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("Runtime asset changed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
