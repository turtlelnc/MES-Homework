import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MES Homework Cloudflare Worker", () => {
  it("exposes a lightweight health endpoint", async () => {
    const response = await worker.fetch(
      new Request("https://site.example/healthz"),
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      service: "mes-homework-official-site",
    });
  });

  it("serves static assets and adds browser security headers", async () => {
    const assets = {
      fetch: vi.fn(async () => new Response("website", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })),
    };

    const response = await worker.fetch(
      new Request("https://site.example/"),
      { ASSETS: assets },
    );

    expect(await response.text()).toBe("website");
    expect(assets.fetch).toHaveBeenCalledOnce();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("returns a clear configuration error when the API origin is missing", async () => {
    const response = await worker.fetch(
      new Request("https://site.example/api/health"),
      {},
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("API origin is not configured");
  });

  it("rejects non-HTTPS and placeholder origin URLs", async () => {
    const request = new Request("https://site.example/api/health");

    const insecure = await worker.fetch(request, {
      ORIGIN_URL: "http://origin.example",
    });
    const placeholder = await worker.fetch(request, {
      ORIGIN_URL: "https://replace-with-your-cloudflared-origin.example.com",
    });

    expect(insecure.status).toBe(503);
    expect(placeholder.status).toBe(503);
  });

  it("redirects the app entry point to the configured origin root", async () => {
    const response = await worker.fetch(
      new Request("https://site.example/app"),
      { ORIGIN_URL: "https://origin.example" },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://origin.example/");
  });

  it("proxies API requests and replaces untrusted forwarding headers", async () => {
    let forwardedRequest;
    const fetchMock = vi.fn(async (request) => {
      forwardedRequest = request;
      return new Response("upstream-ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("https://site.example/api/health?check=1", {
      headers: {
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "198.51.100.10",
        "cf-connecting-ip": "203.0.113.7",
      },
    });
    const response = await worker.fetch(request, {
      ORIGIN_URL: "https://origin.example",
    });

    expect(await response.text()).toBe("upstream-ok");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(forwardedRequest.url).toBe("https://origin.example/api/health?check=1");
    expect(forwardedRequest.headers.get("x-forwarded-host")).toBe("site.example");
    expect(forwardedRequest.headers.get("x-forwarded-proto")).toBe("https");
    expect(forwardedRequest.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it("does not proxy paths that merely start with an API prefix", async () => {
    const assets = { fetch: vi.fn(async () => new Response("asset")) };
    const response = await worker.fetch(
      new Request("https://site.example/apix"),
      { ASSETS: assets },
    );

    expect(await response.text()).toBe("asset");
    expect(assets.fetch).toHaveBeenCalledOnce();
  });
});
