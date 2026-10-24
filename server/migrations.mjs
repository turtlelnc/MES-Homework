// v0.2.1-rc1 schema migrations.
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
  return `user_${String(id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "account"}`;
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
      .prepare("SELECT LOWER(username) name FROM users WHERE username IS NOT NULL")
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
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
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
  db.exec("BEGIN IMMEDIATE");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      db.exec(USERS_V021);
      db.exec(
        `INSERT INTO users_v021(${target.join(",")}) SELECT ${select.join(",")} FROM users`,
      );
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_v021 RENAME TO users");
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
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      db.exec(MISTAKES_V021);
      db.exec(
        `INSERT INTO mistakes_v021(${target.join(",")}) SELECT ${select.join(",")} FROM mistakes`,
      );
      db.exec("DROP TABLE mistakes");
      db.exec("ALTER TABLE mistakes_v021 RENAME TO mistakes");
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}

/**
 * Apply every v0.2.1 schema change to `db`, then create any tables/indexes the
 * running release expects. Call once at startup, before routes are registered.
 */
export function migrateDatabase(db, { schemaSql }) {
  const existing = tableNames(db);
  if (existing.has("users")) {
    const columns = tableColumns(db, "users");
    const sql = tableSql(db, "users");
    if (!columns.has("username") || !sql.includes("'parent'")) rebuildUsers(db);
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
    ensureColumn(db, "mistakes", "reasoning", "TEXT NOT NULL DEFAULT ''", mistakeColumns);
    ensureColumn(db, "mistakes", "guidance_json", "TEXT", mistakeColumns);
    ensureColumn(db, "mistakes", "question_number", "INTEGER", mistakeColumns);
    ensureColumn(db, "mistakes", "prompt", "TEXT NOT NULL DEFAULT ''", mistakeColumns);
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
