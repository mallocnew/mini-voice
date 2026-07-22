const {
  hasVoiceprintAuth,
  grantVoiceprintAuth,
  revokeVoiceprintAuth,
} = require("../../utils/voiceprintAuth");

Page({
  data: {
    agreed: false,
  },

  onShow() {
    this.setData({ agreed: hasVoiceprintAuth() });
  },

  onAgree() {
    grantVoiceprintAuth();
    this.setData({ agreed: true });
    wx.showToast({ title: "已授权", icon: "success" });
    setTimeout(() => {
      wx.navigateBack({ fail: () => {} });
    }, 400);
  },

  onDisagree() {
    revokeVoiceprintAuth();
    this.setData({ agreed: false });
    wx.showToast({ title: "已取消授权", icon: "none" });
    setTimeout(() => {
      wx.navigateBack({ fail: () => {} });
    }, 400);
  },

  onRevoke() {
    wx.showModal({
      title: "撤回授权",
      content:
        "撤回后将无法继续录音或提交语音进行识别。是否确认撤回《声纹授权协议》授权？",
      confirmText: "撤回",
      confirmColor: "#c43c3c",
      success: (res) => {
        if (!res.confirm) return;
        revokeVoiceprintAuth();
        this.setData({ agreed: false });
        wx.showToast({ title: "已撤回授权", icon: "none" });
      },
    });
  },

  onBack() {
    wx.navigateBack({ fail: () => {} });
  },
});
