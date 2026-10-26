import { DatabaseSync } from "node:sqlite";
// v0.2.1 schema migrations (rc1+).
//
// SQLite cannot widen a CHECK constraint or drop NOT NULL in place, so the two
// tables that changed shape are rebuilt with the documented 12-step pattern
// (create new table, copy, drop old, rename). Existing deployments keep all
// rows and all sessions; usernames are derived for accounts created before the
// account-name login existed.
//
// This module is idempotent: it inspects sqlite_master first, and a fresh
// database created from server/schema.sql bypasses every rebuild.

const USERS_V021 = `
CREATE TABLE users_v021(
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('teacher','student','parent')),
  name TEXT NOT NULL,
  username TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  stage TEXT CHECK(stage IN('小学','初中','高中')),
  subject TEXT,
  class_name TEXT,
  created_at TEXT NOT NULL,
  is_school_admin INTEGER NOT NULL DEFAULT 0,
  review_mode TEXT NOT NULL DEFAULT 'all' CHECK(review_mode IN('all','uncertain','none')),
  model_auth_mode TEXT NOT NULL DEFAULT 'api_key' CHECK(model_auth_mode IN('api_key','oauth')),
  oauth_provider TEXT,
  FOREIGN KEY(school_id) REFERENCES schools(id)
)`;

const MISTAKES_V021 = `
CREATE TABLE mistakes_v021(
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  student_id TEXT,
  question_id TEXT,
  knowledge_id TEXT,
  reason TEXT NOT NULL,
  student_answer TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  practice_json TEXT,
  mastery INTEGER NOT NULL DEFAULT 0,
  question_number INTEGER,
  prompt TEXT NOT NULL DEFAULT '',
  standard_answer TEXT NOT NULL DEFAULT '',
  question_score REAL,
  reasoning TEXT NOT NULL DEFAULT '',
  guidance_json TEXT
)`;

export const USERNAME_PATTERN = /^[a-z0-9_.\-\u4e00-\u9fa5]{2,32}$/;

export function deriveUsernameSeed(email, id) {
  const local = String(email || "")
    .trim()
    .toLowerCase()
    .split("@")[0]
    .replace(/[^a-z0-9_.-]/g, "");
  const seed = local.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (seed.length >= 2) return seed.slice(0, 28);
  return `user_${
    String(id || "")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 8) || "account"
  }`;
}

// Fill NULL usernames for pre-v0.2.1 accounts. ASCII names are lower-cased so
// "Student01" and "student01" cannot both be registered.
export function assignMissingUsernames(db) {
  const rows = db
    .prepare(
      "SELECT id,email,username FROM users WHERE username IS NULL OR TRIM(username)='' ORDER BY created_at,id",
    )
    .all();
  if (!rows.length) return 0;
  const used = new Set(
    db
      .prepare(
        "SELECT LOWER(username) name FROM users WHERE username IS NOT NULL",
      )
      .all()
      .map((row) => String(row.name)),
  );
  const update = db.prepare("UPDATE users SET username=? WHERE id=?");
  let changed = 0;
  for (const row of rows) {
    const base = deriveUsernameSeed(row.email, row.id);
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1)
      candidate = `${base.slice(0, 28)}_${suffix}`;
    used.add(candidate);
    update.run(candidate, row.id);
    changed += 1;
  }
  return changed;
}

function tableNames(db) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name)),
  );
}

function tableSql(db, table) {
  return String(
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table)?.sql || "",
  );
}

export function tableColumns(db, table) {
  const map = new Map();
  for (const column of db.prepare(`PRAGMA table_info(${table})`).all())
    map.set(String(column.name), column);
  return map;
}

export function ensureColumn(db, table, column, definition, columns = null) {
  const current = columns || tableColumns(db, table);
  if (current.has(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  current.set(column, { name: column });
  return true;
}

function transaction(db, work) {
  const nested = db.isTransaction;
  db.exec(nested ? "SAVEPOINT migration_step" : "BEGIN IMMEDIATE");
  try {
    work();
    db.exec(nested ? "RELEASE migration_step" : "COMMIT");
  } catch (error) {
    db.exec(
      nested
        ? "ROLLBACK TO migration_step; RELEASE migration_step"
        : "ROLLBACK",
    );
    throw error;
  }
}

function protectRebuild(
  db,
  name,
  columns,
  target,
  canonical,
  allowedChecks = [],
) {
  if ([...columns.keys()].some((c) => !target.includes(c)))
    throw new Error(`数据库表 ${name} 有未识别字段，迁移已回滚`);
  const accepted = [...checks(canonical), ...allowedChecks];
  if (checks(tableSql(db, name)).some((c) => !accepted.includes(c)))
    throw new Error(`数据库表 ${name} 有未识别 CHECK 约束，迁移已回滚`);
  return db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN('index','trigger') AND sql IS NOT NULL",
    )
    .all(name);
}

function rebuildUsers(db) {
  const columns = tableColumns(db, "users");
  const select = [
    "id",
    "school_id",
    "role",
    "name",
    columns.has("username") ? "username" : "NULL",
    columns.has("email") ? "email" : "NULL",
    "password_hash",
    "salt",
    "stage",
    "subject",
    "class_name",
    "created_at",
    columns.has("is_school_admin") ? "COALESCE(is_school_admin,0)" : "0",
    columns.has("review_mode") ? "COALESCE(review_mode,'all')" : "'all'",
    columns.has("model_auth_mode")
      ? "COALESCE(model_auth_mode,'api_key')"
      : "'api_key'",
    columns.has("oauth_provider") ? "oauth_provider" : "NULL",
  ];
  const target = [
    "id",
    "school_id",
    "role",
    "name",
    "username",
    "email",
    "password_hash",
    "salt",
    "stage",
    "subject",
    "class_name",
    "created_at",
    "is_school_admin",
    "review_mode",
    "model_auth_mode",
    "oauth_provider",
  ];
  const retained = protectRebuild(db, "users", columns, target, USERS_V021, [
    "check(rolein('teacher','student'))",
  ]);
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      db.exec(USERS_V021);
      db.exec(
        `INSERT INTO users_v021(${target.join(",")}) SELECT ${select.join(",")} FROM users`,
      );
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_v021 RENAME TO users");
      for (const row of retained) db.exec(row.sql);
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

function backfillMistakeSnapshots(db) {
  db.exec(`
    UPDATE mistakes SET
      question_number=COALESCE(question_number,(SELECT number FROM questions WHERE questions.id=mistakes.question_id)),
      prompt=CASE WHEN prompt='' THEN COALESCE((SELECT prompt FROM questions WHERE questions.id=mistakes.question_id),'') ELSE prompt END,
      standard_answer=CASE WHEN standard_answer='' THEN COALESCE((SELECT standard_answer FROM questions WHERE questions.id=mistakes.question_id),'') ELSE standard_answer END,
      question_score=COALESCE(question_score,(SELECT score FROM questions WHERE questions.id=mistakes.question_id))
    WHERE question_id IS NOT NULL
  `);
}

function rebuildMistakes(db) {
  const columns = tableColumns(db, "mistakes");
  const pick = (name, fallback) => (columns.has(name) ? name : fallback);
  const target = [
    "id",
    "submission_id",
    "student_id",
    "question_id",
    "knowledge_id",
    "reason",
    "student_answer",
    "correction",
    "created_at",
    "explanation",
    "practice_json",
    "mastery",
    "question_number",
    "prompt",
    "standard_answer",
    "question_score",
    "reasoning",
    "guidance_json",
  ];
  const select = [
    "id",
    "submission_id",
    "student_id",
    "question_id",
    "knowledge_id",
    "reason",
    "student_answer",
    "correction",
    "created_at",
    pick("explanation", "''"),
    pick("practice_json", "NULL"),
    pick("mastery", "0"),
    pick("question_number", "NULL"),
    pick("prompt", "''"),
    pick("standard_answer", "''"),
    pick("question_score", "NULL"),
    pick("reasoning", "''"),
    pick("guidance_json", "NULL"),
  ];
  const retained = protectRebuild(
    db,
    "mistakes",
    columns,
    target,
    MISTAKES_V021,
  );
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      db.exec(MISTAKES_V021);
      db.exec(
        `INSERT INTO mistakes_v021(${target.join(",")}) SELECT ${select.join(",")} FROM mistakes`,
      );
      db.exec("DROP TABLE mistakes");
      db.exec("ALTER TABLE mistakes_v021 RENAME TO mistakes");
      for (const row of retained) db.exec(row.sql);
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

/**
 * Apply every v0.2.1 schema change to `db`, then create any tables/indexes the
 * running release expects. Call once at startup, before routes are registered.
 */
function migrateSteps(db, { schemaSql }) {
  const existing = tableNames(db);
  if (existing.has("users")) {
    const columns = tableColumns(db, "users");
    const sql = tableSql(db, "users");
    if (
      [
        "username",
        "is_school_admin",
        "review_mode",
        "model_auth_mode",
        "oauth_provider",
      ].some((name) => !columns.has(name)) ||
      !sql.includes("'parent'")
    )
      rebuildUsers(db);
  }
  if (existing.has("mistakes")) {
    const columns = tableColumns(db, "mistakes");
    if (
      !columns.has("guidance_json") ||
      !columns.has("reasoning") ||
      !columns.has("question_score") ||
      columns.get("question_id")?.notnull === 1
    )
      rebuildMistakes(db);
  }
  // Creates v0.2.1 tables and the partial unique indexes for fresh databases;
  // for upgraded databases it is a no-op for the rebuilt tables.
  db.exec(schemaSql);
  // v0.2.1-rc4: provider identity metadata on existing OAuth connections. The
  // migration only adds a column (defaults to '{}') so old rows are preserved.
  if (tableNames(db).has("oauth_connections"))
    ensureColumn(
      db,
      "oauth_connections",
      "meta_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
  if (tableNames(db).has("assignments")) {
    const assignmentColumns = tableColumns(db, "assignments");
    ensureColumn(
      db,
      "assignments",
      "description",
      "TEXT NOT NULL DEFAULT ''",
      assignmentColumns,
    );
    ensureColumn(
      db,
      "assignments",
      "grading_mode",
      "TEXT NOT NULL DEFAULT 'bank'",
      assignmentColumns,
    );
  }
  if (tableNames(db).has("submissions"))
    ensureColumn(db, "submissions", "questions_json", "TEXT");
  if (tableNames(db).has("teaching_analyses"))
    ensureColumn(
      db,
      "teaching_analyses",
      "source_revision",
      "TEXT NOT NULL DEFAULT ''",
    );
  if (tableNames(db).has("mistakes")) {
    const mistakeColumns = tableColumns(db, "mistakes");
    ensureColumn(
      db,
      "mistakes",
      "explanation",
      "TEXT NOT NULL DEFAULT ''",
      mistakeColumns,
    );
    ensureColumn(db, "mistakes", "practice_json", "TEXT", mistakeColumns);
    ensureColumn(
      db,
      "mistakes",
      "mastery",
      "INTEGER NOT NULL DEFAULT 0",
      mistakeColumns,
    );
    ensureColumn(
      db,
      "mistakes",
      "reasoning",
      "TEXT NOT NULL DEFAULT ''",
      mistakeColumns,
    );
    ensureColumn(db, "mistakes", "guidance_json", "TEXT", mistakeColumns);
    ensureColumn(db, "mistakes", "question_number", "INTEGER", mistakeColumns);
    ensureColumn(
      db,
      "mistakes",
      "prompt",
      "TEXT NOT NULL DEFAULT ''",
      mistakeColumns,
    );
    ensureColumn(
      db,
      "mistakes",
      "standard_answer",
      "TEXT NOT NULL DEFAULT ''",
      mistakeColumns,
    );
    ensureColumn(db, "mistakes", "question_score", "REAL", mistakeColumns);
    backfillMistakeSnapshots(db);
  }
  if (tableNames(db).has("users")) assignMissingUsernames(db);
}

const normalizeDefault = (value) =>
  String(value ?? "NULL")
    .trim()
    .replace(/^\((.*)\)$/, "$1");
const foreignKeys = (db, name) =>
  db
    .prepare(`PRAGMA foreign_key_list("${name}")`)
    .all()
    .map(({ table, from, to, on_update, on_delete, match }) =>
      JSON.stringify({ table, from, to, on_update, on_delete, match }),
    )
    .sort();
const checks = (sql) => {
  const result = [];
  for (const match of sql.matchAll(/CHECK\s*\(/gi)) {
    let depth = 1,
      quote = "",
      end = match.index + match[0].length;
    for (; end < sql.length && depth; end++) {
      const ch = sql[end];
      if (quote) {
        if (ch === quote) {
          if (sql[end + 1] === quote) end++;
          else quote = "";
        }
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    result.push(sql.slice(match.index, end).replace(/\s+/g, "").toLowerCase());
  }
  return result.sort();
};
const tableNeedsAlignment = (db, fresh, name) => {
  const actual = tableColumns(db, name),
    expected = tableColumns(fresh, name);
  return (
    [...expected.values()].some((c) => {
      const a = actual.get(c.name);
      return (
        !a ||
        a.type !== c.type ||
        a.notnull !== c.notnull ||
        a.pk !== c.pk ||
        normalizeDefault(a.dflt_value) !== normalizeDefault(c.dflt_value)
      );
    }) ||
    JSON.stringify(foreignKeys(db, name)) !==
      JSON.stringify(foreignKeys(fresh, name)) ||
    checks(tableSql(fresh, name)).some(
      (c) => !checks(tableSql(db, name)).includes(c),
    )
  );
};
// Older releases added columns without the corresponding CHECK/FK clauses.
// Rebuild only within the outer transaction; never discard unknown columns or
// custom triggers/indexes while making known release contracts consistent.
function alignReleaseSchema(db, schemaSql) {
  const fresh = new DatabaseSync(":memory:");
  try {
    fresh.exec(schemaSql);
    const canonicalIndexes = new Set(
      fresh
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((r) => r.name),
    );
    for (const { name, sql } of fresh
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()) {
      if (!tableNeedsAlignment(db, fresh, name)) continue;
      const current = tableColumns(db, name),
        expected = tableColumns(fresh, name);
      if ([...current.keys()].some((c) => !expected.has(c)))
        throw new Error(`数据库表 ${name} 有未识别字段，迁移已回滚`);
      const expectedChecks = checks(sql);
      if (checks(tableSql(db, name)).some((c) => !expectedChecks.includes(c)))
        throw new Error(`数据库表 ${name} 有未识别 CHECK 约束，迁移已回滚`);
      const extra = db
        .prepare(
          "SELECT name,type,sql FROM sqlite_master WHERE tbl_name=? AND type IN('index','trigger') AND sql IS NOT NULL",
        )
        .all(name)
        .filter((r) => r.type === "trigger" || !canonicalIndexes.has(r.name));
      const temporary = `__mes_upgrade_${name}`;
      const create = sql.replace(
        /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|\w+)/i,
        `CREATE TABLE "${temporary}"`,
      );
      db.exec(create);
      const columns = [...expected.keys()].map((c) => `"${c}"`).join(",");
      db.exec(
        `INSERT INTO "${temporary}"(${columns}) SELECT ${columns} FROM "${name}"; DROP TABLE "${name}"; ALTER TABLE "${temporary}" RENAME TO "${name}"`,
      );
      for (const row of extra) db.exec(row.sql);
    }
    db.exec(schemaSql);
    for (const row of fresh
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
      )
      .all()) {
      const actual = db
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(row.name);
      if (
        actual?.sql.replace(/\s+/g, "").toLowerCase() !==
        row.sql.replace(/\s+/g, "").toLowerCase()
      )
        db.exec(`DROP INDEX "${row.name}"; ${row.sql}`);
    }
  } finally {
    fresh.close();
  }
}

// Verify the running release's required tables, columns and indexes against a
// fresh database. Extra deployment tables are allowed; missing release fields
// are never silently served to the application.
export function schemaDifferences(db, schemaSql) {
  const fresh = new DatabaseSync(":memory:");
  try {
    fresh.exec(schemaSql);
    const differences = [];
    for (const row of fresh
      .prepare(
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE type IN('table','index') AND name NOT LIKE 'sqlite_%'",
      )
      .all()) {
      const actual = db
        .prepare("SELECT type,sql FROM sqlite_master WHERE name=?")
        .get(row.name);
      if (!actual || actual.type !== row.type) {
        differences.push(`${row.type}:${row.name}`);
        continue;
      }
      if (
        row.type === "index" &&
        actual.sql?.replace(/\s+/g, "").toLowerCase() !==
          row.sql?.replace(/\s+/g, "").toLowerCase()
      )
        differences.push(`index-contract:${row.name}`);
      if (row.type === "table" && tableNeedsAlignment(db, fresh, row.name))
        differences.push(`table-contract:${row.name}`);
      if (row.type === "table") {
        const columns = tableColumns(db, row.name);
        for (const c of fresh
          .prepare(`PRAGMA table_info("${row.name}")`)
          .all()) {
          const a = columns.get(c.name);
          if (
            !a ||
            a.type.toUpperCase() !== c.type.toUpperCase() ||
            a.pk !== c.pk ||
            a.notnull !== c.notnull
          )
            differences.push(`${row.name}.${c.name}`);
        }
      }
    }
    return differences;
  } finally {
    fresh.close();
  }
}
export function migrateDatabase(db, { schemaSql }) {
  if (db.isTransaction) throw new Error("数据库迁移必须在启动时独立执行");
  db.exec("PRAGMA journal_mode=WAL");
  try {
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    const sql = schemaSql.replace(
      /^PRAGMA (journal_mode|foreign_keys)[^;]*;/gm,
      "",
    );
    migrateSteps(db, { schemaSql: sql });
    alignReleaseSchema(db, sql);
    const differences = schemaDifferences(db, sql);
    if (differences.length)
      throw new Error("数据库结构不完整：" + differences.join(", "));
    if (db.prepare("PRAGMA foreign_key_check").get())
      throw new Error("数据库存在无效外键，迁移已回滚，请检查备份");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
