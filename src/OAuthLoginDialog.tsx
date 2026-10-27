import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  ShieldAlert,
  Smartphone,
  X,
} from "lucide-react";
import { api, json } from "./api";
import { Button } from "./components/ui/button";
import {
  CHATGPT_DEVICE_VERIFICATION_URL,
  OAUTH_WORKBUDDY_REGIONS,
  oauthAttemptErrorMessage,
  oauthPollInterval,
  oauthProviderShortName,
  oauthWorkbuddyRegionLabel,
  type OAuthAttemptResponse,
  type OAuthBrowserStartResponse,
  type OAuthCard,
  type OAuthDeviceStartResponse,
  type OAuthFlow,
  type OAuthRegion,
  type OAuthStartInfo,
} from "./oauth-flows";

type Stage = "region" | "starting" | "waiting" | "error";

type Props = {
  card: OAuthCard;
  flow: OAuthFlow;
  /** Attempt already created by the settings panel (browser / chatgpt device). */
  start?: OAuthStartInfo | null;
  notify: (s: string) => void;
  onClose: () => void;
  onRetry?: () => void;
  /** Refresh /model/access + /oauth/providers after a successful login. */
  onConnected: () => void | Promise<void>;
};

/**
 * Unified rc4 OAuth dialog: browser callback waiting state and device-code
 * state (ChatGPT user code / WorkBuddy authorization link). Polling is owned
 * by this component and every timer/in-flight request is cleaned up when the
 * dialog unmounts or the user cancels.
 */
export function OAuthLoginDialog({
  card,
  flow,
  start,
  notify,
  onClose,
  onRetry,
  onConnected,
}: Props) {
  const isWorkbuddy = card.id === "workbuddy";
  const [stage, setStage] = useState<Stage>(() =>
    start ? "waiting" : isWorkbuddy ? "region" : "error",
  );
  const [attempt, setAttempt] = useState<OAuthStartInfo | null>(start ?? null);
  const [region, setRegion] = useState<OAuthRegion>("cn");
  const [errorText, setErrorText] = useState(() =>
    start || isWorkbuddy ? "" : "未能发起 OAuth 登录，请关闭后重试。",
  );
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const callbacks = useRef({ notify, onClose, onConnected });
  callbacks.current = { notify, onClose, onConnected };
  const startAbort = useRef<AbortController | null>(null);
  const finished = useRef(false);

  const shortName = oauthProviderShortName(card.id);
  const pollInterval = useMemo(
    () => oauthPollInterval(flow, attempt?.intervalMs),
    [flow, attempt?.intervalMs],
  );

  const cancelRef = useRef(() => {});
  const cancel = () => {
    if (attempt?.attemptId && !finished.current)
      void api(
        `/oauth/${encodeURIComponent(card.id)}/attempt/${encodeURIComponent(attempt.attemptId)}`,
        { method: "DELETE" },
      ).catch(() => {});
    callbacks.current.onClose();
  };
  cancelRef.current = cancel;

  // Escape closes the dialog; unmount clears the polling timer below.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the page still while the dialog is open (glass overlay).
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Abort an in-flight device/start when the dialog is closed mid-request.
  useEffect(
    () => () => {
      startAbort.current?.abort();
    },
    [],
  );

  // Poll GET /oauth/:provider/attempt/:attemptId with a self-scheduling
  // timeout. A `stopped` flag plus a per-request AbortController prevents
  // duplicate loops or state updates after unmount/cancel.
  useEffect(() => {
    const attemptId = attempt?.attemptId;
    if (!attemptId || stage !== "waiting") return;
    let stopped = false;
    let timer: number | undefined;
    let inFlight: AbortController | null = null;
    let failures = 0;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => {
        void poll();
      }, delay);
    };

    const poll = async () => {
      if (stopped) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const data = await api<OAuthAttemptResponse>(
          `/oauth/${encodeURIComponent(card.id)}/attempt/${encodeURIComponent(attemptId)}`,
          { signal: controller.signal },
        );
        if (stopped) return;
        failures = 0;
        const status =
          typeof data.status === "string" ? data.status : "pending";
        if (status === "connected") {
          stopped = true;
          if (!finished.current) {
            finished.current = true;
            callbacks.current.notify(
              `${shortName} 已连接，可以切换为 OAuth 使用方式。`,
            );
            void (async () => {
              try {
                await callbacks.current.onConnected();
              } catch (error) {
                callbacks.current.notify(
                  `刷新授权状态失败：${(error as Error).message}`,
                );
              } finally {
                callbacks.current.onClose();
              }
            })();
          }
          return;
        }
        if (status === "error" || status === "expired") {
          stopped = true;
          setErrorText(oauthAttemptErrorMessage(status, data.message));
          setStage("error");
          return;
        }
        schedule(pollInterval);
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        failures += 1;
        if (failures >= 3) {
          stopped = true;
          setErrorText(`无法获取授权状态：${(error as Error).message}`);
          setStage("error");
          return;
        }
        schedule(Math.max(pollInterval, 2500));
      } finally {
        if (inFlight === controller) inFlight = null;
      }
    };

    schedule(pollInterval);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      inFlight?.abort();
    };
  }, [attempt?.attemptId, card.id, pollInterval, shortName, stage]);

  // Waiting counter shown next to the indeterminate progress bar.
  useEffect(() => {
    if (stage !== "waiting") {
      setWaitedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setWaitedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [stage, attempt?.attemptId]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  const copyUserCode = async () => {
    const code = attempt?.userCode || "";
    if (!code) return;
    try {
      if (
        typeof navigator === "undefined" ||
        !navigator.clipboard ||
        typeof navigator.clipboard.writeText !== "function"
      ) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(code);
      setCopyFailed(false);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  const startDevice = async () => {
    setErrorText("");
    setCopyFailed(false);
    setStage("starting");
    const controller = new AbortController();
    startAbort.current = controller;
    try {
      const result = await api<OAuthDeviceStartResponse>(
        `/oauth/${encodeURIComponent(card.id)}/device/start`,
        {
          ...json("POST", isWorkbuddy ? { region } : {}),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (!result.attemptId) throw new Error("服务端未返回登录尝试编号");
      setAttempt({
        attemptId: result.attemptId,
        verificationUrl:
          result.verificationUrl ||
          (card.id === "chatgpt" ? CHATGPT_DEVICE_VERIFICATION_URL : ""),
        userCode: result.userCode,
        intervalMs: result.intervalMs,
      });
      setStage("waiting");
    } catch (error) {
      if (controller.signal.aborted) return;
      setErrorText(`发起设备码登录失败：${(error as Error).message}`);
      setStage("error");
    } finally {
      if (startAbort.current === controller) startAbort.current = null;
    }
  };

  // WorkBuddy 浏览器登录：先选区域，再向服务端申请授权 URL；服务端在后台
  // 轮询换取令牌，前端只需轮询 attempt 状态（与 ChatGPT 浏览器登录一致）。
  const startWorkbuddyBrowser = async () => {
    setErrorText("");
    setStage("starting");
    const controller = new AbortController();
    startAbort.current = controller;
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const result = await api<OAuthBrowserStartResponse>(
        `/oauth/${encodeURIComponent(card.id)}/browser/start`,
        {
          ...json("POST", { region }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      if (!result.attemptId) throw new Error("服务端未返回登录尝试编号");
      const url = result.url || result.authorizeUrl || "";
      const popupBlocked = !popup || !url;
      if (popup && url) popup.location.href = url;
      setAttempt({
        attemptId: result.attemptId,
        verificationUrl: url,
        popupBlocked,
      });
      setStage("waiting");
    } catch (error) {
      popup?.close();
      if (controller.signal.aborted) return;
      setErrorText(`发起浏览器登录失败：${(error as Error).message}`);
      setStage("error");
    } finally {
      if (startAbort.current === controller) startAbort.current = null;
    }
  };

  const title =
    flow === "browser"
      ? `浏览器授权 · ${shortName}`
      : `设备码登录 · ${shortName}`;
  const verificationUrl =
    attempt?.verificationUrl ||
    (card.id === "chatgpt" ? CHATGPT_DEVICE_VERIFICATION_URL : "");

  return (
    <div
      className="oauth-dialog-mask"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        className="oauth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-dialog-title"
      >
        <header>
          <div>
            <span className="oauth-dialog-eyebrow">
              OAUTH · {flow === "browser" ? "BROWSER" : "DEVICE CODE"}
            </span>
            <h2 id="oauth-dialog-title">{title}</h2>
            <p className="oauth-dialog-sub">
              {card.name}
              {card.region === "cn" ? " · 国内直连" : " · 境外服务"}
            </p>
          </div>
          <button
            type="button"
            className="oauth-dialog-close"
            aria-label="关闭登录对话框"
            onClick={cancel}
          >
            <X size={18} />
          </button>
        </header>

        {card.mainlandUnavailable && (
          <p className="oauth-dialog-note">
            <ShieldAlert size={16} />
            <span>
              该服务在中国大陆境内不可用，境外网络可能无法完成授权；如多次失败可改用
              API Key 方式。
            </span>
          </p>
        )}

        {stage === "region" && (
          <div className="oauth-dialog-body">
            <p className="oauth-dialog-hint">
              请选择 WorkBuddy
              版本：默认国内版；使用国际版账号或境外网络时可切换国际版。
            </p>
            <div
              className="oauth-dialog-regions"
              role="radiogroup"
              aria-label="WorkBuddy 版本"
            >
              {OAUTH_WORKBUDDY_REGIONS.map((option) => {
                const active = region === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`oauth-dialog-region${active ? " active" : ""}`}
                    onClick={() => setRegion(option.id)}
                  >
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {stage === "starting" && (
          <div className="oauth-dialog-waiting">
            <Loader2 className="oauth-dialog-spin" size={26} />
            <strong>正在申请授权</strong>
            <span>正在向服务端获取登录链接，请稍候…</span>
          </div>
        )}

        {stage === "waiting" && flow === "browser" && (
          <>
            <div className="oauth-dialog-waiting">
              <Loader2 className="oauth-dialog-spin" size={26} />
              <strong>等待浏览器授权完成</strong>
              <span>
                已打开 {shortName} 授权页，完成授权后本窗口会自动更新并关闭。
              </span>
            </div>
            {attempt?.popupBlocked && verificationUrl && (
              <p className="oauth-dialog-note oauth-dialog-note-warn">
                <ShieldAlert size={16} />
                <span>
                  浏览器拦截了自动打开的新标签页，请点击下方链接继续授权。
                </span>
              </p>
            )}
            {verificationUrl ? (
              <a
                className="oauth-dialog-link"
                href={verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <ExternalLink size={16} />
                {attempt?.popupBlocked ? "打开授权页面" : "重新打开授权页面"}
              </a>
            ) : (
              <p className="oauth-dialog-error">
                服务端未返回授权链接，请取消后重试。
              </p>
            )}
            <div className="oauth-dialog-progress-meta">
              <span>
                {attempt?.popupBlocked
                  ? "请在新标签页完成授权"
                  : "已在新标签页打开授权页"}
              </span>
              <span>已等待 {waitedSeconds} 秒 · 每 1.8 秒自动检查授权状态</span>
            </div>
            <div
              className="oauth-dialog-progress"
              role="progressbar"
              aria-label="等待授权结果"
            />
          </>
        )}

        {stage === "waiting" &&
          flow === "device" &&
          (isWorkbuddy ? (
            <>
              <p className="oauth-dialog-hint">
                已为 {oauthWorkbuddyRegionLabel(region)}{" "}
                生成授权链接，请在浏览器打开并完成 WorkBuddy 授权。
              </p>
              {verificationUrl ? (
                <a
                  className="oauth-dialog-link"
                  href={verificationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink size={16} /> 打开 WorkBuddy 授权页
                </a>
              ) : (
                <p className="oauth-dialog-error">
                  服务端未返回授权链接，请重试或改用 API Key。
                </p>
              )}
              <div className="oauth-dialog-waiting">
                <Loader2 className="oauth-dialog-spin" size={24} />
                <strong>在浏览器完成授权后自动完成</strong>
                <span>请保持本窗口打开，授权成功后会自动关闭并刷新状态。</span>
              </div>
              <div className="oauth-dialog-progress-meta">
                <span>等待浏览器中的 WorkBuddy 授权</span>
                <span>已等待 {waitedSeconds} 秒 · 自动检查授权状态</span>
              </div>
              <div
                className="oauth-dialog-progress"
                role="progressbar"
                aria-label="等待授权结果"
              />
            </>
          ) : (
            <>
              <ol className="oauth-dialog-steps">
                <li>
                  在浏览器打开{" "}
                  <a
                    href={verificationUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {verificationUrl}
                  </a>
                </li>
                <li>输入下面的用户码并确认授权</li>
              </ol>
              <div className="oauth-dialog-code-row">
                <code className="oauth-dialog-code">
                  {attempt?.userCode || "— — — —"}
                </code>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => void copyUserCode()}
                  disabled={!attempt?.userCode}
                >
                  {copied ? (
                    <>
                      <Check size={16} /> 已复制
                    </>
                  ) : (
                    <>
                      <Copy size={16} /> 复制用户码
                    </>
                  )}
                </Button>
              </div>
              {!attempt?.userCode && (
                <p className="oauth-dialog-note oauth-dialog-note-warn">
                  <ShieldAlert size={16} />
                  <span>暂未获取到用户码，请先打开验证页查看设备码。</span>
                </p>
              )}
              {copied && (
                <p className="oauth-dialog-ok">
                  <Check size={15} /> 用户码已复制到剪贴板。
                </p>
              )}
              {copyFailed && (
                <p className="oauth-dialog-error">
                  复制失败，请手动选择用户码复制。
                </p>
              )}
              <div className="oauth-dialog-progress-meta">
                <span>等待浏览器中的授权确认</span>
                <span>已等待 {waitedSeconds} 秒 · 自动检查授权状态</span>
              </div>
              <div
                className="oauth-dialog-progress"
                role="progressbar"
                aria-label="等待授权结果"
              />
            </>
          ))}

        {stage === "error" && (
          <>
            <p className="oauth-dialog-error" role="alert">
              {errorText || "OAuth 授权未完成，请重试。"}
            </p>
            <p className="oauth-dialog-hint">
              可以重试登录，或关闭对话框后改用 API Key
              方式；已保存的其他凭证不会受影响。
            </p>
          </>
        )}

        <footer className="oauth-dialog-actions">
          {stage === "region" ? (
            <>
              <Button variant="outline" type="button" onClick={cancel}>
                取消
              </Button>
              {flow === "browser" ? (
                <Button
                  type="button"
                  onClick={() => void startWorkbuddyBrowser()}
                >
                  <Globe size={16} /> 开始浏览器登录
                </Button>
              ) : (
                <Button type="button" onClick={() => void startDevice()}>
                  <Smartphone size={16} /> 开始设备码登录
                </Button>
              )}
            </>
          ) : stage === "error" ? (
            <>
              <Button variant="outline" type="button" onClick={cancel}>
                关闭
              </Button>
              {onRetry && (
                <Button type="button" onClick={onRetry}>
                  重试
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" type="button" onClick={cancel}>
              取消登录
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
