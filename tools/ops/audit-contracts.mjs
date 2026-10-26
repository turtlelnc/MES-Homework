// Generate a reviewable inventory from actual application source, not a guessed
// list of features. TypeScript parses multiline calls and template literals.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../..");
const files = (dir) =>
  fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(`${dir}/${e.name}`)
        : /\.(mjs|tsx?|jsx)$/.test(e.name) &&
            !/(test|fixture|e2e)\./.test(e.name)
          ? [`${dir}/${e.name}`]
          : [],
    );
const normalize = (s) =>
  s
    .replace(/^\/api/, "")
    .replace(/\$\{[^}]+\}/g, ":_")
    .replace(/:[\w]+/g, ":_")
    .replace(/\?.*$/, "");
const references = [];
const routes = [];
const literals = [];
for (const file of [
  ...files("server"),
  ...files("src"),
  ...files("shared"),
  ...files("tools/ops"),
  ...files("tools/deployer/packaging"),
]) {
  const source = fs.readFileSync(path.join(root, file), "utf8"),
    ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("tsx")
        ? ts.ScriptKind.TSX
        : file.endsWith("ts")
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JS,
    );
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["get", "post", "put", "patch", "delete"].includes(
        node.expression.name.text,
      ) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith("/api/")
    )
      routes.push({
        method: node.expression.name.text.toUpperCase(),
        path: node.arguments[0].text,
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      });
    if (
      file.startsWith("src/") &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node))
    ) {
      const text = ts.isTemplateExpression(node)
        ? node.getText(ast).slice(1, -1)
        : node.text;
      if (text.startsWith("/"))
        references.push({
          path: text,
          file,
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        });
    }
    if (ts.isNumericLiteral(node))
      literals.push({
        file,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        value: node.text,
      });
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
const special = {
  "/api/health": "health/version: deployer, supervisor and operations",
  "/api/schools/register": "legacy alias; UI uses /auth/register school role",
  "/api/submissions/:id/recognize":
    "legacy synchronous alias; UI uses durable recognition-jobs",
  "/api/mistakes/:id/guide":
    "standalone guide API; UI consumes guide embedded in /mistakes",
};
const inventory = routes.map((route) => {
  const matches = references.filter(
    (r) => normalize(r.path) === normalize(route.path),
  );
  if (!matches.length && route.path.startsWith("/api/oauth/"))
    return {
      ...route,
      coverage: "OAuth protocol flow/callback",
      references: [
        "src/oauth-flows.ts",
        "src/OAuthLoginDialog.tsx",
        "src/ProviderSettings.tsx",
      ],
    };
  return {
    ...route,
    coverage: matches.length
      ? "frontend"
      : special[route.path] || "REVIEW_REQUIRED",
    references: matches.map((m) => `${m.file}:${m.line}`),
  };
});
const nativeFiles = (dir) =>
  fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? nativeFiles(`${dir}/${e.name}`)
        : /\.(cpp|h)$/.test(e.name)
          ? [`${dir}/${e.name}`]
          : [],
    );
const nativeLiterals = nativeFiles("tools/deployer/src").flatMap((file) =>
  fs
    .readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .flatMap((line, i) =>
      [...line.matchAll(/\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/g)].map((m) => ({
        file,
        line: i + 1,
        value: m[0],
      })),
    ),
);
const output = process.argv[2];
const report = {
  routes: inventory,
  unmapped: inventory.filter((r) => r.coverage === "REVIEW_REQUIRED"),
  numericLiterals: literals,
  nativeNumericCandidates: nativeLiterals,
};
if (output) {
  fs.writeFileSync(
    path.resolve(output),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `Routes: ${routes.length}; require review: ${report.unmapped.length}; numeric literals: ${literals.length}`,
  );
} else console.log(JSON.stringify(report.unmapped, null, 2));
