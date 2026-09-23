import { storageKey } from "../config/env";
import { runCallbackTask } from "../services/async-task";

const LETTER_RECORDS = ["real_intents", "real_share_tokens", "real_generation_jobs", "real_generation_request_keys"];

export function removeLetterLocally(id: string): void {
  const ids = wx.getStorageSync(storageKey("real_letter_ids"));
  if (Array.isArray(ids)) wx.setStorageSync(storageKey("real_letter_ids"), ids.filter((value) => value !== id));
  for (const name of LETTER_RECORDS) {
    const value = wx.getStorageSync(storageKey(name));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const next = { ...value };
      delete next[id];
      wx.setStorageSync(storageKey(name), next);
    }
  }
  const pending = wx.getStorageSync(storageKey("pending_generation"));
  if (pending?.letterId === id) wx.removeStorageSync(storageKey("pending_generation"));
}

/** Only remove files created by the narration writer, never original user media. */
export async function removeNarrationFiles(letterId?: string): Promise<void> {
  const fs = wx.getFileSystemManager();
  const directory = wx.env.USER_DATA_PATH;
  const prefix = letterId
    ? `warm-letter-narration-${letterId.replace(/[^A-Za-z0-9_-]/g, "-")}-`
    : "warm-letter-narration-";
  const { files } = await runCallbackTask<{ files: string[] }>((callbacks) => {
    fs.readdir({ dirPath: directory, ...callbacks });
  }, { timeoutMs: 5_000, timeoutError: () => new Error("读取本机朗读文件超时，请重试清理") });
  const ownedFiles = files.filter((name) => name.startsWith(prefix) && /^[A-Za-z0-9_.-]+$/.test(name) && /\.(wav|mp3)$/.test(name)
    && (!letterId || /^(?:audio_\d+_[a-z0-9]*|\d+)\.(wav|mp3)$/.test(name.slice(prefix.length))));
  await Promise.all(ownedFiles.map((name) => runCallbackTask<void>(({ success, fail }) => {
    fs.unlink({ filePath: `${directory}/${name}`, success: () => success(undefined), fail });
  }, { timeoutMs: 5_000, timeoutError: () => new Error("清理本机朗读文件超时，请重试清理") })));
}

export function clearWarmLetterStorage(): void {
  const { keys } = wx.getStorageInfoSync() as { keys: string[] };
  for (const key of keys) {
    if (key.startsWith("warm_letter:")) wx.removeStorageSync(key);
  }
}

export function confirmDeletion(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      wx.showModal({ title, content, confirmText: "确认删除", cancelText: "保留", confirmColor: "#8a3e34",
        success: (result: { confirm: boolean }) => resolve(result.confirm), fail: () => resolve(false) });
    } catch { resolve(false); }
  });
}
