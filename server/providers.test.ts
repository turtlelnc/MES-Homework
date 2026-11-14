import { describe, expect, it } from "vitest";
import {
  MODEL_OUTPUT_LIMITS,
  modelOutputLimit,
  providers,
} from "./providers.mjs";

describe("per-model output limits", () => {
  it("clamps each preset to its documented output ceiling", () => {
    expect(
      modelOutputLimit(
        { provider: "anthropic", model: "claude-sonnet-4-5" },
        219136,
        {},
      ),
    ).toBe(64000);
    expect(
      modelOutputLimit({ provider: "qwen", model: "qwen-vl-max" }, 219136, {}),
    ).toBe(8192);
    expect(
      modelOutputLimit(
        { provider: "deepseek", model: "deepseek-flash" },
        219136,
        {},
      ),
    ).toBe(65536);
  });

  it("never raises above the requested value", () => {
    expect(
      modelOutputLimit({ provider: "qwen", model: "qwen-vl-max" }, 2048, {}),
    ).toBe(2048);
  });

  it("leaves custom models on the configured value instead of guessing", () => {
    expect(
      modelOutputLimit(
        { provider: "openai", model: "my-private-deployment" },
        219136,
        {},
      ),
    ).toBe(219136);
  });

  it("lets MODEL_OUTPUT_LIMITS_JSON override a preset or add a custom one", () => {
    const env = {
      MODEL_OUTPUT_LIMITS_JSON: JSON.stringify({
        "qwen/qwen-vl-max": 32768,
        "openai/my-private-deployment": 65536,
      }),
    };
    expect(
      modelOutputLimit({ provider: "qwen", model: "qwen-vl-max" }, 219136, env),
    ).toBe(32768);
    expect(
      modelOutputLimit(
        { provider: "openai", model: "my-private-deployment" },
        219136,
        env,
      ),
    ).toBe(65536);
  });

  it("ignores unparsable or invalid overrides", () => {
    expect(
      modelOutputLimit({ provider: "qwen", model: "qwen-vl-max" }, 219136, {
        MODEL_OUTPUT_LIMITS_JSON: "{not json",
      }),
    ).toBe(8192);
    expect(
      modelOutputLimit({ provider: "qwen", model: "qwen-vl-max" }, 219136, {
        MODEL_OUTPUT_LIMITS_JSON: JSON.stringify({ "qwen/qwen-vl-max": -5 }),
      }),
    ).toBe(8192);
  });

  it("covers every preset default model", () => {
    for (const [id, preset] of Object.entries(providers))
      expect(
        MODEL_OUTPUT_LIMITS[`${id}/${preset.model}`],
        `${id}/${preset.model}`,
      ).toBeGreaterThan(0);
  });
});

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
        applicationCapabilities(db, {
          ALLOW_PUBLIC_REGISTRATION: "0",
          SCHOOL_INVITE_REQUIRED: "1",
        }),
      ).toEqual({
        stages: ["小学", "高中"],
        publicRegistration: false,
        schoolInviteRequired: true,
      });
    } finally {
      db.close();
    }
  });
});
