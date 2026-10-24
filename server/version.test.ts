import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, BUILD_NUMBER, VERSION_LABEL } from "./version.mjs";

const root = path.resolve(import.meta.dirname, "..");

describe("release identity", () => {
  it("keeps package.json, server and frontend version labels in sync", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    const lock = JSON.parse(
      fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
    );
    expect(pkg.version).toBe("0.2.1-rc1");
    expect(APP_VERSION).toBe("v0.2.1-rc1");
    expect(BUILD_NUMBER).toBe("26102401");
    expect(lock.version).toBe("0.2.1-rc1");
    expect(lock.packages[""].version).toBe("0.2.1-rc1");
    expect(VERSION_LABEL).toBe("v0.2.1-rc1 (build26102401)");
    const frontend = fs.readFileSync(path.join(root, "src/version.ts"), "utf8");
    expect(frontend).toContain('APP_VERSION = "v0.2.1-rc1"');
    expect(frontend).toContain('BUILD_NUMBER = "26102401"');
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("v0.2.1-rc1");
    expect(readme).toContain("build26102401");
  });
});
