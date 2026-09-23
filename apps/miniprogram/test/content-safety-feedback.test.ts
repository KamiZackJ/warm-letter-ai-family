import { describe, expect, it } from "vitest";
import { userFacingApiError } from "../src/services/http-client";

describe("content safety feedback", () => {
  it.each([
    ["CONTENT_SAFETY_PENDING", "尚未寄出"],
    ["CONTENT_SAFETY_REJECTED", "删除相关素材"],
    ["CONTENT_SAFETY_UNAVAILABLE", "稍后重试"],
    ["WECHAT_LOGIN_REQUIRED", "重新登录"],
  ])("provides an actionable private-safe message for %s", (code, text) => {
    expect(userFacingApiError(code, "private upstream details")).toContain(text);
    expect(userFacingApiError(code, "private upstream details")).not.toContain("private upstream");
  });
});
