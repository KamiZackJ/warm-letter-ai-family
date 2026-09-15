import { createHash } from "node:crypto";

export interface GenerationRateLimitConfig {
  windowMs?: number;
  maxBuckets?: number;
  perIp?: number;
  perUser?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export interface GenerationRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class GenerationRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private readonly perIp: number;
  private readonly perUser: number;
  private checks = 0;

  constructor(
    config: GenerationRateLimitConfig = {},
    private readonly now: () => number = Date.now,
  ) {
    this.windowMs = config.windowMs ?? 60_000;
    this.maxBuckets = config.maxBuckets ?? 10_000;
    this.perIp = config.perIp ?? 10;
    this.perUser = config.perUser ?? 3;
    this.assertPositiveInteger(this.windowMs, "generation rate limit windowMs");
    this.assertPositiveInteger(this.maxBuckets, "generation rate limit maxBuckets");
    this.assertPositiveInteger(this.perIp, "generation rate limit perIp");
    this.assertPositiveInteger(this.perUser, "generation rate limit perUser");
  }

  check(ip: string, userId: string): GenerationRateLimitResult {
    const now = this.now();
    const ipResult = this.consume(`ip:${ip}`, this.perIp, now);
    if (!ipResult.allowed) return ipResult;

    const userHash = createHash("sha256").update(userId).digest("hex");
    const userResult = this.consume(`user:${userHash}`, this.perUser, now);
    this.recordCheck(now);

    return {
      allowed: userResult.allowed,
      retryAfterSeconds: Math.max(ipResult.retryAfterSeconds, userResult.retryAfterSeconds),
    };
  }

  private consume(key: string, limit: number, now: number): GenerationRateLimitResult {
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

    const bucket =
      !existing || existing.resetAt <= now
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
