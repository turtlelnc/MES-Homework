import { describe, expect, it } from "vitest";
import { providers } from "./providers.mjs";

describe("rc4 provider presets", () => {
  it("ships ten configurable vendors", () => {
    expect(Object.keys(providers)).toHaveLength(10);
    expect(providers.deepseek.vision).toBe(true);
    expect(providers.qwen.vision).toBe(true);
    expect(providers.minimax.vision).toBe(false);
  });

  it("serves registration stages from the actual database constraint", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { applicationCapabilities } = await import("./capabilities.mjs");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE users(stage TEXT CHECK(stage IN('小学','高中')))");
      expect(
        applicationCapabilities(db, { ALLOW_PUBLIC_REGISTRATION: "0" }),
      ).toEqual({ stages: ["小学", "高中"], publicRegistration: false });
    } finally {
      db.close();
    }
  });
});
