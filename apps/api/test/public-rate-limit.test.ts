import { describe, expect, it } from "vitest";
import { PublicRateLimiter } from "../src/public-rate-limit.js";

describe("PublicRateLimiter", () => {
  it("combines an IP budget with a credential-wide budget and resets by window", () => {
    let now = 0;
    const limiter = new PublicRateLimiter(
      {
        windowMs: 1_000,
        reader: { perIp: 10, perCredential: 2 },
      },
      () => now,
    );

    expect(limiter.check("reader", "198.51.100.1", "share-a").allowed).toBe(true);
    expect(limiter.check("reader", "198.51.100.2", "share-a").allowed).toBe(true);
    expect(limiter.check("reader", "198.51.100.3", "share-a")).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1,
    });
    expect(limiter.check("reader", "198.51.100.3", "share-b").allowed).toBe(true);

    now = 1_001;
    expect(limiter.check("reader", "198.51.100.3", "share-a").allowed).toBe(true);
  });

  it("stops allocating buckets after the configured in-memory cap", () => {
    const limiter = new PublicRateLimiter({ maxBuckets: 2 }, () => 0);
    expect(limiter.check("reader", "198.51.100.1", "share-a").allowed).toBe(true);
    expect(limiter.check("reader", "198.51.100.2", "share-b").allowed).toBe(false);
  });

  it("uses only the IP bucket when a credential is absent or non-canonical", () => {
    const limiter = new PublicRateLimiter(
      {
        maxBuckets: 1,
        media: { perIp: 2, perCredential: 1 },
      },
      () => 0,
    );
    expect(limiter.check("media", "198.51.100.1", undefined).allowed).toBe(true);
    expect(limiter.check("media", "198.51.100.1", undefined).allowed).toBe(true);
  });

  it("rejects unsafe limiter configuration", () => {
    expect(() => new PublicRateLimiter({ windowMs: 0 })).toThrow("positive safe integer");
    expect(() => new PublicRateLimiter({ reply: { perCredential: 0 } })).toThrow(
      "positive safe integer",
    );
  });
});
