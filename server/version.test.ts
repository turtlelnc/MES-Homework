import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, BUILD_NUMBER, VERSION_LABEL } from "./version.mjs";

const root = path.resolve(import.meta.dirname, "..");
const expectedVersion = "0.2.1-rc4";
const expectedBuild = "26102501";

describe("release identity", () => {
  it("keeps package.json, server and frontend version labels in sync", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    );
    expect(pkg.version).toBe(expectedVersion);
    expect(APP_VERSION).toBe(`v${expectedVersion}`);
    expect(BUILD_NUMBER).toBe(expectedBuild);
    expect(lock.version).toBe(expectedVersion);
    expect(lock.packages[""].version).toBe(expectedVersion);
    expect(VERSION_LABEL).toBe(`v${expectedVersion} (build${expectedBuild})`);
    const frontend = fs.readFileSync(path.join(root, "src/version.ts"), "utf8");
    expect(frontend).toContain('APP_VERSION = "v0.2.1-rc4"');
    expect(frontend).toContain('BUILD_NUMBER = "26102501"');
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("v0.2.1-rc4");
    expect(readme).toContain("build26102501");
    const deployer = fs.readFileSync(
      path.join(root, "tools/deployer/CMakeLists.txt"),
      "utf8",
    );
    expect(deployer).toContain("server/version.mjs");
    expect(deployer).toContain("MES_RELEASE_SOURCE");
  });
});
