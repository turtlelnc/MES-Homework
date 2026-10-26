import fs from "node:fs";
import path from "node:path";
import { APP_VERSION, BUILD_NUMBER } from "../../server/version.mjs";
import { verifyAppRuntime } from "../deployer/packaging/verify-app-runtime.mjs";
export function packageCompatible(
  pkg,
  platform = process.platform,
  arch = process.arch,
  libc = process.platform === "linux"
    ? process.report.getReport().header.glibcVersionRuntime
      ? "glibc"
      : "musl"
    : undefined,
) {
  const accepts = (list, value) => {
    if (!list) return true;
    const values = Array.isArray(list) ? list : [list];
    if (values.includes("!" + value)) return false;
    const allow = values.filter((x) => !x.startsWith("!"));
    return !allow.length || allow.includes(value) || allow.includes("any");
  };
  return (
    accepts(pkg.os, platform) &&
    accepts(pkg.cpu, arch) &&
    (!libc || accepts(pkg.libc, libc))
  );
}
export function copyTree(source, target, filterPackages = false) {
  if (
    filterPackages &&
    fs.existsSync(path.join(source, "package.json")) &&
    !packageCompatible(
      JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")),
    )
  )
    return;

  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to, filterPackages);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}
export async function assemble(
  root,
  destination,
  { modules = path.join(root, "node_modules") } = {},
) {
  const platform = { win32: "windows", linux: "linux", darwin: "macos" }[
    process.platform
  ];
  if (
    !platform ||
    !["x64", "arm64"].includes(process.arch) ||
    (platform === "macos" && process.arch !== "arm64")
  )
    throw new Error("No native runtime package for this platform/architecture");
  for (const entry of [
    "dist/index.html",
    "server/index.mjs",
    "shared/tile-plan.mjs",
  ])
    if (!fs.existsSync(path.join(root, entry)))
      throw new Error(`Build/install dependencies first: ${entry}`);
  const installed = JSON.parse(
    fs.readFileSync(path.join(modules, ".package-lock.json"), "utf8"),
  );
  if (Object.values(installed.packages).some((entry) => entry.dev))
    throw new Error(
      "Use a production-only dependency tree (--modules); see tools/installer/README.md",
    );
  if (!fs.existsSync(path.join(modules, "express/package.json")))
    throw new Error("Missing production dependencies");
  const runtime = path.join(destination, "runtime"),
    app = path.join(destination, "app");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  const node = path.join(
    runtime,
    process.platform === "win32" ? "node.exe" : "node",
  );
  fs.copyFileSync(process.execPath, node);
  if (process.platform !== "win32") fs.chmodSync(node, 0o755);
  for (const entry of [
    "server",
    "shared",
    "dist",
    "tools/ops",
    "tools/installer/runtime",
  ])
    copyTree(path.join(root, entry), path.join(app, entry));
  copyTree(modules, path.join(app, "node_modules"), true);
  for (const entry of ["package.json", "package-lock.json", "LICENSE"])
    fs.copyFileSync(path.join(root, entry), path.join(app, entry));
  const metadata = {
    version: APP_VERSION,
    build: BUILD_NUMBER,
    platform,
    arch: process.arch,
    nodeVersion: process.version,
    entry: "app/tools/installer/runtime/launch.mjs",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(destination, "bundle.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
  await verifyAppRuntime(destination);
  return metadata;
}
