#!/usr/bin/env node
import { APP_VERSION, BUILD_NUMBER } from "../../../server/version.mjs";
// 汇总应用运行时包信息，生成部署器使用的 release manifest 与校验文件。
// 用法：
//   node tools/deployer/packaging/build-manifest.mjs --dir release --version v0.2.1-rc4 --build 26102501
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dir = path.resolve(option("dir", "release"));
const version = option("version", APP_VERSION);
const build = option("build", BUILD_NUMBER);

if (!fs.existsSync(dir)) {
  console.error(`目录不存在：${dir}`);
  process.exit(1);
}
const files = fs
  .readdirSync(dir)
  .filter((name) => fs.statSync(path.join(dir, name)).isFile())
  .sort();
const entries = [];
const digestFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
for (const name of files.filter((name) => name.endsWith(".meta.json"))) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const asset = path.basename(meta.asset || "");
  if (asset !== meta.asset || !asset.endsWith(".zip"))
    throw new Error("Invalid runtime asset name");
  const actualSize = fs.statSync(path.join(dir, asset)).size;
  const digest = await digestFile(path.join(dir, asset));
  if (digest !== meta.sha256 || actualSize !== meta.size)
    throw new Error(`Runtime asset changed: ${asset}`);
  if (
    !meta.nodeVersion ||
    meta.version !== version ||
    String(meta.build) !== String(build)
  )
    throw new Error(`Runtime metadata mismatch: ${asset}`);
  entries.push({
    platform: meta.platform,
    arch: meta.arch,
    asset: meta.asset,
    sha256: meta.sha256,
    size: meta.size,
    nodeVersion: meta.nodeVersion || "",
  });
}
entries.sort((a, b) =>
  `${a.platform}-${a.arch}`.localeCompare(`${b.platform}-${b.arch}`),
);
const manifest = {
  version,
  build,
  createdAt: new Date().toISOString(),
  entries,
};
fs.writeFileSync(
  path.join(dir, "mes-homework-app-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

const sums = [];
for (const name of fs
  .readdirSync(dir)
  .filter(
    (name) =>
      fs.statSync(path.join(dir, name)).isFile() &&
      !name.endsWith(".sha256") &&
      !name.endsWith(".meta.json") &&
      name !== "SHA256SUMS.txt",
  )) {
  const hash = await digestFile(path.join(dir, name));
  sums.push(`${hash}  ${name}`);
}
fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(
  `manifest: ${entries.length} 个运行时包；校验文件 ${sums.length} 个资产`,
);
for (const entry of entries)
  console.log(
    `  ${entry.platform}-${entry.arch}  ${entry.asset}  ${entry.size}`,
  );
