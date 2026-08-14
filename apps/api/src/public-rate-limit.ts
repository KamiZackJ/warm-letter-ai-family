import { createHash } from "node:crypto";

export type PublicRouteKind = "reader" | "media" | "reply";

export interface PublicRateLimitRule {
  perIp: number;
  perCredential: number;
}

export interface PublicRateLimitConfig {
  windowMs?: number;
  maxBuckets?: number;
  reader?: Partial<PublicRateLimitRule>;
  media?: Partial<PublicRateLimitRule>;
  reply?: Partial<PublicRateLimitRule>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface PublicRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

const defaultRules: Record<PublicRouteKind, PublicRateLimitRule> = {
  reader: { perIp: 120, perCredential: 60 },
  media: { perIp: 600, perCredential: 300 },
  reply: { perIp: 20, perCredential: 5 },
};

export class PublicRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly rules: Record<PublicRouteKind, PublicRateLimitRule>;
  private readonly maxBuckets: number;
  private checks = 0;

  constructor(
    config: PublicRateLimitConfig = {},
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = config.windowMs ?? 60_000;
    this.maxBuckets = config.maxBuckets ?? 10_000;
    this.rules = {
      reader: { ...defaultRules.reader, ...config.reader },
      media: { ...defaultRules.media, ...config.media },
      reply: { ...defaultRules.reply, ...config.reply },
    };
    this.assertPositiveInteger(this.windowMs, "public rate limit windowMs");
    this.assertPositiveInteger(this.maxBuckets, "public rate limit maxBuckets");
    for (const [kind, rule] of Object.entries(this.rules)) {
      this.assertPositiveInteger(rule.perIp, `${kind} perIp`);
      this.assertPositiveInteger(rule.perCredential, `${kind} perCredential`);
    }
  }

  check(kind: PublicRouteKind, ip: string, credential: string | undefined): PublicRateLimitResult {
    const now = this.now();
    const rule = this.rules[kind];
    const ipResult = this.consume(`${kind}:ip:${ip}`, rule.perIp, now);
    if (!ipResult.allowed) return ipResult;
    if (!credential) {
      this.recordCheck(now);
      return ipResult;
    }
    const credentialHash = createHash("sha256").update(credential).digest("hex");
    const credentialResult = this.consume(
      `${kind}:credential:${credentialHash}`,
      rule.perCredential,
      now,
    );

    this.recordCheck(now);

    return {
      allowed: ipResult.allowed && credentialResult.allowed,
      retryAfterSeconds: Math.max(
        ipResult.retryAfterSeconds,
        credentialResult.retryAfterSeconds,
      ),
    };
  }

  private consume(key: string, limit: number, now: number): PublicRateLimitResult {
    const existing = this.buckets.get(key);
    if (!existing && this.buckets.size >= this.maxBuckets) {
      this.prune(now);
      if (this.buckets.size >= this.maxBuckets) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)),
        };
      }
    }
    const bucket = !existing || existing.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : existing;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private recordCheck(now: number): void {
    this.checks += 1;
    if (this.checks % 256 === 0) this.prune(now);
  }

  private assertPositiveInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${field} must be a positive safe integer`);
    }
  }
}
