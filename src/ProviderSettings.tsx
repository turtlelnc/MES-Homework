import React, { useEffect, useState } from "react";
import {
  KeyRound,
  Link2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";

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
type OAuthCard = {
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
  envHint: string[];
};
type OAuthPayload = {
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
  return region === "cn" ? "国内直连" : "境外服务";
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

export function ProviderSettings({ user, notify }: Props) {
  const [access, setAccess] = useState<ModelAccess | null>(null);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [saved, setSaved] = useState<SavedProvider>(null);
  const [oauth, setOauth] = useState<OAuthPayload>({
    providers: [],
    authMode: "api_key",
    provider: null,
  });
  const [review, setReview] = useState<ReviewPayload>({
    mode: "all",
    modes: FALLBACK_REVIEW_MODES,
  });
  const [reviewAvailable, setReviewAvailable] = useState(true);
  const [reviewBusy, setReviewBusy] = useState("");
  const [authModeDraft, setAuthModeDraft] = useState("api_key");
  const [oauthDraft, setOauthDraft] = useState("");
  const [pendingMainland, setPendingMainland] = useState<OAuthCard | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);

  const loadAccess = async () => {
    setAccess(await api<ModelAccess>("/model/access"));
  };
  const loadOAuth = async () => {
    const data = await api<OAuthPayload>("/oauth/providers");
    setOauth(data);
    setAuthModeDraft(data.authMode === "oauth" ? "oauth" : "api_key");
    const connected =
      data.providers.find(
        (card) => card.id === data.provider && card.connected,
      ) || data.providers.find((card) => card.connected);
    setOauthDraft(data.provider || connected?.id || "");
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [accessData, presetData, oauthData, savedData, reviewData] =
          await Promise.all([
            api<ModelAccess>("/model/access"),
            api<ProviderPreset[]>("/providers").catch(() => []),
            api<OAuthPayload>("/oauth/providers"),
            api<SavedProvider>("/settings/provider").catch(() => null),
            api<ReviewPayload>("/settings/review-mode").catch(() => null),
          ]);
        if (!active) return;
        setAccess(accessData);
        setPresets(presetData);
        setOauth(oauthData);
        setAuthModeDraft(oauthData.authMode === "oauth" ? "oauth" : "api_key");
        const connected =
          oauthData.providers.find(
            (card) => card.id === oauthData.provider && card.connected,
          ) || oauthData.providers.find((card) => card.connected);
        setOauthDraft(oauthData.provider || connected?.id || "");
        setSaved(savedData);
        if (reviewData) setReview(reviewData);
        else setReviewAvailable(false);
      } catch (error) {
        if (active) notify((error as Error).message);
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
    const providerId = params.get("oauth_provider") || "模型";
    if (status === "connected")
      notify(`${providerId} OAuth 授权已连接，可以切换为 OAuth 使用方式。`);
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
      await Promise.all([loadAccess(), loadOAuth()]);
    } catch (error) {
      notify((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const saveApiKey = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy("api-key");
    try {
      const result = await api<SavedProvider>(
        "/settings/provider",
        json("PUT", values),
      );
      setSaved(result);
      notify("API Key 已在服务端加密保存。");
      form.reset();
      await loadAccess();
    } catch (error) {
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

  const startOAuth = async (card: OAuthCard) => {
    setPendingMainland(null);
    setBusy(`oauth-${card.id}`);
    try {
      const result = await api<{ authorizeUrl: string }>(
        `/oauth/${encodeURIComponent(card.id)}/start`,
        json("POST", {}),
      );
      window.location.href = result.authorizeUrl;
    } catch (error) {
      notify((error as Error).message);
      setBusy("");
    }
  };

  const connect = (card: OAuthCard) => {
    if (!card.configured) {
      notify(
        `${card.name} 尚未配置，请联系部署管理员设置：${(card.envHint || []).join("、")}`,
      );
      return;
    }
    if (card.mainlandUnavailable) {
      setPendingMainland(card);
      return;
    }
    void startOAuth(card);
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
            图片与 PDF OCR 需选择标记为“视觉”的厂商；AI 教学分析使用同一个模型。
            密钥保存后不会再回显。
          </p>
          <fieldset
            disabled={!access?.canConfigure || busy === "api-key"}
            style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
          >
            <label className="field">
              <span>厂商</span>
              <select
                name="provider"
                defaultValue={saved?.provider || presets[0]?.id || "deepseek"}
              >
                {presets.map((preset) => (
                  <option value={preset.id} key={preset.id}>
                    {preset.name}
                    {preset.vision ? " · 视觉" : " · 文本"}
                  </option>
                ))}
              </select>
            </label>
            <Field
              name="model"
              label="模型名称（可选覆盖）"
              defaultValue={saved?.model || ""}
              placeholder="例如 deepseek-chat"
            />
            <Field
              name="endpoint"
              label="兼容接口地址（可选覆盖）"
              defaultValue={saved?.endpoint || ""}
              placeholder="默认使用厂商官方 HTTPS 地址"
            />
            <Field
              name="apiKey"
              type="password"
              label="API Key"
              required
              autoComplete="off"
              placeholder="粘贴厂商 API Key"
            />
            <Button
              className="full"
              type="submit"
              disabled={!access?.canConfigure || busy === "api-key"}
            >
              <KeyRound />
              {busy === "api-key" ? "正在加密保存…" : "加密保存 API Key"}
            </Button>
          </fieldset>
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
          OAuth 采用授权码 + PKCE 流程，令牌在服务端 AES-256-GCM 加密保存。
          标记“中国大陆境内不可用”的境外服务会先弹出确认，点“仍要继续”才会跳转授权页。
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {oauth.providers.map((card) => (
            <div
              key={card.id}
              style={{
                border: "1px solid #e4e8ee",
                borderRadius: 9,
                padding: 14,
                display: "grid",
                gap: 8,
                alignContent: "start",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <strong>{card.name}</strong>
                <span style={{ fontSize: 12, color: "#7c8796" }}>
                  {regionLabel(card.region)}
                  {card.mainlandUnavailable ? " · 大陆不可用" : ""}
                </span>
              </div>
              <p style={{ color: "#8491a3", fontSize: 13 }}>
                {card.description}
              </p>
              <small style={{ color: "#7c8796" }}>
                默认模型：{card.model || "—"}
                {card.vision ? " · 支持图片" : " · 仅文本"}
              </small>
              {!card.configured && (
                <small style={{ color: "#b7514a" }}>
                  未配置，需设置环境变量：
                  {(card.envHint || []).join("、") || "（请联系部署管理员）"}
                </small>
              )}
              {card.connected && (
                <small style={{ color: "#347854" }}>
                  已连接
                  {card.connectedAt
                    ? ` · ${card.connectedAt.slice(0, 10)}`
                    : ""}
                </small>
              )}
              <div
                className="form-actions"
                style={{ justifyContent: "flex-start" }}
              >
                {card.connected ? (
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => void disconnect(card)}
                    disabled={busy === `oauth-${card.id}`}
                  >
                    断开连接
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => connect(card)}
                    disabled={
                      !card.configured ||
                      !access?.canConfigure ||
                      busy === `oauth-${card.id}`
                    }
                  >
                    {busy === `oauth-${card.id}` ? "正在跳转…" : "连接"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        {oauth.providers.length === 0 && (
          <p className="panel-intro">暂无可用的 OAuth provider。</p>
        )}
      </section>

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
          <p className="panel-intro" style={{ marginTop: 12, marginBottom: 0 }}>
            复核方式接口暂未就绪（由服务端复核模块提供），此处先展示选项。
          </p>
        )}
      </section>

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
              ChatGPT 等服务在中国大陆境内不可用，继续将跳转到境外授权页，
              可能无法完成授权或连接不稳定。
            </p>
            <p className="save-status">
              即将连接的是{regionLabel(pendingMainland.region)}（
              {pendingMainland.name}）。
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
                onClick={() => void startOAuth(pendingMainland)}
              >
                仍要继续
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
