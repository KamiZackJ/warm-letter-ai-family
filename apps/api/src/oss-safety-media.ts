import { createHash } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import OSS from "ali-oss";

export const OSS_SAFETY_MEDIA_PREFIX = "wechat-safety/";
export const OSS_SAFETY_MAX_URL_AGE_MS = 45 * 60 * 1000;
const maximumMediaBytes = 10 * 1024 * 1024;
const acceptedContentTypes = new Set(["image/jpeg", "image/png", "image/bmp", "audio/mpeg", "audio/wav"]);

export interface OssSafetyMediaOptions {
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  namespacePrefix?: string;
  /** Total duration of one operation, including PUT verification. Maximum 15 seconds. */
  timeoutMs?: number;
  /** Background PUT plus HEAD budget. Maximum 90 seconds; cleanup keeps timeoutMs. */
  uploadTimeoutMs?: number;
}

export class OssSafetyMediaError extends Error {
  constructor(readonly code: string) {
    super("Temporary media storage operation could not be completed");
    this.name = "OssSafetyMediaError";
  }
}

function fail(code: string): never { throw new OssSafetyMediaError(code); }

function responseHeader(headers: object, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return typeof entry?.[1] === "string" ? entry[1] : "";
}

/**
 * Private, short-lived review copies only. No bucket creation, public ACL, custom
 * endpoint, credential discovery, account lookup, or background refresh occurs.
 * Deployment must verify the dedicated bucket is private with public access
 * blocked; new objects inherit it without requiring PutObjectAcl permission.
 */
export class OssSafetyMediaStore {
  private readonly options: OssSafetyMediaOptions;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly hostname: string;

  constructor(options: OssSafetyMediaOptions) {
    if (
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !/^oss-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.region) ||
      options.region.endsWith("-internal") ||
      !options.accessKeyId?.trim() || !options.accessKeySecret?.trim() ||
      /[\r\n]/.test(options.accessKeyId + options.accessKeySecret) ||
      (options.namespacePrefix !== undefined && options.namespacePrefix !== OSS_SAFETY_MEDIA_PREFIX)
    ) fail("OSS_SAFETY_CONFIGURATION_INVALID");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000) {
      fail("OSS_SAFETY_CONFIGURATION_INVALID");
    }
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(this.uploadTimeoutMs) || this.uploadTimeoutMs < 1 || this.uploadTimeoutMs > 90_000) {
      fail("OSS_SAFETY_CONFIGURATION_INVALID");
    }
    this.options = { ...options };
    this.hostname = `${options.bucket}.${options.region}.aliyuncs.com`;
  }

  async put(key: string, input: { bytes: Buffer; contentType: string }, signal?: AbortSignal): Promise<void> {
    this.assertKey(key);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > maximumMediaBytes ||
        !acceptedContentTypes.has(input.contentType)) fail("OSS_SAFETY_MEDIA_INVALID");
    // Own the bytes throughout the operation; the caller may discard its source after abort.
    const bytes = Buffer.from(input.bytes);
    const contentMd5 = createHash("md5").update(bytes).digest("base64");
    await this.run("OSS_SAFETY_WRITE_FAILED", signal, async (client, remaining) => {
      const result = await client.put(key, bytes, {
        timeout: remaining(), mime: input.contentType,
        headers: {
          "x-oss-forbid-overwrite": "true",
          "Content-MD5": contentMd5,
          "Cache-Control": "private, no-store, max-age=0",
        },
      });
      if (result.res.status !== 200) fail("OSS_SAFETY_WRITE_FAILED");
      // ali-oss checks PUT's HTTP status and OSS validates Content-MD5. HEAD also
      // proves the committed object has the expected length/type and same ETag.
      const head = await client.head(key, { timeout: remaining(), headers: { "Accept-Encoding": "identity" } });
      const etag = responseHeader(result.res.headers, "etag");
      if (head.res.status !== 200 || !etag || responseHeader(head.res.headers, "etag") !== etag ||
          responseHeader(head.res.headers, "content-length") !== String(bytes.length) ||
          responseHeader(head.res.headers, "content-type").split(";", 1)[0]?.trim() !== input.contentType) {
        fail("OSS_SAFETY_VERIFICATION_FAILED");
      }
    }, this.uploadTimeoutMs);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    this.assertKey(key);
    await this.run("OSS_SAFETY_DELETE_FAILED", signal, async (client, remaining) => {
      // OSS DeleteObject returns 204 even when this object is already absent.
      const result = await client.delete(key, { timeout: remaining() });
      if (result.res.status !== 204) fail("OSS_SAFETY_DELETE_FAILED");
    });
  }

  async signedGetUrl(key: string, expiresAt: Date, signal?: AbortSignal): Promise<string> {
    this.assertKey(key);
    const deadline = expiresAt.getTime();
    const age = deadline - Date.now();
    if (!Number.isFinite(age) || age < 1000 || age > OSS_SAFETY_MAX_URL_AGE_MS) fail("OSS_SAFETY_EXPIRY_INVALID");
    return this.run("OSS_SAFETY_SIGN_FAILED", signal, async (client, remaining) => {
      remaining();
      // SDK v6 signs locally; no STS discovery/refresh or network request is used.
      // ali-oss v6 rounds its current timestamp to the nearest second. Reserve
      // that upper rounded second so the signed expiry never crosses our lease.
      const expires = Math.floor(deadline / 1000) - Math.ceil(Date.now() / 1000);
      if (expires < 1) fail("OSS_SAFETY_EXPIRY_INVALID");
      const signed = client.signatureUrl(key, { method: "GET", expires });
      const url = new URL(signed);
      const expiry = Number(url.searchParams.get("Expires"));
      if (url.protocol !== "https:" || url.hostname !== this.hostname || url.port || url.username || url.password ||
          url.hash || decodeURIComponent(url.pathname) !== `/${key}` ||
          !url.searchParams.get("Signature") || !url.searchParams.get("OSSAccessKeyId") ||
          !Number.isSafeInteger(expiry) || expiry <= Math.floor(Date.now() / 1000) || expiry * 1000 > deadline) {
        fail("OSS_SAFETY_SIGN_FAILED");
      }
      return signed;
    });
  }

  private assertKey(key: string): void {
    // A caller-supplied random filename within exactly this one review namespace.
    if (typeof key !== "string" || !/^wechat-safety\/[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(key)) {
      fail("OSS_SAFETY_KEY_INVALID");
    }
  }

  private run<T>(code: string, signal: AbortSignal | undefined,
    operation: (client: OSS, remaining: () => number) => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    if (signal?.aborted) return Promise.reject(new OssSafetyMediaError("OSS_SAFETY_ABORTED"));
    // urllib 2.x treats even "0" as enabling its global proxy override. That
    // would replace our dedicated agent and bypass transport cancellation.
    if (process.env.URLLIB_ENABLE_PROXY) return Promise.reject(new OssSafetyMediaError("OSS_SAFETY_PROXY_FORBIDDEN"));
    // ali-oss.cancel() only cancels multipart uploads. A dedicated agent per
    // operation lets abort destroy the real HTTPS sockets without cancelling peers.
    const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1, timeout: timeoutMs });
    const deadline = Date.now() + timeoutMs;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (success: boolean, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        agent.destroy();
        if (success) resolve(value as T);
        else reject(value instanceof OssSafetyMediaError ? value : new OssSafetyMediaError(code));
      };
      const abort = () => finish(false, new OssSafetyMediaError("OSS_SAFETY_ABORTED"));
      const timer = setTimeout(() => finish(false, new OssSafetyMediaError("OSS_SAFETY_TIMEOUT")), timeoutMs);
      const remaining = () => {
        if (signal?.aborted) fail("OSS_SAFETY_ABORTED");
        if (process.env.URLLIB_ENABLE_PROXY) fail("OSS_SAFETY_PROXY_FORBIDDEN");
        const time = deadline - Date.now();
        if (settled || time <= 0) fail("OSS_SAFETY_TIMEOUT");
        return Math.min(time, timeoutMs);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        remaining();
        // Extra supported SDK options lack declarations in @types/ali-oss.
        // No user options are spread here: callers cannot override transport or ACL.
        const sdkOptions: OSS.Options & { retryMax: number; httpsAgent: HttpsAgent; enableProxy: boolean } = {
          bucket: this.options.bucket, region: this.options.region,
          accessKeyId: this.options.accessKeyId, accessKeySecret: this.options.accessKeySecret,
          secure: true, internal: false, cname: false, timeout: timeoutMs,
          retryMax: 0, enableProxy: false, httpsAgent: agent,
        };
        const client = new OSS(sdkOptions);
        operation(client, remaining).then((value) => finish(true, value), (error: unknown) => finish(false, error));
      } catch (error) { finish(false, error); }
    });
  }
}
