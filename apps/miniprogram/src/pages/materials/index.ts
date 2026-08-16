import { api } from "../../services/api";
import { createDemoMaterials } from "../../config/demo-materials";
import { environment, environmentView } from "../../config/env";
import { resolveDemoRequest } from "../../config/runtime-environment";
import type { Material, MaterialType } from "../../types/domain";
import { createId } from "../../utils/id";
import {
  getCurrentMaterialSelection,
  updateCurrentMaterialIdsForSession,
} from "../../utils/storage";

type DisplayMaterial = Material & {
  typeLabel: string;
  detail: string;
};

type ImageMaterialType = "photo" | "screenshot";
type SinglePurpose = "text" | "voice";
type BatchPurpose = "image" | "demo";
type RetryStage = "remote" | "local";
type RetryKind = "choose-image" | "prepare-demo" | "single" | "batch" | "record" | "delete";
type BusyAction = "" | "image" | "text" | "voice" | "demo" | "delete";
const MAX_LOAD_ATTEMPTS = 3;

type RetryAction = {
  id: string;
  kind: RetryKind;
  title: string;
  message: string;
  hint: string;
  retryLabel: string;
  stage?: RetryStage;
  singlePurpose?: SinglePurpose;
  material?: Material;
  batchPurpose?: BatchPurpose;
  pendingMaterials?: Material[];
  pendingCommits?: Material[];
  completedCount?: number;
  totalCount?: number;
  imageType?: ImageMaterialType;
  deleteId?: string;
};

const TYPE_LABELS: Record<MaterialType, string> = {
  photo: "照片",
  screenshot: "截图",
  voice: "语音",
  text: "文字",
};

const recorder = wx.getRecorderManager();

function displayMaterial(material: Material): DisplayMaterial {
  const detail =
    material.type === "text"
      ? material.text || ""
      : material.type === "voice"
        ? `${material.durationSeconds || 0} 秒`
        : material.name;
  return { ...material, typeLabel: TYPE_LABELS[material.type], detail };
}

function confirmMaterialDeletion(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    wx.showModal({
      title: "删除这项素材？",
      content: `删除“${name}”后，它将不再用于当前家书。`,
      confirmText: "删除",
      confirmColor: "#8A3E34",
      cancelText: "保留",
      success: (result: { confirm: boolean }) => resolve(result.confirm),
      fail: () => resolve(false),
    });
  });
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    error &&
    typeof error === "object" &&
    "errMsg" in error &&
    typeof error.errMsg === "string" &&
    error.errMsg
  ) {
    return error.errMsg;
  }
  return fallback;
}

function singleRetryAction(purpose: SinglePurpose, material: Material): RetryAction {
  const isText = purpose === "text";
  return {
    id: `${purpose}:${material.id}`,
    kind: "single",
    stage: "remote",
    singlePurpose: purpose,
    material: { ...material },
    title: isText ? "文字还没有加入" : "录音还没有加入",
    message: isText ? "这段文字暂时无法保存" : "这段录音暂时无法保存",
    hint: isText
      ? "失败时的文字已单独保留。重试会原样保存；输入框中的修改可另行加入。"
      : "录音文件仍保留，请重试保存。",
    retryLabel: isText ? "重试原内容" : "重试保存",
  };
}

function batchRetryAction(purpose: BatchPurpose, materials: Material[]): RetryAction {
  const isDemo = purpose === "demo";
  return {
    id: `${purpose}:${createId("batch")}`,
    kind: "batch",
    stage: "remote",
    batchPurpose: purpose,
    pendingMaterials: materials,
    pendingCommits: [],
    completedCount: 0,
    totalCount: materials.length,
    title: isDemo ? "演示素材还没有全部加入" : "图片还没有全部加入",
    message: isDemo ? "演示素材保存中断" : "图片保存中断",
    hint: `已加入 0/${materials.length} 项，重试只继续未完成部分。`,
    retryLabel: "继续加入",
  };
}

function batchProgressHint(action: RetryAction, stage: RetryStage): string {
  const completed = action.completedCount || 0;
  const total = action.totalCount || 0;
  const pendingRemote = action.pendingMaterials?.length || 0;
  const pendingLocal = action.pendingCommits?.length || 0;
  if (stage === "local") {
    return `已加入 ${completed}/${total} 项；${pendingLocal} 项已保存到服务。重试只恢复页面记录，再继续剩余 ${pendingRemote} 项。`;
  }
  return `已加入 ${completed}/${total} 项，重试只继续剩余 ${pendingRemote} 项。`;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

Page({
  disposed: false,
  loadRequestId: 0,
  materialSessionId: "",
  materialSelectionRevision: 0,
  recordingEpoch: 0,

  data: {
    ...environmentView,
    demoMode: false,
    materials: [] as DisplayMaterial[],
    textDraft: "",
    recording: false,
    stoppingRecord: false,
    loading: true,
    loadError: "",
    busyAction: "" as BusyAction,
    activeImageType: "" as "" | ImageMaterialType,
    deletingMaterialId: "",
    actionErrors: [] as RetryAction[],
    retryingId: "",
  },

  expireMaterialSession() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadRequestId += 1;
    wx.showToast({ title: "本次素材流程已失效，请重新开始", icon: "none" });
    wx.reLaunch({ url: "/pages/home/index" });
  },

  onLoad(options: { demo?: string; session?: string }) {
    this.disposed = false;
    const selection = getCurrentMaterialSelection();
    if (!options.session || options.session !== selection.sessionId) {
      this.expireMaterialSession();
      return;
    }
    this.materialSessionId = selection.sessionId;
    this.materialSelectionRevision = selection.revision;
    try {
      this.setData({ demoMode: resolveDemoRequest(options.demo, environment.demoEnabled) });
    } catch (error) {
      wx.showToast({ title: errorMessage(error, "演示入口不可用"), icon: "none" });
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    recorder.offStop();
    recorder.offError();
  },

  onUnload() {
    this.disposed = true;
    this.loadRequestId += 1;
    this.recordingEpoch += 1;
    recorder.offStop();
    recorder.offError();
    if (this.data.recording && !this.data.stoppingRecord) {
      try {
        recorder.stop();
      } catch {
        // The page is already leaving; stopping the microphone is best-effort.
      }
    }
  },

  async onShow() {
    if (this.data.busyAction || this.data.recording) return;
    await this.loadMaterials();
  },

  async loadMaterials() {
    const requestId = this.loadRequestId + 1;
    this.loadRequestId = requestId;
    if (this.disposed) return;
    this.setData({ loading: true });
    try {
      for (let attempt = 0; attempt < MAX_LOAD_ATTEMPTS; attempt += 1) {
        const selection = getCurrentMaterialSelection();
        if (selection.sessionId !== this.materialSessionId) {
          this.expireMaterialSession();
          return;
        }
        const allMaterials = await api.listMaterials();
        if (this.disposed || this.loadRequestId !== requestId) return;

        const latestSelection = getCurrentMaterialSelection();
        if (latestSelection.sessionId !== this.materialSessionId) {
          this.expireMaterialSession();
          return;
        }
        if (latestSelection.revision !== selection.revision) continue;

        const materialsById = new Map(allMaterials.map((item) => [item.id, item]));
        const materials = selection.ids
          .map((id) => materialsById.get(id))
          .filter((item): item is Material => Boolean(item))
          .map(displayMaterial);
        const retainedIds = materials.map((item) => item.id);
        let committedSelection = selection;
        if (!sameIds(retainedIds, selection.ids)) {
          const updated = updateCurrentMaterialIdsForSession(
            this.materialSessionId,
            () => retainedIds,
            selection.revision,
          );
          if (!updated) continue;
          committedSelection = updated;
        }

        this.materialSelectionRevision = committedSelection.revision;
        this.setData({ materials, loadError: "" });
        return;
      }

      this.setData({
        loadError: "素材列表刚刚发生变化，请点重试读取最新内容",
      });
    } catch (error) {
      if (this.disposed || this.loadRequestId !== requestId) return;
      const message = errorMessage(error, "暂时无法读取已选素材");
      this.setData({ loadError: message });
      wx.showToast({ title: message, icon: "none" });
    } finally {
      if (!this.disposed && this.loadRequestId === requestId) {
        this.setData({ loading: false });
      }
    }
  },

  async retryLoadMaterials() {
    if (this.disposed || this.data.loading || this.data.busyAction || this.data.recording) return;
    await this.loadMaterials();
  },

  async chooseImage(event: { currentTarget: { dataset: { type: MaterialType } } }) {
    const type = event.currentTarget.dataset.type;
    if (type !== "photo" && type !== "screenshot") return;
    await this.chooseImages(type);
  },

  async chooseImages(type: ImageMaterialType, retryId = "") {
    if (this.disposed || this.data.loading || this.data.busyAction || this.data.recording) return;
    this.setData({ busyAction: "image", activeImageType: type });
    let result: { tempFiles: Array<{ tempFilePath: string }> } | undefined;
    try {
      result = await new Promise<{ tempFiles: Array<{ tempFilePath: string }> }>(
        (resolve, reject) => {
          wx.chooseMedia({
            count: 6,
            mediaType: ["image"],
            sourceType: ["album", "camera"],
            success: resolve,
            fail: reject,
          });
        },
      );
    } catch (error) {
      const message = errorMessage(error, "选择图片失败");
      if (!this.disposed && !message.includes("cancel")) {
        const id = retryId || `choose-image:${type}`;
        this.upsertActionError({
          id,
          kind: "choose-image",
          imageType: type,
          title: "图片还没有选好",
          message,
          hint: "请检查相册或相机权限后重新选择。",
          retryLabel: "重新选择",
        });
        wx.showToast({ title: message, icon: "none" });
      }
    } finally {
      if (!this.disposed) this.setData({ busyAction: "", activeImageType: "" });
    }

    if (!result || this.disposed) return;
    if (retryId) this.removeActionError(retryId);
    const created = result.tempFiles.map((file, index) => ({
      id: createId(type),
      type,
      name: `${TYPE_LABELS[type]} ${this.data.materials.length + index + 1}`,
      localPath: file.tempFilePath,
      createdAt: new Date().toISOString(),
    }));
    if (created.length > 0) {
      await this.saveBatchMaterials(batchRetryAction("image", created));
    }
  },

  updateTextDraft(event: { detail: { value: string } }) {
    if (this.disposed) return;
    this.setData({ textDraft: event.detail.value });
  },

  async addText() {
    if (this.disposed || this.data.loading || this.data.busyAction || this.data.recording) return;
    const text = this.data.textDraft.trim();
    if (!text) {
      wx.showToast({ title: "先写下一点近况", icon: "none" });
      return;
    }
    const matchingRetry = this.data.actionErrors.find(
      (item) =>
        item.kind === "single" &&
        item.singlePurpose === "text" &&
        item.material?.text?.trim() === text,
    );
    if (matchingRetry?.material) {
      await this.saveSingleMaterial(matchingRetry);
      return;
    }
    const material: Material = {
      id: createId("text"),
      type: "text",
      name: "文字近况",
      text,
      createdAt: new Date().toISOString(),
    };
    await this.saveSingleMaterial(singleRetryAction("text", material));
  },

  bindRecorderCallbacks(epoch: number) {
    let settled = false;
    recorder.offStop();
    recorder.offError();
    recorder.onStop((result: { tempFilePath: string; duration: number }) => {
      if (settled || this.disposed || epoch !== this.recordingEpoch) return;
      settled = true;
      void this.handleRecordedVoice(result);
    });
    recorder.onError(() => {
      if (settled || this.disposed || epoch !== this.recordingEpoch) return;
      settled = true;
      this.setData({ recording: false, stoppingRecord: false });
      this.upsertActionError({
        id: "record",
        kind: "record",
        title: "录音没有完成",
        message: "微信未能完成本次录音。",
        hint: "请检查麦克风权限后重试录音。",
        retryLabel: "重新录音",
      });
      wx.showToast({ title: "录音失败，请检查权限", icon: "none" });
    });
  },

  async saveSingleMaterial(action: RetryAction) {
    const material = action.material;
    const purpose = action.singlePurpose;
    if (!material || !purpose || this.disposed || this.data.busyAction) return;
    const submittedText = material.text?.trim() || "";
    this.setData({ busyAction: purpose });
    let saved = material;
    try {
      if (action.stage !== "local") {
        try {
          saved = await api.saveMaterial(material);
        } catch (error) {
          if (this.disposed) return;
          const message = errorMessage(
            error,
            purpose === "text" ? "这段文字暂时无法保存" : "这段录音暂时无法保存",
          );
          this.upsertActionError({ ...action, stage: "remote", material, message });
          wx.showToast({ title: message, icon: "none" });
          return;
        }
      }

      try {
        if (!this.appendMaterials([saved])) return;
      } catch (error) {
        if (this.disposed) return;
        const message = errorMessage(error, "素材已保存，但本页暂时无法记录");
        this.upsertActionError({
          ...action,
          stage: "local",
          material: saved,
          title:
            purpose === "text"
              ? "文字已保存，页面尚未更新"
              : "录音已保存，页面尚未更新",
          message,
          hint: "素材已保存到服务，重试只恢复本页记录，不会再次上传。",
        });
        wx.showToast({ title: message, icon: "none" });
        return;
      }

      this.removeActionError(action.id);
      if (this.disposed) return;
      if (purpose === "text" && this.data.textDraft.trim() === submittedText) {
        this.setData({ textDraft: "" });
      }
    } finally {
      if (!this.disposed) this.setData({ busyAction: "" });
    }
  },

  startRecord() {
    if (
      this.disposed ||
      this.data.loading ||
      this.data.busyAction ||
      this.data.recording ||
      this.data.stoppingRecord
    ) return;
    const pendingVoice = this.data.actionErrors.some(
      (item) => item.kind === "single" && item.singlePurpose === "voice",
    );
    if (pendingVoice) {
      wx.showToast({ title: "请先重试保存上次录音", icon: "none" });
      return;
    }
    const epoch = this.recordingEpoch + 1;
    this.recordingEpoch = epoch;
    this.bindRecorderCallbacks(epoch);
    this.setData({ recording: true, stoppingRecord: false });
    this.removeActionError("record");
    try {
      recorder.start({
        duration: 60_000,
        format: "mp3",
        sampleRate: 16_000,
        numberOfChannels: 1,
        encodeBitRate: 48_000,
      });
    } catch (error) {
      if (this.recordingEpoch === epoch) this.recordingEpoch += 1;
      recorder.offStop();
      recorder.offError();
      const message = errorMessage(error, "录音未能开始");
      this.setData({ recording: false, stoppingRecord: false });
      this.upsertActionError({
        id: "record",
        kind: "record",
        title: "录音没有开始",
        message,
        hint: "请检查麦克风权限后重试录音。",
        retryLabel: "重新录音",
      });
      wx.showToast({ title: message, icon: "none" });
    }
  },

  stopRecord() {
    if (this.disposed || !this.data.recording || this.data.stoppingRecord) return;
    this.setData({ stoppingRecord: true });
    try {
      recorder.stop();
    } catch (error) {
      this.recordingEpoch += 1;
      recorder.offStop();
      recorder.offError();
      const message = errorMessage(error, "录音未能结束");
      this.setData({ recording: false, stoppingRecord: false });
      this.upsertActionError({
        id: "record",
        kind: "record",
        title: "录音没有完成",
        message,
        hint: "请重新录制这段语音。",
        retryLabel: "重新录音",
      });
      wx.showToast({ title: message, icon: "none" });
    }
  },

  async handleRecordedVoice(result: { tempFilePath: string; duration: number }) {
    const material: Material = {
      id: createId("voice"),
      type: "voice",
      name: "语音近况",
      localPath: result.tempFilePath,
      durationSeconds: Math.max(1, Math.round(result.duration / 1000)),
      createdAt: new Date().toISOString(),
    };
    if (!this.disposed) this.setData({ recording: false, stoppingRecord: false });
    await this.saveSingleMaterial(singleRetryAction("voice", material));
  },

  async loadDemoMaterials() {
    if (this.disposed || this.data.loading || this.data.busyAction || this.data.recording) return;
    if (!environment.demoEnabled || !this.data.demoMode) {
      wx.showToast({ title: "当前环境禁止加载演示素材", icon: "none" });
      return;
    }
    const pending = this.data.actionErrors.find(
      (item) => item.kind === "batch" && item.batchPurpose === "demo",
    );
    if (pending) {
      await this.saveBatchMaterials(pending);
      return;
    }

    let materials: Material[];
    try {
      materials = createDemoMaterials();
      this.removeActionError("prepare-demo");
    } catch (error) {
      const message = errorMessage(error, "演示素材暂时无法准备");
      this.upsertActionError({
        id: "prepare-demo",
        kind: "prepare-demo",
        title: "演示素材还没有准备好",
        message,
        hint: "请重试加载演示素材。",
        retryLabel: "重新准备",
      });
      wx.showToast({ title: message, icon: "none" });
      return;
    }
    await this.saveBatchMaterials(batchRetryAction("demo", materials));
  },

  async saveBatchMaterials(initialAction: RetryAction) {
    const purpose = initialAction.batchPurpose;
    if (!purpose || this.disposed || this.data.busyAction) return;
    const imageCandidate = [
      ...(initialAction.pendingCommits || []),
      ...(initialAction.pendingMaterials || []),
    ].find((item) => item.type === "photo" || item.type === "screenshot");
    const activeImageType =
      imageCandidate?.type === "photo" || imageCandidate?.type === "screenshot"
        ? imageCandidate.type
        : "";
    this.setData({
      busyAction: purpose === "demo" ? "demo" : "image",
      activeImageType,
    });
    let action: RetryAction = {
      ...initialAction,
      pendingMaterials: [...(initialAction.pendingMaterials || [])],
      pendingCommits: [...(initialAction.pendingCommits || [])],
    };

    try {
      while ((action.pendingCommits?.length || 0) > 0) {
        if (this.disposed) return;
        const [saved, ...remainingCommits] = action.pendingCommits || [];
        if (!saved) break;
        try {
          if (!this.appendMaterials([saved])) return;
        } catch (error) {
          if (this.disposed) return;
          const message = errorMessage(error, "素材已保存，但本页暂时无法记录");
          action = {
            ...action,
            stage: "local",
            title: "部分素材已保存，页面尚未更新",
            message,
          };
          this.upsertActionError({
            ...action,
            hint: batchProgressHint(action, "local"),
          });
          wx.showToast({ title: message, icon: "none" });
          return;
        }
        action = {
          ...action,
          pendingCommits: remainingCommits,
          completedCount: (action.completedCount || 0) + 1,
        };
      }

      while ((action.pendingMaterials?.length || 0) > 0) {
        if (this.disposed) return;
        const [material, ...remainingMaterials] = action.pendingMaterials || [];
        if (!material) break;
        let saved: Material;
        try {
          saved = await api.saveMaterial(material);
        } catch (error) {
          if (this.disposed) return;
          const message = errorMessage(error, "素材保存中断");
          action = { ...action, stage: "remote", message };
          this.upsertActionError({
            ...action,
            hint: batchProgressHint(action, "remote"),
          });
          wx.showToast({ title: message, icon: "none" });
          return;
        }

        action = { ...action, pendingMaterials: remainingMaterials };
        try {
          if (!this.appendMaterials([saved])) return;
        } catch (error) {
          if (this.disposed) return;
          const message = errorMessage(error, "素材已保存，但本页暂时无法记录");
          action = {
            ...action,
            stage: "local",
            title: "部分素材已保存，页面尚未更新",
            pendingCommits: [saved, ...(action.pendingCommits || [])],
            message,
          };
          this.upsertActionError({
            ...action,
            hint: batchProgressHint(action, "local"),
          });
          wx.showToast({ title: message, icon: "none" });
          return;
        }
        action = {
          ...action,
          completedCount: (action.completedCount || 0) + 1,
        };
      }

      this.removeActionError(action.id);
      wx.showToast({
        title: purpose === "demo" ? "合成演示素材已加入" : "图片已加入",
        icon: "success",
      });
    } finally {
      if (!this.disposed) this.setData({ busyAction: "", activeImageType: "" });
    }
  },

  appendMaterials(items: Material[]): boolean {
    const incomingIds = new Set(items.map((item) => item.id));
    const materials = [
      ...items.map(displayMaterial),
      ...this.data.materials.filter((item) => !incomingIds.has(item.id)),
    ];
    const updated = updateCurrentMaterialIdsForSession(
      this.materialSessionId,
      (ids) => [
        ...items.map((item) => item.id),
        ...ids.filter((id) => !incomingIds.has(id)),
      ],
    );
    if (!updated) return false;
    this.materialSelectionRevision = updated.revision;
    if (!this.disposed) {
      this.setData({ materials });
      if (!sameIds(updated.ids, materials.map((item) => item.id))) {
        void this.loadMaterials();
      }
    }
    return true;
  },

  async deleteMaterial(event: { currentTarget: { dataset: { id: string } } }) {
    if (this.disposed || this.data.loading || this.data.busyAction || this.data.recording) return;
    const id = event.currentTarget.dataset.id;
    const material = this.data.materials.find((item) => item.id === id);
    if (!material || !(await confirmMaterialDeletion(material.name))) return;
    const pending = this.data.actionErrors.find(
      (item) => item.kind === "delete" && item.deleteId === id,
    );
    await this.deleteWithRecovery(
      pending || {
        id: `delete:${id}`,
        kind: "delete",
        stage: "remote",
        deleteId: id,
        title: "素材还没有删除",
        message: "这项素材暂时无法删除",
        hint: "素材仍保留在列表中，请重试删除。",
        retryLabel: "重试删除",
      },
    );
  },

  async deleteWithRecovery(action: RetryAction) {
    const id = action.deleteId;
    if (!id || this.disposed || this.data.busyAction) return;
    this.setData({ busyAction: "delete", deletingMaterialId: id });
    try {
      if (action.stage !== "local") {
        try {
          await api.deleteMaterial(id);
        } catch (error) {
          if (this.disposed) return;
          const message = errorMessage(error, "这项素材暂时无法删除");
          this.upsertActionError({ ...action, stage: "remote", message });
          wx.showToast({ title: message, icon: "none" });
          return;
        }
      }

      const materials = this.data.materials.filter((item) => item.id !== id);
      try {
        const updated = updateCurrentMaterialIdsForSession(
          this.materialSessionId,
          (ids) => ids.filter((materialId) => materialId !== id),
        );
        if (!updated) return;
        this.materialSelectionRevision = updated.revision;
        if (this.disposed) return;
        this.setData({ materials });
        if (!sameIds(updated.ids, materials.map((item) => item.id))) {
          void this.loadMaterials();
        }
      } catch (error) {
        if (this.disposed) return;
        const message = errorMessage(error, "素材已删除，但本页暂时无法更新");
        this.upsertActionError({
          ...action,
          stage: "local",
          title: "删除已完成，页面尚未更新",
          message,
          hint: "服务端删除已完成，重试只更新本页记录，不会再次发送删除请求。",
        });
        wx.showToast({ title: message, icon: "none" });
        return;
      }
      this.removeActionError(action.id);
    } finally {
      if (!this.disposed) this.setData({ busyAction: "", deletingMaterialId: "" });
    }
  },

  upsertActionError(action: RetryAction) {
    if (this.disposed) return;
    this.setData({
      actionErrors: [
        action,
        ...this.data.actionErrors.filter((item) => item.id !== action.id),
      ],
    });
  },

  removeActionError(id: string) {
    if (this.disposed) return;
    if (!this.data.actionErrors.some((item) => item.id === id)) return;
    this.setData({
      actionErrors: this.data.actionErrors.filter((item) => item.id !== id),
    });
  },

  async retryFailedAction(event: { currentTarget: { dataset: { retryId: string } } }) {
    const id = event.currentTarget.dataset.retryId;
    if (
      !id ||
      this.disposed ||
      this.data.loading ||
      this.data.retryingId ||
      this.data.busyAction ||
      this.data.recording
    ) return;
    const action = this.data.actionErrors.find((item) => item.id === id);
    if (!action) return;
    this.setData({ retryingId: id });
    try {
      if (action.kind === "choose-image" && action.imageType) {
        await this.chooseImages(action.imageType, action.id);
      } else if (action.kind === "prepare-demo") {
        await this.loadDemoMaterials();
      } else if (action.kind === "single") {
        await this.saveSingleMaterial(action);
      } else if (action.kind === "batch") {
        await this.saveBatchMaterials(action);
      } else if (action.kind === "record") {
        this.startRecord();
      } else if (action.kind === "delete") {
        await this.deleteWithRecovery(action);
      }
    } finally {
      if (!this.disposed) this.setData({ retryingId: "" });
    }
  },

  goIntent() {
    if (
      this.disposed ||
      this.data.loading ||
      this.data.busyAction ||
      this.data.recording
    ) {
      return;
    }
    const selection = getCurrentMaterialSelection();
    if (selection.sessionId !== this.materialSessionId) {
      this.expireMaterialSession();
      return;
    }
    if (this.data.loadError) return;
    const visibleIds = this.data.materials.map((item) => item.id);
    if (
      selection.revision !== this.materialSelectionRevision ||
      !sameIds(selection.ids, visibleIds)
    ) {
      this.setData({ loadError: "素材列表已有更新，请重新读取后继续" });
      void this.loadMaterials();
      return;
    }
    const demo = this.data.demoMode ? "?demo=1" : "";
    wx.navigateTo({ url: `/pages/intent/index${demo}` });
  },
});
