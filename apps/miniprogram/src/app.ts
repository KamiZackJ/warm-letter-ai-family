import { createPublishedUpdatePrompt } from "./utils/published-update";

const publishedUpdate = createPublishedUpdatePrompt({
  getManager: () => typeof wx.getUpdateManager === "function" ? wx.getUpdateManager() : undefined,
  getPages: () => typeof getCurrentPages === "function" ? getCurrentPages() : [],
  showModal: (prompt) => wx.showModal(prompt),
});

App({
  globalData: {
    appName: "暖笺",
  },
  onLaunch() { publishedUpdate.initialize(); },
  onShow() { publishedUpdate.onShow(); },
  onHide() { publishedUpdate.onHide(); },
});
