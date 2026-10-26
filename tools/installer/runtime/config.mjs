import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";

export function locations(
  mode,
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
) {
  if (!["local", "service"].includes(mode))
    throw new Error("Unknown application mode");
  let base;
  if (mode === "local") {
    base =
      env.MES_HOMEWORK_HOME ||
      (platform === "win32"
        ? path.join(
            env.LOCALAPPDATA || path.join(home, "AppData/Local"),
            "MESHomework",
          )
        : platform === "darwin"
          ? path.join(home, "Library/Application Support/MESHomework")
          : path.join(
              env.XDG_DATA_HOME || path.join(home, ".local/share"),
              "mes-homework",
            ));
  } else if (platform === "win32") {
    if (!env.ProgramData) throw new Error("ProgramData is not available");
    base = path.join(env.ProgramData, "MESHomework");
  } else if (platform === "darwin")
    base = path.join(home, "Library/Application Support/MESHomeworkServer");
  else base = "/var/lib/mes-homework";
  base = path.resolve(base);
  return {
    base,
    data: path.join(base, "data"),
    config:
      env.MES_HOMEWORK_CONFIG ||
      (mode === "service" && platform === "linux"
        ? "/etc/mes-homework/environment"
        : path.join(base, ".env")),
  };
}
export function prepareConfig(mode, paths) {
  fs.mkdirSync(paths.base, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(paths.config), { recursive: true, mode: 0o700 });
  let original = "";
  try {
    const stat = fs.lstatSync(paths.config);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid configuration file");
    original = fs.readFileSync(paths.config, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const existing = parseEnv(original);
  if (
    !existing.APP_SECRET &&
    fs.existsSync(
      path.join(existing.DATA_DIR || paths.data, "smart-campus.sqlite"),
    )
  )
    throw new Error(
      "Existing database has no APP_SECRET configuration; restore the original secret before starting",
    );
  const defaults = {
    APP_SECRET: randomBytes(48).toString("hex"),
    DATA_DIR: paths.data.replaceAll("\\", "/"),
    HOST: "127.0.0.1",
    PORT: "8787",
    NODE_ENV: mode === "local" ? "development" : "production",
  };
  const missing = Object.entries(defaults).filter(
    ([key]) => !(key in existing),
  );
  if (missing.length) {
    const content =
      original +
      (original && !original.endsWith("\n") ? "\n" : "") +
      missing
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") +
      "\n";
    const temp = paths.config + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, paths.config);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  const config = { ...defaults, ...existing };
  if (
    !/^\d+$/.test(config.PORT) ||
    Number(config.PORT) < 1 ||
    Number(config.PORT) > 65535
  )
    throw new Error("PORT must be 1..65535");
  if (config.APP_SECRET.length < 32)
    throw new Error("APP_SECRET must contain at least 32 characters");
  if (
    mode === "local" &&
    !["127.0.0.1", "::1", "localhost"].includes(config.HOST)
  )
    throw new Error(
      "Local mode must listen on loopback; use service mode for network hosting",
    );
  if (!path.isAbsolute(config.DATA_DIR))
    throw new Error("Installed application DATA_DIR must be an absolute path");
  fs.mkdirSync(config.DATA_DIR, { recursive: true, mode: 0o700 });
  return config;
}
