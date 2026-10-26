import { packageCompatible } from "../tools/installer/assemble.mjs";
import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { packageVersions } from "../tools/installer/versions.mjs";
import {
  locations,
  prepareConfig,
} from "../tools/installer/runtime/config.mjs";
it("orders native prerelease versions before stable and refuses unrepresentable identities", () => {
  const versions = [
    "v0.2.1-alpha1",
    "v0.2.1-beta1",
    "v0.2.1-rc4",
    "v0.2.1-rc10",
    "v0.2.1",
    "v0.2.2-alpha1",
  ].map((x) => packageVersions(x, "26102501"));
  const numbers = versions.map((x) => Number(x.native.split(".")[2]));
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  expect(versions[2].deb).toBe("0.2.1~rc4+build26102501");
  expect(() => packageVersions("v0.2.99", "1")).toThrow();
  expect(() => packageVersions("v0.2.1-unknown", "1")).toThrow();
});
it("uses actual profile locations rather than guessed usernames or drives", () => {
  expect(
    locations(
      "local",
      { LOCALAPPDATA: "/provided/profile" },
      "win32",
      "/home/other",
    ).base,
  ).toBe(path.resolve("/provided/profile/MESHomework"));
  expect(
    locations(
      "local",
      { XDG_DATA_HOME: "/provided/data" },
      "linux",
      "/home/other",
    ).base,
  ).toBe("/provided/data/mes-homework");
  expect(() => locations("service", {}, "win32", "/home/other")).toThrow(
    "ProgramData",
  );
});
it("preserves existing secrets and custom configuration across repeated preparation", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mes-config-test-"));
  const paths = {
    base,
    data: path.join(base, "data"),
    config: path.join(base, ".env"),
  };
  try {
    const first = prepareConfig("local", paths);
    expect(first.APP_SECRET).toHaveLength(96);
    fs.appendFileSync(
      paths.config,
      "MODEL_GLOBAL_CONCURRENCY=3\n# custom operator settings\n",
    );
    const original = fs.readFileSync(paths.config);
    expect(prepareConfig("local", paths).APP_SECRET).toBe(first.APP_SECRET);
    expect(fs.readFileSync(paths.config)).toEqual(original);
    expect(first.HOST).toBe("127.0.0.1");
    if (process.platform !== "win32")
      expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
it("refuses to replace a lost database master secret or expose local mode on a public interface", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mes-config-guard-"));
  const paths = {
    base,
    data: path.join(base, "data"),
    config: path.join(base, ".env"),
  };
  try {
    fs.mkdirSync(paths.data);
    fs.writeFileSync(path.join(paths.data, "smart-campus.sqlite"), "synthetic");
    expect(() => prepareConfig("local", paths)).toThrow("original secret");
    expect(fs.existsSync(paths.config)).toBe(false);
    fs.writeFileSync(
      paths.config,
      `APP_SECRET=${"a".repeat(64)}\nHOST=0.0.0.0\n`,
    );
    expect(() => prepareConfig("local", paths)).toThrow("loopback");
    expect(
      fs.readFileSync(path.join(paths.data, "smart-campus.sqlite"), "utf8"),
    ).toBe("synthetic");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

it("filters optional native modules using declared OS, CPU and libc metadata",()=>{
  expect(packageCompatible({os:["linux"],cpu:["x64"],libc:["glibc"]},"linux","x64","glibc")).toBe(true);
  expect(packageCompatible({os:["linux"],cpu:["x64"],libc:["musl"]},"linux","x64","glibc")).toBe(false);
  expect(packageCompatible({os:["!win32"]},"win32","arm64")).toBe(false);
  expect(packageCompatible({cpu:["arm64"]},"linux","x64","glibc")).toBe(false);
});
