// v0.2.1-rc4 OAuth provider helpers shared by the settings panel and the
// unified login dialog. Keep this module dependency-free and side-effect free:
// it maps the server's provider payload to the three OAuth providers that the
// rc4 UI still exposes and normalises the flow/polling rules from
// docs/oauth-flows.md. Legacy payloads (no `flows` field) fall back to the
// per-provider defaults below.

export type OAuthFlow = "browser" | "device";
export type OAuthRegion = "cn" | "global";
export type OAuthProviderId = "chatgpt" | "gemini" | "workbuddy";

export type OAuthCard = {
  id: string;
  name: string;
  region: string;
  mainlandUnavailable: boolean;
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  description: string;
  model: string;
  vision: boolean;
  envHint?: string[];
  /** rc4 server returns the supported flows; rc3 payloads omit the field. */
  flows?: string[] | null;
};

export type OAuthPayload = {
  providers?: OAuthCard[] | null;
  authMode?: string;
  provider?: string | null;
};

/** GET /api/oauth/:provider/attempt/:attemptId */
export type OAuthAttemptResponse = {
  status?: string;
  message?: string;
  provider?: string;
  connectedAt?: string;
};

/** POST /api/oauth/:provider/browser/start */
export type OAuthBrowserStartResponse = {
  attemptId?: string;
  mode?: string;
  url?: string;
  /** v0.2.1-rc3 legacy `<provider>/start` response, kept as a fallback. */
  authorizeUrl?: string;
};

/** POST /api/oauth/:provider/device/start */
export type OAuthDeviceStartResponse = {
  attemptId?: string;
  mode?: string;
  verificationUrl?: string;
  userCode?: string;
  intervalMs?: number;
};

/** Attempt metadata handed from the settings panel to the login dialog. */
export type OAuthStartInfo = {
  attemptId: string;
  verificationUrl: string;
  userCode?: string;
  intervalMs?: number;
  popupBlocked?: boolean;
};

/** Only these providers are exposed by the rc4 OAuth UI, in this order. */
export const OAUTH_PROVIDER_ORDER: readonly OAuthProviderId[] = [
  "chatgpt",
  "gemini",
  "workbuddy",
];

const PROVIDER_SHORT_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  workbuddy: "WorkBuddy",
};

/** WorkBuddy defaults to the mainland edition; the dialog can switch. */
export const OAUTH_WORKBUDDY_REGIONS: ReadonlyArray<{
  id: OAuthRegion;
  label: string;
  description: string;
}> = [
  {
    id: "cn",
    label: "国内版",
    description: "默认版本，国内网络直连，使用国内版 WorkBuddy 账号。",
  },
  {
    id: "global",
    label: "国际版",
    description: "适用于国际版账号或境外网络，授权与接口走国际线路。",
  },
];

/** Fallback used when the server omits the device verification page. */
export const CHATGPT_DEVICE_VERIFICATION_URL =
  "https://auth.openai.com/codex/device";

/** Browser flows poll every 1.8s (docs/oauth-flows.md asks for 1.5–2s). */
export const OAUTH_BROWSER_POLL_MS = 1800;
/** Device flows usually return intervalMs; this is the conservative default. */
export const OAUTH_DEVICE_POLL_FALLBACK_MS = 3000;
const OAUTH_POLL_MIN_MS = 1500;
const OAUTH_POLL_MAX_MS = 10000;

const DEFAULT_FLOWS: Record<OAuthProviderId, readonly OAuthFlow[]> = {
  chatgpt: ["browser"],
  gemini: ["browser"],
  workbuddy: ["browser", "device"],
};

function isOAuthFlow(value: unknown): value is OAuthFlow {
  return value === "browser" || value === "device";
}

export function isVisibleOAuthProvider(id: string): id is OAuthProviderId {
  return (OAUTH_PROVIDER_ORDER as readonly string[]).includes(id);
}

/**
 * Keep only the three rc4 providers (removed ids such as claude/qwen/千问/
 * deepseek never reach the UI) and reorder them for a stable card grid.
 */
export function visibleOAuthProviders(
  providers: OAuthCard[] | null | undefined,
): OAuthCard[] {
  if (!Array.isArray(providers)) return [];
  const byId = new Map<string, OAuthCard>();
  for (const card of providers) {
    if (card && typeof card.id === "string" && card.id) {
      byId.set(card.id, card);
    }
  }
  return OAUTH_PROVIDER_ORDER.map((id) => byId.get(id)).filter(
    (card): card is OAuthCard => Boolean(card),
  );
}

/**
 * Resolve the login buttons to render. Server-declared flows win; payloads
 * from rc3 (no `flows`) fall back to chatgpt/gemini=browser,
 * workbuddy=browser+device.
 */
export function oauthFlowsFor(
  card: Pick<OAuthCard, "id" | "flows">,
): OAuthFlow[] {
  const declared = Array.isArray(card.flows)
    ? card.flows.filter(isOAuthFlow)
    : [];
  const unique = Array.from(new Set(declared));
  if (unique.length) return unique;
  if (isVisibleOAuthProvider(card.id)) return [...DEFAULT_FLOWS[card.id]];
  return ["browser"];
}

export function oauthProviderShortName(id: string | null | undefined): string {
  const key = String(id || "");
  return (key && PROVIDER_SHORT_NAMES[key]) || key || "模型";
}

export function oauthWorkbuddyRegionLabel(region: OAuthRegion): string {
  const found = OAUTH_WORKBUDDY_REGIONS.find((option) => option.id === region);
  return found ? found.label : "国内版";
}

/** Human-readable connected timestamp; falls back to the raw date prefix. */
export function formatConnectedAt(value: string | null | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10);
  return parsed.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Poll cadence: browser flows every 1.8s; device flows honour the server
 * interval (clamped to 1.5–10s) so we never hammer the token endpoint.
 */
export function oauthPollInterval(
  flow: OAuthFlow,
  returnedMs?: number | null,
): number {
  if (flow === "browser") return OAUTH_BROWSER_POLL_MS;
  const value = Number(returnedMs);
  if (Number.isFinite(value) && value >= OAUTH_POLL_MIN_MS) {
    return Math.min(Math.round(value), OAUTH_POLL_MAX_MS);
  }
  return OAUTH_DEVICE_POLL_FALLBACK_MS;
}

/** Chinese error text for error/expired attempt states. */
export function oauthAttemptErrorMessage(
  status: string | undefined,
  message?: string,
): string {
  const text = typeof message === "string" ? message.trim() : "";
  if (text) return text;
  if (status === "expired") return "授权已过期，请重新发起登录。";
  return "授权未完成，请重新发起登录或改用 API Key。";
}
