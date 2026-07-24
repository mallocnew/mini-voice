const recorderManager = wx.getRecorderManager();
const { extractAudioFromVideo } = require("../../utils/mediaContainerExtract");
const {
  buildSubtitleSegments,
  decorateSegments,
  toSrt,
  toVtt,
  findActiveIndex,
} = require("../../utils/subtitle");
const { hasVoiceprintAuth } = require("../../utils/voiceprintAuth");

const RECORD_MAX_MS = 60000;
const RECORD_OPTIONS = {
  duration: RECORD_MAX_MS,
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: "mp3",
};

/** base64 直传建议上限（原始文件），超过则走 CDN */
const BASE64_MAX_BYTES = 700 * 1024;
/** 音频转写上限 50MB */
const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** 上滑超过该距离（px）取消录音 */
const CANCEL_SLIDE_PX = 72;
const RECORD_MAX_SEC = Math.floor(RECORD_MAX_MS / 1000);

const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg", "flac", "pcm"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "3gp"];

/** 全局只绑定一次，避免热重载/重复进页叠回调 */
let recorderHandlersBound = false;

Page({
  data: {
    recording: false,
    recognizing: false,
    converting: false,
    picking: false,
    busy: false,
    recordCancelHint: false,
    resultText: "",
    resultView: "text",
    subtitleSegments: [],
    activeSubtitleIndex: -1,
    sourceAudioPath: "",
    sourceAudioName: "",
    sourceAudioDuration: 0,
    playingSource: false,
    errorMsg: "",
    statusHint: "按住录音，或选择音频 / 视频",
    pickedFileName: "",
    convertedAudioPath: "",
    convertedAudioName: "",
    convertedAudioFormat: "m4a",
    playingConverted: false,
    convertPercent: 0,
    recordSeconds: 0,
    micHint: "按住录音（≤60秒）· 上滑取消",
  },

  _fingerDown: false,
  _wantRecord: false,
  _discardRecord: false,
  _recordStartY: 0,
  _recordStartedAt: 0,
  _recordTimer: null,
  _innerAudio: null,
  _playbackMode: "",
  _suppressAudioStop: 0,
  _alive: false,
  _taskSeq: 0,
  _convertTaskId: 0,
  _recognizeTaskId: 0,

  onLoad() {
    this._alive = true;
    this._bindRecorder();
    this.setData({ micHint: this._micHint() });
    this._enableShareMenu();
  },

  onUnload() {
    this._alive = false;
    this._fingerDown = false;
    this._wantRecord = false;
    this._discardRecord = true;
    this._taskSeq += 1;
    this._clearRecordTimer();
    if (this.data.recording || this._wantRecord) {
      try {
        recorderManager.stop();
      } catch (_) {}
    }
    this._stopAllAudio();
    if (this._innerAudio) {
      try {
        this._innerAudio.destroy();
      } catch (_) {}
      this._innerAudio = null;
    }
    this._suppressAudioStop = 0;
  },

  _enableShareMenu() {
    if (typeof wx.showShareMenu !== "function") return;
    wx.showShareMenu({
      withShareTicket: true,
      menus: ["shareAppMessage", "shareTimeline"],
      fail: () => {
        try {
          wx.showShareMenu({ withShareTicket: true });
        } catch (_) {}
      },
    });
  },

  _shareTitle() {
    const text = String(this.data.resultText || "").trim();
    if (text) {
      const preview = text.length > 28 ? `${text.slice(0, 28)}…` : text;
      return `语音转写：${preview}`;
    }
    return "Mini Voice · 按住说话，一键转文字";
  },

  onShareAppMessage() {
    return {
      title: this._shareTitle(),
      path: "/pages/index/index",
    };
  },

  onShareTimeline() {
    return {
      title: this._shareTitle(),
      query: "",
    };
  },

  _safeSetData(partial) {
    if (!this._alive) return;
    this.setData(partial);
  },

  _setBusy(partial) {
    if (!this._alive) return;
    const next = { ...partial };
    const recognizing =
      next.recognizing !== undefined ? next.recognizing : this.data.recognizing;
    const converting =
      next.converting !== undefined ? next.converting : this.data.converting;
    const recording =
      next.recording !== undefined ? next.recording : this.data.recording;
    const picking =
      next.picking !== undefined ? next.picking : this.data.picking;
    next.busy = !!(recognizing || converting || recording || picking);
    this.setData(next);
  },

  _nextTaskId() {
    this._taskSeq += 1;
    return this._taskSeq;
  },

  _micHint() {
    if (this.data.recording) {
      if (this.data.recordCancelHint) return "松开取消";
      const sec = this.data.recordSeconds || 0;
      const left = RECORD_MAX_SEC - sec;
      if (left <= 5) return `录音 ${sec}s · 还剩 ${left}s`;
      return `录音 ${sec}s · 上滑取消`;
    }
    if (this.data.converting) return "提取中…";
    if (this.data.recognizing) return "识别中…";
    if (this.data.picking) return "选择文件中…";
    return "按住录音（≤60秒）· 上滑取消";
  },

  _clearRecordTimer() {
    if (this._recordTimer) {
      clearInterval(this._recordTimer);
      this._recordTimer = null;
    }
  },

  _startRecordTimer() {
    this._clearRecordTimer();
    this._recordStartedAt = Date.now();
    this._safeSetData({ recordSeconds: 0 });
    this._recordTimer = setInterval(() => {
      if (!this._alive || !this.data.recording) return;
      const sec = Math.min(
        RECORD_MAX_SEC,
        Math.floor((Date.now() - this._recordStartedAt) / 1000)
      );
      const left = RECORD_MAX_SEC - sec;
      const statusHint =
        left <= 5
          ? `即将达到上限（还剩 ${left}s）`
          : `正在聆听… ${sec}s`;
      this._safeSetData({
        recordSeconds: sec,
        statusHint,
        micHint: this.data.recordCancelHint
          ? "松开取消"
          : left <= 5
            ? `录音 ${sec}s · 还剩 ${left}s`
            : `录音 ${sec}s · 上滑取消`,
      });
    }, 200);
  },

  _bindRecorder() {
    if (recorderHandlersBound) return;
    recorderHandlersBound = true;

    recorderManager.onStart(() => {
      const page = getCurrentPages().slice(-1)[0];
      if (!page || !page._alive || page.route !== "pages/index/index") return;

      if (!page._fingerDown || !page._wantRecord || page._discardRecord) {
        try {
          recorderManager.stop();
        } catch (_) {}
        return;
      }

      page._setBusy({
        recording: true,
        recordCancelHint: false,
        recordSeconds: 0,
        errorMsg: "",
        statusHint: "正在聆听… 0s",
      });
      page._startRecordTimer();
      page._safeSetData({ micHint: page._micHint() });
    });

    recorderManager.onStop((res) => {
      const page = getCurrentPages().slice(-1)[0];
      if (!page || !page._alive || page.route !== "pages/index/index") return;

      page._clearRecordTimer();
      const discarded = page._discardRecord;
      page._wantRecord = false;
      page._discardRecord = false;
      page._setBusy({
        recording: false,
        recordCancelHint: false,
        recordSeconds: 0,
      });

      if (discarded) {
        page._safeSetData({
          statusHint: "已取消录音",
          micHint: page._micHint(),
        });
        wx.showToast({ title: "已取消", icon: "none" });
        return;
      }

      const { tempFilePath, duration } = res;
      if (!tempFilePath || duration < 400) {
        page._setBusy({
          statusHint: "录音太短，请重新按住说话",
          recognizing: false,
        });
        page._safeSetData({ micHint: page._micHint() });
        return;
      }
      page._recognizeFromPath(tempFilePath, "mp3");
    });

    recorderManager.onError((err) => {
      console.error("recorder error", err);
      const page = getCurrentPages().slice(-1)[0];
      if (!page || !page._alive || page.route !== "pages/index/index") return;
      page._clearRecordTimer();
      page._wantRecord = false;
      page._fingerDown = false;
      page._discardRecord = false;
      page._setBusy({
        recording: false,
        recognizing: false,
        recordCancelHint: false,
        recordSeconds: 0,
        errorMsg: "录音失败，请检查麦克风权限",
        statusHint: "按住录音，或选择音频 / 视频",
      });
      page._safeSetData({ micHint: page._micHint() });
    });
  },

  _ensureCloudEnv() {
    const app = getApp();
    if (!app.globalData.env) {
      wx.showModal({
        title: "提示",
        content: "请先在 miniprogram/app.js 中配置云开发环境 ID（env）",
        showCancel: false,
      });
      return false;
    }
    return true;
  },

  /**
   * 录音 / 提交语音前必须已同意《声纹授权协议》
   * @returns {Promise<boolean>}
   */
  _ensureVoiceprintAuth() {
    if (hasVoiceprintAuth()) return Promise.resolve(true);

    return new Promise((resolve) => {
      wx.showModal({
        title: "声纹信息授权",
        content:
          "为进行语音识别，需要收集并使用您的声纹 / 语音信息。请先阅读并同意《声纹授权协议》后，再使用录音或转写功能。",
        confirmText: "去阅读",
        cancelText: "不同意",
        success: (res) => {
          if (res.confirm) {
            wx.navigateTo({
              url: "/pages/voiceprint-auth/voiceprint-auth",
            });
          }
          resolve(false);
        },
        fail: () => resolve(false),
      });
    });
  },

  onOpenVoiceprintAuth() {
    wx.navigateTo({
      url: "/pages/voiceprint-auth/voiceprint-auth",
    });
  },

  async onRecordStart(e) {
    if (this.data.busy) return;
    if (!this._ensureCloudEnv()) return;

    const touch = e && e.touches && e.touches[0];
    this._recordStartY = touch ? touch.clientY : 0;
    this._fingerDown = true;
    this._wantRecord = true;
    this._discardRecord = false;
    this._safeSetData({
      errorMsg: "",
      pickedFileName: "",
      recordCancelHint: false,
    });

    const voiceOk = await this._ensureVoiceprintAuth();
    if (!this._alive) return;
    if (!voiceOk) {
      this._fingerDown = false;
      this._wantRecord = false;
      this._discardRecord = false;
      return;
    }

    // 无权限时先授权，不立刻进入按住态（避免弹窗打断手势）
    const ok = await this._ensureRecordAuth();
    if (!this._alive) return;
    if (!ok) {
      this._fingerDown = false;
      this._wantRecord = false;
      return;
    }
    if (!this._fingerDown || !this._wantRecord || this._discardRecord) {
      this._wantRecord = false;
      return;
    }

    this._stopAllAudio();

    try {
      recorderManager.start(RECORD_OPTIONS);
    } catch (err) {
      console.error("recorder start error", err);
      this._fingerDown = false;
      this._wantRecord = false;
      this._setBusy({
        recording: false,
        errorMsg: "无法开始录音",
        statusHint: "按住录音，或选择音频 / 视频",
      });
    }
  },

  onRecordMove(e) {
    if (!this._fingerDown || (!this.data.recording && !this._wantRecord)) return;
    const touch = e && e.touches && e.touches[0];
    if (!touch) return;
    const dy = this._recordStartY - touch.clientY;
    const willCancel = dy >= CANCEL_SLIDE_PX;
    this._discardRecord = willCancel;
    if (willCancel !== this.data.recordCancelHint) {
      const sec = this.data.recordSeconds || 0;
      this._safeSetData({
        recordCancelHint: willCancel,
        micHint: willCancel
          ? "松开取消"
          : `录音 ${sec}s · 上滑取消`,
      });
    }
  },

  onRecordEnd() {
    this._fingerDown = false;
    if (!this._wantRecord && !this.data.recording) {
      this._discardRecord = false;
      return;
    }
    this._wantRecord = false;
    if (this.data.recording || this._discardRecord) {
      try {
        recorderManager.stop();
      } catch (_) {}
    }
  },

  _ensureRecordAuth() {
    return new Promise((resolve) => {
      wx.getSetting({
        success: (res) => {
          if (res.authSetting["scope.record"]) {
            try {
              wx.setStorageSync("__record_auth_ok", 1);
            } catch (_) {}
            resolve(true);
            return;
          }
          wx.authorize({
            scope: "scope.record",
            success: () => {
              try {
                wx.setStorageSync("__record_auth_ok", 1);
              } catch (_) {}
              resolve(true);
            },
            fail: () => {
              wx.showModal({
                title: "需要麦克风权限",
                content: "请在设置中开启麦克风，以便进行语音识别",
                confirmText: "去设置",
                success: (modalRes) => {
                  if (modalRes.confirm) {
                    wx.openSetting();
                  }
                },
              });
              resolve(false);
            },
          });
        },
        fail: () => resolve(false),
      });
    });
  },

  _withPicking(openFn) {
    this._setBusy({ picking: true, errorMsg: "" });
    const done = () => {
      if (!this._alive) return;
      this._setBusy({ picking: false });
      this._safeSetData({ micHint: this._micHint() });
    };
    try {
      openFn(done);
    } catch (err) {
      done();
      throw err;
    }
  },

  async onPickFile() {
    if (this.data.busy) return;
    if (!this._ensureCloudEnv()) return;
    if (!(await this._ensureVoiceprintAuth())) return;

    this._withPicking((done) => {
      wx.chooseMessageFile({
        count: 1,
        type: "file",
        extension: AUDIO_EXTENSIONS,
        success: (res) => {
          done();
          if (!this._alive) return;
          const file = res.tempFiles && res.tempFiles[0];
          if (!file || !file.path) {
            this._safeSetData({ errorMsg: "未选择到有效文件" });
            return;
          }
          if (file.size > FILE_MAX_BYTES) {
            this._safeSetData({ errorMsg: "文件过大（上限 50MB）" });
            return;
          }

          const format = this._extFromName(file.name, AUDIO_EXTENSIONS, "mp3");
          this._safeSetData({
            pickedFileName: file.name || "已选音频",
            errorMsg: "",
          });
          this._recognizeFromPath(file.path, format, file.size, file.name);
        },
        fail: (err) => {
          done();
          if (!this._alive) return;
          if (err.errMsg && err.errMsg.includes("cancel")) return;
          console.error("chooseMessageFile error", err);
          this._safeSetData({ errorMsg: "选择文件失败" });
        },
      });
    });
  },

  async onPickVideo() {
    if (this.data.busy) return;
    if (!(await this._ensureVoiceprintAuth())) return;

    this._withPicking((done) => {
      wx.showActionSheet({
        itemList: ["从相册选择", "从聊天文件选择"],
        success: (sheet) => {
          // ActionSheet 关闭后仍保持 picking，直到相册/文件选择结束
          if (!this._alive) {
            done();
            return;
          }
          if (sheet.tapIndex === 0) {
            this._pickVideoFromAlbum(done);
          } else if (sheet.tapIndex === 1) {
            this._pickVideoFromMessage(done);
          } else {
            done();
          }
        },
        fail: () => done(),
      });
    });
  },

  _pickVideoFromAlbum(done) {
    wx.chooseVideo({
      sourceType: ["album"],
      compressed: false,
      success: (res) => {
        done();
        if (!this._alive) return;
        if (!res || !res.tempFilePath) {
          this._safeSetData({ errorMsg: "未选择到有效视频" });
          return;
        }
        this._startVideoConvert(
          res.tempFilePath,
          res.size,
          res.tempFilePath.split("/").pop() || "video.mp4"
        );
      },
      fail: (err) => {
        done();
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("chooseVideo error", err);
        this._safeSetData({ errorMsg: "选择视频失败" });
      },
    });
  },

  _pickVideoFromMessage(done) {
    wx.chooseMessageFile({
      count: 1,
      type: "file",
      extension: VIDEO_EXTENSIONS,
      success: (res) => {
        done();
        if (!this._alive) return;
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.path) {
          this._safeSetData({ errorMsg: "未选择到有效视频" });
          return;
        }
        this._startVideoConvert(file.path, file.size, file.name || "video.mp4");
      },
      fail: (err) => {
        done();
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("chooseMessageFile video error", err);
        this._safeSetData({ errorMsg: "选择视频失败" });
      },
    });
  },

  async _startVideoConvert(filePath, fileSize, fileName) {
    if (!this._alive) return;

    const taskId = this._nextTaskId();
    this._convertTaskId = taskId;
    this._stopConvertedAudio();
    this._setBusy({
      converting: true,
      convertPercent: 0,
      pickedFileName: fileName || "已选视频",
      convertedAudioPath: "",
      convertedAudioName: "",
      convertedAudioFormat: "m4a",
      errorMsg: "",
      statusHint: "正在提取音频…",
    });
    this._safeSetData({ micHint: this._micHint() });

    const phaseHint = {
      native: "正在提取音频…",
      done: "提取完成",
    };

    try {
      const result = await extractAudioFromVideo(filePath, {
        onProgress: ({ phase, percent }) => {
          if (!this._alive || this._convertTaskId !== taskId) return;
          this._safeSetData({
            convertPercent: percent,
            statusHint: phaseHint[phase] || "正在提取音频…",
          });
        },
      });

      if (!this._alive || this._convertTaskId !== taskId) return;

      const format = result.format || "m4a";
      const outName = this._audioNameFromVideo(fileName, format);

      this._setBusy({
        converting: false,
        convertPercent: 100,
        convertedAudioPath: result.path,
        convertedAudioName: outName,
        convertedAudioFormat: format,
        statusHint: "音频已就绪，可试听或转写",
      });
      this._safeSetData({ micHint: this._micHint() });
      wx.showToast({ title: "提取成功", icon: "success" });
    } catch (err) {
      if (!this._alive || this._convertTaskId !== taskId) return;
      console.error("video convert error", err);
      this._setBusy({
        converting: false,
        convertPercent: 0,
        errorMsg: err.message || "提取失败，请更新微信后重试或使用含音轨的 MP4/MOV",
        statusHint: "按住录音，或选择音频 / 视频",
      });
      this._safeSetData({ micHint: this._micHint() });
    }
  },

  onCancelTask() {
    if (!this.data.converting && !this.data.recognizing) return;
    this._taskSeq += 1;
    this._convertTaskId = this._taskSeq;
    this._recognizeTaskId = this._taskSeq;
    this._setBusy({
      converting: false,
      recognizing: false,
      convertPercent: 0,
      statusHint: "已取消",
    });
    this._safeSetData({ micHint: this._micHint() });
    wx.showToast({ title: "已取消", icon: "none" });
  },

  _audioNameFromVideo(name, format) {
    const base = String(name || "audio")
      .replace(/\.[^.]+$/, "")
      .trim();
    return `${base || "audio"}.${format || "m4a"}`;
  },

  _fileExists(filePath) {
    return new Promise((resolve) => {
      wx.getFileSystemManager().access({
        path: filePath,
        success: () => resolve(true),
        fail: () => resolve(false),
      });
    });
  },

  async _ensureConvertedFile() {
    const path = this.data.convertedAudioPath;
    if (!path) return false;
    const ok = await this._fileExists(path);
    if (!ok) {
      this._safeSetData({
        convertedAudioPath: "",
        convertedAudioName: "",
        errorMsg: "音频文件已失效，请重新提取",
      });
      return false;
    }
    return true;
  },

  async onPlayConverted() {
    if (!(await this._ensureConvertedFile())) return;
    const path = this.data.convertedAudioPath;

    if (this.data.playingConverted) {
      this._stopAllAudio();
      return;
    }

    this._playAudio(path, "converted");
  },

  _ensureInnerAudio() {
    if (this._innerAudio) return;

    this._innerAudio = wx.createInnerAudioContext();
    this._innerAudio.obeyMuteSwitch = false;
    this._innerAudio.onEnded(() => {
      if (!this._alive) return;
      this._suppressAudioStop = 0;
      this._clearPlaybackState();
    });
    this._innerAudio.onStop(() => {
      if (!this._alive) return;
      if (this._suppressAudioStop > 0) {
        this._suppressAudioStop -= 1;
        return;
      }
      this._clearPlaybackState();
    });
    this._innerAudio.onError((err) => {
      console.error("play audio error", err);
      if (!this._alive) return;
      this._suppressAudioStop = 0;
      this._clearPlaybackState();
      this._safeSetData({
        errorMsg: "播放失败，请尝试转发后用系统播放器打开",
      });
    });
    this._innerAudio.onTimeUpdate(() => {
      if (!this._alive || this._playbackMode !== "source") return;
      const index = findActiveIndex(
        this.data.subtitleSegments,
        this._innerAudio.currentTime
      );
      if (index !== this.data.activeSubtitleIndex) {
        this._safeSetData({ activeSubtitleIndex: index });
      }
    });
  },

  _clearPlaybackState() {
    this._playbackMode = "";
    if (
      !this._alive ||
      (!this.data.playingConverted &&
        !this.data.playingSource &&
        this.data.activeSubtitleIndex < 0)
    ) {
      return;
    }
    this._safeSetData({
      playingConverted: false,
      playingSource: false,
      activeSubtitleIndex: -1,
    });
  },

  _stopAudioEngine() {
    if (!this._innerAudio) return;
    this._suppressAudioStop += 1;
    try {
      this._innerAudio.stop();
    } catch (_) {
      this._suppressAudioStop = Math.max(0, this._suppressAudioStop - 1);
    }
  },

  _stopAllAudio() {
    const wasPlaying =
      !!this._playbackMode ||
      this.data.playingConverted ||
      this.data.playingSource;
    if (wasPlaying) {
      this._stopAudioEngine();
    }
    this._clearPlaybackState();
  },

  _playAudio(path, mode) {
    if (!path) return;
    this._ensureInnerAudio();

    const wasPlaying =
      !!this._playbackMode ||
      this.data.playingConverted ||
      this.data.playingSource;
    if (wasPlaying) {
      this._stopAudioEngine();
    }

    this._playbackMode = mode;
    this._innerAudio.src = path;

    const patch = {
      playingConverted: mode === "converted",
      playingSource: mode === "source",
      activeSubtitleIndex: -1,
    };
    if (mode === "source" && this.data.subtitleSegments.length) {
      const index = findActiveIndex(this.data.subtitleSegments, 0);
      patch.activeSubtitleIndex = index >= 0 ? index : 0;
    }
    this._safeSetData(patch);

    try {
      this._innerAudio.play();
    } catch (err) {
      console.error("play audio error", err);
      this._suppressAudioStop = 0;
      this._clearPlaybackState();
      this._safeSetData({
        errorMsg: "播放失败，请尝试转发后用系统播放器打开",
      });
    }
  },

  _stopConvertedAudio() {
    if (this._playbackMode === "converted" || this.data.playingConverted) {
      this._stopAllAudio();
    }
  },

  async onPlaySourceAudio() {
    const path = this.data.sourceAudioPath;
    if (!path) {
      wx.showToast({ title: "无关联音频", icon: "none" });
      return;
    }
    const ok = await this._fileExists(path);
    if (!ok) {
      this._safeSetData({
        sourceAudioPath: "",
        sourceAudioName: "",
        errorMsg: "音频文件已失效，请重新识别",
      });
      return;
    }

    if (this.data.playingSource) {
      this._stopAllAudio();
      return;
    }

    this._playAudio(path, "source");
  },

  onSwitchView(e) {
    const view = e.currentTarget.dataset.view;
    if (!view || view === this.data.resultView) return;
    this._safeSetData({ resultView: view });
  },

  async onRecognizeConverted() {
    if (this.data.busy) return;
    if (!this._ensureCloudEnv()) return;
    if (!(await this._ensureVoiceprintAuth())) return;
    if (!(await this._ensureConvertedFile())) return;
    const path = this.data.convertedAudioPath;
    const format = this.data.convertedAudioFormat || "m4a";
    this._recognizeFromPath(
      path,
      format,
      undefined,
      this.data.convertedAudioName
    );
  },

  async onShareConverted() {
    if (!(await this._ensureConvertedFile())) return;
    const path = this.data.convertedAudioPath;
    const name = this.data.convertedAudioName || "audio.m4a";

    this._stopAllAudio();

    if (!wx.shareFileMessage) {
      wx.showToast({ title: "当前基础库不支持转发文件", icon: "none" });
      return;
    }

    wx.shareFileMessage({
      filePath: path,
      fileName: name,
      fail: (err) => {
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("shareFileMessage error", err);
        this._safeSetData({ errorMsg: "转发失败，请稍后重试" });
      },
    });
  },

  onShareSourceAudio() {
    const path = this.data.sourceAudioPath;
    if (!path) {
      wx.showToast({ title: "无关联音频", icon: "none" });
      return;
    }

    this._stopAllAudio();

    if (!wx.shareFileMessage) {
      wx.showToast({ title: "当前基础库不支持转发文件", icon: "none" });
      return;
    }

    const fileName =
      this.data.sourceAudioName || path.split("/").pop() || "录音.mp3";

    wx.shareFileMessage({
      filePath: path,
      fileName,
      fail: (err) => {
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("shareFileMessage source audio error", err);
        const msg = String(err.errMsg || "");
        if (msg.includes("TAP gesture")) {
          this._safeSetData({ errorMsg: "转发需在真机点击触发，请重试" });
          return;
        }
        if (msg.includes("fail") && msg.includes("file")) {
          this._safeSetData({
            sourceAudioPath: "",
            sourceAudioName: "",
            errorMsg: "音频文件已失效，请重新录音或选择文件",
          });
          return;
        }
        this._safeSetData({ errorMsg: "转发失败，请稍后重试" });
      },
    });
  },

  onSaveSourceAudio() {
    const path = this.data.sourceAudioPath;
    if (!path) {
      wx.showToast({ title: "无关联音频", icon: "none" });
      return;
    }

    this._stopAllAudio();

    if (typeof wx.saveFileToDisk === "function") {
      wx.saveFileToDisk({
        filePath: path,
        success: () => {
          wx.showToast({ title: "已保存", icon: "success" });
        },
        fail: (err) => {
          if (!this._alive) return;
          if (err.errMsg && err.errMsg.includes("cancel")) return;
          console.error("saveFileToDisk source audio error", err);
          this._safeSetData({ errorMsg: "保存失败，请稍后重试" });
        },
      });
      return;
    }

    // 手机端无系统另存为，转发到聊天后可长按保存
    this.onShareSourceAudio();
  },

  _sourceAudioDisplayName(format, fileName) {
    if (fileName) return fileName;
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `录音_${stamp}.${format || "mp3"}`;
  },

  _persistSourceAudio(tempPath, format, fileName) {
    const name = this._sourceAudioDisplayName(format, fileName);
    const dest = `${wx.env.USER_DATA_PATH}/${name}`;
    const fs = wx.getFileSystemManager();

    return new Promise((resolve) => {
      const finish = (path) => resolve({ path, name });

      if (typeof fs.copyFile === "function") {
        fs.copyFile({
          srcPath: tempPath,
          destPath: dest,
          success: () => finish(dest),
          fail: () => {
            fs.saveFile({
              tempFilePath: tempPath,
              success: (res) => finish(res.savedFilePath),
              fail: () => finish(tempPath),
            });
          },
        });
        return;
      }

      fs.saveFile({
        tempFilePath: tempPath,
        success: (res) => finish(res.savedFilePath),
        fail: () => finish(tempPath),
      });
    });
  },

  _extFromName(name, allowList, fallback) {
    const ext = String(name || "")
      .split(".")
      .pop()
      .toLowerCase();
    return allowList.includes(ext) ? ext : fallback;
  },

  _readFileBase64(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath,
        encoding: "base64",
        success: (res) => resolve(res.data),
        fail: reject,
      });
    });
  },

  async _recognizeFromPath(filePath, format, fileSize, fileName) {
    const taskId = this._nextTaskId();
    this._recognizeTaskId = taskId;

    this._setBusy({
      recognizing: true,
      statusHint: "准备识别…",
      errorMsg: "",
    });
    this._safeSetData({ micHint: this._micHint() });

    try {
      let payload;
      const size =
        typeof fileSize === "number"
          ? fileSize
          : await this._getFileSize(filePath);

      if (!this._alive || this._recognizeTaskId !== taskId) return;

      if (size > FILE_MAX_BYTES) {
        throw new Error("音频过大（上限 50MB），无法转写");
      }

      if (size <= BASE64_MAX_BYTES) {
        this._safeSetData({ statusHint: "读取音频…" });
        const fileBase64 = await this._readFileBase64(filePath);
        if (!this._alive || this._recognizeTaskId !== taskId) return;
        payload = { fileBase64, format, fileName };
      } else {
        this._safeSetData({ statusHint: "提交音频…" });
        payload = {
          audio: wx.cloud.CDN({
            type: "filePath",
            filePath,
          }),
          format,
          fileName,
        };
      }

      if (!this._alive || this._recognizeTaskId !== taskId) return;

      this._safeSetData({ statusHint: "识别中…" });

      const { result } = await wx.cloud.callFunction({
        name: "speechToText",
        data: payload,
      });

      if (!this._alive || this._recognizeTaskId !== taskId) return;

      if (!result || !result.success) {
        throw new Error((result && result.error) || "识别失败");
      }

      const text = result.text || "（未识别到有效内容）";
      const segments = decorateSegments(
        buildSubtitleSegments(result.segments)
      );
      const sourceAudioDuration =
        Number(result.duration) > 0
          ? Number(result.duration)
          : segments.length
            ? segments[segments.length - 1].end
            : 0;
      const persisted = await this._persistSourceAudio(
        filePath,
        format,
        fileName
      );

      if (!this._alive || this._recognizeTaskId !== taskId) return;

      this._setBusy({
        resultText: text,
        resultView: "text",
        subtitleSegments: segments,
        activeSubtitleIndex: -1,
        sourceAudioPath: persisted.path,
        sourceAudioName: persisted.name,
        sourceAudioDuration,
        recognizing: false,
        statusHint: segments.length
          ? "字幕已生成，可导出 SRT / VTT"
          : "按住录音，或选择音频 / 视频",
      });
      this._safeSetData({ micHint: this._micHint() });
    } catch (err) {
      if (!this._alive || this._recognizeTaskId !== taskId) return;
      console.error("recognize error", err);
      let message = err.message || "识别失败，请稍后重试";
      if (
        String(message).includes("FunctionName") ||
        String(err.errMsg || "").includes("FunctionName")
      ) {
        message =
          "云函数未找到。请右键 cloudfunctions/speechToText，选择「上传并部署：云端安装依赖」。";
      }
      if (String(err.errMsg || "").includes("Environment not found")) {
        message = "云开发环境未找到，请检查 app.js 中的 env 配置。";
      }
      this._setBusy({
        recognizing: false,
        errorMsg: message,
        statusHint: "按住录音，或选择音频 / 视频",
      });
      this._safeSetData({ micHint: this._micHint() });
    }
  },

  _getFileSize(filePath) {
    return new Promise((resolve, reject) => {
      wx.getFileSystemManager().getFileInfo({
        filePath,
        success: (res) => resolve(res.size || 0),
        fail: reject,
      });
    });
  },

  onCopy() {
    const text = this.data.resultText;
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: "已复制", icon: "success" });
      },
    });
  },

  onExportMenu() {
    const hasSubtitle = this.data.subtitleSegments.length > 0;
    const hasSourceAudio = !!this.data.sourceAudioPath;
    const canSaveToDisk = typeof wx.saveFileToDisk === "function";

    const items = ["导出 TXT 文稿"];
    if (hasSubtitle) {
      items.push("导出 SRT 字幕", "导出 VTT 字幕");
    }
    if (hasSourceAudio) {
      items.push("转发音频文件");
      if (canSaveToDisk) {
        items.push("保存音频到本地");
      }
    }

    if (items.length === 1) {
      this.onExportTranscript();
      return;
    }

    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        let i = 0;
        if (res.tapIndex === i++) this.onExportTranscript();
        else if (hasSubtitle && res.tapIndex === i++) this._exportSubtitleFile("srt");
        else if (hasSubtitle && res.tapIndex === i++) this._exportSubtitleFile("vtt");
        else if (hasSourceAudio && res.tapIndex === i++) this.onShareSourceAudio();
        else if (hasSourceAudio && canSaveToDisk && res.tapIndex === i++) {
          this.onSaveSourceAudio();
        }
      },
    });
  },

  onExportTranscript() {
    const text = this.data.resultText;
    if (!text) return;

    if (!wx.shareFileMessage) {
      wx.showToast({ title: "当前基础库不支持导出文件", icon: "none" });
      return;
    }

    const fileName = this._transcriptFileName();
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;

    try {
      // shareFileMessage 必须在用户点击的同步回调内调用，不能 await 异步写盘
      wx.getFileSystemManager().writeFileSync(filePath, text, "utf8");
    } catch (err) {
      console.error("write transcript error", err);
      this._safeSetData({ errorMsg: "文稿写入失败，请稍后重试" });
      return;
    }

    wx.shareFileMessage({
      filePath,
      fileName,
      fail: (err) => {
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("shareFileMessage transcript error", err);
        const msg = String(err.errMsg || "");
        if (msg.includes("TAP gesture")) {
          this._safeSetData({ errorMsg: "导出需在真机点击触发，请重试" });
          return;
        }
        this._safeSetData({ errorMsg: "导出失败，请稍后重试" });
      },
    });
  },

  _exportSubtitleFile(kind) {
    const segments = this.data.subtitleSegments;
    if (!segments.length) {
      wx.showToast({ title: "暂无字幕", icon: "none" });
      return;
    }

    if (!wx.shareFileMessage) {
      wx.showToast({ title: "当前基础库不支持导出文件", icon: "none" });
      return;
    }

    const ext = kind === "vtt" ? "vtt" : "srt";
    const fileName = this._subtitleFileName(ext);
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`;
    const content = kind === "vtt" ? toVtt(segments) : toSrt(segments);

    try {
      wx.getFileSystemManager().writeFileSync(filePath, content, "utf8");
    } catch (err) {
      console.error("write subtitle error", err);
      this._safeSetData({ errorMsg: "字幕写入失败，请稍后重试" });
      return;
    }

    wx.shareFileMessage({
      filePath,
      fileName,
      fail: (err) => {
        if (!this._alive) return;
        if (err.errMsg && err.errMsg.includes("cancel")) return;
        console.error("shareFileMessage subtitle error", err);
        const msg = String(err.errMsg || "");
        if (msg.includes("TAP gesture")) {
          this._safeSetData({ errorMsg: "导出需在真机点击触发，请重试" });
          return;
        }
        this._safeSetData({ errorMsg: "导出失败，请稍后重试" });
      },
    });
  },

  _subtitleFileName(ext) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `字幕_${stamp}.${ext}`;
  },

  _transcriptFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `转写文稿_${stamp}.txt`;
  },

  onClear() {
    this._taskSeq += 1;
    this._convertTaskId = this._taskSeq;
    this._recognizeTaskId = this._taskSeq;
    this._stopAllAudio();
    this._setBusy({
      recognizing: false,
      converting: false,
      picking: false,
      recordCancelHint: false,
      resultText: "",
      resultView: "text",
      subtitleSegments: [],
      activeSubtitleIndex: -1,
      sourceAudioPath: "",
      sourceAudioName: "",
      sourceAudioDuration: 0,
      playingSource: false,
      errorMsg: "",
      pickedFileName: "",
      convertedAudioPath: "",
      convertedAudioName: "",
      convertedAudioFormat: "m4a",
      convertPercent: 0,
      recordSeconds: 0,
      statusHint: "按住录音，或选择音频 / 视频",
    });
    this._safeSetData({ micHint: this._micHint() });
  },
});
