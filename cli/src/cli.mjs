import path from "node:path";
import { spawnSync } from "node:child_process";
import { APP_VERSION, VERSION_LABEL, BUILD_NUMBER } from "../../server/version.mjs";
import {
  appPaths,
  databasePath,
  instanceState,
  isProcessAlive,
  launcherEntry,
  loadConfig,
  openBrowser,
  openDatabase,
  packageRoot,
  readSettings,
  runningInstance,
  spawnLauncher,
  updateConfig,
} from "./runtime.mjs";
import { normalizeLanguage, translator } from "./i18n.mjs";
import {
  configureApi,
  issueCode,
  listAccounts,
  runCheck,
  setLanguage,
  setWebsite,
} from "./ops.mjs";
import { togglePower } from "./power.mjs";
import { configureTunnel, installCloudflared, readTunnelConfig, startTunnel } from "./cloudflared.mjs";
import { openAdmin } from "./admin.mjs";
import { runMcpServer } from "./mcp.mjs";

const VALUE_FLAGS = new Set(["language", "power"]);

function parse(argv) {
  const options = { flags: new Set(), values: {}, words: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (VALUE_FLAGS.has(name) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
        options.values[name] = argv[index + 1];
        index += 1;
      } else options.flags.add(name);
    } else options.words.push(token);
  }
  return options;
}

function help(t) {
  const rows = [
    ["--power [on|off]", t("help.describe.power")],
    ["--local", t("help.describe.local")],
    ["--all", t("help.describe.all")],
    ["--cf", t("help.describe.cf")],
    ["--cfinstall", t("help.describe.cfinstall")],
    ["--cfset", t("help.describe.cfset")],
    ["--website", t("help.describe.website")],
    ["--code", t("help.describe.code")],
    ["--api", t("help.describe.api")],
    ["--list", t("help.describe.list")],
    ["--check", t("help.describe.check")],
    ["--manger", t("help.describe.manger")],
    ["--mcp", t("help.describe.mcp")],
    ["--github", t("help.describe.github")],
    ["--language <zh|en> [--msh]", t("help.describe.language")],
    ["--version", t("help.describe.version")],
    ["--stop", t("help.describe.stop")],
    ["--status", t("help.describe.status")],
  ];
  const lines = [
    "",
    `  ${t("cli.title")}  ${VERSION_LABEL}`,
    "",
    `  ${t("help.intro")}`,
    "",
    `  ${t("help.usage")}:  msh <command>`,
    "",
    `${t("help.commands")}:`,
    ...rows.map(([flag, text]) => `  ${flag.padEnd(34)}${text}`),
    "",
    `${t("help.examples")}:`,
    "  msh --local",
    "  msh --code",
    "  msh --api",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function version(t, config) {
  process.stdout.write(
    [
      `${t("version.label")}: ${APP_VERSION} (build${BUILD_NUMBER})`,
      `${t("version.node")}: ${process.versions.node}`,
      `${t("version.platform")}: ${process.platform}/${process.arch}`,
      `${t("version.config")}: ${appPaths.config}`,
      `${t("version.data")}: ${config?.DATA_DIR || path.join(appPaths.base, "data")}`,
      "",
    ].join("\n"),
  );
}

async function waitForHealth(url, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${url}/api/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (response.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function startLauncher(args) {
  return new Promise((resolve) => {
    const child = spawnLauncher(args);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function startServer(config, t, { host, tunnel = false, headless = false } = {}) {
  if (host && host !== config.HOST) updateConfig({ HOST: host });
  const url = `http://127.0.0.1:${config.PORT}`;
  const existing = runningInstance();
  if (existing) {
    process.stdout.write(`${t("status.running", { pid: existing.pid, url: existing.url || url })}\n`);
    return 0;
  }
  if (tunnel) {
    const tunnelConfig = readTunnelConfig();
    if (!tunnelConfig) throw new Error(t("cf.missing"));
  }
  process.stdout.write(`${t("common.starting")}\n`);
  const child = spawnLauncher(headless ? ["--headless"] : []);
  let tunnelChild = null;
  if (tunnel) {
    void waitForHealth(url).then((ok) => {
      if (!ok) {
        process.stderr.write(`${t("common.browserHint", { url })}\n`);
        return;
      }
      try {
        tunnelChild = startTunnel(t);
        tunnelChild.on("exit", () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        });
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
      }
    });
  }
  const code = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 0)));
  tunnelChild?.kill("SIGTERM");
  return code;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const stored = readSettings();
  let config = null;
  const language = normalizeLanguage(
    stored.cliLanguage || process.env.MSH_LANGUAGE || "zh",
  );
  const t = translator(language);

  const has = (...names) =>
    names.some(
      (name) => options.flags.has(name) || Object.hasOwn(options.values, name),
    );
  const headless = has("headless") || has("no-browser");
  const command =
    options.words[0] ||
    [...options.flags].find((flag) => flag !== "msh") ||
    "";

  const isHelp = !command || has("help") || options.words[0] === "help";
  const isVersion = has("version") || command === "version";
  let loadError = null;
  if (!isHelp && !isVersion) {
    try {
      config = loadConfig();
    } catch (error) {
      loadError = error;
    }
  }
  const openDb = () => openDatabase(config);

  try {
    if (loadError) throw loadError;
    if (isHelp) {
      help(t);
      return;
    }
    if (isVersion) {
      version(t, config);
      return;
    }
    if (has("github") || command === "github") {
      openBrowser("https://github.com/turtlelnc/MES-Homework");
      process.stdout.write("https://github.com/turtlelnc/MES-Homework\n");
      return;
    }
    if (has("check") || command === "check") {
      const db = openDb();
      const ok = await runCheck(db, config, t);
      db?.close();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (has("language")) {
      const value = options.values.language || options.words[1] || "";
      const result = setLanguage(value, { cliOnly: has("msh") }, t);
      const next = translator(result.lang);
      process.stdout.write(
        `${result.cliOnly ? next("lang.cli", { lang: result.lang }) : next("lang.server", { lang: result.server })}\n`,
      );
      return;
    }
    if (has("code")) {
      const db = openDb();
      if (!db) throw new Error(`${t("common.error")}: ${databasePath(config)}`);
      await issueCode(db, t);
      db.close();
      return;
    }
    if (has("api")) {
      const db = openDb();
      if (!db) throw new Error(`${t("common.error")}: ${databasePath(config)}`);
      await configureApi(db, config, t);
      db.close();
      return;
    }
    if (has("list")) {
      const db = openDb();
      listAccounts(db, t);
      db?.close();
      return;
    }
    if (has("power")) {
      process.stdout.write(`${togglePower(t, options.values.power)}\n`);
      return;
    }
    if (has("stop")) {
      process.stdout.write(`${t("common.stopping")}\n`);
      const result = spawnSync(process.execPath, [launcherEntry, "--stop"], {
        stdio: "inherit",
      });
      process.exitCode = result.status ?? 1;
      return;
    }
    if (has("status")) {
      const state = instanceState();
      const alive = state && isProcessAlive(state.pid);
      process.stdout.write(
        `${alive ? t("status.running", { pid: state.pid, url: state.url }) : t("status.stopped")}\n`,
      );
      return;
    }
    if (has("cfinstall")) {
      await installCloudflared(t);
      return;
    }
    if (has("cfset")) {
      await configureTunnel(t, Number(config.PORT));
      return;
    }
    if (has("manger", "manager")) {
      const db = openDb();
      if (!db) throw new Error(`${t("common.error")}: ${databasePath(config)}`);
      await openAdmin(db, config, t);
      return;
    }
    if (has("mcp")) {
      const db = openDb();
      runMcpServer({ db, config, instance: runningInstance() });
      return;
    }
    if (has("website")) {
      const db = openDb();
      if (!config.APP_ORIGIN) await setWebsite(config, t);
      else process.stdout.write(`${t("website.current", { origin: config.APP_ORIGIN })}\n`);
      db?.close();
      process.exitCode = await startServer(loadConfig(), t, { host: "127.0.0.1" });
      return;
    }
    if (has("all")) {
      process.stdout.write(`${t("all.mode")}\n${t("all.warning")}\n`);
      process.exitCode = await startServer(config, t, { host: "0.0.0.0", headless });
      return;
    }
    if (has("cf")) {
      process.stdout.write(`${t("local.mode")}\n`);
      process.exitCode = await startServer(config, t, {
        host: "127.0.0.1",
        headless,
        tunnel: true,
      });
      return;
    }
    if (has("local")) {
      process.stdout.write(`${t("local.mode")}\n`);
      process.exitCode = await startServer(config, t, { host: "127.0.0.1", headless });
      return;
    }
    process.stderr.write(`${t("common.unknownCommand", { cmd: command })}\n`);
    help(t);
    process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${t("common.error")}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
