// API Key protocols only. OAuth Responses/SSE adapters remain independent.
// Classify bounded diagnostics, but never reflect upstream text: it may contain
// credentials, submitted homework, or HTML from a proxy.
export function providerHttpError(status, raw) {
  const error = raw?.error;
  const diagnostic = [error?.code, error?.type, error?.message]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  let hint = "请检查接口地址及模型配置";
  if (status === 401) hint = "API Key 无效或已失效，请在设置中重新保存";
  else if (
    status === 402 ||
    /insufficient[_ ](?:balance|quota)|balance.*insufficient/.test(diagnostic)
  )
    hint = "模型账户余额或额度不足，请到供应商控制台检查";
  else if (status === 403) hint = "模型账户无访问权限，请检查供应商账户状态";
  else if (
    /model.*(?:not.*(?:exist|found)|invalid|unsupported)|model_not_found/.test(
      diagnostic,
    )
  )
    hint = "模型名称不存在或不可用，请检查设置中的模型名称";
  else if (/context.*(?:length|limit)|too many tokens/.test(diagnostic))
    hint = "输入超过模型上下文上限，请减少页数或内容";
  else if (status === 404)
    hint = "接口路径或模型不存在，请检查完整接口地址和模型名称";
  else if (status === 429) hint = "供应商限流或并发已满，请稍后重试";
  else if (status >= 500) hint = "供应商暂时不可用，请稍后重试";
  return Object.assign(new Error(`模型接口请求失败 (${status})：${hint}`), {
    code: "PROVIDER_HTTP_ERROR",
    retryable: status === 429 || status >= 500,
  });
}

export function assertProviderCompletion(config, raw) {
  const reason =
    config.provider === "anthropic"
      ? raw?.stop_reason
      : raw?.choices?.[0]?.finish_reason;
  if (reason === "length" || reason === "max_tokens")
    throw Object.assign(
      new Error(
        "模型输出达到 token 上限，结果被截断；请减少本次题目或页数，或由管理员调整输出预算",
      ),
      { code: "MODEL_OUTPUT_TRUNCATED" },
    );
  if (reason === "content_filter" || reason === "refusal")
    throw Object.assign(
      new Error("模型供应商拒绝生成该内容，请检查输入或更换模型"),
      { code: "MODEL_CONTENT_FILTERED" },
    );
}

export function modelResponseLimits(env = process.env) {
  const positive = (name, fallback) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  const timeoutMs = Math.min(
    positive("MODEL_REQUEST_TIMEOUT_MS", 60000),
    120000,
  );
  return {
    timeoutMs,
    // Non-streaming providers can send headers before generating any JSON.
    // Waiting for that body is not a stalled upload. Keep the total deadline.
    idleMs: Math.min(positive("MODEL_RESPONSE_IDLE_MS", timeoutMs), timeoutMs),
    maxBytes: Math.min(
      positive("MODEL_RESPONSE_MAX_BYTES", 2 * 1024 * 1024),
      8 * 1024 * 1024,
    ),
    errorMaxBytes: 16384,
  };
}

export function providerRequest(config, content, key, maxTokens) {
  key = key.trim();
  if (config.provider !== "anthropic")
    return {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: {
        model: config.model,
        response_format: { type: "json_object" },
        temperature: 0,
        stream: false,
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
      },
    };
  const blocks = (
    Array.isArray(content) ? content : [{ type: "text", text: content }]
  ).map((block) => {
    if (block.type !== "image_url") return block;
    const match = block.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) throw new Error("Anthropic 图片必须为内联图片");
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  });
  return {
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: config.model,
      max_tokens: maxTokens,
      temperature: 0,
      stream: false,
      messages: [{ role: "user", content: blocks }],
    },
  };
}
export function providerReply(config, raw) {
  if (config.provider !== "anthropic")
    return { text: raw?.choices?.[0]?.message?.content, usage: raw?.usage };
  return {
    text: raw?.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
    usage: raw?.usage
      ? {
          prompt_tokens: raw.usage.input_tokens,
          completion_tokens: raw.usage.output_tokens,
        }
      : undefined,
  };
}
