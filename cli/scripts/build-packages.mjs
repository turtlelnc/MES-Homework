import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, ".npm-packages");
const app = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = app.version;

// 运行时真正需要的依赖；React/图表等只用于构建 dist，不装进全局 CLI。
const RUNTIME_DEPS = [
  "@napi-rs/canvas",
  "express",
  "mammoth",
  "multer",
  "pdfjs-dist",
  "read-excel-file",
  "word-extractor",
];
const APP_DIRS = [
  "server",
  "shared",
  "cli",
  "dist",
  "tools/ops",
  "tools/installer/runtime",
];

function copyDir(relative) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`缺少 ${relative}，请先 npm run build`);
  const target = path.join(out, "msh", relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

fs.rmSync(out, { recursive: true, force: true });

// ── @turtlelnc/msh：本体的 CLI 与运行时 ─────────────────────────────
fs.mkdirSync(path.join(out, "msh", "bin"), { recursive: true });
for (const dir of APP_DIRS) copyDir(dir);
fs.copyFileSync(path.join(root, "README.md"), path.join(out, "msh", "README.md"));
fs.writeFileSync(
  path.join(out, "msh", "bin", "msh.mjs"),
  '#!/usr/bin/env node\nimport { main } from "../cli/src/cli.mjs";\n\nawait main();\n',
  { mode: 0o755 },
);
fs.writeFileSync(
  path.join(out, "msh", "package.json"),
  `${JSON.stringify(
    {
      name: "@turtlelnc/msh",
      version,
      description: "MES-Homework 便携服务器命令行工具（本地服务、隧道、开通码、管理与 MCP）",
      type: "module",
      bin: { msh: "bin/msh.mjs" },
      engines: { node: ">=24" },
      files: ["bin", ...APP_DIRS, "README.md"],
      dependencies: Object.fromEntries(
        RUNTIME_DEPS.filter((name) => app.dependencies?.[name]).map((name) => [
          name,
          app.dependencies[name],
        ]),
      ),
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/turtlelnc/MES-Homework.git",
      },
      homepage: "https://github.com/turtlelnc/MES-Homework",
    },
    null,
    2,
  )}\n`,
);

// ── @turtlelnc/mes-homework：同代码的入口包，依赖 msh ────────────────
fs.mkdirSync(path.join(out, "mes-homework", "bin"), { recursive: true });
fs.writeFileSync(
  path.join(out, "mes-homework", "bin", "mes-homework.mjs"),
  '#!/usr/bin/env node\nconst { main } = await import("@turtlelnc/msh/cli/src/cli.mjs");\n\nawait main();\n',
  { mode: 0o755 },
);
fs.copyFileSync(path.join(root, "README.md"), path.join(out, "mes-homework", "README.md"));
fs.writeFileSync(
  path.join(out, "mes-homework", "package.json"),
  `${JSON.stringify(
    {
      name: "@turtlelnc/mes-homework",
      version,
      description: "MES-Homework 便携服务器（命令行入口）",
      type: "module",
      bin: { "mes-homework": "bin/mes-homework.mjs", msh: "bin/mes-homework.mjs" },
      engines: { node: ">=24" },
      files: ["bin", "README.md"],
      dependencies: { "@turtlelnc/msh": version },
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/turtlelnc/MES-Homework.git",
      },
      homepage: "https://github.com/turtlelnc/MES-Homework",
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`已生成 ${out}/msh 与 ${out}/mes-homework（${version}）\n`);
