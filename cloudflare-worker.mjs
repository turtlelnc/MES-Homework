export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/uploads/")
    ) {
      if (!env.ORIGIN_URL || env.ORIGIN_URL.includes("请替换"))
        return Response.json(
          { error: "Cloudflare Worker 尚未配置 ORIGIN_URL" },
          { status: 503 },
        );
      const target = new URL(url.pathname + url.search, env.ORIGIN_URL);
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-proto", "https");
      return fetch(target, new Request(request, { headers }));
    }
    return env.ASSETS.fetch(request);
  },
};
