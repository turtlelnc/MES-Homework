import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { APP_VERSION } from "../../server/version.mjs";
import { issueInvite } from "../../server/school-invites.mjs";
import { encryptSecret, databasePath } from "./runtime.mjs";
import { providers } from "../../server/providers.mjs";

const PROTOCOL_VERSION = "2024-11-05";

const TOOLS = [
  {
    name: "msh_list_schools",
    description: "列出本机 MES-Homework 已注册的学校（id、名称、用户数）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "msh_list_users",
    description: "列出本机账号，可按学校筛选。",
    inputSchema: {
      type: "object",
      properties: { school: { type: "string", description: "学校 id" } },
      additionalProperties: false,
    },
  },
  {
    name: "msh_issue_invite",
    description: "签发一枚一次性学校开通码（一码一校）。",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "备注" },
        days: { type: "integer", description: "有效天数，省略表示长期有效" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "msh_set_school_api_key",
    description: "为某所学校的管理员配置模型 API Key；apiKey 留空表示清除。",
    inputSchema: {
      type: "object",
      properties: {
        school: { type: "string", description: "学校 id" },
        provider: { type: "string", description: "厂商 id，例如 deepseek" },
        apiKey: { type: "string", description: "API Key，留空清除" },
      },
      required: ["school", "provider"],
      additionalProperties: false,
    },
  },
  {
    name: "msh_server_status",
    description: "查看服务运行状态、数据目录与版本。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/**
 * 极简 MCP stdio 服务：newline-delimited JSON-RPC 2.0。
 * stdout 只写协议消息，日志一律走 stderr。
 */
export function runMcpServer({ db, config, instance }) {
  const call = ({ name, arguments: args = {} }) => {
    if (!db) throw new Error(`数据库不存在：${databasePath(config)}`);
    if (name === "msh_list_schools")
      return text(
        db
          .prepare(
            "SELECT s.id,s.name,(SELECT COUNT(*) FROM users u WHERE u.school_id=s.id) users FROM schools s ORDER BY s.created_at",
          )
          .all(),
      );
    if (name === "msh_list_users") {
      const rows = args.school
        ? db
            .prepare(
              "SELECT role,username,name,class_name FROM users WHERE school_id=? ORDER BY role,name",
            )
            .all(args.school)
        : db
            .prepare(
              "SELECT school_id,role,username,name,class_name FROM users ORDER BY school_id,role,name",
            )
            .all();
      return text(rows);
    }
    if (name === "msh_issue_invite") {
      const days = Number(args.days);
      const expiresAt =
        Number.isSafeInteger(days) && days > 0
          ? new Date(Date.now() + days * 86400000).toISOString()
          : null;
      return text({
        code: issueInvite(db, { note: String(args.note || ""), expiresAt }),
        expiresAt,
      });
    }
    if (name === "msh_set_school_api_key") {
      const admin = db
        .prepare(
          "SELECT id FROM users WHERE school_id=? AND role='teacher' AND is_school_admin=1 ORDER BY created_at LIMIT 1",
        )
        .get(args.school);
      if (!admin) throw new Error("该学校没有管理员账号");
      if (!args.apiKey) {
        db.prepare("DELETE FROM provider_settings WHERE user_id=?").run(admin.id);
        return text({ cleared: true });
      }
      const preset = providers[args.provider];
      if (!preset) throw new Error(`未知厂商：${args.provider}`);
      const [encrypted, iv] = encryptSecret(config, String(args.apiKey));
      db.prepare(
        "INSERT INTO provider_settings(id,user_id,provider,endpoint,model,encrypted_key,iv,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,endpoint=excluded.endpoint,model=excluded.model,encrypted_key=excluded.encrypted_key,iv=excluded.iv,updated_at=excluded.updated_at",
      ).run(
        randomUUID(),
        admin.id,
        args.provider,
        preset.endpoint,
        preset.model,
        encrypted,
        iv,
        new Date().toISOString(),
      );
      return text({ saved: true, provider: args.provider });
    }
    if (name === "msh_server_status")
      return text({
        version: APP_VERSION,
        running: Boolean(instance),
        url: instance?.url || null,
        dataDir: config.DATA_DIR,
        host: config.HOST,
        port: config.PORT,
      });
    throw new Error(`未知工具：${name}`);
  };

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, message) =>
    send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return fail(null, "无效的 JSON-RPC 消息");
    }
    const { id, method, params } = message;
    try {
      if (method === "initialize")
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "msh", version: APP_VERSION },
        });
      if (method === "notifications/initialized") return;
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools: TOOLS });
      if (method === "tools/call") {
        const result = call(params || {});
        return reply(id, result);
      }
      return fail(id, `不支持的方法：${method}`);
    } catch (error) {
      return fail(id, error.message);
    }
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write("msh MCP server ready (stdio)\n");
}
