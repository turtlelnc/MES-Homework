// Runs only in an explicitly requested GitHub Actions publishing job. The
// managed editor's API credentials need not work on uploads.github.com.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { APP_VERSION, BUILD_NUMBER } from "../../server/version.mjs";

const repo = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN;
const runId = process.env.RELEASE_SOURCE_RUN,
  target = process.env.RELEASE_TARGET_COMMIT;
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !/^[\w.-]+\/[\w.-]+$/.test(repo || "") ||
  !token ||
  !/^\d+$/.test(runId || "") ||
  !/^[a-f0-9]{40}$/.test(target || "")
)
  throw new Error("Explicit Actions publishing inputs are required");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mes-release-"));
async function api(endpoint, method = "GET", body) {
  const response = await fetch(
    "https://api.github.com/repos/" + repo + endpoint,
    {
      method,
      headers: {
        authorization: "Bearer " + token,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    },
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `GitHub API ${method} ${endpoint}: ${response.status} ${error.message || ""}`,
    );
  }
  return response.status === 204 ? null : response.json();
}
async function digest(file) {
  const h = createHash("sha256");
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest("hex");
}
async function resolveTag() {
  const r = await fetch(
    `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(APP_VERSION)}`,
    {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(30000),
    },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Unable to inspect release tag");
  let object = (await r.json()).object;
  for (let i = 0; i < 5 && object.type === "tag"; i++)
    object = (await api("/git/tags/" + object.sha)).object;
  if (object.type !== "commit")
    throw new Error("Release tag does not resolve to a commit");
  return object.sha;
}
async function upload(release, file) {
  const name = path.basename(file),
    size = fs.statSync(file).size,
    hash = await digest(file);
  const url =
    release.upload_url.replace(/\{.*$/, "?") +
    "name=" +
    encodeURIComponent(name);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/octet-stream",
      "content-length": String(size),
    },
    body: fs.createReadStream(file),
    duplex: "half",
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok)
    throw new Error(`Release upload failed for ${name}: ${response.status}`);
  const asset = await response.json();
  if (
    asset.size !== size ||
    (asset.digest && asset.digest !== "sha256:" + hash)
  )
    throw new Error(`Uploaded bytes do not match: ${name}`);
  console.log(`Uploaded and checked ${name} (${size} bytes)`);
  return asset;
}
try {
  const source = await api("/actions/runs/" + runId);
  if (
    source.status !== "completed" ||
    source.conclusion !== "success" ||
    source.head_repository?.full_name !== repo ||
    source.path !== ".github/workflows/native-installers.yml"
  )
    throw new Error(
      "Source run is not a successful native build from this repository",
    );
  const comparison = await api("/compare/" + source.head_sha + "..." + target);
  if (
    comparison.files?.some(
      (f) =>
        !(f.filename.startsWith("docs/") || /^[^/]+\.md$/.test(f.filename)),
    )
  )
    throw new Error(
      "Target source differs from the verified application/installer build",
    );
  const versionFile = await api("/contents/server/version.mjs?ref=" + target);
  const versionText = Buffer.from(versionFile.content, "base64").toString();
  if (
    !versionText.includes(`APP_VERSION = "${APP_VERSION}"`) ||
    !versionText.includes(`BUILD_NUMBER = "${BUILD_NUMBER}"`)
  )
    throw new Error("Target release identity differs");
  const tag = await resolveTag();
  if (tag && tag !== target)
    throw new Error(
      "Existing tag points to another commit; refusing to move it",
    );
  execFileSync(
    "gh",
    [
      "run",
      "download",
      runId,
      "--repo",
      repo,
      "--name",
      "native-installers-verified",
      "--dir",
      scratch,
    ],
    { stdio: "inherit" },
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(scratch, "mes-homework-installers.json"), "utf8"),
  );
  const targets = JSON.parse(
    fs.readFileSync(
      new URL("../installer/targets.json", import.meta.url),
      "utf8",
    ),
  );
  const keys = new Set(),
    files = [];
  if (manifest.version !== APP_VERSION || manifest.build !== BUILD_NUMBER)
    throw new Error("Artifact version mismatch");
  for (const entry of manifest.installers) {
    const key = entry.platform + "-" + entry.arch + "/" + entry.format;
    if (
      keys.has(key) ||
      path.basename(entry.asset) !== entry.asset ||
      !targets.some(
        (t) =>
          t.slug === entry.platform + "-" + entry.arch &&
          t.formats.includes(entry.format),
      )
    )
      throw new Error("Unexpected installer metadata");
    keys.add(key);
    const file = path.join(scratch, entry.asset);
    if (
      fs.statSync(file).size !== entry.size ||
      (await digest(file)) !== entry.sha256
    )
      throw new Error("Artifact integrity check failed");
    files.push(file);
  }
  for (const t of targets)
    for (const f of t.formats)
      if (!keys.has(t.slug + "/" + f))
        throw new Error("A required installer is missing");
  files.push(
    path.join(scratch, "mes-homework-installers.json"),
    path.join(scratch, "SHA256SUMS.txt"),
  );
  for (const line of fs
    .readFileSync(path.join(scratch, "SHA256SUMS.txt"), "utf8")
    .trim()
    .split("\n")) {
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (
      !m ||
      path.basename(m[2]) !== m[2] ||
      (await digest(path.join(scratch, m[2]))) !== m[1]
    )
      throw new Error("Checksum list is invalid");
  }
  const releases = await api("/releases?per_page=100");
  let release = releases.find((r) => r.tag_name === APP_VERSION);
  if (!release)
    throw new Error("Prepare the reviewed release draft before publishing");
  const expected = new Map(
    await Promise.all(
      files.map(async (f) => [
        path.basename(f),
        { file: f, size: fs.statSync(f).size, hash: await digest(f) },
      ]),
    ),
  );
  if (!release.draft) {
    for (const [name, x] of expected) {
      const a = release.assets.find((a) => a.name === name);
      if (!a || a.size !== x.size || a.digest !== "sha256:" + x.hash)
        throw new Error(
          "Published release differs; use a new version instead of overwriting it",
        );
    }
    console.log(`Already published and verified: ${release.html_url}`);
  } else {
    const legacy = release.assets.filter((a) => !expected.has(a.name));
    if (
      legacy.some(
        (a) =>
          !a.name.startsWith("mes-deployer-") &&
          !a.name.startsWith("mes-homework-app-"),
      )
    )
      throw new Error("Unrecognized assets in draft; refusing to remove them");
    release = await api("/releases/" + release.id, "PATCH", {
      target_commitish: target,
      name: `MES Homework ${APP_VERSION} · 原生安装包`,
      draft: true,
      prerelease: APP_VERSION.includes("-"),
    });
    for (const [name, x] of expected) {
      const existing = release.assets.find((a) => a.name === name);
      if (
        existing &&
        existing.size === x.size &&
        existing.digest === "sha256:" + x.hash
      )
        continue;
      if (existing) await api("/releases/assets/" + existing.id, "DELETE");
      await upload(release, x.file);
    }
    const checked = await api("/releases/" + release.id);
    if (!checked.draft) throw new Error("Release was published concurrently");
    for (const [name, x] of expected) {
      const a = checked.assets.find((a) => a.name === name);
      if (
        !a ||
        a.state !== "uploaded" ||
        a.size !== x.size ||
        (a.digest && a.digest !== "sha256:" + x.hash)
      )
        throw new Error("Remote asset verification failed");
    }
    for (const old of legacy) await api("/releases/assets/" + old.id, "DELETE");
    const ready = await api("/releases/" + release.id);
    if (ready.assets.length !== expected.size)
      throw new Error("Final release asset set is not exact");
    const published = await api("/releases/" + release.id, "PATCH", {
      draft: false,
      prerelease: APP_VERSION.includes("-"),
      make_latest: APP_VERSION.includes("-") ? "false" : "true",
    });
    if (published.draft || (await resolveTag()) !== target)
      throw new Error("Published tag verification failed");
    console.log(`Published and verified: ${published.html_url}`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
