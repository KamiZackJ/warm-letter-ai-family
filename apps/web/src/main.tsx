import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
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
import { ApiRequestError, apiErrorFrom } from "./api-request";
import { resolveReaderEntry, type ShareParams } from "./reader-entry";
import {
  readReaderFontSize,
  type ReaderFontSize,
  writeReaderFontSize,
} from "./reader-font-size";
import { installReplyDraftGuard } from "./reply-draft-guard";
import {
  acquireReplyAttempt,
  appendReply,
  mergeReaderPreservingReplies,
  postReply,
  retainReplyAttemptForDraft,
  type ReplyAttempt,
  type ReplyRecord,
} from "./reply-flow";
import {
  assertRemoteDeploymentMode,
  resolveWebRuntimeConfig,
  RuntimeConfigurationError,
} from "./runtime-config";
import "./styles.css";

type SourceType = "photo" | "screenshot" | "audio" | "text";
type ParagraphSourceAttribution =
  | "ai"
  | "sources-confirmed"
  | "user-supplied"
  | "needs-review";

type Source = {
  id: string;
  type: SourceType;
  name: string;
  alt?: string;
  contentType?: string;
  mediaUrl?: string;
  mediaExpiresAt?: string;
  durationSeconds?: number;
  imageDisplay?: "cover" | "contain";
  imageLayout?: "landscape" | "portrait";
};

type LetterSection = {
  id: string;
  text: string;
  sourceRefs: string[];
  sourceAttribution?: ParagraphSourceAttribution;
  sourceAttributionLabel?: string;
};

type ReaderData = {
  id: string;
  recipient: string;
  draft: {
    title: string;
    greeting: string;
    paragraphs: LetterSection[];
    closing: string;
    signature: string;
    provider?: string;
  };
  publishedAt: string;
  sources: Source[];
  replies: ReplyRecord[];
};

type ReaderFailure = {
  title: string;
  detail: string;
  retryable: boolean;
};

type SpeechState = "idle" | "playing" | "paused";

const REPLY_PREVIEW_COUNT = 3;

const readerFontSizeOptions: ReadonlyArray<{ value: ReaderFontSize; label: string }> = [
  { value: "standard", label: "标准" },
  { value: "large", label: "大字" },
  { value: "extra", label: "特大" },
];

function skipToLetterContent(event: MouseEvent<HTMLAnchorElement>): void {
  event.preventDefault();
  const content = document.getElementById("letter-content");
  if (!content) return;
  content.focus({ preventScroll: true });
  content.scrollIntoView({ block: "start" });
}

const runtimeConfig = resolveWebRuntimeConfig({
  appEnv: import.meta.env.VITE_APP_ENV,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  demoEnabled: import.meta.env.VITE_DEMO_ENABLED,
  demoCase: import.meta.env.VITE_DEMO_CASE,
  expectedMode: import.meta.env.MODE,
});

const API_BASE_URL = runtimeConfig.apiBaseUrl;

const syntheticDemoReader: ReaderData = {
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
    closing: "愿你平安顺心，等我们下次再慢慢聊。",
    signature: "想你的，阿宁",
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
};

function createCase001DemoReader(caseData: ControlledCase001BuildData): ReaderData {
  const bodyParts = caseData.recommendedDraftBody
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (bodyParts.length < 3) {
    throw new Error("受控 CASE-001 推荐审核稿格式不符合预期");
  }
  const [greeting, ...remainingParts] = bodyParts;
  const signature = remainingParts.pop()!;
  const paragraphs = remainingParts;
  const recipient = greeting.replace(/^亲爱的/, "").replace(/[：:]$/, "").trim() || "家里人";

  return {
    id: "case-001-reader-demo",
    recipient,
    draft: {
      title: caseData.title,
      greeting,
      paragraphs: paragraphs.map((text, index) => {
        const evidence = caseData.recommendedDraftParagraphs[index];
        if (!evidence) {
          throw new Error("受控 CASE-001 推荐审核稿缺少段落依据");
        }
        return {
          id: `case-001-recommended-a-${index + 1}`,
          text,
          sourceRefs: evidence.sourceIds,
          sourceAttribution: "sources-confirmed",
          sourceAttributionLabel: evidence.attributionLabel,
        };
      }),
      closing: "",
      signature,
      provider: caseData.provenanceLabel,
    },
    publishedAt: "2026-08-28T00:00:00.000Z",
    sources: [
      {
        id: "case-001-photo",
        type: "photo",
        name: "队友提供生活照片（隐私裁切图）",
        alt: "队友生活照片的隐私裁切图，只保留货架、商品与 9.9 元价签",
        contentType: "image/jpeg",
        mediaUrl: `/${caseData.photoFile}`,
        imageDisplay: "contain",
        imageLayout: "portrait",
      },
      {
        id: "case-001-audio",
        type: "audio",
        name: "队友提供示例语音（原始 m4a）",
        contentType: "audio/mp4",
        mediaUrl: `/${caseData.audioFile}`,
        durationSeconds: caseData.audioDurationSeconds,
      },
    ],
    replies: [],
  };
}

const case001DemoReader = __WARM_LETTER_CONTROLLED_CASE_001__
  ? createCase001DemoReader(__WARM_LETTER_CONTROLLED_CASE_001__)
  : null;

const demoReader: ReaderData | null = __WARM_LETTER_DEMO_BUILD__
  ? __WARM_LETTER_DEMO_CASE__ === "case-001"
    ? case001DemoReader
    : syntheticDemoReader
  : null;

const emptyReader: ReaderData = {
  id: "",
  recipient: "",
  draft: {
    title: "",
    greeting: "",
    paragraphs: [],
    closing: "",
    signature: "",
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

function paragraphAttribution(section: LetterSection): ParagraphSourceAttribution {
  return section.sourceAttribution ?? "ai";
}

function paragraphAttributionLabel(section: LetterSection): string {
  if (section.sourceAttributionLabel) return section.sourceAttributionLabel;
  switch (paragraphAttribution(section)) {
    case "sources-confirmed":
      return "写信人修改，已重新核对依据";
    case "user-supplied":
      return "写信人补充，无素材依据";
    case "needs-review":
      return "修改后待核对依据";
    case "ai":
      return "AI 根据素材整理";
  }
}

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
  const [replyHistoryExpanded, setReplyHistoryExpanded] = useState(false);
  const [readerFontSize, setReaderFontSize] = useState(readReaderFontSize);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const replyDraftRef = useRef("");
  const replyAttemptRef = useRef<ReplyAttempt | null>(null);
  const replyControllerRef = useRef<AbortController | null>(null);
  const mediaControllersRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(true);

  const shareParams = useMemo(readShareParams, []);
  const { letterId, shareToken } = shareParams;
  const readerEntry = useMemo(
    () => resolveReaderEntry(runtimeConfig, shareParams),
    [shareParams],
  );
  const isDemo = __WARM_LETTER_DEMO_BUILD__ && readerEntry.kind === "demo";
  const isControlledCase001Demo = isDemo && __WARM_LETTER_DEMO_CASE__ === "case-001";
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
  const hiddenReplyCount = Math.max(0, reader.replies.length - REPLY_PREVIEW_COUNT);
  const visibleReplies = replyHistoryExpanded
    ? reader.replies
    : reader.replies.slice(-REPLY_PREVIEW_COUNT);
  const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      replyControllerRef.current?.abort();
      for (const controller of mediaControllersRef.current) controller.abort();
      mediaControllersRef.current.clear();
    };
  }, []);

  useEffect(() => installReplyDraftGuard(() => replyDraftRef.current), []);

  useEffect(() => {
    setReplyHistoryExpanded(false);
  }, [reader.id]);

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
        reader.draft.signature,
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
    const controller = new AbortController();
    mediaControllersRef.current.add(controller);
    setMediaRefreshing((current) => ({ ...current, [sourceId]: true }));
    try {
      const refreshedReader = await fetchReaderData(letterId, shareToken, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setReader((current) => mergeReaderPreservingReplies(refreshedReader, current));
      setMediaNow(Date.now());
      setMediaErrors({});
      setMediaAttempts((current) => ({ ...current, [sourceId]: (current[sourceId] || 0) + 1 }));
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      setMediaErrors((current) => ({ ...current, [sourceId]: true }));
    } finally {
      mediaControllersRef.current.delete(controller);
      if (mountedRef.current) {
        setMediaRefreshing((current) => ({ ...current, [sourceId]: false }));
      }
    }
  };

  const sendReply = async () => {
    if (submitting || replyControllerRef.current) return;
    if (!reply.trim()) {
      setReplyError("请先写一句回复。");
      replyInputRef.current?.focus();
      return;
    }
    setReplyError("");
    setSubmitting(true);
    setSent(false);
    setSentLocally(false);
    const attempt = acquireReplyAttempt(replyAttemptRef.current, reply);
    replyAttemptRef.current = attempt;
    const controller = new AbortController();
    replyControllerRef.current = controller;
    try {
      let createdReply: ReplyRecord;
      let savedLocally = false;
      if (__WARM_LETTER_DEMO_BUILD__ && isDemo) {
        const createdAt = new Date().toISOString();
        createdReply = {
          id: `demo-reply-${createdAt}`,
          text: attempt.text,
          authorName: "家人",
          authorVerified: false,
          createdAt,
        };
        savedLocally = true;
      } else {
        if (!letterId || !shareToken) throw new Error("读信链接不完整");
        createdReply = await postReply({
          apiBaseUrl: API_BASE_URL,
          letterId,
          shareToken,
          text: attempt.text,
          authorName: "家人",
          requestKey: attempt.requestKey,
          signal: controller.signal,
        });
      }

      if (!mountedRef.current || controller.signal.aborted) return;
      setReader((current) => ({
        ...current,
        replies: appendReply(current.replies, createdReply),
      }));
      setSentLocally(savedLocally);
      if (replyAttemptRef.current?.requestKey === attempt.requestKey) {
        replyAttemptRef.current = null;
      }
      if (replyDraftRef.current.trim() === attempt.text) {
        replyDraftRef.current = "";
        setReply("");
        setSent(true);
      }
    } catch (error) {
      if (controller.signal.aborted || !mountedRef.current) return;
      if (error instanceof ApiRequestError) {
        if (
          error.code === "IDEMPOTENCY_KEY_REUSED" &&
          replyAttemptRef.current?.requestKey === attempt.requestKey
        ) {
          replyAttemptRef.current = null;
        }
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
      if (replyControllerRef.current === controller) replyControllerRef.current = null;
      if (mountedRef.current) setSubmitting(false);
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

  const selectReaderFontSize = (value: ReaderFontSize) => {
    setReaderFontSize(value);
    writeReaderFontSize(value);
  };

  return (
    <main className="reader-shell" data-reader-font-size={readerFontSize}>
      <EnvironmentBadge />
      <a className="skip-link" href="#letter-content" onClick={skipToLetterContent}>
        跳到家书正文
      </a>
      <header className="topbar">
        <div className="brand">
          <BookOpenText aria-hidden="true" size={22} strokeWidth={1.8} />
          <span>暖笺</span>
        </div>
        <span className="date">{formatDate(reader.publishedAt)}</span>
      </header>

      <div className="reader-settings">
        <span className="reader-settings-label" id="reader-font-size-label">
          阅读字号
        </span>
        <div
          className="reader-font-size-control"
          role="group"
          aria-labelledby="reader-font-size-label"
        >
          {readerFontSizeOptions.map((option) => (
            <button
              className="reader-font-size-button"
              data-testid={`reader-font-size-${option.value}`}
              type="button"
              key={option.value}
              aria-pressed={readerFontSize === option.value}
              onClick={() => selectReaderFontSize(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <article id="letter-content" className="letter" aria-labelledby="letter-title" tabIndex={-1}>
        <div className="letter-heading">
          <p className="recipient">写给{reader.recipient}</p>
          <h1 id="letter-title">{reader.draft.title}</h1>
          <p className="lead">由生活素材整理，经本人确认后寄出</p>
          {isControlledCase001Demo ? (
            <p className="case-provenance" role="note">
              已接入队友提供材料：隐私裁切照片、原始示例语音与固定审核稿
            </p>
          ) : null}
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
              const imageLayout =
                source.imageLayout || (source.type === "screenshot" ? "portrait" : "landscape");
              const imageDisplay =
                source.imageDisplay || (source.type === "screenshot" ? "contain" : "cover");
              return (
                <figure
                  className={`memory-photo memory-photo-${source.type} memory-photo-layout-${imageLayout}`}
                  key={source.id}
                  data-testid="source-image"
                >
                  <div className="memory-photo-frame">
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
                        className={`memory-photo-image memory-photo-image-${imageDisplay}`}
                        src={source.mediaUrl!}
                        alt={source.alt || source.name}
                        width={imageLayout === "portrait" ? 720 : 640}
                        height={imageLayout === "portrait" ? 1020 : 480}
                        loading={index === 0 ? "eager" : "lazy"}
                        fetchPriority={index === 0 ? "high" : "auto"}
                        referrerPolicy="no-referrer"
                        onLoad={() => markMediaLoaded(source.id)}
                        onError={() => markMediaFailed(source.id)}
                      />
                    )}
                  </div>
                  <figcaption>
                    <span className="memory-source-type">{sourceMeta[source.type].label}</span>
                    <span className="memory-source-name">{source.name}</span>
                  </figcaption>
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
              <p
                className={`paragraph-attribution attribution-${paragraphAttribution(section)}`}
                aria-label={`段落归因：${paragraphAttributionLabel(section)}`}
              >
                {paragraphAttributionLabel(section)}
              </p>
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
          {reader.draft.closing ? <p className="closing">{reader.draft.closing}</p> : null}
          <p className="signature">{reader.draft.signature}</p>
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
          <section className="reply-history" aria-labelledby="reply-history-title">
            <div className="reply-history-heading">
              <h3 id="reply-history-title">家人的回复</h3>
              <span>{reader.replies.length} 条</span>
            </div>
            {hiddenReplyCount > 0 ? (
              <button
                className="reply-history-toggle"
                type="button"
                onClick={() => setReplyHistoryExpanded((value) => !value)}
                aria-expanded={replyHistoryExpanded}
                aria-controls="reply-list"
              >
                <span>
                  {replyHistoryExpanded
                    ? "收起较早回复"
                    : `查看较早的 ${hiddenReplyCount} 条回复`}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={replyHistoryExpanded ? "chevron-open" : ""}
                  size={18}
                />
              </button>
            ) : null}
            <ol className="reply-list" id="reply-list">
              {visibleReplies.map((item) => (
                <li className="reply-item" key={item.id}>
                  <div>
                    <span className="reply-author">
                      <strong>{item.authorName}</strong>
                      {!item.authorVerified ? <small>未验证身份</small> : null}
                    </span>
                    <time dateTime={item.createdAt}>{formatDateTime(item.createdAt)}</time>
                  </div>
                  <p>{item.text}</p>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <div className="reply-composer">
          <textarea
            ref={replyInputRef}
            data-testid="reply-input"
            value={reply}
            onChange={(event) => {
              const nextDraft = event.target.value;
              replyDraftRef.current = nextDraft;
              replyAttemptRef.current = retainReplyAttemptForDraft(
                replyAttemptRef.current,
                nextDraft,
              );
              setReply(nextDraft);
              setSent(false);
              setSentLocally(false);
              if (replyError) setReplyError("");
            }}
            name="reply"
            autoComplete="off"
            placeholder="例如：收到信了，周末给你打电话…"
            maxLength={240}
            aria-label="回复内容"
            aria-invalid={Boolean(replyError)}
            aria-describedby={replyError ? "reply-error" : undefined}
            disabled={submitting}
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

        {sent ? (
          <div className="sent-state" data-testid="reply-success" role="status" aria-live="polite">
            <Check aria-hidden="true" size={22} />
            <div>
              <strong>
                {__WARM_LETTER_DEMO_BUILD__ && sentLocally
                  ? "演示回复已保存在本页"
                  : "回复已经送达"}
              </strong>
              <p>输入框已清空，可以继续写下一条回复。</p>
              {__WARM_LETTER_DEMO_BUILD__ && sentLocally ? (
                <p>这条回复没有发送给任何人，刷新页面后会消失。</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <footer>AI 辅助整理 · 由本人确认后寄出 · 素材可追溯</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
