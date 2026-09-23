import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WechatStableTokenProvider } from "../src/wechat-token.js";
import { WechatContentSafetyProvider, requireTextSafety } from "../src/content-safety.js";

const response = (body: unknown): Response => new Response(JSON.stringify(body));
const input = { content: "今天一起吃了晚饭。", openId: "openid-test", scene: 4 as const };
const passed = { errcode: 0, trace_id: "trace-1", result: { suggest: "pass", label: 100 } };
const observe = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
afterEach(() => vi.useRealTimers());

describe("stable WeChat server token", () => {
  it("coalesces concurrent refreshes, caches then refreshes before expiry without forced invalidation", async () => {
    let now = 0;
    let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((accept) => { resolve = accept; }));
    const provider = new WechatStableTokenProvider({ appId: "wx-test", appSecret: "test-secret", fetchImpl, now: () => now });
    const first = provider.getToken();
    const second = provider.getToken();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledOnce();
    resolve(response({ access_token: "first", expires_in: 7200 }));
    await expect(first).resolves.toBe("first");
    await expect(provider.getToken()).resolves.toBe("first");
    now = 6_901_000;
    const third = provider.getToken();
    await Promise.resolve();
    resolve(response({ access_token: "second", expires_in: 7200 }));
    await expect(third).resolves.toBe("second");
    provider.invalidate("first");
    await expect(provider.getToken()).resolves.toBe("second");
    const request = (fetchImpl.mock.calls as unknown as [unknown, RequestInit][])[0]![1];
    expect(JSON.parse(request.body as string)).toEqual({ grant_type: "client_credential", appid: "wx-test", secret: "test-secret", force_refresh: false });
    expect(request.redirect).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not cache provider failures or retain provider secrets in errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ errcode: 40125, errmsg: "private-secret" }))
      .mockResolvedValueOnce(response({ access_token: "recovered", expires_in: 7200 }));
    const provider = new WechatStableTokenProvider({ appId: "wx-test", appSecret: "private-secret", fetchImpl });
    const result = await observe(provider.getToken());
    expect(result).toMatchObject({ error: { reason: "provider" } });
    expect(JSON.stringify(result)).not.toContain("private-secret");
    await expect(provider.getToken()).resolves.toBe("recovered");
  });

  it("bounds incomplete token bodies and releases an abandoned in-flight refresh", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"access_token":"late","expires_in":7200}')); }, cancel,
    }))).mockResolvedValueOnce(response({ access_token: "fresh", expires_in: 7200 }));
    const provider = new WechatStableTokenProvider({ appId: "wx-test", appSecret: "secret", timeoutMs: 500, fetchImpl });
    const result = observe(provider.getToken());
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ error: { reason: "timeout" } });
    expect(cancel).toHaveBeenCalled();
    await expect(provider.getToken()).resolves.toBe("fresh");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("WeChat content safety", () => {
  function provider(fetchImpl: typeof fetch, timeoutMs = 1000) {
    const tokenProvider = { getToken: vi.fn(async () => "token"), invalidate: vi.fn() };
    return { tokenProvider, safety: new WechatContentSafetyProvider({ tokenProvider, fetchImpl, timeoutMs }) };
  }

  it.each(["risky", "review"])("does not publish %s results", async (suggest) => {
    const fetchImpl = vi.fn(async () => response({ ...passed, result: { suggest, label: 20001 } }));
    const { safety } = provider(fetchImpl);
    await expect(safety.checkText(input)).resolves.toEqual({ decision: "reject", reason: suggest, traceId: "trace-1" });
    await expect(requireTextSafety(safety, input)).rejects.toMatchObject({ statusCode: 422, code: "CONTENT_REJECTED" });
  });

  it("sends the exact version 2 identity/scene/content payload and allows only a complete pass", async () => {
    const fetchImpl = vi.fn(async () => response(passed));
    const { safety } = provider(fetchImpl);
    await expect(safety.checkText(input)).resolves.toEqual({ decision: "allow", traceId: "trace-1" });
    const [url, init] = (fetchImpl.mock.calls as unknown as [URL, RequestInit][])[0]!;
    expect(url.href).toBe("https://api.weixin.qq.com/wxa/msg_sec_check?access_token=token");
    expect(JSON.parse(init.body as string)).toEqual({ version: 2, content: input.content, openid: input.openId, scene: 4 });
    expect(init.redirect).toBe("error");
  });

  it.each([{}, { errcode: 0, trace_id: "receipt-only" }, { ...passed, result: { suggest: "unknown", label: 100 } }, { ...passed, errcode: 45009 }])("fails closed for missing/unknown results and quotas", async (body) => {
    const fetchImpl = vi.fn(async () => response(body));
    const { safety } = provider(fetchImpl);
    expect((await safety.checkText(input)).decision).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a definite expired credential once, with no retry for expired visitor identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ errcode: 40001 })).mockResolvedValueOnce(response(passed));
    const { safety, tokenProvider } = provider(fetchImpl);
    await expect(safety.checkText(input)).resolves.toMatchObject({ decision: "allow" });
    expect(tokenProvider.invalidate).toHaveBeenCalledWith("token");
    expect(tokenProvider.getToken).toHaveBeenCalledTimes(2);
    fetchImpl.mockReset().mockImplementation(async () => response({ errcode: 61010 }));
    await expect(requireTextSafety(safety, input)).rejects.toMatchObject({ statusCode: 401, code: "WECHAT_LOGIN_REQUIRED" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("caps repeated invalid-token retries at two calls", async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: 40001 }));
    const { safety } = provider(fetchImpl);
    await expect(safety.checkText(input)).resolves.toMatchObject({ decision: "unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects absent identity, oversized text and untrusted media URLs before requests", async () => {
    const fetchImpl = vi.fn();
    const { safety } = provider(fetchImpl);
    await expect(safety.checkText({ ...input, openId: " " })).resolves.toMatchObject({ decision: "unavailable", reason: "login-required" });
    await expect(safety.checkText({ ...input, content: "字".repeat(2501) })).resolves.toMatchObject({ decision: "reject", reason: "invalid-content" });
    await expect(safety.submitMedia({ openId: "open", scene: 4, mediaType: "image", mediaUrl: "http://localhost/asset" })).resolves.toMatchObject({ decision: "unavailable", reason: "invalid-content" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("media submission is pending even if an unexpected pass field is present", async () => {
    const fetchImpl = vi.fn(async () => response(passed));
    const { safety } = provider(fetchImpl);
    await expect(safety.submitMedia({ mediaUrl: "https://api.example/media?token=private", mediaType: "audio", openId: input.openId, scene: 4 }))
      .resolves.toEqual({ decision: "pending", traceId: "trace-1" });
    const [, init] = (fetchImpl.mock.calls as unknown as [URL, RequestInit][])[0]!;
    expect(JSON.parse(init.body as string)).toMatchObject({ version: 2, media_type: 1, scene: 4 });
  });

  it("bounds stuck headers and discards/cancels late success without another request", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((accept) => { resolve = accept; }));
    const { safety } = provider(fetchImpl, 500);
    const result = safety.checkText(input);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ decision: "unavailable", reason: "timeout" });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one deadline across token refresh, retry and the complete body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const tokenProvider = {
      getToken: vi.fn(() => new Promise<string>((resolve) => setTimeout(() => resolve("token"), 200))),
      invalidate: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ errcode: 42001 })).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(passed))); },
      // Even a complete JSON prefix is not accepted until EOF.
      cancel,
    })));
    const safety = new WechatContentSafetyProvider({ tokenProvider, fetchImpl, timeoutMs: 500 });
    const result = safety.checkText(input);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ decision: "unavailable", reason: "timeout" });
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("limits the full response body and never returns upstream private error text", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("private-secret".repeat(12000)))
      .mockRejectedValueOnce(new Error("private-secret and access_token=secret"));
    const { safety } = provider(fetchImpl);
    expect(JSON.stringify(await safety.checkText(input))).toBe('{"decision":"unavailable","reason":"invalid-response","retryable":true}');
    expect(JSON.stringify(await safety.checkText(input))).not.toContain("secret");
  });

  it("works with a local HTTP server through an injected test transport without sending real credentials", async () => {
    const paths: string[] = [];
    const server = createServer((request, reply) => {
      paths.push(request.url!);
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        const payload = JSON.parse(body);
        if (request.url === "/cgi-bin/stable_token") {
          expect(payload.secret).toBe("synthetic-secret");
          reply.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 7200 }));
        } else {
          expect(payload.openid).toBe(input.openId);
          reply.end(JSON.stringify(passed));
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No local address");
    const localFetch: typeof fetch = (url, init) => {
      const target = new URL(String(url));
      return fetch(`http://127.0.0.1:${address.port}${target.pathname}${target.search}`, init);
    };
    try {
      const safety = new WechatContentSafetyProvider({ fetchImpl: localFetch, tokenProvider: new WechatStableTokenProvider({ appId: "synthetic-app", appSecret: "synthetic-secret", fetchImpl: localFetch }) });
      await expect(safety.checkText(input)).resolves.toMatchObject({ decision: "allow" });
      expect(paths).toEqual(["/cgi-bin/stable_token", "/wxa/msg_sec_check?access_token=synthetic-token"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
