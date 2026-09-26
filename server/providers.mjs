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
    vision: false,
  },
};
export const publicProviders = () =>
  Object.entries(providers).map(([id, p]) => ({ id, ...p }));
