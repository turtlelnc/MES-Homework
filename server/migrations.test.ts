import os from "node:os";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const schemaSql = fs.readFileSync(path.join(root, "server/schema.sql"), "utf8");
it("rolls back the complete upgrade on a malformed schema and restores foreign-key enforcement", async () => {
  const { migrateDatabase, schemaDifferences } =
    await import("./migrations.mjs");
  const db = legacyDatabase();
  try {
    const before = JSON.stringify(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    );
    expect(() =>
      migrateDatabase(db, { schemaSql: schemaSql + "\nTHIS IS NOT SQL;" }),
    ).toThrow();
    expect(
      JSON.stringify(
        db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      ),
    ).toBe(before);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
    migrateDatabase(db, { schemaSql });
    expect(schemaDifferences(db, schemaSql)).toEqual([]);
    db.exec("DROP INDEX idx_users_school");
    expect(schemaDifferences(db, schemaSql)).toContain(
      "index:idx_users_school",
    );
    migrateDatabase(db, { schemaSql });
    expect(schemaDifferences(db, schemaSql)).toEqual([]);
  } finally {
    db.close();
  }
});

it("does not silently discard deployment-specific checks while aligning a release table", async () => {
  const { migrateDatabase } = await import("./migrations.mjs");
  const db = new DatabaseSync(":memory:");
  const customized = schemaSql.replace(
    "score REAL NOT NULL DEFAULT 0,FOREIGN KEY(assignment_id) REFERENCES assignments(id) ON DELETE CASCADE",
    "score REAL NOT NULL DEFAULT 0 CHECK(score >= 0 AND length(prompt) > 0)",
  );
  try {
    db.exec(customized);
    expect(() => migrateDatabase(db, { schemaSql })).toThrow("未识别 CHECK");
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name='questions'").get()!
        .sql,
    ).toContain("length(prompt)");
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
  } finally {
    db.close();
  }
});

it("preserves custom indexes and triggers across legacy user rebuilding", async () => {
  const { migrateDatabase } = await import("./migrations.mjs");
  const db = legacyDatabase();
  try {
    db.exec(
      "CREATE INDEX deployment_user_name ON users(name); CREATE TRIGGER deployment_user_trigger AFTER UPDATE OF name ON users BEGIN SELECT 1; END",
    );
    migrateDatabase(db, { schemaSql });
    expect(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name IN ('deployment_user_name','deployment_user_trigger')",
        )
        .get()!.n,
    ).toBe(2);
  } finally {
    db.close();
  }
});
it("rolls back legacy rebuilding rather than dropping unknown user columns", async () => {
  const { migrateDatabase } = await import("./migrations.mjs");
  const db = legacyDatabase();
  try {
    db.exec(
      "ALTER TABLE users ADD COLUMN deployment_note TEXT DEFAULT 'retained'",
    );
    expect(() => migrateDatabase(db, { schemaSql })).toThrow("未识别字段");
    expect(
      db.prepare("SELECT deployment_note FROM users LIMIT 1").get()!
        .deployment_note,
    ).toBe("retained");
  } finally {
    db.close();
  }
});

it("restores foreign keys even when the upgrade cannot acquire its initial write lock", async () => {
  const { migrateDatabase } = await import("./migrations.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mes-migration-lock-"));
  const file = path.join(dir, "data.sqlite");
  const writer = new DatabaseSync(file),
    reader = new DatabaseSync(file);
  try {
    writer.exec(schemaSql);
    reader.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
    writer.exec("BEGIN IMMEDIATE");
    expect(() => migrateDatabase(reader, { schemaSql })).toThrow();
    expect(reader.isTransaction).toBe(false);
    expect(reader.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
  } finally {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    reader.close();
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// v0.2.0 的旧库结构（用户/错题表与当前版本不兼容，必须原地升级）。
const legacySchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE schools(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE users(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('teacher','student')),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,salt TEXT NOT NULL,stage TEXT CHECK(stage IN('小学','初中','高中')),subject TEXT,class_name TEXT,created_at TEXT NOT NULL,is_school_admin INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(school_id) REFERENCES schools(id));
CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE provider_settings(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,encrypted_key TEXT NOT NULL,iv TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE knowledge(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,stage TEXT NOT NULL,subject TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE assignments(id TEXT PRIMARY KEY,school_id TEXT NOT NULL,teacher_id TEXT NOT NULL,title TEXT NOT NULL,stage TEXT NOT NULL,subject TEXT NOT NULL,class_name TEXT NOT NULL,due_at TEXT,status TEXT NOT NULL DEFAULT 'published',created_at TEXT NOT NULL);
CREATE TABLE questions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,number INTEGER NOT NULL,prompt TEXT NOT NULL,standard_answer TEXT NOT NULL,knowledge_id TEXT,score REAL NOT NULL DEFAULT 0);
CREATE TABLE submissions(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,student_id TEXT,student_name TEXT NOT NULL,file_path TEXT NOT NULL,file_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'uploaded',ocr_text TEXT,analysis_json TEXT,teacher_reviewed INTEGER NOT NULL DEFAULT 0,score REAL,created_at TEXT NOT NULL);
CREATE TABLE mistakes(id TEXT PRIMARY KEY,submission_id TEXT NOT NULL,student_id TEXT,question_id TEXT NOT NULL,knowledge_id TEXT,reason TEXT NOT NULL,student_answer TEXT NOT NULL,correction TEXT NOT NULL,created_at TEXT NOT NULL,explanation TEXT NOT NULL DEFAULT '',practice_json TEXT,mastery INTEGER NOT NULL DEFAULT 0);
CREATE TABLE teaching_analyses(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN('class','student')),student_id TEXT,school_id TEXT NOT NULL,created_by TEXT NOT NULL,model TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,stats_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
`;

function legacyDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  const time = new Date().toISOString();
  db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
    "school-1",
    "老学校",
    time,
  );
  const insertUser = db.prepare(
    "INSERT INTO users(id,school_id,role,name,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insertUser.run(
    "u-admin",
    "school-1",
    "teacher",
    "校长",
    "admin@old.test",
    "hash",
    "salt",
    null,
    null,
    null,
    time,
    1,
  );
  insertUser.run(
    "u-teacher",
    "school-1",
    "teacher",
    "王老师",
    "wang@old.test",
    "hash",
    "salt",
    "初中",
    "物理",
    "八年级（1）班",
    time,
    0,
  );
  insertUser.run(
    "u-student",
    "school-1",
    "student",
    "林一",
    "lin@old.test",
    "hash",
    "salt",
    "初中",
    null,
    "八年级（1）班",
    time,
    0,
  );
  // Two accounts share the same email local part -> derived usernames must not collide.
  insertUser.run(
    "u-student-dup",
    "school-1",
    "student",
    "林二",
    "lin@other.test",
    "hash",
    "salt",
    "初中",
    null,
    "八年级（1）班",
    time,
    0,
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
    "session-1",
    "u-admin",
    time,
  );
  db.prepare(
    "INSERT INTO assignments(id,school_id,teacher_id,title,stage,subject,class_name,due_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "a-1",
    "school-1",
    "u-teacher",
    "老作业",
    "初中",
    "物理",
    "八年级（1）班",
    null,
    "published",
    time,
  );
  db.prepare("INSERT INTO questions VALUES(?,?,?,?,?,?,?)").run(
    "q-1",
    "a-1",
    1,
    "旧题干",
    "旧答案",
    null,
    10,
  );
  db.prepare(
    "INSERT INTO submissions(id,assignment_id,student_id,student_name,file_path,file_type,status,ocr_text,analysis_json,teacher_reviewed,score,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "s-1",
    "a-1",
    "u-student",
    "林一",
    "/tmp/old.jpg",
    "image/jpeg",
    "completed",
    "旧 OCR",
    JSON.stringify({ items: [] }),
    1,
    6,
    time,
  );
  db.prepare("INSERT INTO mistakes VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "m-1",
    "s-1",
    "u-student",
    "q-1",
    null,
    "计算粗心",
    "5",
    "6",
    time,
    "分步解析",
    JSON.stringify([{ prompt: "同类题", answer: "6" }]),
    0,
  );
  return db;
}

describe("v0.2.1 schema migrations", () => {
  it("upgrades a v0.2.0 database without losing accounts, sessions or mistakes", async () => {
    const { migrateDatabase } = await import("./migrations.mjs");
    const db = legacyDatabase();
    migrateDatabase(db, { schemaSql });

    const users = db.prepare("SELECT * FROM users ORDER BY id").all();
    expect(users).toHaveLength(4);
    expect(users.every((user) => typeof user.username === "string")).toBe(true);
    expect(new Set(users.map((user) => user.username)).size).toBe(4);
    expect(users.every((user) => user.review_mode === "all")).toBe(true);
    expect(users.every((user) => user.model_auth_mode === "api_key")).toBe(
      true,
    );
    // legacy emails still work for login and are preserved
    expect(users.find((user) => user.id === "u-teacher").email).toBe(
      "wang@old.test",
    );
    // sessions survive the table rebuild
    expect(db.prepare("SELECT COUNT(*) n FROM sessions").get().n).toBe(1);
    // parent role is accepted by the rebuilt CHECK constraint
    db.prepare(
      "INSERT INTO users(id,school_id,role,name,username,email,password_hash,salt,stage,subject,class_name,created_at,is_school_admin) VALUES(?,?,?,?,?,NULL,?,?,?,?,?,?,0)",
    ).run(
      "u-parent",
      "school-1",
      "parent",
      "林家长",
      "linparent",
      "hash",
      "salt",
      null,
      null,
      null,
      new Date().toISOString(),
    );

    const mistake = db.prepare("SELECT * FROM mistakes WHERE id='m-1'").get();
    expect(mistake.question_id).toBe("q-1");
    expect(mistake.prompt).toBe("旧题干");
    expect(mistake.standard_answer).toBe("旧答案");
    expect(mistake.question_score).toBe(10);
    expect(mistake.reasoning).toBe("");
    // direct-grading mistakes need a nullable question_id
    db.prepare(
      "INSERT INTO mistakes(id,submission_id,student_id,question_id,knowledge_id,reason,student_answer,correction,created_at) VALUES(?,?,?,NULL,NULL,?,?,?,?)",
    ).run(
      "m-direct",
      "s-1",
      "u-student",
      "粗心",
      "8",
      "7",
      new Date().toISOString(),
    );

    const assignment = db
      .prepare("SELECT * FROM assignments WHERE id='a-1'")
      .get();
    expect(assignment.description).toBe("");
    expect(assignment.grading_mode).toBe("bank");
    expect(
      db
        .prepare("PRAGMA table_info(submissions)")
        .all()
        .some((column) => column.name === "questions_json"),
    ).toBe(true);
    for (const table of [
      "school_settings",
      "class_teachers",
      "parent_students",
      "student_insights",
      "oauth_connections",
      "oauth_states",
      "mistake_progress",
    ])
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table),
        table,
      ).toBeTruthy();
    db.close();
  });

  it("is a no-op on a database created from the current schema", async () => {
    const { migrateDatabase } = await import("./migrations.mjs");
    const db = new DatabaseSync(":memory:");
    migrateDatabase(db, { schemaSql });
    const before = JSON.stringify(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    );
    migrateDatabase(db, { schemaSql });
    const after = JSON.stringify(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    );
    expect(after).toBe(before);
    db.close();
  });
});

// v0.2.1-rc4 给 oauth_connections 增加 meta_json；旧库必须原地 ALTER 且保留行。
const RC3_OAUTH_CONNECTIONS = `
CREATE TABLE oauth_connections(
  id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,
  account_label TEXT NOT NULL DEFAULT '',encrypted_access TEXT NOT NULL,
  encrypted_refresh TEXT,iv TEXT NOT NULL,token_type TEXT NOT NULL DEFAULT 'Bearer',
  scope TEXT NOT NULL DEFAULT '',expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,UNIQUE(user_id,provider)
);`;

function rc3OauthDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(legacySchema);
  db.exec(RC3_OAUTH_CONNECTIONS);
  const time = new Date().toISOString();
  db.prepare(
    "INSERT INTO oauth_connections(id,user_id,provider,account_label,encrypted_access,encrypted_refresh,iv,token_type,scope,expires_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "conn-1",
    "u-teacher",
    "deepseek",
    "旧账号",
    "cipher-access",
    "cipher-body.cipher-iv",
    "iv-value",
    "Bearer",
    "openid",
    123,
    "active",
    time,
    time,
  );
  return db;
}

describe("v0.2.1-rc4 oauth meta_json migration", () => {
  it("adds meta_json to an existing oauth_connections table without losing rows", async () => {
    const { migrateDatabase, tableColumns } = await import("./migrations.mjs");
    const db = rc3OauthDatabase();
    migrateDatabase(db, { schemaSql });

    const columns = tableColumns(db, "oauth_connections");
    expect(columns.has("meta_json")).toBe(true);
    expect(columns.get("meta_json")?.notnull).toBe(1);
    expect(columns.get("meta_json")?.dflt_value).toBe("'{}'");
    const row = db
      .prepare("SELECT * FROM oauth_connections WHERE id='conn-1'")
      .get();
    expect(row.provider).toBe("deepseek");
    expect(row.encrypted_access).toBe("cipher-access");
    expect(row.encrypted_refresh).toBe("cipher-body.cipher-iv");
    expect(row.meta_json).toBe("{}");
    db.close();
  });

  it("is idempotent when the connection table already has meta_json", async () => {
    const { migrateDatabase } = await import("./migrations.mjs");
    const db = rc3OauthDatabase();
    migrateDatabase(db, { schemaSql });
    const before = JSON.stringify(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    );
    migrateDatabase(db, { schemaSql });
    const after = JSON.stringify(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    );
    expect(after).toBe(before);
    db.close();
  });
});
