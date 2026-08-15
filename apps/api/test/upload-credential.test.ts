import { describe, expect, it } from "vitest";
import { UploadCredentialService } from "../src/upload-credential.js";

const primaryKey = Buffer.alloc(32, 7);
const previousKey = Buffer.alloc(32, 8);

describe("UploadCredentialService", () => {
  it("issues a short-lived capability bound to one material and content type", () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    const service = new UploadCredentialService({
      signingKeys: [primaryKey],
      ttlMs: 60_000,
      now: () => now,
    });

    const credential = service.issue("material-1", "image/jpeg");
    expect(service.verify(credential)).toEqual({
      status: "valid",
      claims: {
        materialId: "material-1",
        contentType: "image/jpeg",
        expiresAtSeconds: Math.ceil((now.getTime() + 60_000) / 1000),
      },
    });

    const [payload] = credential.split(".");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      v: 1,
      aud: "material-upload",
      mid: "material-1",
      ct: "image/jpeg",
      exp: Math.ceil((now.getTime() + 60_000) / 1000),
    });
  });

  it("rejects missing, malformed, tampered, and differently signed credentials", () => {
    const service = new UploadCredentialService({ signingKeys: [primaryKey] });
    const credential = service.issue("material-1", "image/jpeg");
    const [payload, signature] = credential.split(".") as [string, string];
    const tamperedSignature = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const otherSigner = new UploadCredentialService({ signingKeys: [previousKey] });

    for (const candidate of [
      undefined,
      "",
      `${payload}.${tamperedSignature}`,
      `${credential}.extra`,
      otherSigner.issue("material-1", "image/jpeg"),
      "x".repeat(2049),
    ]) {
      expect(service.verify(candidate)).toEqual({ status: "invalid" });
    }
  });

  it("expires credentials and supports verification during key rotation", () => {
    let now = new Date("2026-08-16T00:00:00.000Z");
    const previousIssuer = new UploadCredentialService({
      signingKeys: [previousKey],
      ttlMs: 1_000,
      now: () => now,
    });
    const credential = previousIssuer.issue("material-1", "audio/wav");
    const rotatedVerifier = new UploadCredentialService({
      signingKeys: [primaryKey, previousKey],
      ttlMs: 1_000,
      now: () => now,
    });

    expect(rotatedVerifier.verify(credential).status).toBe("valid");
    now = new Date("2026-08-16T00:00:01.000Z");
    expect(rotatedVerifier.verify(credential)).toEqual({ status: "expired" });
  });

  it("rejects weak keys and invalid TTL values", () => {
    expect(() => new UploadCredentialService({ signingKeys: [Buffer.alloc(31)] })).toThrow(
      "at least 32 bytes",
    );
    expect(() => new UploadCredentialService({ ttlMs: 0 })).toThrow("positive safe integer");
  });
});
