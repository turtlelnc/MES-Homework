import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { packageVersions } from "./versions.mjs";
const dir = path.resolve(process.argv[2] || "release-native"),
  expected = JSON.parse(
    fs.readFileSync(new URL("targets.json", import.meta.url), "utf8"),
  );
const identity = packageVersions(),
  entries = [],
  found = new Set();
async function hash(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}
for (const file of fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".meta.json"))) {
  const entry = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  if (
    path.basename(entry.asset || "") !== entry.asset ||
    !expected.some(
      (t) =>
        t.slug === `${entry.platform}-${entry.arch}` &&
        t.formats.includes(entry.format),
    )
  )
    throw new Error("Unsupported installer metadata");
  if (
    entry.version !== identity.version ||
    entry.build !== identity.build ||
    !entry.nodeVersion
  )
    throw new Error("Installer identity mismatch");
  if (
    path.extname(entry.asset) !== "." + entry.format ||
    fs.statSync(path.join(dir, entry.asset)).size !== entry.size ||
    (await hash(path.join(dir, entry.asset))) !== entry.sha256
  )
    throw new Error("Installer bytes changed after packaging");
  const key = `${entry.platform}-${entry.arch}/${entry.format}`;
  if (found.has(key)) throw new Error("Duplicate installer");
  found.add(key);
  entries.push(entry);
}
for (const t of expected)
  for (const format of t.formats)
    if (!found.has(t.slug + "/" + format))
      throw new Error(`Missing installer: ${t.slug}/${format}`);
entries.sort((a, b) => a.asset.localeCompare(b.asset));
const manifest = path.join(dir, "mes-homework-installers.json");
fs.writeFileSync(
  manifest,
  JSON.stringify(
    { version: identity.version, build: identity.build, installers: entries },
    null,
    2,
  ) + "\n",
);
const sums = [];
for (const file of [...entries.map((e) => e.asset), path.basename(manifest)])
  sums.push(`${await hash(path.join(dir, file))}  ${file}`);
fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(
  `Verified ${entries.length} native installers; no legacy deployer assets included`,
);
