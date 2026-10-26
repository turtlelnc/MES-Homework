export function applicationCapabilities(db, env = process.env) {
  const sql =
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'",
      )
      .get()?.sql || "";
  const values = sql.match(/CHECK\s*\(\s*stage\s+IN\s*\(([^)]+)\)/i)?.[1];
  const stages = [...(values || "").matchAll(/'((?:''|[^'])*)'/g)].map((m) =>
    m[1].replaceAll("''", "'"),
  );
  if (!stages.length) throw new Error("数据库缺少学段约束，无法生成注册表单");
  return { stages, publicRegistration: env.ALLOW_PUBLIC_REGISTRATION !== "0" };
}
