Page({
  openWechatPrivacy() {
    if (typeof wx.openPrivacyContract !== "function") {
      wx.showToast({ title: "请更新微信后查看隐私保护指引", icon: "none" });
      return;
    }
    wx.openPrivacyContract({ fail: () => wx.showToast({ title: "暂时无法打开，请稍后重试", icon: "none" }) });
  },
});
