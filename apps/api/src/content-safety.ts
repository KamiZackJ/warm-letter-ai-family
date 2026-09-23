import { OperationDeadline } from "./deadline.js";
import { ApiError } from "./errors.js";
import {
  ContentSafetyTransportError,
  isObject,
  safetyEndpoint,
  safetyPostJson,
  validateSafetyTimeout,
  type SafetyFailureReason,
} from "./content-safety-http.js";
import { WechatStableTokenProvider, type WechatTokenProvider } from "./wechat-token.js";

export interface TextSafetyInput {
  content: string;
  openId: string;
  /** 1: profile, 2: comment, 3: forum, 4: social journal. */
  scene: 1 | 2 | 3 | 4;
}

export type TextSafetyResult =
  | { decision: "allow"; traceId: string }
  | { decision: "reject"; reason: "risky" | "review" | "invalid-content"; traceId?: string }
  | { decision: "unavailable"; reason: SafetyFailureReason | "login-required"; retryable: boolean };

export interface ContentSafetyProvider {
  readonly name: string;
  checkText(input: TextSafetyInput): Promise<TextSafetyResult>;
}

export interface MediaSafetyInput {
  mediaUrl: string;
  mediaType: "image" | "audio";
  openId: string;
  scene: 1 | 2 | 3 | 4;
}

export type MediaSafetySubmission =
  | { decision: "pending"; traceId: string }
  | { decision: "unavailable"; reason: SafetyFailureReason | "login-required" | "invalid-content"; retryable: boolean };

export interface MediaSafetyProvider {
  submitMedia(input: MediaSafetyInput): Promise<MediaSafetySubmission>;
}

export interface WechatContentSafetyOptions {
  tokenProvider: WechatTokenProvider;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  mediaEndpoint?: string;
}

// https://developers.weixin.qq.com/miniprogram/dev/server/API/sec-center/sec-check/api_msgseccheck.html
// Only definitive credential-expiry errors get one retry. Never retry risky/review or quota errors.
const invalidTokenCodes = new Set([40001, 40014, 42001]);
const invalidIdentityCodes = new Set([40003, 43104, 61010]);

export class WechatContentSafetyProvider implements ContentSafetyProvider, MediaSafetyProvider {
  readonly name = "wechat-msg-sec-check-v2";
  private readonly tokenProvider: WechatTokenProvider;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly mediaEndpoint: string;

  constructor(options: WechatContentSafetyOptions) {
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = validateSafetyTimeout(options.timeoutMs ?? 15_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = safetyEndpoint(options.endpoint ?? "https://api.weixin.qq.com/wxa/msg_sec_check");
    this.mediaEndpoint = safetyEndpoint(options.mediaEndpoint ?? "https://api.weixin.qq.com/wxa/media_check_async");
  }

  async checkText(input: TextSafetyInput): Promise<TextSafetyResult> {
    if (!input.openId.trim() || input.openId.length > 128) {
      return { decision: "unavailable", reason: "login-required", retryable: false };
    }
    if (!input.content.trim() || Array.from(input.content).length > 2500 || ![1, 2, 3, 4].includes(input.scene)) {
      return { decision: "reject", reason: "invalid-content" };
    }
    const deadline = new OperationDeadline(this.timeoutMs, () => new ContentSafetyTransportError("timeout"));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await deadline.wait(() => this.tokenProvider.getToken());
        const url = new URL(this.endpoint);
        url.searchParams.set("access_token", token);
        const result = await safetyPostJson(this.fetchImpl, url, {
          openid: input.openId,
          content: input.content,
          scene: input.scene,
          version: 2,
        }, deadline);
        if (typeof result.errcode === "number" && invalidTokenCodes.has(result.errcode)) {
          this.tokenProvider.invalidate(token);
          if (attempt === 0) continue;
        }
        if (typeof result.errcode === "number" && invalidIdentityCodes.has(result.errcode)) {
          return { decision: "unavailable", reason: "login-required", retryable: false };
        }
        if (result.errcode !== 0) throw new ContentSafetyTransportError("provider");
        if (
          !isObject(result.result) || typeof result.trace_id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(result.trace_id) ||
          typeof result.result.label !== "number" || !Number.isSafeInteger(result.result.label)
        ) throw new ContentSafetyTransportError("invalid-response");
        if (result.result.suggest === "pass") return { decision: "allow", traceId: result.trace_id };
        if (result.result.suggest === "risky" || result.result.suggest === "review") {
          return { decision: "reject", reason: result.result.suggest, traceId: result.trace_id };
        }
        throw new ContentSafetyTransportError("invalid-response");
      }
      throw new ContentSafetyTransportError("provider");
    } catch (error) {
      return {
        decision: "unavailable",
        reason: error instanceof ContentSafetyTransportError ? error.reason : "provider",
        retryable: true,
      };
    } finally {
      deadline.dispose();
    }
  }

  /** Receipt of a trace ID is NOT approval. Publication must await a signed callback. */
  async submitMedia(input: MediaSafetyInput): Promise<MediaSafetySubmission> {
    if (!input.openId.trim() || input.openId.length > 128) {
      return { decision: "unavailable", reason: "login-required", retryable: false };
    }
    try {
      const url = new URL(input.mediaUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || ![1, 2, 3, 4].includes(input.scene) ||
        !["image", "audio"].includes(input.mediaType)) throw new Error();
    } catch {
      return { decision: "unavailable", reason: "invalid-content", retryable: false };
    }
    const deadline = new OperationDeadline(this.timeoutMs, () => new ContentSafetyTransportError("timeout"));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const token = await deadline.wait(() => this.tokenProvider.getToken());
        const url = new URL(this.mediaEndpoint);
        url.searchParams.set("access_token", token);
        const result = await safetyPostJson(this.fetchImpl, url, {
          openid: input.openId,
          scene: input.scene,
          version: 2,
          media_url: input.mediaUrl,
          media_type: input.mediaType === "audio" ? 1 : 2,
        }, deadline);
        if (typeof result.errcode === "number" && invalidTokenCodes.has(result.errcode)) {
          this.tokenProvider.invalidate(token);
          if (attempt === 0) continue;
        }
        if (typeof result.errcode === "number" && invalidIdentityCodes.has(result.errcode)) {
          return { decision: "unavailable", reason: "login-required", retryable: false };
        }
        if (result.errcode !== 0) throw new ContentSafetyTransportError("provider");
        if (typeof result.trace_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(result.trace_id)) {
          throw new ContentSafetyTransportError("invalid-response");
        }
        return { decision: "pending", traceId: result.trace_id };
      }
      throw new ContentSafetyTransportError("provider");
    } catch (error) {
      return { decision: "unavailable", reason: error instanceof ContentSafetyTransportError ? error.reason : "provider", retryable: true };
    } finally {
      deadline.dispose();
    }
  }
}

export async function requireTextSafety(provider: ContentSafetyProvider, input: TextSafetyInput): Promise<void> {
  let result: TextSafetyResult;
  try {
    result = await provider.checkText(input);
  } catch {
    throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "内容安全检查暂时不可用，请稍后重试");
  }
  if (result.decision === "allow") return;
  if (result.decision === "reject") {
    if (result.reason === "invalid-content") throw new ApiError(400, "CONTENT_SAFETY_INVALID_TEXT", "待检查文字不能为空，且每次不超过2500字");
    throw new ApiError(422, "CONTENT_REJECTED", "内容暂不适合发送，请修改后重试");
  }
  if (result.reason === "login-required") throw new ApiError(401, "WECHAT_LOGIN_REQUIRED", "请重新登录后再发送");
  throw new ApiError(503, "CONTENT_SAFETY_UNAVAILABLE", "内容安全检查暂时不可用，请稍后重试");
}

export function createContentSafetyProviderFromEnv(env: NodeJS.ProcessEnv): WechatContentSafetyProvider {
  const parseTimeout = (key: string, fallback: number): number =>
    validateSafetyTimeout(env[key]?.trim() ? Number(env[key]) : fallback);
  return new WechatContentSafetyProvider({
    tokenProvider: new WechatStableTokenProvider({
      appId: env.WECHAT_APP_ID ?? "",
      appSecret: env.WECHAT_APP_SECRET ?? "",
      timeoutMs: parseTimeout("WECHAT_TOKEN_TIMEOUT_MS", 5_000),
    }),
    timeoutMs: parseTimeout("CONTENT_SAFETY_TIMEOUT_MS", 15_000),
  });
}
