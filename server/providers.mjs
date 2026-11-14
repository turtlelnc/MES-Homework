export const providers = {
  deepseek: {
    name: "DeepSeek V4.1 Flash",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-flash",
    vision: true,
  },
  openai: {
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4.1-mini",
    vision: true,
  },
  qwen: {
    name: "通义千问",
    endpoint:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: "qwen-vl-max",
    vision: true,
  },
  doubao: {
    name: "豆包",
    endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    model: "doubao-1.5-vision-pro-32k",
    vision: true,
  },
  zhipu: {
    name: "智谱 GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: "glm-4.5v",
    vision: true,
  },
  moonshot: {
    name: "Kimi",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    model: "moonshot-v1-128k-vision-preview",
    vision: true,
  },
  siliconflow: {
    name: "硅基流动",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    vision: true,
  },
  minimax: {
    name: "MiniMax",
    endpoint: "https://api.minimax.chat/v1/text/chatcompletion_v2",
    model: "MiniMax-Text-01",
    vision: false,
  },
  gemini: {
    name: "Google Gemini",
    endpoint:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.5-flash",
    vision: true,
  },
  anthropic: {
    name: "Anthropic Claude",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-5",
    vision: true,
  },
};
// 每个预设默认模型能接受的输出 token 上限（按供应商文档取的保守上界）。
// 超过该值的 max_tokens 会被上游拒绝，因此请求与费用预留都要按它收敛；
// 自定义模型不在表内，沿用 MODEL_MAX_OUTPUT_TOKENS，不做猜测。
export const MODEL_OUTPUT_LIMITS = {
  "deepseek/deepseek-flash": 65536,
  "openai/gpt-4.1-mini": 32768,
  "qwen/qwen-vl-max": 8192,
  "doubao/doubao-1.5-vision-pro-32k": 4096,
  "zhipu/glm-4.5v": 16384,
  "moonshot/moonshot-v1-128k-vision-preview": 8192,
  "siliconflow/Qwen/Qwen2.5-VL-72B-Instruct": 8192,
  "minimax/MiniMax-Text-01": 8192,
  "gemini/gemini-2.5-flash": 65536,
  "anthropic/claude-sonnet-4-5": 64000,
};

/** 把请求值收敛到该模型支持的输出上限；MODEL_OUTPUT_LIMITS_JSON 可按模型覆盖。 */
export function modelOutputLimit(
  { provider, model } = {},
  requested,
  env = process.env,
) {
  let overrides = {};
  try {
    overrides = JSON.parse(env.MODEL_OUTPUT_LIMITS_JSON || "{}") || {};
  } catch {
    /* 配置损坏时退回预设表，不放大请求 */
  }
  const key = `${provider}/${model}`;
  const override = overrides[key];
  const configured =
    Number.isSafeInteger(override) && override > 0
      ? override
      : MODEL_OUTPUT_LIMITS[key];
  const limit =
    Number.isSafeInteger(configured) && configured > 0 ? configured : null;
  return limit ? Math.min(requested, limit) : requested;
}

export const publicProviders = () =>
  Object.entries(providers).map(([id, p]) => ({ id, ...p }));
