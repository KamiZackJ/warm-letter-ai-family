import { useEffect, useMemo, useState } from "react";
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

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8787/v1").replace(
  /\/$/,
  "",
);

const demoReader: ReaderData = {
  id: "demo-letter",
  recipient: "妈妈",
  draft: {
    title: "写给家的今天",
    greeting: "妈：",
    paragraphs: [
      {
        id: "opening",
        text: "今天下班比平时早一点。我骑车经过河边，刚好碰上很漂亮的晚霞，就停下来拍了一张。风有点凉，但整个人一下子安静了。",
        sourceRefs: ["photo"],
      },
      {
        id: "work",
        text: "这周一直在忙的项目，今天终于完成了第一次演示。还有一些地方要慢慢调整，不过最难的那一步已经走过去了。你不用担心，我最近虽然忙，三餐都有好好吃。",
        sourceRefs: ["desk", "note", "voice"],
      },
      {
        id: "closing",
        text: "周末有空我给你打电话。家里的桂花是不是快开了？记得拍一张给我看看。",
        sourceRefs: ["voice"],
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
      name: "傍晚的河边",
      contentType: "image/png",
      mediaUrl: "/samples/riverside-sunset.png",
    },
    {
      id: "desk",
      type: "screenshot",
      name: "第一次演示",
      contentType: "image/png",
      mediaUrl: "/samples/project-desk.png",
    },
    { id: "note", type: "text", name: "今日小记" },
    { id: "voice", type: "audio", name: "想让妈妈放心", durationSeconds: 18 },
  ],
  replies: [],
};

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

function isMediaExpired(source: Source): boolean {
  if (!source.mediaExpiresAt) return false;
  const expiresAt = new Date(source.mediaExpiresAt).getTime();
  return !Number.isNaN(expiresAt) && expiresAt <= Date.now();
}

function retryableMediaUrl(url: string, attempt: number): string {
  if (attempt === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}warmLetterRetry=${attempt}`;
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
    { signal },
  );
  if (!response.ok) throw await apiErrorFrom(response, "家书暂时无法打开");
  const payload = (await response.json()) as { reader?: ReaderData };
  if (!payload.reader) {
    throw new ApiRequestError("家书数据不完整", 502, "INVALID_READER_RESPONSE");
  }
  return payload.reader;
}

function describeReaderFailure(error: unknown): ReaderFailure {
  if (error instanceof ApiRequestError) {
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
    if (error.code === "INVALID_SHARE_TOKEN" || error.status === 403 || error.status === 404) {
      return {
        title: "无法打开这封家书",
        detail: "读信链接不正确，或这封家书已经不存在。",
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

function App() {
  const [reader, setReader] = useState<ReaderData>(demoReader);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ReaderFailure | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [mediaErrors, setMediaErrors] = useState<Record<string, boolean>>({});
  const [mediaAttempts, setMediaAttempts] = useState<Record<string, number>>({});
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const letterId = params.get("letterId");
  const shareToken = params.get("token");
  const isDemo = !letterId && !shareToken;
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
    if (isDemo) {
      setLoading(false);
      setLoadError(null);
      return;
    }
    if (!letterId || !shareToken) {
      setLoading(false);
      setLoadError({
        title: "读信链接不完整",
        detail: "请重新打开寄信人分享的完整链接。",
        retryable: false,
      });
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    fetchReaderData(letterId, shareToken, controller.signal)
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
  }, [isDemo, letterId, shareToken, loadAttempt]);

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

  const retryMedia = (sourceId: string) => {
    setMediaErrors((current) => ({ ...current, [sourceId]: false }));
    setMediaAttempts((current) => ({ ...current, [sourceId]: (current[sourceId] || 0) + 1 }));
  };

  const sendReply = async () => {
    if (!reply.trim() || submitting) return;
    setReplyError("");
    setSubmitting(true);
    const replyText = reply.trim();
    try {
      if (isDemo) {
        const createdAt = new Date().toISOString();
        setReader((current) => ({
          ...current,
          replies: [
            ...current.replies,
            {
              id: `demo-reply-${createdAt}`,
              text: replyText,
              authorName: "家人",
              createdAt,
            },
          ],
        }));
      } else {
        if (!letterId || !shareToken) throw new Error("读信链接不完整");
        const response = await fetch(
          `${API_BASE_URL}/letters/${encodeURIComponent(letterId)}/replies?token=${encodeURIComponent(shareToken)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: replyText, authorName: "家人" }),
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
        <BookOpenText aria-hidden="true" size={30} strokeWidth={1.6} />
        <p>正在打开家书…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="reader-shell reader-state reader-error" role="alert">
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
              const expired = isMediaExpired(source);
              const failed = mediaErrors[source.id];
              const attempt = mediaAttempts[source.id] || 0;
              return (
                <figure className="memory-photo" key={source.id} data-testid="source-image">
                  {expired ? (
                    <div className="media-fallback" role="status">
                      <AlertCircle aria-hidden="true" size={23} />
                      <span>图片访问已到期</span>
                    </div>
                  ) : failed ? (
                    <div className="media-fallback" role="status" aria-live="polite">
                      <ImageIcon aria-hidden="true" size={23} />
                      <span>图片暂时无法加载</span>
                      <button type="button" onClick={() => retryMedia(source.id)}>
                        <RefreshCw aria-hidden="true" size={15} />
                        重试
                      </button>
                    </div>
                  ) : (
                    <img
                      key={attempt}
                      src={retryableMediaUrl(source.mediaUrl!, attempt)}
                      alt={source.name}
                      width={1200}
                      height={900}
                      loading={index === 0 ? "eager" : "lazy"}
                      fetchPriority={index === 0 ? "high" : "auto"}
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
                const expired = isMediaExpired(source);
                const failed = mediaErrors[source.id];
                const attempt = mediaAttempts[source.id] || 0;
                return (
                  <div className="audio-source" key={source.id} data-testid="source-audio">
                    <div className="audio-source-copy">
                      <strong>{source.name}</strong>
                      {source.durationSeconds !== undefined ? (
                        <span>{formatDuration(source.durationSeconds)}</span>
                      ) : null}
                    </div>
                    {expired ? (
                      <p className="media-inline-error" role="status">
                        语音访问已到期，请向寄信人索取新链接。
                      </p>
                    ) : failed ? (
                      <div className="audio-error-row" role="status" aria-live="polite">
                        <p className="media-inline-error">语音暂时无法播放。</p>
                        <button type="button" onClick={() => retryMedia(source.id)}>
                          <RefreshCw aria-hidden="true" size={15} />
                          重试
                        </button>
                      </div>
                    ) : (
                      <audio
                        key={attempt}
                        controls
                        controlsList="nodownload"
                        preload="metadata"
                        src={retryableMediaUrl(source.mediaUrl!, attempt)}
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
          >
            <span>这封信参考了 {reader.sources.length} 份素材</span>
            <ChevronDown
              aria-hidden="true"
              className={sourcesOpen ? "chevron-open" : ""}
              size={20}
            />
          </button>
          {sourcesOpen ? (
            <div className="source-list">
              {reader.sources.map((source) => {
                const meta = sourceMeta[source.type];
                return (
                  <div className="source-item" key={source.id}>
                    <span className={`source-dot dot-${meta.tone}`} />
                    <div>
                      <strong>{source.name}</strong>
                      <p>
                        {meta.label}素材
                        {source.durationSeconds !== undefined
                          ? ` · ${formatDuration(source.durationSeconds)}`
                          : ""}
                        {source.mediaExpiresAt ? ` · 随链接有效至 ${formatDateTime(source.mediaExpiresAt)}` : ""}
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
                  <strong>{item.authorName}</strong>
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
              <strong>回复已经送达</strong>
              {replyError ? <p>{replyError}</p> : null}
            </div>
          </div>
        ) : (
          <div className="reply-composer">
            <textarea
              data-testid="reply-input"
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              name="reply"
              autoComplete="off"
              placeholder="例如：收到信了，周末给你打电话…"
              maxLength={240}
              aria-label="回复内容"
            />
            {replyError ? (
              <p className="reply-error" role="alert" aria-live="polite">
                {replyError}
              </p>
            ) : null}
            <button
              className="send-button"
              data-testid="reply-submit"
              type="button"
              onClick={sendReply}
              disabled={!reply.trim() || submitting}
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
