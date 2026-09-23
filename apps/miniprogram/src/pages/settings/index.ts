import { api } from "../../services/api";
import { openPrivacyPage } from "../../services/privacy";
import type { LetterSummary } from "../../types/domain";
import { clearWarmLetterStorage, confirmDeletion, removeLetterLocally, removeNarrationFiles } from "../../utils/data-deletion";
import { storageKey } from "../../config/env";

Page({
  disposed: false,
  loadId: 0,
  pendingLocalLetterIds: [] as string[],
  data: {
    letters: [] as LetterSummary[], loading: false, busy: false, error: "", notice: "",
    accountDeleted: false, localCleanupNeeded: false,
  },

  async onShow() {
    this.disposed = false;
    if (typeof wx.getStorageSync === "function" && wx.getStorageSync(storageKey("account_deleted")) === true) {
      this.setData({ accountDeleted: true, letters: [], loading: false });
    }
    if (!this.data.accountDeleted) await this.loadLetters();
  },
  onUnload() { this.disposed = true; this.loadId += 1; },
  openPrivacy: openPrivacyPage,

  async loadLetters() {
    if (this.data.loading || this.data.busy) return;
    const id = ++this.loadId;
    this.setData({ loading: true, error: "" });
    try {
      const letters = await api.listLetters();
      if (!this.disposed && id === this.loadId) this.setData({ letters });
    } catch (error) {
      if (!this.disposed && id === this.loadId) this.setData({ error: error instanceof Error ? error.message : "暂时无法读取家书，请重试" });
    } finally {
      if (!this.disposed && id === this.loadId) this.setData({ loading: false });
    }
  },

  async deleteLetter(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.busy || this.data.accountDeleted || this.disposed) return;
    const letter = this.data.letters.find((item) => item.id === event.currentTarget.dataset.id);
    if (!letter) return;
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const confirmed = await confirmDeletion("删除这封家书？", `“${letter.title}”及其回复将删除，分享链接立即失效，删除后无法恢复。素材可在素材页单独管理。`);
      if (!confirmed || this.disposed) return;
      const result = await api.deleteLetter(letter.id);
      if (this.disposed) return;
      this.loadId += 1;
      if (!result.localCleanupComplete) this.pendingLocalLetterIds.push(letter.id);
      this.setData({
        letters: this.data.letters.filter((item) => item.id !== letter.id),
        loading: false,
        localCleanupNeeded: this.data.localCleanupNeeded || !result.localCleanupComplete,
        notice: result.localCleanupComplete ? "家书已删除，分享已撤销。" : "家书已从服务器删除，分享已撤销；本机缓存未完全清理，请点击下方清理。",
      });
    } catch (error) {
      if (!this.disposed) this.setData({ error: error instanceof Error ? error.message : "删除未完成，请重试" });
    } finally { if (!this.disposed) this.setData({ busy: false }); }
  },

  async deleteAccount() {
    if (this.data.busy || this.data.accountDeleted || this.disposed) return;
    this.setData({ busy: true, error: "", notice: "" });
    try {
      const confirmed = await confirmDeletion("注销并删除全部数据？", "将删除你的全部家书、素材、回复和登录数据，撤销全部分享，并清理本机暖笺缓存。删除后无法恢复。再次使用写信功能会创建新的账号。你的相册原件不会删除。");
      if (!confirmed || this.disposed) return;
      const result = await api.deleteAccount();
      if (this.disposed) return;
      this.loadId += 1;
      this.setData({
        letters: [], loading: false, accountDeleted: true, localCleanupNeeded: !result.localCleanupComplete,
        notice: result.localCleanupComplete ? "账号已注销，云端数据和本机缓存已清除。" : "账号已注销，云端数据已删除；本机缓存未完全清理，请点击下方清理。",
      });
    } catch (error) {
      if (!this.disposed) this.setData({ error: error instanceof Error ? error.message : "注销未完成，请重试" });
    } finally { if (!this.disposed) this.setData({ busy: false }); }
  },

  async clearLocalCache() {
    if (this.data.busy || this.disposed) return;
    this.setData({ busy: true, error: "" });
    try {
      // For a single-letter deletion preserve active drafts and login metadata.
      if (this.data.accountDeleted) {
        clearWarmLetterStorage();
        wx.setStorageSync(storageKey("account_deleted"), true);
        await removeNarrationFiles();
      } else {
        for (const id of this.pendingLocalLetterIds) {
          removeLetterLocally(id);
          await removeNarrationFiles(id);
        }
      }
      this.pendingLocalLetterIds = [];
      if (!this.disposed) this.setData({ localCleanupNeeded: false, notice: "本机朗读缓存已清理。" });
    } catch {
      if (!this.disposed) this.setData({ error: "本机缓存尚未清理完成，请重试；也可在微信中删除本小程序的本地数据。" });
    } finally { if (!this.disposed) this.setData({ busy: false }); }
  },
});
