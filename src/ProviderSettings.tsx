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
  const [review, setReview] = useState<ReviewPayload>({
    mode: "all",
    modes: FALLBACK_REVIEW_MODES,
  });
  const [reviewAvailable, setReviewAvailable] = useState(true);
  const [reviewError, setReviewError] = useState("");
  const [reviewBusy, setReviewBusy] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadAccess = async () => {
    setAccess(await api<ModelAccess>("/model/access"));
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
    void Promise.all([loadAccess()]).catch((error) => notify(error.message));
  }, [configurationRevision]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [accessData, presetData, savedData, reviewData] =
          await Promise.all([
            api<ModelAccess>("/model/access"),
            api<ProviderPreset[]>("/providers"),
            api<SavedProvider>("/settings/provider"),
            api<ReviewPayload>("/settings/review-mode").catch((error) => {
              if (active) setReviewError(error.message);
              return null;
            }),
          ]);
        if (!active) return;
        setAccess(accessData);
        setPresets(presetData);
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

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [, , nextPresets, nextSaved] = await Promise.all([
        loadAccess(),
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
      await Promise.all([loadAccess()]);
    } catch (error) {
      setApiKeyStatus(`保存失败：${(error as Error).message}`);
      notify(`保存失败：${(error as Error).message}`);
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
          <span className="eyebrow">MODEL SETTINGS</span>
          <h1>模型与授权</h1>
          <p>
            选择模型厂商，填入 API Key 后保存即可。密钥仅在服务端加密保存。
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
                API Key
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
      </div>

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
    </div>
  );
}
