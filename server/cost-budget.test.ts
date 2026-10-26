import { it, expect, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { createCostBudget } from "./cost-budget.mjs";
import { seedTeachingFixture } from "./analysis.fixture.mjs";
afterEach(() => vi.unstubAllEnvs());
const setup = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const f = seedTeachingFixture(db);
  vi.stubEnv("MODEL_SCHOOL_DAILY_MICRO_CNY", "2000000");
  vi.stubEnv("MODEL_USER_DAILY_MICRO_CNY", "1000000");
  vi.stubEnv(
    "MODEL_COST_RATES_JSON",
    JSON.stringify({
      "deepseek/deepseek-flash": {
        input: 1000000,
        output: 2000000,
        imageTokens: 1024,
      },
    }),
  );
  return {
    db,
    f,
    cost: createCostBudget(db),
    config: { provider: "deepseek", model: "deepseek-flash" },
  };
};
it("reserves before dispatch, reconciles usage, and charges retries independently", () => {
  const { db, f, cost, config } = setup();
  try {
    const one = cost.reserve(f.teacherId, config, "test", 2)!;
    expect(cost.summary(f.schoolId).exposureMicroCny).toBeGreaterThan(0);
    one.dispatch();
    one.settle({ prompt_tokens: 2000, completion_tokens: 100 });
    one.close();
    expect(cost.summary(f.schoolId).exposureMicroCny).toBe(2200);
    const two = cost.reserve(f.teacherId, config, "test", 2)!;
    two.dispatch();
    two.close();
    expect(cost.summary(f.schoolId).exposureMicroCny).toBeGreaterThan(2200);
    expect(cost.summary(f.schoolId).uncertain).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM model_costs").get()!.n).toBe(2);
  } finally {
    db.close();
  }
});
it("does not invent DeepSeek image token limits from a model name", () => {
  const { db, f, config } = setup();
  try {
    vi.stubEnv(
      "MODEL_COST_RATES_JSON",
      JSON.stringify({
        "deepseek/deepseek-flash": { input: 1000000, output: 2000000 },
      }),
    );
    const budget = createCostBudget(db);
    expect(() => budget.reserve(f.teacherId, config, "prompt", 1)).toThrow(
      /单图 token 上界/,
    );
    expect(db.prepare("SELECT COUNT(*) n FROM model_costs").get()!.n).toBe(0);
  } finally {
    db.close();
  }
});
it("keeps unknown and crashed reservations and releases only requests never sent", () => {
  const { db, f, cost, config } = setup();
  try {
    const cancelled = cost.reserve(f.teacherId, config, "test", 1)!;
    cancelled.close();
    expect(cost.summary(f.schoolId).exposureMicroCny).toBe(0);
    cost.reserve(f.teacherId, config, "test", 1); // simulated process death before dispatch
    const recovered = createCostBudget(db);
    expect(recovered.summary(f.schoolId).exposureMicroCny).toBeGreaterThan(0);
    const unknown = recovered.reserve(f.teacherId, config, "test", 1)!;
    unknown.dispatch();
    unknown.settle({});
    unknown.close();
    expect(recovered.summary(f.schoolId).uncertain).toBe(2);
  } finally {
    db.close();
  }
});
it("refuses insufficient budget and incomplete/unknown pricing configurations", () => {
  const { db, f, config } = setup();
  try {
    vi.stubEnv("MODEL_USER_DAILY_MICRO_CNY", "1");
    expect(() =>
      createCostBudget(db).reserve(f.teacherId, config, "test", 1),
    ).toThrow(/预算不足/);
    expect(db.prepare("SELECT COUNT(*) n FROM model_costs").get()!.n).toBe(0);
    vi.stubEnv("MODEL_USER_DAILY_MICRO_CNY", "0");
    expect(() =>
      createCostBudget(db).reserve(f.teacherId, config, "test", 1),
    ).toThrow(/同时配置/);
    vi.stubEnv("MODEL_USER_DAILY_MICRO_CNY", "1000000");
    expect(() =>
      createCostBudget(db).reserve(
        f.teacherId,
        { provider: "other", model: "x" },
        "test",
        1,
      ),
    ).toThrow(/费用上界/);
  } finally {
    db.close();
  }
});

it("audits manual reconciliation and refuses to refund a live reservation", async () => {
  const { reconcileCost } = await import("../tools/ops/reconcile-cost.mjs");
  const { db, f, cost, config } = setup();
  try {
    const hold = cost.reserve(f.teacherId, config, "test", 1)!;
    hold.dispatch();
    hold.close();
    const row = db
      .prepare("SELECT * FROM model_costs ORDER BY rowid DESC LIMIT 1")
      .get()!;
    expect(() =>
      reconcileCost(db, row.id, 0, 0, "provider confirmed no charge"),
    ).toThrow(/15 分钟/);
    db.prepare("UPDATE model_costs SET updated_at=? WHERE id=?").run(
      Date.now() - 1000000,
      row.id,
    );
    expect(
      reconcileCost(db, row.id, 10, 20, "confirmed synthetic receipt"),
    ).toEqual({ chargedMicroCny: 50 });
    expect(
      db.prepare("SELECT COUNT(*) n FROM model_cost_reconciliations").get()!.n,
    ).toBe(1);
    expect(cost.summary(f.schoolId).uncertain).toBe(0);
    expect(() => reconcileCost(db, row.id, 0, 0, "second edit")).toThrow(
      /已结算/,
    );
  } finally {
    db.close();
  }
});

it("pauses restored budgets until explicit audited acknowledgement without refunding holds", async () => {
  const { acknowledgeRestoredBudget } =
    await import("../tools/ops/reconcile-cost.mjs");
  const { db, f, cost, config } = setup();
  try {
    const hold = cost.reserve(f.teacherId, config, "test", 1)!;
    hold.dispatch();
    hold.close();
    const exposure = cost.summary(f.schoolId).exposureMicroCny;
    db.exec("INSERT INTO system_flags VALUES('restored_budget_review','1')");
    expect(() => cost.reserve(f.teacherId, config, "test", 1)).toThrow(
      /恢复备份/,
    );
    acknowledgeRestoredBudget(db, "synthetic provider billing checked");
    expect(cost.summary(f.schoolId).exposureMicroCny).toBe(exposure);
    cost.reserve(f.teacherId, config, "test", 1)!.close();
  } finally {
    db.close();
  }
});
