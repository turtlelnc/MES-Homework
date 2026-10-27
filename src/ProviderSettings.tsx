import React, { useEffect, useState } from "react";
import {
  Globe,
  KeyRound,
  Link2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";
import { OAuthLoginDialog } from "./OAuthLoginDialog";
import {
  CHATGPT_DEVICE_VERIFICATION_URL,
  formatConnectedAt,
  isVisibleOAuthProvider,
  oauthFlowsFor,
  oauthProviderShortName,
  visibleOAuthProviders,
  type OAuthBrowserStartResponse,
  type OAuthCard,
  type OAuthDeviceStartResponse,
  type OAuthFlow,
  type OAuthPayload,
  type OAuthStartInfo,
} from "./oauth-flows";

type ModeInfo = { id: string; label: string; desc: string };
type ModelAccess = {
  mode: string;
  modes: ModeInfo[];
  ownerId: string | null;
  ownerName: string;
  ownerRole: string;
  hasApiKey: boolean;
  hasOAuth: boolean;
  authMode: string;
  provider: string | null;
  configured: boolean;
  hint: string;
  canConfigure: boolean;
  schoolMode: string;
  source?: string;
  fallback?: boolean;
};
type ProviderPreset = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  vision: boolean;
};
type OAuthState = {
  providers: OAuthCard[];
  authMode: string;
  provider: string | null;
};
type ReviewModeInfo = { id: string; label: string; desc: string };
type ReviewPayload = { mode: string; modes: ReviewModeInfo[] };
type SavedProvider = {
  provider: string;
  endpoint: string;
  model: string;
  updated_at?: string;
} | null;
type Props = {
  user: { id?: string; role?: string; is_school_admin?: number; name?: string };
  notify: (s: string) => void;
  configurationRevision?: number;
};

const ROLE_LABELS: Record<string, string> = {
  teacher: "教师",
  student: "学生",
  parent: "家长",
  administrator: "学校管理员",
};

const FALLBACK_REVIEW_MODES: ReviewModeInfo[] = [
  {
    id: "all",
    label: "全部复核",
    desc: "每道题都要教师确认后才写入错题本。",
  },
  {
    id: "uncertain",
    label: "仅存疑复核",
    desc: "AI 高置信度的判分自动通过，教师只复核低置信度、无法辨认、分数异常的题。",
  },
  {
    id: "none",
    label: "不复核",
    desc: "AI 批改后直接完成并写入错题本，教师可事后重新识别覆盖。",
  },
];

function regionLabel(region: string) {
  return region === "cn" ? "中国区服务" : "国际区服务";
}

const CONNECTED_BADGE: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 9px",
  borderRadius: 999,
  color: "#347854",
  background: "#eef9f2",
  border: "1px solid #d5ecdd",
};
const DISCONNECTED_BADGE: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 9px",
  borderRadius: 999,
  color: "#7c8796",
  background: "#f4f6f9",
  border: "1px solid #e4e8ee",
};
const UNCONFIGURED_BADGE: React.CSSProperties = {
  fontSize: 12,
  padding: "2px 9px",
  borderRadius: 999,
  color: "#b7514a",
  background: "#fdf0ee",
  border: "1px solid #f3d6d1",
};

function oauthBadgeStyle(card: OAuthCard): React.CSSProperties {
  if (card.connected) return CONNECTED_BADGE;
  if (!card.configured) return UNCONFIGURED_BADGE;
  return DISCONNECTED_BADGE;
}

function Field(
  props: React.InputHTMLAttributes<HTMLInputElement> & { label: string },
) {
  const { label, ...rest } = props;
  return (
    <label className="field">
      <span>{label}</span>
      <input {...rest} />
    </label>
  );
}

export function ProviderSettings({
  user,
  notify,
  configurationRevision = 0,
}: Props) {
  const [access, setAccess] = useState<ModelAccess | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [saved, setSaved] = useState<SavedProvider>(null);
  const [apiProviderDraft, setApiProviderDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [endpointDraft, setEndpointDraft] = useState("");
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState("");
  const [oauth, setOauth] = useState<OAuthState>({
    providers: [],
    authMode: "api_key",
    provider: null,
  });
  const [review, setReview] = useState<ReviewPayload>({
    mode: "all",
    modes: FALLBACK_REVIEW_MODES,
  });
  const [reviewAvailable, setReviewAvailable] = useState(true);
  const [reviewError, setReviewError] = useState("");
  const [reviewBusy, setReviewBusy] = useState("");
  const [authModeDraft, setAuthModeDraft] = useState("api_key");
  const [oauthDraft, setOauthDraft] = useState("");
  const [pendingMainland, setPendingMainland] = useState<{
    card: OAuthCard;
    flow: OAuthFlow;
  } | null>(null);
  const [session, setSession] = useState<{
    card: OAuthCard;
    flow: OAuthFlow;
    start: OAuthStartInfo | null;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Keep only the rc4 providers (chatgpt/gemini/workbuddy) and make sure the
  // "使用方式" provider select never points at a removed/disconnected card.
  const applyOAuthPayload = (data: OAuthPayload | null | undefined) => {
    const providers = visibleOAuthProviders(data?.providers);
    const connected = providers.filter((card) => card.connected);
    const providerId =
      data?.provider && isVisibleOAuthProvider(data.provider)
        ? data.provider
        : null;
    const preferred =
      (providerId && connected.some((card) => card.id === providerId)
        ? providerId
        : connected[0]?.id) || "";
    setOauth({
      providers,
      authMode: data?.authMode === "oauth" ? "oauth" : "api_key",
      provider: providerId,
    });
    setAuthModeDraft(data?.authMode === "oauth" ? "oauth" : "api_key");
    setOauthDraft(preferred);
  };

  const loadAccess = async () => {
    setAccess(await api<ModelAccess>("/model/access"));
  };
  const loadOAuth = async () => {
    applyOAuthPayload(await api<OAuthPayload>("/oauth/providers"));
  };
  const loadReview = async () => {
    setReview(await api<ReviewPayload>("/settings/review-mode"));
    setReviewAvailable(true);
    setReviewError("");
  };
  const observedRevision = React.useRef(configurationRevision);
  useEffect(() => {
    if (observedRevision.current === configurationRevision) return;
    observedRevision.current = configurationRevision;
    void Promise.all([loadAccess(), loadOAuth()]).catch((error) =>
      notify(error.message),
    );
  }, [configurationRevision]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [accessData, presetData, oauthData, savedData, reviewData] =
          await Promise.all([
            api<ModelAccess>("/model/access"),
            api<ProviderPreset[]>("/providers"),
            api<OAuthPayload>("/oauth/providers"),
            api<SavedProvider>("/settings/provider"),
            api<ReviewPayload>("/settings/review-mode").catch((error) => {
              if (active) setReviewError(error.message);
              return null;
            }),
          ]);
        if (!active) return;
        setAccess(accessData);
        setPresets(presetData);
        applyOAuthPayload(oauthData);
        setSaved(savedData);
        setApiProviderDraft(savedData?.provider || presetData[0]?.id || "");
        setModelDraft(savedData?.model || "");
        setEndpointDraft(savedData?.endpoint || "");
        if (reviewData) setReview(reviewData);
        else setReviewAvailable(false);
      } catch (error) {
        if (active) {
          setLoadError((error as Error).message);
          notify((error as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // OAuth provider callbacks land on "/" with query flags; consume them once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("oauth_status");
    if (!status) return;
    const providerId = params.get("oauth_provider") || "";
    const providerName = oauthProviderShortName(providerId);
    if (status === "connected")
      notify(`${providerName} OAuth 授权已连接，可以切换为 OAuth 使用方式。`);
    else if (status === "denied") notify("已取消 OAuth 授权，未做任何更改。");
    else
      notify(
        `OAuth 授权未完成（${params.get("oauth_reason") || "unknown"}），请重试或继续使用 API Key。`,
      );
    for (const key of ["oauth_status", "oauth_provider", "oauth_reason"])
      params.delete(key);
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );
  }, []);

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [, , , nextPresets, nextSaved] = await Promise.all([
        loadAccess(),
        loadOAuth(),
        loadReview(),
        api<ProviderPreset[]>("/providers"),
        api<SavedProvider>("/settings/provider"),
      ]);
      setPresets(nextPresets);
      setSaved(nextSaved);
      setApiProviderDraft(nextSaved?.provider || nextPresets[0]?.id || "");
      setModelDraft(nextSaved?.model || "");
      setEndpointDraft(nextSaved?.endpoint || "");
      setApiKeyDraft("");
      setLoadError("");
    } catch (error) {
      setLoadError((error as Error).message);
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveApiKey = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const activate =
      submitter instanceof HTMLButtonElement && submitter.value === "activate";
    setBusy("api-key");
    try {
      const result = await api<SavedProvider>(
        "/settings/provider",
        json("PUT", { ...values, activate }),
      );
      setSaved(result);
      setApiKeyDraft("");
      setModelDraft(result?.model || "");
      setEndpointDraft(result?.endpoint || "");
      const message = activate
        ? "已保存并切换为 API Key。"
        : "配置已保存，当前使用方式未更改。";
      setApiKeyStatus(message);
      notify(message);
      await Promise.all([loadAccess(), loadOAuth()]);
    } catch (error) {
      setApiKeyStatus(`保存失败：${(error as Error).message}`);
      notify(`保存失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const saveAuthMode = async () => {
    setBusy("auth-mode");
    try {
      await api(
        "/model/auth-mode",
        json("PUT", {
          mode: authModeDraft,
          ...(authModeDraft === "oauth" ? { provider: oauthDraft } : {}),
        }),
      );
      notify(
        authModeDraft === "oauth"
          ? "已切换为 OAuth 授权方式。"
          : "已切换为 API Key 方式。",
      );
      await Promise.all([loadAccess(), loadOAuth()]);
    } catch (error) {
      notify(`切换失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  // Begin a browser or device attempt. WorkBuddy device login needs the
  // region choice first, so the dialog creates that attempt itself.
  const launchFlow = async (card: OAuthCard, flow: OAuthFlow) => {
    setPendingMainland(null);
    if (card.id === "workbuddy") {
      // WorkBuddy 的浏览器登录/设备码登录都需要先选国内版或国际版；
      // 对话框在用户选择后自行发起 attempt。
      setSession({ card, flow, start: null });
      return;
    }
    setBusy(`oauth-${card.id}`);
    let popup: Window | null = null;
    try {
      if (flow === "browser") {
        popup = window.open("about:blank", "_blank");
        if (popup) popup.opener = null;
        const result = await api<OAuthBrowserStartResponse>(
          `/oauth/${encodeURIComponent(card.id)}/browser/start`,
          json("POST", {}),
        );
        const url = result.url || result.authorizeUrl || "";
        if (!result.attemptId) {
          // v0.2.1-rc3 compatibility: the old endpoint only returned a URL.
          if (url) {
            window.location.href = url;
            return;
          }
          throw new Error("服务端未返回授权链接");
        }
        const popupBlocked = !popup || !url;
        if (popup && url) popup.location.href = url;
        setSession({
          card,
          flow,
          start: {
            attemptId: result.attemptId,
            verificationUrl: url,
            popupBlocked,
          },
        });
      } else {
        const result = await api<OAuthDeviceStartResponse>(
          `/oauth/${encodeURIComponent(card.id)}/device/start`,
          json("POST", {}),
        );
        if (!result.attemptId) throw new Error("服务端未返回登录尝试编号");
        setSession({
          card,
          flow,
          start: {
            attemptId: result.attemptId,
            verificationUrl:
              result.verificationUrl ||
              (card.id === "chatgpt" ? CHATGPT_DEVICE_VERIFICATION_URL : ""),
            userCode: result.userCode,
            intervalMs: result.intervalMs,
          },
        });
      }
    } catch (error) {
      popup?.close();
      notify(`发起 OAuth 登录失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const startFlow = (card: OAuthCard, flow: OAuthFlow) => {
    if (!card.configured) {
      notify(
        `${card.name} 尚未配置，需设置环境变量：${(card.envHint || []).join("、") || "请联系部署管理员"}`,
      );
      return;
    }
    if (!access?.canConfigure) {
      notify("当前模式与角色不允许本账户配置 OAuth，请联系学校管理员。");
      return;
    }
    if (card.mainlandUnavailable && flow === "browser") {
      // Legacy guard kept for the browser flow (README: 跳转前提示); device
      // login warns inside the dialog because the user opens the page manually.
      setPendingMainland({ card, flow });
      return;
    }
    void launchFlow(card, flow);
  };

  const retrySession = async () => {
    const current = session;
    if (!current) return;
    if (current.start?.attemptId) {
      try {
        await api(
          `/oauth/${current.card.id}/attempt/${current.start.attemptId}`,
          { method: "DELETE" },
        );
      } catch {
        /* Expired attempts are already closed by the server. */
      }
    }
    setSession(null);
    if (current.card.mainlandUnavailable && current.flow === "browser") {
      setPendingMainland({ card: current.card, flow: current.flow });
      return;
    }
    void launchFlow(current.card, current.flow);
  };

  const handleOAuthConnected = async () => {
    try {
      await Promise.all([loadAccess(), loadOAuth()]);
    } catch (error) {
      notify(`刷新授权状态失败：${(error as Error).message}`);
    }
  };

  const disconnect = async (card: OAuthCard) => {
    setBusy(`oauth-${card.id}`);
    try {
      await api(
        `/oauth/${encodeURIComponent(card.id)}/disconnect`,
        json("POST", {}),
      );
      notify(`已断开 ${card.name} 的 OAuth 连接。`);
      await Promise.all([loadAccess(), loadOAuth()]);
    } catch (error) {
      notify(`断开失败：${(error as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const saveReviewMode = async (id: string) => {
    if (id === review.mode) return;
    setReviewBusy(id);
    try {
      await api("/settings/review-mode", json("PUT", { mode: id }));
      setReview({ ...review, mode: id });
      notify("作业复核方式已更新。");
    } catch (error) {
      notify(`复核方式保存失败：${(error as Error).message}`);
    } finally {
      setReviewBusy("");
    }
  };

  const modeLabel =
    access?.modes.find((mode) => mode.id === access.mode)?.label ||
    access?.mode ||
    "—";
  const outerRole =
    Number(user?.is_school_admin) === 1
      ? ROLE_LABELS.administrator
      : ROLE_LABELS[String(user?.role || "")] || user?.role || "";
  const ownerRole =
    access?.ownerRole === "teacher"
      ? access.ownerId === user?.id && Number(user?.is_school_admin) === 1
        ? ROLE_LABELS.administrator
        : ROLE_LABELS.teacher
      : ROLE_LABELS[access?.ownerRole || ""] || access?.ownerRole || "";
  const reviewModes =
    review.modes && review.modes.length ? review.modes : FALLBACK_REVIEW_MODES;
  const selectedPreset = presets.find(
    (preset) => preset.id === apiProviderDraft,
  );
  const canReuseKey = saved?.provider === apiProviderDraft;

  return (
    <div style={{ display: "grid", gap: 20, alignContent: "start" }}>
      <div className="rc4-title">
        <div>
          <span className="eyebrow">MODEL ACCESS · OAUTH</span>
          <h1>模型与授权</h1>
          <p>
            API Key 与 OAuth
            双通道；密钥与令牌只在服务端加密保存，任何页面都不会回显。
            当前账户：{user?.name || ""}
            {outerRole ? `（${outerRole}）` : ""}。
          </p>
        </div>
        <Button
          variant="outline"
          type="button"
          onClick={() => void refreshAll()}
          disabled={loading}
        >
          <RefreshCw /> {loading ? "读取中…" : "刷新状态"}
        </Button>
      </div>

      {loadError && (
        <p role="alert">
          无法读取模型设置：{loadError}。请点击“刷新状态”重试。
        </p>
      )}
      <section className="rc4-panel">
        <h2>
          <ShieldCheck /> 当前生效凭证
        </h2>
        {!access ? (
          <p className="panel-intro">正在读取当前凭证状态…</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
              gap: 12,
            }}
          >
            <div className="metric">
              <span>调用模式</span>
              <strong>{modeLabel}</strong>
            </div>
            <div className="metric">
              <span>凭证归属</span>
              <strong>
                {access.ownerName || "未找到"}
                {ownerRole ? `（${ownerRole}）` : ""}
              </strong>
            </div>
            <div className="metric">
              <span>配置状态</span>
              <strong>{access.configured ? "已配置" : "未配置"}</strong>
            </div>
            <div className="metric">
              <span>使用方式</span>
              <strong>
                {access.authMode === "oauth" ? "OAuth 授权" : "API Key"}
                {access.provider ? ` · ${access.provider}` : ""}
              </strong>
            </div>
          </div>
        )}
        {access?.hint && (
          <p className="panel-intro" style={{ marginTop: 14, marginBottom: 0 }}>
            {access.hint}
          </p>
        )}
        {access && !access.canConfigure && (
          <p className="panel-intro" style={{ marginTop: 10, marginBottom: 0 }}>
            当前模式与角色不允许本账户单独配置凭证，表单已锁定；如需更换请联系学校管理员。
          </p>
        )}
      </section>

      <div style={{ display: "grid", gap: 20 }}>
        <form className="rc4-panel" onSubmit={saveApiKey}>
          <h2>
            <KeyRound /> API Key 方式
          </h2>
          <p className="panel-intro">
            每个账户保存一套 API Key 配置。选择厂商并填写密钥即可使用默认模型；
            图片与 PDF 识别需视觉模型。保存配置不会发送付费测试请求。
          </p>
          <fieldset
            disabled={
              loading ||
              Boolean(loadError) ||
              !access?.canConfigure ||
              busy === "api-key"
            }
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <label className="field">
              <span>厂商</span>
              <select
                name="provider"
                value={apiProviderDraft}
                onChange={(event) => {
                  setApiProviderDraft(event.currentTarget.value);
                  setModelDraft("");
                  setEndpointDraft("");
                  setApiKeyDraft("");
                  setApiKeyStatus("");
                }}
              >
                {presets.map((preset) => (
                  <option value={preset.id} key={preset.id}>
                    {preset.name}
                    {preset.vision ? " · 视觉" : " · 文本"}
                  </option>
                ))}
              </select>
            </label>
            <p className="panel-intro" aria-live="polite">
              默认模型：{selectedPreset?.model || "读取中…"}；
              {selectedPreset?.vision ? "支持图片识别" : "仅文本"}。
              {canReuseKey
                ? " 已保存此厂商的密钥，留空即可保留。"
                : " 切换厂商后须填写对应厂商的新密钥。"}
            </p>
            <Field
              name="apiKey"
              type="password"
              label="API Key"
              required={!canReuseKey}
              autoComplete="off"
              value={apiKeyDraft}
              onChange={(event) => setApiKeyDraft(event.target.value)}
              placeholder={
                canReuseKey
                  ? "已保存；留空保留，填写则替换"
                  : "粘贴所选厂商的 API Key"
              }
            />
            <details
              open={Boolean(
                (modelDraft && modelDraft !== selectedPreset?.model) ||
                (endpointDraft && endpointDraft !== selectedPreset?.endpoint),
              )}
            >
              <summary>高级设置：模型名称与接口地址</summary>
              <Field
                name="model"
                label="模型名称（可选覆盖）"
                value={modelDraft}
                onChange={(event) => setModelDraft(event.target.value)}
                placeholder={selectedPreset?.model || "留空使用默认模型"}
              />
              <Field
                name="endpoint"
                label="兼容接口地址（可选覆盖）"
                value={endpointDraft}
                onChange={(event) => setEndpointDraft(event.target.value)}
                placeholder={
                  selectedPreset?.endpoint || "默认使用厂商官方 HTTPS 地址"
                }
              />
            </details>
            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <Button
                className="full"
                type="submit"
                name="intent"
                value="activate"
                disabled={!access?.canConfigure || busy === "api-key"}
              >
                <KeyRound />
                {busy === "api-key" ? "正在保存…" : "保存并使用 API Key"}
              </Button>
              <Button
                type="submit"
                variant="outline"
                name="intent"
                value="save"
                disabled={busy === "api-key"}
              >
                仅保存配置
              </Button>
            </div>
          </fieldset>
          {apiKeyStatus && <p role="status">{apiKeyStatus}</p>}
          {saved?.provider && (
            <p className="save-status" style={{ marginTop: 14 }}>
              已保存：
              {presets.find((preset) => preset.id === saved.provider)?.name ||
                saved.provider}
              {saved.model ? ` · ${saved.model}` : ""}
            </p>
          )}
        </form>

        <section className="rc4-panel">
          <h2>
            <Link2 /> 当前使用方式
          </h2>
          <p className="panel-intro">
            API Key 与 OAuth 可共存；这里选择当前实际用于模型调用的通道。 OAuth
            方式要求对应 provider 已连接。
          </p>
          <label className="field">
            <span>使用方式</span>
            <select
              value={authModeDraft}
              onChange={(e) => setAuthModeDraft(e.target.value)}
              disabled={!access?.canConfigure || busy === "auth-mode"}
            >
              <option value="api_key">API Key</option>
              <option value="oauth">OAuth 授权</option>
            </select>
          </label>
          {authModeDraft === "oauth" && (
            <label className="field">
              <span>OAuth 提供方</span>
              <select
                value={oauthDraft}
                onChange={(e) => setOauthDraft(e.target.value)}
                disabled={!access?.canConfigure || busy === "auth-mode"}
              >
                <option value="">请选择已连接的 provider</option>
                {oauth.providers
                  .filter((card) => card.connected)
                  .map((card) => (
                    <option value={card.id} key={card.id}>
                      {card.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <Button
            className="full"
            type="button"
            onClick={() => void saveAuthMode()}
            disabled={!access?.canConfigure || busy === "auth-mode"}
          >
            {busy === "auth-mode" ? "正在保存…" : "保存使用方式"}
          </Button>
        </section>
      </div>

      <section className="rc4-panel">
        <h2>
          <Link2 /> OAuth 授权方式
        </h2>
        <p className="panel-intro">
          登录完成后点击“使用此连接”启用。Gemini 需要部署方配置；ChatGPT 与
          WorkBuddy
          为实验性兼容入口，适用条件见各卡片。授权令牌仅在服务器加密保存。
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {oauth.providers.map((card) => {
            const flows = oauthFlowsFor(card);
            const cardBusy = busy === `oauth-${card.id}`;
            const envHints = card.envHint || [];
            return (
              <div
                key={card.id}
                style={{
                  border: "1px solid #e4e8ee",
                  borderRadius: 13,
                  padding: 16,
                  display: "grid",
                  gap: 10,
                  alignContent: "start",
                  background: "linear-gradient(160deg, #ffffff, #f8fbff)",
                  boxShadow: "0 1px 2px rgba(16, 40, 72, 0.04)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <strong>{card.name}</strong>
                  <span style={oauthBadgeStyle(card)}>
                    {card.connected
                      ? "已连接"
                      : card.configured
                        ? "未连接"
                        : "未配置"}
                  </span>
                </div>
                <p style={{ color: "#8491a3", fontSize: 13, lineHeight: 1.7 }}>
                  {card.description}
                </p>
                {card.setupHint && (
                  <p className="panel-intro">{card.setupHint}</p>
                )}
                {card.verification === "experimental" && (
                  <strong>实验性兼容连接 · 尚未验证真实登录</strong>
                )}
                {card.redirectUri && (
                  <small>
                    Google 控制台回调地址：
                    <code style={{ overflowWrap: "anywhere" }}>
                      {card.redirectUri}
                    </code>
                  </small>
                )}
                <small style={{ color: "#7c8796", lineHeight: 1.7 }}>
                  默认模型：{card.model || "—"}
                  {card.vision ? " · 支持图片" : " · 仅文本"} ·{" "}
                  {regionLabel(card.region)}
                  {card.mainlandUnavailable ? " · 大陆可能不可用" : ""}
                </small>
                {card.connected && (
                  <small style={{ color: "#347854", lineHeight: 1.7 }}>
                    已连接
                    {card.connectedAt
                      ? ` · ${formatConnectedAt(card.connectedAt)}`
                      : ""}
                  </small>
                )}
                {!card.configured && (
                  <small style={{ color: "#b7514a", lineHeight: 1.7 }}>
                    未配置，需设置环境变量：
                    {envHints.length
                      ? envHints.join("、")
                      : "（请联系部署管理员）"}
                  </small>
                )}
                <div
                  className="form-actions"
                  style={{
                    justifyContent: "flex-start",
                    flexWrap: "wrap",
                    marginTop: 2,
                  }}
                >
                  {card.connected ? (
                    <>
                      <Button
                        type="button"
                        disabled={
                          cardBusy || !access?.canConfigure || !card.configured
                        }
                        onClick={async () => {
                          setBusy(`oauth-${card.id}`);
                          try {
                            await api(
                              "/model/auth-mode",
                              json("PUT", { mode: "oauth", provider: card.id }),
                            );
                            await Promise.all([loadAccess(), loadOAuth()]);
                            notify(`当前已使用 ${card.name}。`);
                          } catch (error) {
                            notify((error as Error).message);
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        {oauth.authMode === "oauth" &&
                        oauth.provider === card.id
                          ? "当前正在使用"
                          : "使用此连接"}
                      </Button>
                      <Button
                        variant="outline"
                        type="button"
                        onClick={() => void disconnect(card)}
                        disabled={cardBusy}
                      >
                        {cardBusy ? "正在断开…" : "断开连接"}
                      </Button>
                    </>
                  ) : (
                    flows.map((flow) => (
                      <Button
                        key={flow}
                        type="button"
                        variant={flow === "browser" ? "default" : "outline"}
                        onClick={() => startFlow(card, flow)}
                        disabled={
                          cardBusy || !card.configured || !access?.canConfigure
                        }
                      >
                        {flow === "browser" ? (
                          <>
                            <Globe size={16} />
                            {cardBusy ? "正在申请…" : "浏览器登录"}
                          </>
                        ) : (
                          <>
                            <Smartphone size={16} />
                            {cardBusy ? "正在申请…" : "设备码登录"}
                          </>
                        )}
                      </Button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {oauth.providers.length === 0 && (
          <p className="panel-intro">暂无可用的 OAuth provider。</p>
        )}
      </section>

      {user.role === "teacher" && !user.is_school_admin && (
        <section className="rc4-panel">
          <h2>
            <ShieldAlert /> 作业复核方式
          </h2>
          <p className="panel-intro">
            决定 AI
            批改后教师需要核对的范围；仅任课教师可修改，学校管理员不参与作业复核。
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
              gap: 12,
            }}
          >
            {reviewModes.map((mode) => {
              const active = review.mode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  className={active ? "active" : ""}
                  onClick={() => void saveReviewMode(mode.id)}
                  disabled={Boolean(reviewBusy) || !reviewAvailable}
                  style={{
                    textAlign: "left",
                    borderRadius: 9,
                    padding: 14,
                    display: "grid",
                    gap: 6,
                    cursor: active ? "default" : "pointer",
                    border: active ? "2px solid #1168c9" : "1px solid #e4e8ee",
                    background: active ? "#eef5ff" : "#fff",
                    color: "#26364a",
                  }}
                >
                  <strong style={{ color: active ? "#1168c9" : "#26364a" }}>
                    {active ? "✓ " : ""}
                    {mode.label}
                  </strong>
                  <small style={{ color: "#7c8796", lineHeight: 1.6 }}>
                    {mode.desc}
                  </small>
                  <small style={{ color: "#939eac" }}>
                    {active
                      ? "当前生效"
                      : reviewBusy === mode.id
                        ? "正在保存…"
                        : "点击切换"}
                  </small>
                </button>
              );
            })}
          </div>
          {!reviewAvailable && (
            <p
              className="panel-intro"
              style={{ marginTop: 12, marginBottom: 0 }}
            >
              无法读取复核设置：{reviewError || "请重新加载页面"}
            </p>
          )}
        </section>
      )}

      {pendingMainland && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(9, 31, 58, 0.55)",
            display: "grid",
            placeItems: "center",
            padding: 20,
            zIndex: 1000,
          }}
        >
          <div className="rc4-panel" style={{ maxWidth: 520, width: "100%" }}>
            <h2>
              <ShieldAlert /> 中国大陆境内不可用确认
            </h2>
            <p className="panel-intro">
              {pendingMainland.card.name}{" "}
              在中国大陆境内不可用，继续将打开境外授权页，
              可能无法完成授权或连接不稳定。
            </p>
            <p className="save-status">
              即将以{regionLabel(pendingMainland.card.region)}方式连接
              {pendingMainland.flow === "browser" ? "浏览器授权" : "设备码登录"}
              （{pendingMainland.card.name}）。
            </p>
            <div className="form-actions">
              <Button
                variant="outline"
                type="button"
                onClick={() => setPendingMainland(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                onClick={() =>
                  void launchFlow(pendingMainland.card, pendingMainland.flow)
                }
              >
                仍要继续
              </Button>
            </div>
          </div>
        </div>
      )}

      {session && (
        <OAuthLoginDialog
          key={`${session.card.id}-${session.flow}-${session.start?.attemptId || "new"}`}
          card={session.card}
          flow={session.flow}
          start={session.start}
          notify={notify}
          onClose={() => setSession(null)}
          onRetry={retrySession}
          onConnected={handleOAuthConnected}
        />
      )}
    </div>
  );
}
