import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import {
  WechatCode2SessionProvider,
  WechatAuthError,
} from "../src/wechat-auth.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("WechatCode2SessionProvider", () => {
  it("exchanges a code and discards the session key", async () => {
    let requestUrl = "";
    const provider = new WechatCode2SessionProvider({
      appId: "wx-test-app",
      appSecret: "test-secret",
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return response({ openid: "openid-1", session_key: "must-not-leak", unionid: "union-1" });
      },
    });

    await expect(provider.exchangeCode("code-1")).resolves.toEqual({
      openId: "openid-1",
      unionId: "union-1",
    });
    const url = new URL(requestUrl);
    expect(url.searchParams.get("appid")).toBe("wx-test-app");
    expect(url.searchParams.get("secret")).toBe("test-secret");
    expect(url.searchParams.get("js_code")).toBe("code-1");
    expect(requestUrl).not.toContain("session_key");
  });

  it("maps invalid WeChat codes to a non-retryable 401 error", async () => {
    const provider = new WechatCode2SessionProvider({
      appId: "wx-test-app",
      appSecret: "test-secret",
      fetchImpl: async () => response({ errcode: 40029, errmsg: "invalid code" }),
    });

    await expect(provider.exchangeCode("bad-code")).rejects.toMatchObject({
      code: "WECHAT_LOGIN_REJECTED",
      retryable: false,
      statusCode: 401,
    });
  });

  it("fails closed on malformed provider responses", async () => {
    const provider = new WechatCode2SessionProvider({
      appId: "wx-test-app",
      appSecret: "test-secret",
      fetchImpl: async () => response({}),
    });

    await expect(provider.exchangeCode("code-1")).rejects.toMatchObject({
      code: "WECHAT_PROVIDER_INVALID_RESPONSE",
      retryable: true,
    });
  });

  it("rejects blank codes before making a network request", async () => {
    let called = false;
    const provider = new WechatCode2SessionProvider({
      appId: "wx-test-app",
      appSecret: "test-secret",
      fetchImpl: async () => {
        called = true;
        return response({ openid: "not-used" });
      },
    });

    await expect(provider.exchangeCode("  ")).rejects.toMatchObject({
      code: "WECHAT_CODE_INVALID",
      statusCode: 401,
    });
    expect(called).toBe(false);
  });
});

describe("WeChat login route", () => {
  it("issues a server session and authenticates protected routes", async () => {
    const app = buildApp({
      deploymentMode: "test",
      authProviderMode: "wechat",
      wechatAuthProvider: {
        exchangeCode: async (code) => ({ openId: `openid-for-${code}` }),
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/wx-login",
        payload: { code: "real-code", displayName: "测试用户" },
      });
      expect(login.statusCode).toBe(200);
      const body = login.json<{ token: string; user: { openId: string } }>();
      expect(body.token).toMatch(/^wx\./);
      expect(body.user.openId).toBe("openid-for-real-code");

      const materials = await app.inject({
        method: "GET",
        url: "/v1/materials",
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(materials.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not fall back to a development token when WeChat exchange fails", async () => {
    const app = buildApp({
      deploymentMode: "test",
      authProviderMode: "wechat",
      wechatAuthProvider: {
        exchangeCode: async () => {
          throw new WechatAuthError("WECHAT_LOGIN_REJECTED", "微信登录 code 无效", false, 401);
        },
      },
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/wx-login",
        payload: { code: "bad-code" },
      });
      expect(login.statusCode).toBe(401);
      expect(login.body).not.toContain("dev.");
      expect(login.body).not.toContain("session_key");
    } finally {
      await app.close();
    }
  });
});
