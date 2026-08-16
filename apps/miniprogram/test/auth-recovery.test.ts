import { beforeEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/services/api";

const accessTokenKey = "warm_letter:test:access_token";

type WxRequestOptions = {
  url: string;
  method: string;
  data?: unknown;
  header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(error: { errMsg?: string }): void;
};

type LoginOptions = {
  success(result: { code: string }): void;
  fail(error: { errMsg?: string }): void;
};

function requestPath(options: WxRequestOptions): string {
  return new URL(options.url).pathname;
}

function rejectUnauthorized(options: WxRequestOptions): void {
  options.success({
    statusCode: 401,
    data: {
      error: {
        code: "UNAUTHORIZED",
        message: "access token expired",
        retryable: false,
      },
    },
  });
}

describe("real API authentication recovery", () => {
  const storage = new Map<string, unknown>();
  const requestMock = vi.fn();
  const loginMock = vi.fn();
  const removeStorageMock = vi.fn();

  beforeEach(() => {
    storage.clear();
    storage.set(accessTokenKey, "expired-token");
    requestMock.mockReset();
    loginMock.mockReset();
    removeStorageMock.mockReset();
    removeStorageMock.mockImplementation((key: string) => {
      storage.delete(key);
    });

    Object.assign(globalThis, {
      wx: {
        getStorageSync(key: string) {
          return storage.get(key);
        },
        setStorageSync(key: string, value: unknown) {
          storage.set(key, value);
        },
        removeStorageSync: removeStorageMock,
        login: loginMock,
        request: requestMock,
      },
    });
  });

  it("shares one WeChat login across concurrent 401 responses", async () => {
    const pendingFirstAttempts: WxRequestOptions[] = [];
    let materialAttemptCount = 0;
    let resolveLogin: LoginOptions["success"] | undefined;

    loginMock.mockImplementation((options: LoginOptions) => {
      resolveLogin = options.success;
    });
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = requestPath(options);
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/auth/wx-login") {
        options.success({ statusCode: 200, data: { token: "fresh-token" } });
        return;
      }
      if (options.method === "GET" && path === "/v1/materials") {
        materialAttemptCount += 1;
        if (materialAttemptCount <= 2) {
          pendingFirstAttempts.push(options);
          if (pendingFirstAttempts.length === 2) {
            pendingFirstAttempts.forEach(rejectUnauthorized);
          }
          return;
        }
        options.success({ statusCode: 200, data: { materials: [] } });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    const first = realApi.listMaterials();
    const second = realApi.listMaterials();

    await vi.waitFor(() => {
      expect(loginMock).toHaveBeenCalledOnce();
      expect(resolveLogin).toBeTypeOf("function");
    });
    resolveLogin!({ code: "new-wechat-code" });

    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);

    const requests = requestMock.mock.calls.map(([options]) => options as WxRequestOptions);
    const materialRequests = requests.filter(
      (options) => requestPath(options) === "/v1/materials",
    );
    const loginRequests = requests.filter(
      (options) => requestPath(options) === "/v1/auth/wx-login",
    );
    expect(materialRequests).toHaveLength(4);
    expect(materialRequests.slice(0, 2).map((options) => options.header.authorization)).toEqual([
      "Bearer expired-token",
      "Bearer expired-token",
    ]);
    expect(materialRequests.slice(2).map((options) => options.header.authorization)).toEqual([
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);
    expect(loginRequests).toHaveLength(1);
    expect(loginRequests[0]?.header.authorization).toBe("");
    expect(removeStorageMock).toHaveBeenCalledOnce();
    expect(storage.get(accessTokenKey)).toBe("fresh-token");
  });

  it("replays an operation only once when the refreshed token is also rejected", async () => {
    loginMock.mockImplementation((options: LoginOptions) => {
      options.success({ code: "new-wechat-code" });
    });
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = requestPath(options);
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/auth/wx-login") {
        options.success({ statusCode: 200, data: { token: "still-invalid-token" } });
        return;
      }
      if (options.method === "GET" && path === "/v1/materials") {
        rejectUnauthorized(options);
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    await expect(realApi.listMaterials()).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });

    const requests = requestMock.mock.calls.map(([options]) => options as WxRequestOptions);
    expect(
      requests.filter((options) => requestPath(options) === "/v1/materials"),
    ).toHaveLength(2);
    expect(
      requests.filter((options) => requestPath(options) === "/v1/auth/wx-login"),
    ).toHaveLength(1);
    expect(loginMock).toHaveBeenCalledOnce();
    expect(removeStorageMock).toHaveBeenCalledTimes(2);
    expect(storage.has(accessTokenKey)).toBe(false);
  });

  it("keeps a stable idempotency key while replaying a rejected material write", async () => {
    const materialRequests: WxRequestOptions[] = [];
    let remoteWriteCount = 0;

    loginMock.mockImplementation((options: LoginOptions) => {
      options.success({ code: "new-wechat-code" });
    });
    requestMock.mockImplementation((options: WxRequestOptions) => {
      const path = requestPath(options);
      if (options.method === "GET" && path === "/health") {
        options.success({ statusCode: 200, data: { deploymentMode: "test" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/auth/wx-login") {
        options.success({ statusCode: 200, data: { token: "fresh-token" } });
        return;
      }
      if (options.method === "POST" && path === "/v1/materials") {
        materialRequests.push(options);
        if (materialRequests.length === 1) {
          rejectUnauthorized(options);
          return;
        }
        remoteWriteCount += 1;
        options.success({
          statusCode: 200,
          data: {
            material: {
              id: "server-text",
              type: "text",
              name: "Daily note",
              textContent: "Dinner went well.",
              status: "READY",
              createdAt: "2026-08-16T08:00:00.000Z",
            },
          },
        });
        return;
      }
      options.fail({ errMsg: `Unexpected request: ${options.method} ${options.url}` });
    });

    const material = {
      id: "text_1786867200000_auth_retry",
      type: "text" as const,
      name: "Daily note",
      text: "Dinner went well.",
      createdAt: "2026-08-16T08:00:00.000Z",
    };
    await expect(realApi.saveMaterial(material)).resolves.toMatchObject({
      id: "server-text",
      text: material.text,
    });

    expect(materialRequests).toHaveLength(2);
    expect(materialRequests.map((options) => options.header["idempotency-key"])).toEqual([
      material.id,
      material.id,
    ]);
    expect(materialRequests.map((options) => options.header.authorization)).toEqual([
      "Bearer expired-token",
      "Bearer fresh-token",
    ]);
    expect(remoteWriteCount).toBe(1);
  });
});
