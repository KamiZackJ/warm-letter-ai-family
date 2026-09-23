import { environment } from "../config/env";
import { runCallbackTask } from "./async-task";

let consentInFlight: Promise<void> | undefined;

/** Let WeChat display its registered privacy agreement before a protected action. */
export async function ensurePrivacyConsent(): Promise<void> {
  if (environment.apiMode !== "real") return;
  if (typeof wx.requirePrivacyAuthorize !== "function") {
    throw new Error("请更新微信后，再使用添加素材和回复功能");
  }
  if (!consentInFlight) {
    consentInFlight = runCallbackTask<void>(({ success, fail }) => {
      wx.requirePrivacyAuthorize({
        success: () => success(undefined),
        fail: () => fail(new Error("你尚未同意隐私保护指引，内容没有上传；可以继续阅读家书")),
      });
    }, {
      timeoutMs: 120_000,
      timeoutError: () => new Error("隐私确认尚未完成，请重试；内容没有上传"),
    }).finally(() => { consentInFlight = undefined; });
  }
  await consentInFlight;
}

export function openPrivacyPage(): void {
  wx.navigateTo({ url: "/pages/privacy/index" });
}
