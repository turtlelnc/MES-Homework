import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModelBudget } from "./model-budget.mjs";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
);
describe("model reservations across SQLite connections", () => {
  it("allows concurrent staff calls across connections but retains the global, school and student limits", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parallel-budget-"));
    dirs.push(dir);
    const one = new DatabaseSync(path.join(dir, "db"));
    one.exec(
      "CREATE TABLE users(id TEXT,school_id TEXT,role TEXT); INSERT INTO users VALUES('t','s','teacher'),('v','s','teacher'),('x','other','student'); CREATE TABLE model_usage(id TEXT PRIMARY KEY,user_id TEXT,school_id TEXT,created_at INTEGER,finished_at INTEGER,lease_until INTEGER)",
    );
    const two = new DatabaseSync(path.join(dir, "db"));
    try {
      const reserve = createModelBudget(one),
        other = createModelBudget(two);
      const active = [reserve("t"), other("t"), reserve("t"), other("t")];
      expect(() => reserve("t")).toThrow(/正在进行/);
      expect(() => other("v")).toThrow(/正在进行/);
      expect(() => other("x")).toThrow(/正在进行/);
      active.pop()!();
      const student = other("x");
      expect(() => reserve("x")).toThrow(/正在进行/);
      student();
      active.forEach((release) => release());
      other("v")();
    } finally {
      two.close();
      one.close();
    }
  });
  it("shares active leases, persists usage and refuses expired lease renewal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-"));
    dirs.push(dir);
    const filename = path.join(dir, "db.sqlite");
    const one = new DatabaseSync(filename);
    one.exec(
      "CREATE TABLE users(id TEXT,school_id TEXT,role TEXT); INSERT INTO users VALUES('u','s','student'),('v','other','student'); CREATE TABLE model_usage(id TEXT PRIMARY KEY,user_id TEXT,school_id TEXT,created_at INTEGER,finished_at INTEGER,lease_until INTEGER)",
    );
    const two = new DatabaseSync(filename);
    try {
      const reserve = createModelBudget(one),
        other = createModelBudget(two);
      const release = reserve("u");
      expect(() => other("u")).toThrow(/正在进行/);
      const independent = other("v");
      independent();
      one
        .prepare("UPDATE model_usage SET lease_until=? WHERE user_id='u'")
        .run(Date.now() - 1);
      expect(() => release.renew()).toThrow(/过期/);
      const replacement = other("u");
      release();
      release();
      expect(() => reserve("u")).toThrow(/正在进行/);
      replacement();
      expect(
        one
          .prepare("SELECT COUNT(*) n FROM model_usage WHERE user_id='u'")
          .get()!.n,
      ).toBe(2);
    } finally {
      two.close();
      one.close();
    }
    const reopened = new DatabaseSync(filename);
    try {
      expect(
        reopened
          .prepare("SELECT COUNT(*) n FROM model_usage WHERE user_id='u'")
          .get()!.n,
      ).toBe(2);
    } finally {
      reopened.close();
    }
  });
});

it("limits total active model calls across independent schools", () => {
  const db = new DatabaseSync(":memory:");
  const previous = process.env.MODEL_GLOBAL_CONCURRENCY;
  process.env.MODEL_GLOBAL_CONCURRENCY = "1";
  try {
    db.exec(
      "CREATE TABLE users(id TEXT,school_id TEXT,role TEXT); INSERT INTO users VALUES('a','one','teacher'),('b','two','teacher'); CREATE TABLE model_usage(id TEXT PRIMARY KEY,user_id TEXT,school_id TEXT,created_at INTEGER,finished_at INTEGER,lease_until INTEGER)",
    );
    const reserve = createModelBudget(db);
    const release = reserve("a");
    expect(() => reserve("b")).toThrow(/正在进行/);
    release();
    reserve("b")();
  } finally {
    if (previous === undefined) delete process.env.MODEL_GLOBAL_CONCURRENCY;
    else process.env.MODEL_GLOBAL_CONCURRENCY = previous;
    db.close();
  }
});
