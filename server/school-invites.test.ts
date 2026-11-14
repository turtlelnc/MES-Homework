import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import {
  bootstrapInvite,
  consumeInvite,
  generateInviteCode,
  issueInvite,
  listInvites,
  normalizeInviteCode,
  revokeInvite,
  schoolInviteRequired,
} from "./school-invites.mjs";

const root = new URL(".", import.meta.url);
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("./schema.sql", root), "utf8"));
});

afterEach(() => db.close());

describe("开通码规范化", () => {
  it("接受大小写、空格与连字符的不同写法", () => {
    expect(normalizeInviteCode("abcde-fghjk")).toBe("ABCDE-FGHJK");
    expect(normalizeInviteCode("ABCDE FGHJK")).toBe("ABCDE-FGHJK");
    expect(normalizeInviteCode("  abcdefghjk  ")).toBe("ABCDE-FGHJK");
    expect(normalizeInviteCode("A1B2C-3D4E5")).toBe("A1B2C-3D4E5");
  });

  it("长度不符或空值不做补齐", () => {
    expect(normalizeInviteCode("")).toBe("");
    expect(normalizeInviteCode(null)).toBe("");
    expect(normalizeInviteCode("ABC123")).toBe("ABC123");
  });
});

describe("开通码生成", () => {
  it("固定为 5-5 分组且只含无歧义字符", () => {
    const code = generateInviteCode(Buffer.alloc(10, 7));
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
    expect(code).not.toMatch(/[IO01]/);
  });

  it("同样字节生成同样码，不同字节不同码", () => {
    expect(generateInviteCode(Buffer.alloc(10, 1))).toBe(
      generateInviteCode(Buffer.alloc(10, 1)),
    );
    expect(generateInviteCode(Buffer.alloc(10, 1))).not.toBe(
      generateInviteCode(Buffer.alloc(10, 2)),
    );
  });
});

describe("开通码签发与核销", () => {
  it("默认要求开通码，显式设为 0 才关闭", () => {
    expect(schoolInviteRequired({})).toBe(true);
    expect(schoolInviteRequired({ SCHOOL_INVITE_REQUIRED: "0" })).toBe(false);
    expect(schoolInviteRequired({ SCHOOL_INVITE_REQUIRED: "1" })).toBe(true);
  });

  it("签发后可核销一次，并记录学校去向", () => {
    const code = issueInvite(db, { note: "海沙实验中学" });
    expect(consumeInvite(db, code, { schoolId: "school-1" })).toBe(code);
    const row = db
      .prepare("SELECT used_at,school_id FROM school_invites WHERE code=?")
      .get(code) as any;
    expect(row.used_at).toBeTruthy();
    expect(row.school_id).toBe("school-1");
    expect(() => consumeInvite(db, code, { schoolId: "school-2" })).toThrow(
      "开通码无效或已使用",
    );
  });

  it("空码、未知码、过期码、吊销码统一报错", () => {
    expect(() => consumeInvite(db, "  ", { schoolId: "s" })).toThrow(
      "请填写学校开通码",
    );
    expect(() => consumeInvite(db, "ZZZZZ-ZZZZZ", { schoolId: "s" })).toThrow(
      "开通码无效或已使用",
    );
    const expired = issueInvite(db, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(() => consumeInvite(db, expired, { schoolId: "s" })).toThrow(
      "开通码无效或已使用",
    );
    const revoked = issueInvite(db);
    expect(revokeInvite(db, revoked)).toBe(true);
    expect(() => consumeInvite(db, revoked, { schoolId: "s" })).toThrow(
      "开通码无效或已使用",
    );
    expect(revokeInvite(db, revoked)).toBe(false);
  });

  it("有效期内的过期时间被接受", () => {
    const code = issueInvite(db, {
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(consumeInvite(db, code, { schoolId: "s" })).toBe(code);
  });

  it("全新部署自动获得引导码，重启复用同一枚，建校后不再签发", () => {
    const first = bootstrapInvite(db);
    expect(first).toBeTruthy();
    // 重启（进程重新调用）时复用还没用掉的引导码，不会刷出一堆码。
    expect(bootstrapInvite(db)).toBe(first);
    expect(consumeInvite(db, first!, { schoolId: "school-1" })).toBe(first);
    // 码被用掉但学校还没建成时，会再签发一枚。
    const second = bootstrapInvite(db);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    db.prepare("INSERT INTO schools VALUES(?,?,?)").run(
      "school-1",
      "海沙实验中学",
      new Date().toISOString(),
    );
    expect(bootstrapInvite(db)).toBeNull();
    // 关闭开通码要求时不签发。
    const empty = new DatabaseSync(":memory:");
    try {
      empty.exec(fs.readFileSync(new URL("./schema.sql", root), "utf8"));
      expect(bootstrapInvite(empty, { required: false })).toBeNull();
    } finally {
      empty.close();
    }
  });

  it("列表返回备注与使用状态", () => {
    const first = issueInvite(db, { note: "甲校" });
    consumeInvite(db, first, { schoolId: "school-a" });
    issueInvite(db, { note: "乙校" });
    const rows = listInvites(db);
    expect(rows).toHaveLength(2);
    const used = rows.find((row: any) => row.code === first) as any;
    expect(used.used_at).toBeTruthy();
    expect(used.school_id).toBe("school-a");
    expect(rows.filter((row: any) => !row.used_at)).toHaveLength(1);
  });
});
