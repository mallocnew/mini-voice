# Mini Voice · 语音识别小程序

微信小程序 + 云开发，接入 [SiliconFlow 语音转文本](https://api-docs.siliconflow.cn/docs/api/audio-transcriptions-post)，模型使用 `TeleAI/TeleSpeechASR`。

## 功能

- 按住录音、松手识别（≤60 秒）
- 选择聊天中的音频文件转写（mp3 / wav / m4a 等，≤50MB）
- **纯本地**视频提取音频：解析 MP4/MOV，抽出 AAC 音轨（不经过任何服务器）
- 云函数转发 SiliconFlow ASR，API Key 不暴露在前端
- 识别结果可复制、导出为 TXT 文稿（微信转发）

## 使用前配置

### 1. 云开发环境

在 `miniprogram/app.js` 中填入云环境 ID：

```js
env: "your-env-id",
```

### 2. SiliconFlow API Key

1. 到 [SiliconFlow](https://cloud.siliconflow.cn/) 获取 API Key
2. 在微信开发者工具中打开「云开发」→「云函数」→ `speechToText` →「配置」→「环境变量」
3. 新增：
   - 名称：`SILICONFLOW_API_KEY`
   - 值：你的 API Key

### 3. 上传云函数

右键 `cloudfunctions/speechToText` → **上传并部署：云端安装依赖**

（需安装 `axios`、`form-data`。）

## 目录说明

```
miniprogram/pages/index/       # 录音、识别与视频提取音频页面
miniprogram/utils/mp4ToAac.js  # 纯 JS 解析 MP4/MOV，抽取 AAC 音轨
cloudfunctions/speechToText/   # ASR 云函数
```

## 调用流程

**录音识别**

1. `RecorderManager` 录制 mp3（≤60s）
2. 读成 base64，调用云函数 `speechToText`

**文件转写**

1. `wx.chooseMessageFile` 选择音频（从微信聊天文件）
2. 较小文件（≤700KB）走 base64；更大文件走 `wx.cloud.CDN` 临时地址
3. 云函数取到音频后 multipart 调用 SiliconFlow

**视频提取音频（工业级：不压缩、不转码）**

1. 相册 `chooseVideo({ compressed: false })` 或聊天文件选原视频（不限制大小）
2. **优先** `wx.createMediaContainer` 原生只导出音轨（不重编码画面）
3. 失败再回退纯 JS demux：拷贝 AAC 帧为 `.aac`
4. 可试听、转发，或再送去语音转写

> 不做系统视频压缩 / `compressVideo`（那是重编码，最慢）。手机相册视频几乎都是 H.264/H.265 + AAC。超大视频依赖原生路径；若回退 demux，可能因内存不足失败。

## 参考

- [SiliconFlow Audio Transcriptions](https://api-docs.siliconflow.cn/docs/api/audio-transcriptions-post)
- [微信云开发文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloud/basis/getting-started.html)
