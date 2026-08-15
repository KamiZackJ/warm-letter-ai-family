import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AudioLines,
  BookOpenText,
  Check,
  ChevronDown,
  Image as ImageIcon,
  MessageCircle,
  Pause,
  Play,
  RefreshCw,
  Send,
  Volume2,
} from "lucide-react";
import { createRoot } from "react-dom/client";
import { resolveReaderEntry, type ShareParams } from "./reader-entry";
import {
  assertRemoteDeploymentMode,
  resolveWebRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config";
import "./styles.css";

type SourceType = "photo" | "screenshot" | "audio" | "text";

type Source = {
  id: string;
  type: SourceType;
  name: string;
  contentType?: string;
  mediaUrl?: string;
  mediaExpiresAt?: string;
  durationSeconds?: number;
};

type LetterSection = {
  id: string;
  text: string;
  sourceRefs: string[];
};

type Reply = {
  id: string;
  text: string;
  authorName: string;
  authorVerified: boolean;
  createdAt: string;
};

type ReaderData = {
  id: string;
  recipient: string;
  draft: {
    title: string;
    greeting: string;
    paragraphs: LetterSection[];
    closing: string;
    provider?: string;
  };
  publishedAt: string;
  sources: Source[];
  replies: Reply[];
};

type ReaderFailure = {
  title: string;
  detail: string;
  retryable: boolean;
};

type SpeechState = "idle" | "playing" | "paused";

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const runtimeConfig = resolveWebRuntimeConfig({
  appEnv: import.meta.env.VITE_APP_ENV,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  demoEnabled: import.meta.env.VITE_DEMO_ENABLED,
  expectedMode: import.meta.env.MODE,
});

const API_BASE_URL = runtimeConfig.apiBaseUrl;

const demoReader: ReaderData | null = __WARM_LETTER_DEMO_BUILD__
  ? {
  id: "demo-letter",
  recipient: "妈妈",
  draft: {
    title: "第一次做你常做的番茄炒蛋",
    greeting: "妈：",
    paragraphs: [
      {
        id: "opening",
        text: "周末我第一次学着做你常做的番茄炒蛋。端上桌的时候，我拍了一张照片，想让你看看这个小进步。",
        sourceRefs: ["photo", "note"],
      },
      {
        id: "work",
        text: "最近工作虽然有点忙，但我每天都有按时吃饭。那天把饭菜摆好时，我也觉得自己正在慢慢学会照顾生活。",
        sourceRefs: ["note", "voice"],
      },
      {
        id: "closing",
        text: "你不用担心我。周末学会这道菜以后，我想再练几次，把这个熟悉的味道做得更好一点。",
        sourceRefs: ["note", "voice"],
      },
    ],
    closing: "想你的，阿宁",
    provider: "demo-ai",
  },
  publishedAt: "2026-08-14T10:00:00.000Z",
  sources: [
    {
      id: "photo",
      type: "photo",
      name: "合成演示图：周末做饭",
      contentType: "image/png",
      mediaUrl: "/synthetic-cooking-demo.png",
    },
    { id: "note", type: "text", name: "最近的小事" },
    {
      id: "voice",
      type: "audio",
      name: "系统合成演示语音",
      contentType: "audio/wav",
      mediaUrl: "/synthetic-voice-demo.wav",
      durationSeconds: 12,
    },
  ],
  replies: [],
    }
  : null;

const emptyReader: ReaderData = {
  id: "",
  recipient: "",
  draft: {
    title: "",
    greeting: "",
    paragraphs: [],
    closing: "",
  },
  publishedAt: "",
  sources: [],
  replies: [],
};

let deploymentCheck: Promise<void> | null = null;

async function verifyRemoteDeploymentMode(signal?: AbortSignal): Promise<void> {
  if (!deploymentCheck) {
    deploymentCheck = fetch(runtimeConfig.healthUrl, {
      signal,
      cache: "no-store",
      referrerPolicy: "no-referrer",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new ApiRequestError(
            "无法核对服务端运行环境，请稍后重试",
            response.status,
            "HEALTH_UNAVAILABLE",
          );
        }
        let payload: { deploymentMode?: unknown };
        try {
          payload = (await response.json()) as { deploymentMode?: unknown };
        } catch {
          throw new ApiRequestError(
            "服务端环境信息无效，请稍后重试",
            502,
            "HEALTH_UNAVAILABLE",
          );
        }
        assertRemoteDeploymentMode(runtimeConfig.deploymentMode, payload.deploymentMode);
      })
      .catch((error) => {
        deploymentCheck = null;
        throw error;
      });
  }
  return deploymentCheck;
}

const sourceMeta: Record<SourceType, { label: string; tone: "coral" | "sage" | "blue" }> = {
  photo: { label: "照片", tone: "coral" },
  screenshot: { label: "截图", tone: "blue" },
  audio: { label: "语音", tone: "blue" },
  text: { label: "文字", tone: "sage" },
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("/", ".");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(value?: number): string {
  if (value === undefined) return "";
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60)
    .toString()
    .padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function isMediaExpired(source: Source, now = Date.now()): boolean {
  if (!source.mediaExpiresAt) return false;
  const expiresAt = new Date(source.mediaExpiresAt).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

async function apiErrorFrom(response: Response, fallback: string): Promise<ApiRequestError> {
  let code: string | undefined;
  let message = fallback;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    code = payload.error?.code;
    message = payload.error?.message || fallback;
  } catch {
    // Keep the user-facing fallback when the server response is not JSON.
  }
  return new ApiRequestError(message, response.status, code);
}

async function fetchReaderData(
  letterId: string,
  shareToken: string,
  signal?: AbortSignal,
): Promise<ReaderData> {
  const response = await fetch(
    `${API_BASE_URL}/letters/${encodeURIComponent(letterId)}/reader?token=${encodeURIComponent(shareToken)}`,
    { signal, referrerPolicy: "no-referrer" },
  );
  if (!response.ok) throw await apiErrorFrom(response, "家书暂时无法打开");
  const payload = (await response.json()) as { reader?: ReaderData };
  if (!payload.reader) {
    throw new ApiRequestError("家书数据不完整", 502, "INVALID_READER_RESPONSE");
  }
  return payload.reader;
}

function describeReaderFailure(error: unknown): ReaderFailure {
  if (error instanceof RuntimeConfigurationError) {
    return {
      title: "运行环境不匹配",
      detail: `${error.message}。请使用与该链接一致的服务环境。`,
      retryable: false,
    };
  }
  if (error instanceof ApiRequestError) {
    if (error.code === "HEALTH_UNAVAILABLE") {
      return {
        title: "服务暂时不可用",
        detail: error.message,
        retryable: true,
      };
    }
    if (error.code === "SHARE_TOKEN_REVOKED") {
      return {
        title: "这封家书已停止分享",
        detail: "寄信人已经撤销了这个链接。需要对方重新分享后才能继续阅读。",
        retryable: false,
      };
    }
    if (error.code === "SHARE_TOKEN_EXPIRED") {
      return {
        title: "读信链接已过期",
        detail: "为保护家书内容，这个链接已经失效。请向寄信人索取新链接。",
        retryable: false,
      };
    }
    if (error.code === "PUBLIC_ACCESS_NOT_FOUND" || error.status === 403 || error.status === 404) {
      return {
        title: "无法打开这封家书",
        detail: "读信链接不正确，或这封家书已经不存在。",
        retryable: false,
      };
    }
    if (error.code === "SHARE_UNAVAILABLE") {
      return {
        title: "这封家书暂时无法阅读",
        detail: "寄信人分享的内容暂时不可用，请稍后再试或联系寄信人。",
        retryable: false,
      };
    }
    return {
      title: "家书暂时无法打开",
      detail: error.message,
      retryable: error.status >= 500,
    };
  }

  return {
    title: "网络连接不稳定",
    detail: "请检查网络后再试一次。",
    retryable: true,
  };
}

function readShareParams(): ShareParams {
  const query = new URLSearchParams(window.location.search);
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const queryToken = query.get("token");
  return {
    letterId: query.get("letterId") || fragment.get("letterId"),
    shareToken: queryToken || fragment.get("token"),
    cameFromQuery: Boolean(queryToken),
  };
}

function EnvironmentBadge() {
  return (
    <div
      className={`environment-badge environment-badge-${runtimeConfig.deploymentMode}`}
      role="status"
      aria-label={`${runtimeConfig.environmentLabel}，${runtimeConfig.environmentDetail}`}
    >
      <strong>{runtimeConfig.environmentLabel}</strong>
      <span>{runtimeConfig.environmentDetail}</span>
    </div>
  );
}

function App() {
  const [reader, setReader] = useState<ReaderData>(demoReader || emptyReader);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ReaderFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const [mediaAttempts, setMediaAttempts] = useState<Record<string, number>>({});
  const [mediaRefreshing, setMediaRefreshing] = useState<Record<string, boolean>>({});
  const [mediaNow, setMediaNow] = useState(() => Date.now());
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [sentLocally, setSentLocally] = useState(false);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);

  const shareParams = useMemo(readShareParams, []);
  const { letterId, shareToken } = shareParams;
  const readerEntry = useMemo(
    () => resolveReaderEntry(runtimeConfig, shareParams),
    [shareParams],
  );
  const isDemo = __WARM_LETTER_DEMO_BUILD__ && readerEntry.kind === "demo";
  const sourceMap = useMemo(
    () => new Map(reader.sources.map((source) => [source.id, source])),
    [reader.sources],
  );
  const imageSources = useMemo(
    () =>
      reader.sources.filter(
        (source) =>
          (source.type === "photo" || source.type === "screenshot") && Boolean(source.mediaUrl),
      ),
    [reader.sources],
  );
  const audioSources = useMemo(
    () => reader.sources.filter((source) => source.type === "audio" && Boolean(source.mediaUrl)),
    [reader.sources],
  );
  const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!shareParams.cameFromQuery || !letterId || !shareToken) return;
    const fragment = new URLSearchParams({ letterId, token: shareToken });
    window.history.replaceState(null, "", `${window.location.pathname}#${fragment.toString()}`);
  }, [letterId, shareParams.cameFromQuery, shareToken]);

  useEffect(() => {
    if (readerEntry.kind === "demo") {
      if (!demoReader) {
        setLoadError({
          title: "演示配置不可用",
          detail: "当前构建不包含演示数据，请重新使用正确的演示构建。",
          retryable: false,
        });
        setLoading(false);
        return;
      }
      setReader(demoReader);
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (readerEntry.kind === "error") {
      setLoading(false);
      setLoadError({
        title: readerEntry.title,
        detail: readerEntry.detail,
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    verifyRemoteDeploymentMode(controller.signal)
      .then(() =>
        fetchReaderData(readerEntry.letterId, readerEntry.shareToken, controller.signal),
      )
      .then((nextReader) => {
        setReader(nextReader);
        setMediaErrors({});
        setMediaAttempts({});
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(describeReaderFailure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [readerEntry, loadAttempt]);

  useEffect(() => {
    const expirations = reader.sources
      .map((source) => (source.mediaExpiresAt ? Date.parse(source.mediaExpiresAt) : Number.NaN))
      .filter((value) => Number.isFinite(value) && value > Date.now());
    if (expirations.length === 0) return;
    const timeout = window.setTimeout(
      () => setMediaNow(Date.now()),
      Math.max(50, Math.min(...expirations) - Date.now() + 50),
    );
    return () => window.clearTimeout(timeout);
  }, [reader.sources]);

  useEffect(() => {
    return () => {
      if (speechSupported) window.speechSynthesis.cancel();
    };
  }, [speechSupported]);

  const toggleSpeech = () => {
    if (!speechSupported) return;
    if (speechState === "playing") {
      window.speechSynthesis.pause();
      setSpeechState("paused");
      return;
    }
    if (speechState === "paused") {
      window.speechSynthesis.resume();
      setSpeechState("playing");
      return;
    }

    const utterance = new SpeechSynthesisUtterance(
      [
        reader.draft.greeting,
        ...reader.draft.paragraphs.map((paragraph) => paragraph.text),
        reader.draft.closing,
      ].join("。"),
    );
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    utterance.onend = () => setSpeechState("idle");
    utterance.onerror = () => setSpeechState("idle");
    window.speechSynthesis.speak(utterance);
    setSpeechState("playing");
  };

  const markMediaLoaded = (sourceId: string) => {
    setMediaErrors((current) => ({ ...current, [sourceId]: false }));
  };

  const markMediaFailed = (sourceId: string) => {
    setMediaErrors((current) => ({ ...current, [sourceId]: true }));
  };

  const retryMedia = async (sourceId: string) => {
    setMediaErrors((current) => ({ ...current, [sourceId]: false }));
    if (isDemo || !letterId || !shareToken) {
      setMediaAttempts((current) => ({ ...current, [sourceId]: (current[sourceId] || 0) + 1 }));
      return;
    }
    setMediaRefreshing((current) => ({ ...current, [sourceId]: true }));
    try {
      const refreshedReader = await fetchReaderData(letterId, shareToken);
      setReader(refreshedReader);
      setMediaNow(Date.now());
      setMediaErrors({});
      setMediaAttempts((current) => ({ ...current, [sourceId]: (current[sourceId] || 0) + 1 }));
    } catch {
      setMediaErrors((current) => ({ ...current, [sourceId]: true }));
    } finally {
      setMediaRefreshing((current) => ({ ...current, [sourceId]: false }));
    }
  };

  const sendReply = async () => {
    if (submitting) return;
    if (!reply.trim()) {
      setReplyError("请先写一句回复。");
      replyInputRef.current?.focus();
      return;
    }
    setReplyError("");
    setSubmitting(true);
    setSentLocally(false);
    const replyText = reply.trim();
    try {
      if (__WARM_LETTER_DEMO_BUILD__ && isDemo) {
        const createdAt = new Date().toISOString();
        setReader((current) => ({
          ...current,
          replies: [
            ...current.replies,
            {
              id: `demo-reply-${createdAt}`,
              text: replyText,
              authorName: "家人",
              authorVerified: false,
              createdAt,
            },
          ],
        }));
        setSentLocally(true);
      } else {
        if (!letterId || !shareToken) throw new Error("读信链接不完整");
        const response = await fetch(
          `${API_BASE_URL}/letters/${encodeURIComponent(letterId)}/replies?token=${encodeURIComponent(shareToken)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: replyText, authorName: "家人" }),
            referrerPolicy: "no-referrer",
          },
        );
        if (!response.ok) throw await apiErrorFrom(response, "回复发送失败，请稍后重试");

        try {
          const refreshedReader = await fetchReaderData(letterId, shareToken);
          setReader(refreshedReader);
        } catch {
          setReplyError("回复已送达，但回信列表暂时无法刷新。重新打开链接即可查看。");
        }
      }
      setSent(true);
      setReply("");
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const failure = describeReaderFailure(error);
        setReplyError(
          error.code === "SHARE_TOKEN_REVOKED" || error.code === "SHARE_TOKEN_EXPIRED"
            ? failure.detail
            : error.message,
        );
      } else {
        setReplyError(error instanceof Error ? error.message : "回复发送失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main className="reader-shell reader-state" aria-live="polite">
        <EnvironmentBadge />
        <BookOpenText aria-hidden="true" size={30} strokeWidth={1.6} />
        <p>正在打开家书…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="reader-shell reader-state reader-error" role="alert">
        <EnvironmentBadge />
        <AlertCircle aria-hidden="true" size={34} strokeWidth={1.6} />
        <h1>{loadError.title}</h1>
        <p>{loadError.detail}</p>
        {loadError.retryable ? (
          <button className="retry-button" type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
            <RefreshCw aria-hidden="true" size={17} />
            重新加载
          </button>
        ) : null}
      </main>
    );
  }

  const speechLabel =
    speechState === "playing"
      ? "暂停系统朗读"
      : speechState === "paused"
        ? "继续系统朗读"
        : "播放系统朗读";

  return (
    <main className="reader-shell">
      <EnvironmentBadge />
      <a className="skip-link" href="#letter-content">
        跳到家书正文
      </a>
      <header className="topbar">
        <div className="brand">
          <BookOpenText aria-hidden="true" size={22} strokeWidth={1.8} />
          <span>暖笺</span>
        </div>
        <span className="date">{formatDate(reader.publishedAt)}</span>
      </header>

      <article id="letter-content" className="letter" aria-labelledby="letter-title" tabIndex={-1}>
        <div className="letter-heading">
          <p className="recipient">写给{reader.recipient}</p>
          <h1 id="letter-title">{reader.draft.title}</h1>
          <p className="lead">由生活素材整理，经本人确认后寄出</p>
        </div>

        <section className="voice-bar" aria-label="系统语音朗读">
          <button
            className="icon-button play-button"
            data-testid="voice-toggle"
            type="button"
            onClick={toggleSpeech}
            disabled={!speechSupported}
            aria-label={speechLabel}
            title={speechLabel}
          >
            {speechState === "playing" ? (
              <Pause aria-hidden="true" size={20} fill="currentColor" />
            ) : (
              <Play aria-hidden="true" size={20} fill="currentColor" />
            )}
          </button>
          <div className="voice-copy">
            <strong>
              {speechState === "playing"
                ? "正在系统朗读"
                : speechState === "paused"
                  ? "系统朗读已暂停"
                  : "听这封家书"}
            </strong>
            <span>{speechSupported ? "设备系统语音 · 不克隆家人声音" : "当前浏览器不支持系统朗读"}</span>
          </div>
          <Volume2 aria-hidden="true" size={22} strokeWidth={1.6} />
        </section>

        {imageSources.length > 0 ? (
          <section
            className={`memory-strip ${imageSources.length === 1 ? "memory-strip-single" : ""}`}
            aria-label="家书图片素材"
          >
            {imageSources.map((source, index) => {
              const expired = isMediaExpired(source, mediaNow);
              const failed = mediaErrors[source.id];
              const attempt = mediaAttempts[source.id] || 0;
              const refreshing = mediaRefreshing[source.id];
              return (
                <figure className="memory-photo" key={source.id} data-testid="source-image">
                  {expired ? (
                    <div className="media-fallback" role="status">
                      <AlertCircle aria-hidden="true" size={23} />
                      <span>图片访问已到期</span>
                      <button
                        type="button"
                        disabled={refreshing}
                        onClick={() => void retryMedia(source.id)}
                      >
                        <RefreshCw aria-hidden="true" size={15} />
                        {refreshing ? "刷新中…" : "重新获取"}
                      </button>
                    </div>
                  ) : failed ? (
                    <div className="media-fallback" role="status" aria-live="polite">
                      <ImageIcon aria-hidden="true" size={23} />
                      <span>图片暂时无法加载</span>
                      <button
                        type="button"
                        disabled={refreshing}
                        onClick={() => void retryMedia(source.id)}
                      >
                        <RefreshCw aria-hidden="true" size={15} />
                        {refreshing ? "刷新中…" : "重新获取"}
                      </button>
                    </div>
                  ) : (
                    <img
                      key={attempt}
                      src={source.mediaUrl!}
                      alt={source.name}
                      width={640}
                      height={480}
                      loading={index === 0 ? "eager" : "lazy"}
                      fetchPriority={index === 0 ? "high" : "auto"}
                      referrerPolicy="no-referrer"
                      onLoad={() => markMediaLoaded(source.id)}
                      onError={() => markMediaFailed(source.id)}
                    />
                  )}
                  <figcaption>{source.name}</figcaption>
                </figure>
              );
            })}
          </section>
        ) : null}

        {audioSources.length > 0 ? (
          <section className="original-audio" aria-labelledby="original-audio-title">
            <div className="media-section-heading">
              <AudioLines aria-hidden="true" size={21} strokeWidth={1.7} />
              <div>
                <h2 id="original-audio-title">原始语音</h2>
                <p>寄信人随素材留下的声音</p>
              </div>
            </div>
            <div className="audio-list">
              {audioSources.map((source) => {
                const expired = isMediaExpired(source, mediaNow);
                const failed = mediaErrors[source.id];
                const attempt = mediaAttempts[source.id] || 0;
                const refreshing = mediaRefreshing[source.id];
                return (
                  <div className="audio-source" key={source.id} data-testid="source-audio">
                    <div className="audio-source-copy">
                      <strong>{source.name}</strong>
                      {source.durationSeconds !== undefined ? (
                        <span>{formatDuration(source.durationSeconds)}</span>
                      ) : null}
                    </div>
                    {expired ? (
                      <div className="audio-error-row" role="status" aria-live="polite">
                        <p className="media-inline-error">语音访问已到期。</p>
                        <button
                          type="button"
                          disabled={refreshing}
                          onClick={() => void retryMedia(source.id)}
                        >
                          <RefreshCw aria-hidden="true" size={15} />
                          {refreshing ? "刷新中…" : "重新获取"}
                        </button>
                      </div>
                    ) : failed ? (
                      <div className="audio-error-row" role="status" aria-live="polite">
                        <p className="media-inline-error">语音暂时无法播放。</p>
                        <button
                          type="button"
                          disabled={refreshing}
                          onClick={() => void retryMedia(source.id)}
                        >
                          <RefreshCw aria-hidden="true" size={15} />
                          {refreshing ? "刷新中…" : "重新获取"}
                        </button>
                      </div>
                    ) : (
                      <audio
                        key={attempt}
                        controls
                        controlsList="nodownload"
                        preload="metadata"
                        src={source.mediaUrl!}
                        aria-label={`播放原始语音：${source.name}`}
                        onCanPlay={() => markMediaLoaded(source.id)}
                        onError={() => markMediaFailed(source.id)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <div className="letter-body">
          <p className="salutation">{reader.draft.greeting}</p>
          {reader.draft.paragraphs.map((section) => (
            <div className="letter-section" key={section.id}>
              <p>{section.text}</p>
              <div className="source-row" aria-label="段落来源">
                {section.sourceRefs.map((sourceId) => {
                  const source = sourceMap.get(sourceId);
                  if (!source) return null;
                  const meta = sourceMeta[source.type];
                  return (
                    <span className={`source-chip source-${meta.tone}`} key={source.id}>
                      {meta.label} · {source.name}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
          <p className="signature">{reader.draft.closing}</p>
        </div>

        <section className="source-panel">
          <button
            className="source-toggle"
            data-testid="source-toggle"
            type="button"
            onClick={() => setSourcesOpen((value) => !value)}
            aria-expanded={sourcesOpen}
            aria-controls="source-list"
          >
            <span>这封信参考了 {reader.sources.length} 份素材</span>
            <ChevronDown
              aria-hidden="true"
              className={sourcesOpen ? "chevron-open" : ""}
              size={20}
            />
          </button>
          {sourcesOpen ? (
            <div className="source-list" id="source-list">
              {reader.sources.map((source) => {
                const meta = sourceMeta[source.type];
                return (
                  <div className="source-item" key={source.id}>
                    <span aria-hidden="true" className={`source-dot dot-${meta.tone}`} />
                    <div>
                      <strong>{source.name}</strong>
                      <p>
                        {meta.label}素材
                        {source.durationSeconds !== undefined
                          ? ` · ${formatDuration(source.durationSeconds)}`
                          : ""}
                        {source.mediaExpiresAt ? ` · 媒体访问有效至 ${formatDateTime(source.mediaExpiresAt)}` : ""}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      </article>

      <section className="reply-section" aria-labelledby="reply-title">
        <div className="reply-heading">
          <MessageCircle aria-hidden="true" size={24} strokeWidth={1.7} />
          <div>
            <h2 id="reply-title">回一句吧</h2>
            <p>你的回复会留在这封家书里。</p>
          </div>
        </div>

        {reader.replies.length > 0 ? (
          <section className="reply-history" aria-label="家人的回复">
            {reader.replies.map((item) => (
              <article className="reply-item" key={item.id}>
                <div>
                  <span className="reply-author">
                    <strong>{item.authorName}</strong>
                    {!item.authorVerified ? <small>未验证身份</small> : null}
                  </span>
                  <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                </div>
                <p>{item.text}</p>
              </article>
            ))}
          </section>
        ) : null}

        {sent ? (
          <div className="sent-state" role="status">
            <Check aria-hidden="true" size={22} />
            <div>
              <strong>
                {__WARM_LETTER_DEMO_BUILD__ && sentLocally
                  ? "演示回复已保存在本页"
                  : "回复已经送达"}
              </strong>
              {__WARM_LETTER_DEMO_BUILD__ && sentLocally ? (
                <p>这条回复没有发送给任何人，刷新页面后会消失。</p>
              ) : null}
              {replyError ? <p>{replyError}</p> : null}
            </div>
          </div>
        ) : (
          <div className="reply-composer">
            <textarea
              ref={replyInputRef}
              data-testid="reply-input"
              value={reply}
              onChange={(event) => {
                setReply(event.target.value);
                if (replyError) setReplyError("");
              }}
              name="reply"
              autoComplete="off"
              placeholder="例如：收到信了，周末给你打电话…"
              maxLength={240}
              aria-label="回复内容"
              aria-invalid={Boolean(replyError)}
              aria-describedby={replyError ? "reply-error" : undefined}
            />
            {replyError ? (
              <p id="reply-error" className="reply-error" role="alert" aria-live="polite">
                {replyError}
              </p>
            ) : null}
            <button
              className="send-button"
              data-testid="reply-submit"
              type="button"
              onClick={sendReply}
              disabled={submitting}
            >
              <Send aria-hidden="true" size={18} />
              {submitting ? "发送中…" : "发送回复"}
            </button>
          </div>
        )}
      </section>

      <footer>AI 辅助整理 · 由本人确认后寄出 · 素材可追溯</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
