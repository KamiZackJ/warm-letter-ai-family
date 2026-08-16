import { api } from "../../services/api";
import { createDemoMaterials } from "../../config/demo-materials";
import { environment, environmentView } from "../../config/env";
import { resolveDemoRequest } from "../../config/runtime-environment";
import type { Material, MaterialType } from "../../types/domain";
import { createId } from "../../utils/id";
import {
  getCurrentMaterialIds,
  saveCurrentMaterialIds,
} from "../../utils/storage";

type DisplayMaterial = Material & {
  typeLabel: string;
  detail: string;
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

Page({
  data: {
    ...environmentView,
    demoMode: false,
    materials: [] as DisplayMaterial[],
    textDraft: "",
    recording: false,
    loading: true,
  },

  onLoad(options: { demo?: string }) {
    try {
      this.setData({ demoMode: resolveDemoRequest(options.demo, environment.demoEnabled) });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
      wx.reLaunch({ url: "/pages/home/index" });
      return;
    }
    recorder.offStop();
    recorder.offError();
    recorder.onStop((result: { tempFilePath: string; duration: number }) => {
      void this.handleRecordedVoice(result);
    });
    recorder.onError(() => {
      this.setData({ recording: false });
      wx.showToast({ title: "录音失败，请检查权限", icon: "none" });
    });
  },

  onUnload() {
    recorder.offStop();
    recorder.offError();
  },

  async onShow() {
    try {
      const selectedIds = getCurrentMaterialIds();
      const allMaterials = await api.listMaterials();
      const materials = allMaterials
        .filter((item) => selectedIds.includes(item.id))
        .map(displayMaterial);
      this.setData({ materials });
    } catch (error) {
      wx.showToast({ title: (error as Error).message, icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async chooseImage(event: { currentTarget: { dataset: { type: MaterialType } } }) {
    const type = event.currentTarget.dataset.type;
    try {
      const result = await new Promise<{ tempFiles: Array<{ tempFilePath: string }> }>(
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
      const created = result.tempFiles.map((file, index) => ({
        id: createId(type),
        type,
        name: `${TYPE_LABELS[type]} ${this.data.materials.length + index + 1}`,
        localPath: file.tempFilePath,
        createdAt: new Date().toISOString(),
      }));
      const saved = await Promise.all(created.map((item) => api.saveMaterial(item)));
      this.appendMaterials(saved);
    } catch (error) {
      const message = (error as { errMsg?: string }).errMsg || "选择图片失败";
      if (!message.includes("cancel")) {
        wx.showToast({ title: message, icon: "none" });
      }
    }
  },

  updateTextDraft(event: { detail: { value: string } }) {
    this.setData({ textDraft: event.detail.value });
  },

  async addText() {
    const text = this.data.textDraft.trim();
    if (!text) {
      wx.showToast({ title: "先写下一点近况", icon: "none" });
      return;
    }
    const material: Material = {
      id: createId("text"),
      type: "text",
      name: "文字近况",
      text,
      createdAt: new Date().toISOString(),
    };
    const saved = await api.saveMaterial(material);
    this.appendMaterials([saved]);
    this.setData({ textDraft: "" });
  },

  startRecord() {
    recorder.start({
      duration: 60_000,
      format: "mp3",
      sampleRate: 16_000,
      numberOfChannels: 1,
      encodeBitRate: 48_000,
    });
    this.setData({ recording: true });
  },

  stopRecord() {
    recorder.stop();
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
    const saved = await api.saveMaterial(material);
    this.appendMaterials([saved]);
    this.setData({ recording: false });
  },

  async loadDemoMaterials() {
    if (!environment.demoEnabled || !this.data.demoMode) {
      wx.showToast({ title: "当前环境禁止加载演示素材", icon: "none" });
      return;
    }
    const materials = createDemoMaterials();
    const saved = await Promise.all(materials.map((item) => api.saveMaterial(item)));
    this.appendMaterials(saved);
    wx.showToast({ title: "合成演示素材已加入", icon: "success" });
  },

  appendMaterials(items: Material[]) {
    const ids = [...this.data.materials.map((item) => item.id), ...items.map((item) => item.id)];
    saveCurrentMaterialIds(Array.from(new Set(ids)));
    this.setData({
      materials: [...items.map(displayMaterial), ...this.data.materials],
    });
  },

  async deleteMaterial(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id;
    const material = this.data.materials.find((item) => item.id === id);
    if (!material || !(await confirmMaterialDeletion(material.name))) return;
    await api.deleteMaterial(id);
    const materials = this.data.materials.filter((item) => item.id !== id);
    saveCurrentMaterialIds(materials.map((item) => item.id));
    this.setData({ materials });
  },

  goIntent() {
    const demo = this.data.demoMode ? "?demo=1" : "";
    wx.navigateTo({ url: `/pages/intent/index${demo}` });
  },
});
