#!/usr/bin/env node
import { verifyAppRuntime } from "./verify-app-runtime.mjs";
// 打包「应用运行时」zip：Node 运行时 + 已构建的 server/dist + 生产依赖。
// 用法：
//   node tools/deployer/packaging/build-app-bundle.mjs --out release/mes-homework-app-windows-x64.zip
// 依赖：在仓库根目录已执行 npm ci && npm run build && npm prune --omit=dev。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDefault = path.resolve(here, "..", "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const hostPlatform = { win32: "windows", darwin: "macos", linux: "linux" }[
  process.platform
];
if (!hostPlatform) throw new Error("当前系统没有受支持的运行时包格式");
const platform = option("platform", hostPlatform);
const arch = option(
  "arch",
  process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "x86",
);
const root = path.resolve(option("root", rootDefault));
const out = path.resolve(
  option(
    "out",
    path.join(root, "release", `mes-homework-app-${platform}-${arch}.zip`),
  ),
);
const release = await import(
  pathToFileURL(path.join(root, "server/version.mjs")).href
);
const version = option("version", release.APP_VERSION);
const build = option("build", release.BUILD_NUMBER);
if (
  platform !== hostPlatform ||
  arch !== process.arch ||
  !["x64", "arm64"].includes(process.arch)
)
  throw new Error(
    "运行时包的平台/架构必须与当前 Node 运行时一致，不能伪造跨平台包",
  );
if (version !== release.APP_VERSION || build !== release.BUILD_NUMBER)
  throw new Error("打包版本必须与实际源码一致");

function fail(message) {
  console.error(`打包失败：${message}`);
  process.exit(1);
}
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

if (!fs.existsSync(path.join(root, "dist", "index.html")))
  fail("找不到 dist/index.html，请先在仓库根目录执行 npm run build");
if (!fs.existsSync(path.join(root, "server", "index.mjs")))
  fail("找不到 server/index.mjs");
const nodeModules = path.join(root, "node_modules");
if (!fs.existsSync(nodeModules)) fail("找不到 node_modules（请执行 npm ci）");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mes-app-bundle-"));
const bundle = path.join(work, "bundle");
const runtimeDir = path.join(bundle, "runtime");
const appDir = path.join(bundle, "app");
fs.mkdirSync(runtimeDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });

// 1) Node 运行时（当前构建节点自带，保证与架构一致）
const nodeName = process.platform === "win32" ? "node.exe" : "node";
const nodeTarget = path.join(runtimeDir, nodeName);
fs.copyFileSync(process.execPath, nodeTarget);
if (process.platform !== "win32") fs.chmodSync(nodeTarget, 0o755);

// 2) 应用本体
copyDir(path.join(root, "server"), path.join(appDir, "server"));
copyDir(path.join(root, "dist"), path.join(appDir, "dist"));
copyDir(path.join(root, "shared"), path.join(appDir, "shared"));
copyDir(path.join(root, "tools", "ops"), path.join(appDir, "tools", "ops"));
copyDir(nodeModules, path.join(appDir, "node_modules"));
for (const file of ["package.json", "package-lock.json"]) {
  const source = path.join(root, file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(appDir, file));
}

// 3) 元数据
const meta = {
  version,
  build,
  platform,
  arch,
  nodeVersion: process.version,
  entry: "app/server/index.mjs",
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(
  path.join(bundle, "bundle.json"),
  JSON.stringify(meta, null, 2) + "\n",
);

const startupCheck = await verifyAppRuntime(bundle);
console.log(`runtime check: ${JSON.stringify(startupCheck)}`);

// 4) 压缩为 zip（用 CMake 自带的跨平台 tar，避免 CI 额外依赖）
fs.mkdirSync(path.dirname(out), { recursive: true });
const cmake = spawnSync(
  "cmake",
  ["-E", "tar", "cf", out, "--format=zip", "."],
  {
    cwd: bundle,
    stdio: "inherit",
  },
);
if (cmake.error || cmake.status !== 0) fail("cmake -E tar 打包失败");

const byteLength = fs.statSync(out).size;
const hash = createHash("sha256");
for await (const chunk of fs.createReadStream(out)) hash.update(chunk);
const sha256 = hash.digest("hex");
const shaFile = `${out}.sha256`;
fs.writeFileSync(shaFile, `${sha256}  ${path.basename(out)}\n`);
const entryFile = `${out}.meta.json`;
fs.writeFileSync(
  entryFile,
  JSON.stringify(
    {
      version,
      build,
      platform,
      arch,
      asset: path.basename(out),
      sha256,
      size: byteLength,
      nodeVersion: process.version,
    },
    null,
    2,
  ) + "\n",
);
fs.rmSync(work, { recursive: true, force: true });

console.log(`已生成 ${out}`);
console.log(`  sha256=${sha256}`);
console.log(`  size=${byteLength}`);
console.log(`  入口=${entryFile}`);
