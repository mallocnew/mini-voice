/** 声纹 / 语音信息授权：本地同意状态 */

const STORAGE_KEY = "__voiceprint_auth_ok";
const STORAGE_AT_KEY = "__voiceprint_auth_at";

function hasVoiceprintAuth() {
  try {
    return !!wx.getStorageSync(STORAGE_KEY);
  } catch (_) {
    return false;
  }
}

function grantVoiceprintAuth() {
  try {
    wx.setStorageSync(STORAGE_KEY, 1);
    wx.setStorageSync(STORAGE_AT_KEY, Date.now());
  } catch (_) {}
}

function revokeVoiceprintAuth() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
    wx.removeStorageSync(STORAGE_AT_KEY);
  } catch (_) {}
}

module.exports = {
  STORAGE_KEY,
  hasVoiceprintAuth,
  grantVoiceprintAuth,
  revokeVoiceprintAuth,
};
