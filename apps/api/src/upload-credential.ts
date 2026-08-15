import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const uploadCredentialHeader = "x-warm-letter-upload-token";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const defaultUploadCredentialTtlMs = 5 * 60 * 1000;
const maximumCredentialLength = 2048;

type UploadCredentialClaims = {
  materialId: string;
  contentType: string;
  expiresAtSeconds: number;
};

export type UploadCredentialVerification =
  | { status: "valid"; claims: UploadCredentialClaims }
  | { status: "expired" }
  | { status: "invalid" };

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!value || !base64UrlPattern.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export class UploadCredentialService {
  private readonly signingKeys: readonly Buffer[];
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(options: {
    signingKeys?: readonly Uint8Array[];
    ttlMs?: number;
    now?: () => Date;
  } = {}) {
    this.signingKeys = (options.signingKeys?.length ? options.signingKeys : [randomBytes(32)]).map(
      (key) => Buffer.from(key),
    );
    this.ttlMs = options.ttlMs ?? defaultUploadCredentialTtlMs;
    this.now = options.now ?? (() => new Date());

    if (this.signingKeys.some((key) => key.length < 32)) {
      throw new Error("upload credential signing keys must contain at least 32 bytes per key");
    }
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new Error("upload credential ttlMs must be a positive safe integer");
    }
  }

  issue(materialId: string, contentType: string): string {
    const expiresAtSeconds = Math.ceil((this.now().getTime() + this.ttlMs) / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        aud: "material-upload",
        mid: materialId,
        ct: contentType,
        exp: expiresAtSeconds,
      }),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.signingKeys[0]!).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  verify(credential: string | undefined): UploadCredentialVerification {
    if (!credential || credential.length > maximumCredentialLength) return { status: "invalid" };
    const [payload, encodedSignature, extra] = credential.split(".");
    if (!payload || !encodedSignature || extra !== undefined) return { status: "invalid" };

    const payloadBytes = decodeCanonicalBase64Url(payload);
    const signature = decodeCanonicalBase64Url(encodedSignature);
    if (!payloadBytes || !signature || signature.length !== 32) return { status: "invalid" };

    const signatureIsValid = this.signingKeys.some((key) => {
      const expected = createHmac("sha256", key).update(payload).digest();
      return timingSafeEqual(expected, signature);
    });
    if (!signatureIsValid) return { status: "invalid" };

    try {
      const parsed = JSON.parse(payloadBytes.toString("utf8")) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort().join(",");
      if (
        keys !== "aud,ct,exp,mid,v" ||
        parsed.v !== 1 ||
        parsed.aud !== "material-upload" ||
        typeof parsed.mid !== "string" ||
        !parsed.mid ||
        typeof parsed.ct !== "string" ||
        !parsed.ct ||
        typeof parsed.exp !== "number" ||
        !Number.isSafeInteger(parsed.exp)
      ) {
        return { status: "invalid" };
      }
      if (parsed.exp <= Math.floor(this.now().getTime() / 1000)) {
        return { status: "expired" };
      }
      return {
        status: "valid",
        claims: {
          materialId: parsed.mid,
          contentType: parsed.ct,
          expiresAtSeconds: parsed.exp,
        },
      };
    } catch {
      return { status: "invalid" };
    }
  }
}
