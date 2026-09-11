export interface WechatIdentity {
  openId: string;
  unionId?: string;
}

export interface WechatAuthProvider {
  exchangeCode(code: string): Promise<WechatIdentity>;
}

export interface WechatCode2SessionProviderOptions {
  appId: string;
  appSecret: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WechatAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly statusCode = 503,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "WechatAuthError";
  }
}

type Code2SessionPayload = {
  errcode?: number;
  errmsg?: string;
  openid?: string;
  unionid?: string;
  session_key?: string;
};

function isCode2SessionPayload(value: unknown): value is Code2SessionPayload {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const defaultEndpoint = "https://api.weixin.qq.com/sns/jscode2session";
const defaultTimeoutMs = 5_000;

function assertPositiveTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 500 || value > 60_000) {
    throw new Error("WECHAT_AUTH_TIMEOUT_MS must be an integer between 500 and 60000");
  }
}

function normalizedRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function errorForWechatCode(errcode: number, errmsg?: string): WechatAuthError {
  const message = "微信登录暂时不可用";
  if (errcode === 40029 || errcode === 40013 || errcode === 40125) {
    return new WechatAuthError("WECHAT_LOGIN_REJECTED", message, false, 401);
  }
  if (errcode === 45011 || errcode === 45009 || errcode >= 50000) {
    return new WechatAuthError("WECHAT_PROVIDER_RATE_LIMITED", message, true, 503);
  }
  return new WechatAuthError(
    "WECHAT_PROVIDER_ERROR",
    message,
    false,
    503,
    new Error(`wechat code2Session error ${errcode}: ${errmsg ?? "unknown"}`),
  );
}

export class WechatCode2SessionProvider {
  readonly name = "wechat-code2session";
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WechatCode2SessionProviderOptions) {
    this.appId = normalizedRequired(options.appId, "WECHAT_APP_ID");
    this.appSecret = normalizedRequired(options.appSecret, "WECHAT_APP_SECRET");
    this.endpoint = options.endpoint?.trim() || defaultEndpoint;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    assertPositiveTimeout(this.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
    try {
      const endpointUrl = new URL(this.endpoint);
      if (endpointUrl.protocol !== "https:" || endpointUrl.username || endpointUrl.password) {
        throw new Error("endpoint must be an HTTPS URL without credentials");
      }
    } catch (error) {
      throw new Error("WECHAT_CODE2SESSION_ENDPOINT must be a valid HTTPS URL", { cause: error });
    }
  }

  async exchangeCode(code: string): Promise<WechatIdentity> {
    const normalizedCode = code.trim();
    if (!normalizedCode || normalizedCode.length > 256) {
      throw new WechatAuthError("WECHAT_CODE_INVALID", "微信登录 code 无效", false, 401);
    }

    const url = new URL(this.endpoint);
    url.searchParams.set("appid", this.appId);
    url.searchParams.set("secret", this.appSecret);
    url.searchParams.set("js_code", normalizedCode);
    url.searchParams.set("grant_type", "authorization_code");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new WechatAuthError("WECHAT_PROVIDER_TIMEOUT", "微信登录服务响应超时", true, 503, error);
      }
      throw new WechatAuthError("WECHAT_PROVIDER_UNAVAILABLE", "微信登录服务暂时不可用", true, 503, error);
    } finally {
      clearTimeout(timeout);
    }

    let payload: Code2SessionPayload;
    try {
      const parsed = await response.json();
      if (!isCode2SessionPayload(parsed)) {
        throw new Error("response body is not an object");
      }
      payload = parsed;
    } catch (error) {
      throw new WechatAuthError("WECHAT_PROVIDER_INVALID_RESPONSE", "微信登录服务返回格式异常", true, 503, error);
    }

    if (!response.ok) {
      throw new WechatAuthError("WECHAT_PROVIDER_HTTP_ERROR", "微信登录服务暂时不可用", true, 503);
    }
    if (typeof payload.errcode === "number" && payload.errcode !== 0) {
      throw errorForWechatCode(payload.errcode, payload.errmsg);
    }
    if (
      typeof payload.openid !== "string" ||
      !payload.openid.trim() ||
      payload.openid.trim().length > 128
    ) {
      throw new WechatAuthError("WECHAT_PROVIDER_INVALID_RESPONSE", "微信登录服务未返回用户标识", true, 503);
    }

    // session_key is intentionally discarded. It is only needed for server-side
    // encrypted-data flows, which are not part of the current login contract.
    return {
      openId: payload.openid.trim(),
      unionId: typeof payload.unionid === "string" && payload.unionid.trim() ? payload.unionid.trim() : undefined,
    };
  }
}

function integerFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  assertPositiveTimeout(value);
  return value;
}

export function createWechatAuthProviderFromEnv(
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number } = {},
): WechatCode2SessionProvider {
  return new WechatCode2SessionProvider({
    appId: normalizedRequired(env.WECHAT_APP_ID ?? "", "WECHAT_APP_ID"),
    appSecret: normalizedRequired(env.WECHAT_APP_SECRET ?? "", "WECHAT_APP_SECRET"),
    endpoint: env.WECHAT_CODE2SESSION_ENDPOINT,
    timeoutMs: options.timeoutMs ?? integerFromEnv(env, "WECHAT_AUTH_TIMEOUT_MS", defaultTimeoutMs),
  });
}
