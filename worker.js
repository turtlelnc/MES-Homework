const PROXY_PREFIXES = ["/api", "/uploads"];

function isProxyPath(pathname) {
  return PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/"),
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function parseOrigin(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ORIGIN_URL is not configured");
  }

  let origin;
  try {
    origin = new URL(value.trim());
  } catch {
    throw new Error("ORIGIN_URL must be an absolute URL");
  }

  if (origin.protocol !== "https:") {
    throw new Error("ORIGIN_URL must use HTTPS");
  }
  if (origin.username || origin.password || origin.search || origin.hash) {
    throw new Error("ORIGIN_URL cannot contain credentials, query, or fragment");
  }

  origin.pathname = origin.pathname.replace(/\/+$/, "");
  return origin;
}

function addSecurityHeaders(response, html = false) {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("x-frame-options", "DENY");

  if (html) {
    headers.set("cache-control", "no-cache");
    headers.set(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function proxyToOrigin(request, incomingUrl, env) {
  let origin;
  try {
    origin = parseOrigin(env.ORIGIN_URL);
  } catch (error) {
    return json({ error: "API origin is not configured", detail: error.message }, 503);
  }

  const target = new URL(origin.origin);
  target.pathname = origin.pathname + incomingUrl.pathname;
  target.search = incomingUrl.search;

  const headers = new Headers(request.headers);
  // Never trust forwarding metadata supplied by the incoming client.
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.slice(0, -1));
  headers.delete("host");

  try {
    const upstream = new Request(target.toString(), request);
    const forwarded = new Request(upstream, { headers, redirect: "manual" });
    const response = await fetch(forwarded);
    return addSecurityHeaders(response);
  } catch {
    return json({ error: "Unable to reach the configured API origin" }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ ok: true, service: "mes-homework-official-site" });
    }

    if (isProxyPath(url.pathname)) {
      return proxyToOrigin(request, url, env);
    }

    if (!env.ASSETS) {
      return new Response("Static asset binding ASSETS is missing.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const isHtml =
      url.pathname === "/" ||
      url.pathname.endsWith(".html") ||
      (assetResponse.headers.get("content-type") || "").includes("text/html");

    return addSecurityHeaders(assetResponse, isHtml);
  },
};
