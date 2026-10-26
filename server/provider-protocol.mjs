// API Key protocols only. OAuth Responses/SSE adapters remain independent.
export function providerRequest(config, content, key, maxTokens) {
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
    return { text: raw.choices?.[0]?.message?.content, usage: raw.usage };
  return {
    text: raw.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
    usage: raw.usage
      ? {
          prompt_tokens: raw.usage.input_tokens,
          completion_tokens: raw.usage.output_tokens,
        }
      : undefined,
  };
}
