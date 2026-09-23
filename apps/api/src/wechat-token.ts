import { OperationDeadline } from "./deadline.js";
import {
  ContentSafetyTransportError,
  safetyEndpoint,
  safetyPostJson,
  validateSafetyTimeout,
} from "./content-safety-http.js";

export interface WechatTokenProvider {
  getToken(): Promise<string>;
  /** A delayed failure from an older request must not evict a newer token. */
  invalidate(token: string): void;
}

export interface WechatStableTokenOptions {
  appId: string;
  appSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Dependency injection for tests; environment factories use the official endpoint. */
  endpoint?: string;
  now?: () => number;
}

export class WechatStableTokenProvider implements WechatTokenProvider {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: { token: string; refreshAt: number };
  private inFlight?: Promise<string>;

  constructor(options: WechatStableTokenOptions) {
    this.appId = options.appId.trim();
    this.appSecret = options.appSecret.trim();
    if (!this.appId || !this.appSecret) throw new Error("WECHAT_APP_ID and WECHAT_APP_SECRET are required");
    this.timeoutMs = validateSafetyTimeout(options.timeoutMs ?? 5_000);
    this.endpoint = safetyEndpoint(options.endpoint ?? "https://api.weixin.qq.com/cgi-bin/stable_token");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAt) return Promise.resolve(this.cached.token);
    if (this.inFlight) return this.inFlight;
    const work = this.loadToken().finally(() => {
      if (this.inFlight === work) this.inFlight = undefined;
    });
    this.inFlight = work;
    return work;
  }

  invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = undefined;
  }

  private async loadToken(): Promise<string> {
    const deadline = new OperationDeadline(this.timeoutMs, () => new ContentSafetyTransportError("timeout"));
    const requestedAt = this.now();
    try {
      const result = await safetyPostJson(this.fetchImpl, this.endpoint, {
        grant_type: "client_credential",
        appid: this.appId,
        secret: this.appSecret,
        // Normal refresh avoids invalidating other callers and the 20/day force-refresh quota.
        force_refresh: false,
      }, deadline);
      if (result.errcode !== undefined && result.errcode !== 0) throw new ContentSafetyTransportError("provider");
      if (
        typeof result.access_token !== "string" || !result.access_token.trim() ||
        result.access_token.length > 4096 || /\s/u.test(result.access_token) ||
        typeof result.expires_in !== "number" || !Number.isSafeInteger(result.expires_in) ||
        result.expires_in <= 0 || result.expires_in > 7200
      ) throw new ContentSafetyTransportError("invalid-response");
      const lifetimeMs = result.expires_in * 1000;
      const refreshAt = requestedAt + lifetimeMs - Math.min(300_000, lifetimeMs / 10);
      if (this.now() >= refreshAt) throw new ContentSafetyTransportError("invalid-response");
      deadline.check();
      this.cached = { token: result.access_token, refreshAt };
      return result.access_token;
    } finally {
      deadline.dispose();
    }
  }
}
