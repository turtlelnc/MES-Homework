import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
// @ts-expect-error server JavaScript module
import { matchStudent } from "../shared/student-match.mjs";
describe("student matching boundaries", () => {
  it("requires one exact name in the assignment school and class, and rejects ambiguity", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE users(id TEXT, name TEXT, school_id TEXT,role TEXT,stage TEXT,class_name TEXT)",
    );
    const add = db.prepare("INSERT INTO users VALUES(?,?,?,?,?,?)");
    add.run("a", "林一", "school", "student", "初中", "七年级1班");
    add.run("other", "林一", "another", "student", "初中", "七年级1班");
    add.run("other-class", "林一", "school", "student", "初中", "七年级2班");
    const assignment = {
      school_id: "school",
      stage: "初中",
      class_name: "七年级1班",
    };
    expect(matchStudent(db, assignment, " 林一 ")).toEqual({
      id: "a",
      name: "林一",
    });
    expect(matchStudent(db, assignment, "林")).toBe(null);
    add.run("duplicate", "林一", "school", "student", "初中", "七年级1班");
    expect(matchStudent(db, assignment, "林一")).toBe(null);
    db.close();
  });
});
