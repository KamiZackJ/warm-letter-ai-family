import type { Agent } from "node:https";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OSS_SAFETY_MAX_URL_AGE_MS, OssSafetyMediaStore, type OssSafetyMediaOptions } from "../src/oss-safety-media.js";

const sdk = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown> & { httpsAgent: Agent }>,
  put: vi.fn(), head: vi.fn(), delete: vi.fn(), signatureUrl: vi.fn(),
}));
vi.mock("ali-oss", () => ({ default: class {
  constructor(options: Record<string, unknown> & { httpsAgent: Agent }) {
    vi.spyOn(options.httpsAgent, "destroy");
    sdk.instances.push(options);
  }
  put = sdk.put;
  head = sdk.head;
  delete = sdk.delete;
  signatureUrl = sdk.signatureUrl;
} }));

const config: OssSafetyMediaOptions = {
  bucket: "synthetic-review-bucket", region: "oss-cn-beijing",
  accessKeyId: "synthetic-key-id", accessKeySecret: "synthetic-key-secret",
  namespacePrefix: "wechat-safety/", timeoutMs: 10_000,
};
const key = "wechat-safety/1f9638b5-5500-4ad4-a16d-38b88b66ca07.png";
const media = { bytes: Buffer.from("synthetic-review-png"), contentType: "image/png" };
const putResult = { res: { status: 200, headers: { etag: '"synthetic-etag"' } } };
const headResult = () => ({ res: { status: 200, headers: {
  etag: '"synthetic-etag"', "content-length": String(media.bytes.length), "content-type": media.contentType,
} } });
const observe = <T>(promise: Promise<T>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
const signedUrl = (objectKey: string, expires: number) =>
  `https://${config.bucket}.${config.region}.aliyuncs.com/${objectKey}?OSSAccessKeyId=synthetic&Signature=synthetic&Expires=${Math.floor(Date.now() / 1000) + expires}`;

beforeEach(() => {
  vi.stubEnv("URLLIB_ENABLE_PROXY", "");
  vi.clearAllMocks();
  sdk.instances.length = 0;
  sdk.put.mockReset().mockResolvedValue(putResult);
  sdk.head.mockReset().mockImplementation(async () => headResult());
  sdk.delete.mockReset().mockResolvedValue({ res: { status: 204 } });
  sdk.signatureUrl.mockReset().mockImplementation((objectKey, options) => signedUrl(objectKey, options.expires));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("private OSS review copies", () => {
  it("uses official HTTPS transport and immutable PUT inheriting the verified private bucket, with HEAD verification", async () => {
    const store = new OssSafetyMediaStore(config);
    await store.put(key, media);
    const client = sdk.instances[0]!;
    expect(client).toMatchObject({ bucket: config.bucket, region: config.region, accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret, secure: true, internal: false, cname: false,
      timeout: 10_000, retryMax: 0, enableProxy: false });
    expect(client).not.toHaveProperty("endpoint");
    expect(client).not.toHaveProperty("refreshSTSToken");
    expect(sdk.put).toHaveBeenCalledExactlyOnceWith(key, media.bytes, expect.objectContaining({
      timeout: expect.any(Number), mime: media.contentType, headers: {
        "x-oss-forbid-overwrite": "true",
        "Content-MD5": createHash("md5").update(media.bytes).digest("base64"),
        "Cache-Control": "private, no-store, max-age=0",
      },
    }));
    expect(sdk.put.mock.calls[0]![1]).not.toBe(media.bytes);
    expect(sdk.put.mock.calls[0]![2].headers).not.toHaveProperty("x-oss-object-acl");
    expect(sdk.head).toHaveBeenCalledExactlyOnceWith(key, expect.objectContaining({
      timeout: expect.any(Number), headers: { "Accept-Encoding": "identity" },
    }));
    expect(client.httpsAgent.destroy).toHaveBeenCalledOnce();
  });

  it.each(["image/jpeg", "image/bmp", "audio/mpeg", "audio/wav"])("preserves normalized %s content type", async (contentType) => {
    const result = headResult();
    result.res.headers["content-type"] = contentType;
    sdk.head.mockResolvedValueOnce(result);
    await new OssSafetyMediaStore(config).put(key, { ...media, contentType });
    expect(sdk.put).toHaveBeenCalledWith(key, media.bytes, expect.objectContaining({ mime: contentType }));
  });

  it.each([
    "photos/source.png", "wechat-safety/", "wechat-safety/../private", "wechat-safety/a/b",
    "wechat-safety/%2e%2e", "wechat-safety/a?x=1", "wechat-safety/a#b", "wechat-safety/a\\b", "wechat-safety/a\nb",
  ])("rejects an out-of-namespace or ambiguous key in every operation: %s", async (objectKey) => {
    const store = new OssSafetyMediaStore(config);
    for (const action of [() => store.put(objectKey, media), () => store.delete(objectKey),
      () => store.signedGetUrl(objectKey, new Date(Date.now() + 60_000))]) {
      await expect(action()).rejects.toMatchObject({ code: "OSS_SAFETY_KEY_INVALID" });
    }
    expect(sdk.instances).toHaveLength(0);
  });

  it.each([
    { bucket: "https://another-host" }, { region: "oss-cn-beijing.evil.test" }, { region: "oss-cn-beijing-internal" },
    { accessKeyId: "" }, { accessKeySecret: "\nsecret" }, { namespacePrefix: "photos/" },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 15_001 },
    { uploadTimeoutMs: 0 }, { uploadTimeoutMs: Infinity }, { uploadTimeoutMs: 90_001 },
  ])("rejects invalid config without including the value in errors: %j", (patch) => {
    expect(() => new OssSafetyMediaStore({ ...config, ...patch })).toThrow("Temporary media storage operation could not be completed");
    expect(sdk.instances).toHaveLength(0);
  });

  it("rejects unsupported/empty/oversized media before any SDK operation", async () => {
    const store = new OssSafetyMediaStore(config);
    for (const input of [ { ...media, contentType: "text/html" }, { ...media, bytes: Buffer.alloc(0) },
      { ...media, bytes: Buffer.alloc(10 * 1024 * 1024 + 1) } ]) {
      await expect(store.put(key, input)).rejects.toMatchObject({ code: "OSS_SAFETY_MEDIA_INVALID" });
    }
    expect(sdk.instances).toHaveLength(0);
  });

  it.each(["status", "length", "type", "etag"])("rejects a stored object with mismatched %s", async (field) => {
    const response = headResult();
    if (field === "status") response.res.status = 304;
    if (field === "length") response.res.headers["content-length"] = "1";
    if (field === "type") response.res.headers["content-type"] = "text/html";
    if (field === "etag") response.res.headers.etag = '"wrong"';
    sdk.head.mockResolvedValueOnce(response);
    await expect(new OssSafetyMediaStore(config).put(key, media)).rejects.toMatchObject({ code: "OSS_SAFETY_VERIFICATION_FAILED" });
    expect(sdk.put).toHaveBeenCalledOnce();
    expect(sdk.delete).not.toHaveBeenCalled(); // Persistent staging owns cleanup even after ambiguous writes.
  });

  it("never retries or exposes SDK credentials, URLs, request headers or causes", async () => {
    sdk.put.mockRejectedValueOnce(Object.assign(new Error("https://private-signed-url?Signature=secret"), {
      params: { authorization: "secret" }, accessKeySecret: config.accessKeySecret,
    }));
    const result = await observe(new OssSafetyMediaStore(config).put(key, media));
    expect(result).toMatchObject({ error: { code: "OSS_SAFETY_WRITE_FAILED" } });
    expect(JSON.stringify(result)).not.toMatch(/private-signed|synthetic-key|authorization/);
    expect(sdk.put).toHaveBeenCalledOnce();
    expect(sdk.head).not.toHaveBeenCalled();
    sdk.delete.mockRejectedValueOnce(undefined);
    await expect(new OssSafetyMediaStore(config).delete(key)).rejects.toMatchObject({ code: "OSS_SAFETY_DELETE_FAILED" });
  });

  it("treats confirmed 204 deletes as complete and propagates rejected deletes for durable retry", async () => {
    const store = new OssSafetyMediaStore(config);
    await store.delete(key);
    expect(sdk.delete).toHaveBeenCalledExactlyOnceWith(key, { timeout: expect.any(Number) });
    sdk.delete.mockResolvedValueOnce({ res: { status: 403 } });
    await expect(store.delete(key)).rejects.toMatchObject({ code: "OSS_SAFETY_DELETE_FAILED" });
    expect(sdk.delete).toHaveBeenCalledTimes(2);
  });

  it("bounds PUT plus HEAD by one deadline and aborts its transport", async () => {
    vi.useFakeTimers();
    sdk.put.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(putResult), 7_000)));
    sdk.head.mockImplementationOnce(() => new Promise(() => undefined));
    const result = observe(new OssSafetyMediaStore(config).put(key, media));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(sdk.head).toHaveBeenCalledWith(key, expect.objectContaining({ timeout: 3_000 }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toMatchObject({ error: { code: "OSS_SAFETY_TIMEOUT" } });
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight write, ignores late resolution and never starts HEAD afterward", async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    sdk.put.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const result = observe(new OssSafetyMediaStore(config).put(key, media, controller.signal));
    controller.abort(new Error("sensitive abort reason"));
    expect(await result).toMatchObject({ error: { code: "OSS_SAFETY_ABORTED" } });
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    finish(putResult);
    await Promise.resolve(); await Promise.resolve();
    expect(sdk.head).not.toHaveBeenCalled();
  });

  it("allows a bounded slower upload without lengthening deletion or leaving sockets open", async () => {
    vi.useFakeTimers();
    sdk.put.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(putResult), 45_000)));
    sdk.head.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(headResult()), 2_000)));
    const store = new OssSafetyMediaStore({ ...config, uploadTimeoutMs: 90_000 });
    const upload = store.put(key, media);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(sdk.head).toHaveBeenCalledWith(key, expect.objectContaining({ timeout: 45_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    await upload;
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    sdk.delete.mockImplementationOnce(() => new Promise(() => undefined));
    const deletion = observe(store.delete(key));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await deletion).toMatchObject({ error: { code: "OSS_SAFETY_TIMEOUT" } });
    expect(sdk.instances[1]).toMatchObject({ timeout: 10_000 });
    expect(sdk.instances[1]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stalled background PUT at its own deadline without starting HEAD", async () => {
    vi.useFakeTimers();
    sdk.put.mockImplementationOnce(() => new Promise(() => undefined));
    const result = observe(new OssSafetyMediaStore({ ...config, uploadTimeoutMs: 90_000 }).put(key, media));
    await vi.advanceTimersByTimeAsync(89_999);
    expect(sdk.instances[0]!.httpsAgent.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ error: { code: "OSS_SAFETY_TIMEOUT" } });
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    expect(sdk.head).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 1, 499, 500, 746, 999])("keeps SDK rounded timestamps inside the absolute lease at millisecond %i", async (millisecond) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 27, 11, 2, 58, millisecond)));
    // Actual ali-oss utility.timestamp uses Math.round, not Math.floor.
    sdk.signatureUrl.mockImplementationOnce((objectKey, options) =>
      `https://${config.bucket}.${config.region}.aliyuncs.com/${objectKey}?OSSAccessKeyId=synthetic&Signature=synthetic&Expires=${Math.round(Date.now() / 1000) + options.expires}`);
    const absoluteExpiry = new Date(Date.UTC(2026, 8, 27, 11, 47, 48, 942));
    const url = new URL(await new OssSafetyMediaStore(config).signedGetUrl(key, absoluteExpiry));
    const actualExpiry = Number(url.searchParams.get("Expires")) * 1000;
    expect(actualExpiry).toBeLessThanOrEqual(absoluteExpiry.getTime());
    expect(actualExpiry).toBeGreaterThan(absoluteExpiry.getTime() - 2_000);
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.head).not.toHaveBeenCalled();
  });

  it("cancels a delete without cancelling concurrent operations", async () => {
    const controller = new AbortController();
    let completeWrite!: (value: unknown) => void;
    sdk.delete.mockImplementationOnce(() => new Promise(() => undefined));
    sdk.put.mockImplementationOnce(() => new Promise(resolve => { completeWrite = resolve; }));
    const store = new OssSafetyMediaStore(config);
    const deletion = observe(store.delete(key, controller.signal));
    const upload = store.put(key, media);
    controller.abort();
    expect(await deletion).toMatchObject({ error: { code: "OSS_SAFETY_ABORTED" } });
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
    expect(sdk.instances[1]!.httpsAgent.destroy).not.toHaveBeenCalled();
    completeWrite(putResult);
    await upload;
    expect(sdk.instances[1]!.httpsAgent.destroy).toHaveBeenCalledOnce();
  });

  it("does not create an SDK client for a previously aborted operation", async () => {
    const controller = new AbortController(); controller.abort();
    const store = new OssSafetyMediaStore(config);
    await expect(store.put(key, media, controller.signal)).rejects.toMatchObject({ code: "OSS_SAFETY_ABORTED" });
    await expect(store.delete(key, controller.signal)).rejects.toMatchObject({ code: "OSS_SAFETY_ABORTED" });
    await expect(store.signedGetUrl(key, new Date(Date.now() + 60_000), controller.signal)).rejects.toMatchObject({ code: "OSS_SAFETY_ABORTED" });
    expect(sdk.instances).toHaveLength(0);
  });

  it.each(["1", "true", "0"])("rejects urllib's global proxy override %s before SDK creation", async (value) => {
    vi.stubEnv("URLLIB_ENABLE_PROXY", value);
    const store = new OssSafetyMediaStore(config);
    await expect(store.put(key, media)).rejects.toMatchObject({ code: "OSS_SAFETY_PROXY_FORBIDDEN" });
    await expect(store.delete(key)).rejects.toMatchObject({ code: "OSS_SAFETY_PROXY_FORBIDDEN" });
    await expect(store.signedGetUrl(key, new Date(Date.now() + 60_000)))
      .rejects.toMatchObject({ code: "OSS_SAFETY_PROXY_FORBIDDEN" });
    expect(sdk.instances).toHaveLength(0);
  });

  it("refuses a new HEAD request when proxy environment changes during PUT", async () => {
    sdk.put.mockImplementationOnce(async () => {
      vi.stubEnv("URLLIB_ENABLE_PROXY", "1");
      return putResult;
    });
    await expect(new OssSafetyMediaStore(config).put(key, media)).rejects.toMatchObject({ code: "OSS_SAFETY_PROXY_FORBIDDEN" });
    expect(sdk.head).not.toHaveBeenCalled();
    expect(sdk.instances[0]!.httpsAgent.destroy).toHaveBeenCalledOnce();
  });

  it("signs with the real SDK across the rounding boundary without network access", async () => {
    const { default: RealOss } = await vi.importActual<{ default: typeof import("ali-oss") }>("ali-oss");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T11:02:58.746Z"));
    const realClient = new RealOss({ bucket: config.bucket, region: config.region,
      accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, secure: true });
    sdk.signatureUrl.mockImplementationOnce((objectKey, options) => realClient.signatureUrl(objectKey, options));
    const deadline = new Date("2026-09-27T11:47:48.942Z");
    const signed = new URL(await new OssSafetyMediaStore(config).signedGetUrl(key, deadline));
    expect(Number(signed.searchParams.get("Expires")) * 1000).toBeLessThanOrEqual(deadline.getTime());
    expect(sdk.put).not.toHaveBeenCalled();
    expect(sdk.head).not.toHaveBeenCalled();
  });

  it("creates a GET-only signed URL no later than the requested 45-minute deadline, with no network operations", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-27T12:00:00.800Z"));
    const expiry = new Date(Date.now() + OSS_SAFETY_MAX_URL_AGE_MS);
    const url = new URL(await new OssSafetyMediaStore(config).signedGetUrl(key, expiry));
    expect(url.protocol).toBe("https:");
    expect(Number(url.searchParams.get("Expires")) * 1000).toBeLessThanOrEqual(expiry.getTime());
    expect(sdk.signatureUrl).toHaveBeenCalledExactlyOnceWith(key, { method: "GET", expires: 2699 });
    expect(sdk.put).not.toHaveBeenCalled(); expect(sdk.head).not.toHaveBeenCalled(); expect(sdk.delete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 999, -1000, OSS_SAFETY_MAX_URL_AGE_MS + 1, NaN])("rejects unsafe URL lifetime %s without SDK calls", async (age) => {
    vi.useFakeTimers();
    await expect(new OssSafetyMediaStore(config).signedGetUrl(key, new Date(Date.now() + age)))
      .rejects.toMatchObject({ code: "OSS_SAFETY_EXPIRY_INVALID" });
    expect(sdk.instances).toHaveLength(0);
  });

  it.each(["http://", "https://evil.test/", "wrong-key", "too-late"])("rejects a malformed SDK URL: %s", async (variant) => {
    const expiry = new Date(Date.now() + 60_000);
    let value = signedUrl(key, variant === "too-late" ? 61 : 60);
    if (variant === "http://") value = value.replace("https://", "http://");
    if (variant === "https://evil.test/") value = value.replace(`${config.bucket}.${config.region}.aliyuncs.com`, "evil.test");
    if (variant === "wrong-key") value = value.replace(key, "private/source.png");
    sdk.signatureUrl.mockReturnValueOnce(value);
    await expect(new OssSafetyMediaStore(config).signedGetUrl(key, expiry)).rejects.toMatchObject({ code: "OSS_SAFETY_SIGN_FAILED" });
  });
});
