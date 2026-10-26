import { randomUUID } from "node:crypto";
const fail = (message) =>
  Object.assign(new Error(message), { status: 429, code: "MODEL_QUOTA" });
const integer = (value, fallback = 0) =>
  Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Number(value)
    : fallback;
export function costSettings() {
  let rates = {};
  try {
    rates = JSON.parse(process.env.MODEL_COST_RATES_JSON || "{}");
  } catch {
    /* enabled configurations fail closed below */
  }
  const school = integer(process.env.MODEL_SCHOOL_DAILY_MICRO_CNY);
  const user = integer(process.env.MODEL_USER_DAILY_MICRO_CNY);
  const output = integer(process.env.MODEL_MAX_OUTPUT_TOKENS, 8192);
  return {
    rates,
    school,
    user,
    output: Math.min(output || 8192, 32768),
    enabled:
      school > 0 ||
      user > 0 ||
      [
        process.env.MODEL_SCHOOL_DAILY_MICRO_CNY,
        process.env.MODEL_USER_DAILY_MICRO_CNY,
      ].some((v) => v && v !== "0"),
    ready: school > 0 && user > 0,
  };
}
export function price(tokens, rate) {
  const amount = (BigInt(tokens) * BigInt(rate) + 999999n) / 1000000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw fail("费用预留超出安全范围");
  return Number(amount);
}
export function createCostBudget(db) {
  const settings = costSettings();
  const exposure = (column, value, time) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(
    CASE WHEN status IN('reserved','dispatched','unknown') THEN reserved ELSE charged END),0) amount
    FROM model_costs WHERE ${column}=? AND (created_at>? OR status IN('reserved','dispatched','unknown'))`,
      )
      .get(value, time - 86400000).amount;
  return {
    enabled: settings.enabled,
    ready: settings.ready,
    configured(provider, model) {
      const r = settings.rates?.[`${provider}/${model}`];
      return (
        settings.ready &&
        r &&
        [r.input, r.output].every((n) => Number.isSafeInteger(n) && n > 0)
      );
    },
    summary(schoolId) {
      return {
        enabled: settings.enabled,
        schoolLimitMicroCny: settings.school,
        userLimitMicroCny: settings.user,
        exposureMicroCny: exposure("school_id", schoolId, Date.now()),
        requiresReview:
          db
            .prepare(
              "SELECT value FROM system_flags WHERE key='restored_budget_review'",
            )
            .get()?.value === "1",
        uncertain: db
          .prepare(
            "SELECT COUNT(*) n FROM model_costs WHERE school_id=? AND status IN('reserved','dispatched','unknown')",
          )
          .get(schoolId).n,
      };
    },
    reserve(userId, config, prompt, imageCount) {
      if (!settings.enabled) return null;
      if (
        db
          .prepare(
            "SELECT value FROM system_flags WHERE key='restored_budget_review'",
          )
          .get()?.value === "1"
      )
        throw fail("恢复备份后费用账本需要管理员对账确认，暂不能调用模型");
      if (!settings.ready) throw fail("必须同时配置账户和学校费用上限");
      const rates = settings.rates?.[`${config.provider}/${config.model}`];
      if (
        !rates ||
        ![rates.input, rates.output].every(
          (n) => Number.isSafeInteger(n) && n > 0,
        )
      )
        throw fail("管理员尚未配置此模型的费用上界，暂不能调用");
      // Conservative byte-level bound for text plus framing; no cache discount assumed.
      const imageTokens = rates.imageTokens;
      if (
        imageCount &&
        (!Number.isSafeInteger(imageTokens) ||
          imageTokens <= 0 ||
          imageTokens > 100000)
      )
        throw fail("管理员尚未配置此模型的单图 token 上界");
      const input =
        Buffer.byteLength(prompt, "utf8") +
        imageCount * (imageTokens || 0) +
        4096;
      if (input > 120000) throw fail("单次输入超过预算上限，请拆分作业");
      const reserved =
        price(input, rates.input) + price(settings.output, rates.output);
      const user = db
        .prepare("SELECT school_id FROM users WHERE id=?")
        .get(userId);
      if (!user) throw fail("账户不存在");
      const id = randomUUID(),
        time = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        if (
          exposure("school_id", user.school_id, time) + reserved >
            settings.school ||
          exposure("user_id", userId, time) + reserved > settings.user
        )
          throw fail("账户或学校费用预算不足，请联系管理员");
        db.prepare(
          "INSERT INTO model_costs VALUES(?,?,?,?,?,'reserved',?,0,?,?,?,?,?,?)",
        ).run(
          id,
          userId,
          user.school_id,
          config.provider,
          config.model,
          reserved,
          input,
          settings.output,
          rates.input,
          rates.output,
          time,
          time,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      let sent = false,
        done = false;
      return {
        maxTokens: settings.output,
        dispatch() {
          if (done || sent) throw new Error("费用预留不能重复发送");
          db.prepare(
            "UPDATE model_costs SET status='dispatched',updated_at=? WHERE id=?",
          ).run(Date.now(), id);
          sent = true;
        },
        settle(usage) {
          if (done) return;
          const a = usage?.prompt_tokens,
            b = usage?.completion_tokens;
          if (
            !sent ||
            ![a, b].every((n) => Number.isSafeInteger(n) && n >= 0) ||
            a + b > 2_000_000
          )
            return;
          const charged = price(a, rates.input) + price(b, rates.output);
          db.prepare(
            "INSERT OR REPLACE INTO model_cost_receipts VALUES(?,?,?,?)",
          ).run(id, a, b, Date.now());
          db.prepare(
            "UPDATE model_costs SET status='settled',charged=?,updated_at=? WHERE id=?",
          ).run(charged, Date.now(), id);
          done = true;
        },
        close() {
          if (done) return;
          // A crash or unknown outcome must never refund a potentially billed request.
          db.prepare(
            "UPDATE model_costs SET status=?,charged=?,updated_at=? WHERE id=?",
          ).run(
            sent ? "unknown" : "cancelled",
            sent ? reserved : 0,
            Date.now(),
            id,
          );
          done = true;
        },
      };
    },
  };
}
