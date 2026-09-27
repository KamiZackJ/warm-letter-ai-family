import { describe, expect, it } from "vitest";
import { userFacingApiError } from "../src/services/http-client";

describe("content safety feedback", () => {
  it.each([
    ["CONTENT_SAFETY_PENDING", "尚未寄出"],
    ["CONTENT_SAFETY_DOWNLOAD_FAILED", "草稿和素材已保留"],
    ["CONTENT_SAFETY_REJECTED", "删除相关素材"],
    ["CONTENT_SAFETY_UNAVAILABLE", "稍后重试"],
    ["CONTENT_SAFETY_TIMEOUT", "草稿已保存"],
    ["WECHAT_LOGIN_REQUIRED", "重新登录"],
  ])("provides an actionable private-safe message for %s", (code, text) => {
    expect(userFacingApiError(code, "private upstream details")).toContain(text);
    expect(userFacingApiError(code, "private upstream details")).not.toContain("private upstream");
  });

  it("does not promise a completion time or describe failed downloads as a normal queue", () => {
    const pending = userFacingApiError("CONTENT_SAFETY_PENDING");
    const failed = userFacingApiError("CONTENT_SAFETY_DOWNLOAD_FAILED", "private signed URL");
    expect(pending).not.toMatch(/\d+\s*分钟/u);
    expect(failed).toContain("暂未成功");
    expect(failed).not.toMatch(/正在|仍在|分钟|private/u);
  });
});
