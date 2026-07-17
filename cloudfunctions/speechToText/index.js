const cloud = require("wx-server-sdk");
const axios = require("axios");
const FormData = require("form-data");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const ASR_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const ASR_MODEL = "TeleAI/TeleSpeechASR";
/** 单次 ASR 请求超时（ms），云函数总上限见 config.json timeout */
const ASR_REQUEST_TIMEOUT_MS = 140000;
/** 拉取 CDN 音频超时（ms） */
const CDN_DOWNLOAD_TIMEOUT_MS = 60000;

const CONTENT_TYPES = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  pcm: "audio/pcm",
};

function resolveFormat(nameOrFormat) {
  const raw = String(nameOrFormat || "mp3").toLowerCase();
  const ext = raw.includes(".") ? raw.split(".").pop() : raw;
  return CONTENT_TYPES[ext] ? ext : "mp3";
}

function parseTranscriptionBody(data) {
  if (typeof data === "string") {
    return { text: data, segments: [], duration: 0 };
  }
  if (!data || typeof data !== "object") {
    return { text: "", segments: [], duration: 0 };
  }

  const text = String(data.text || "");
  const duration = Number(data.duration) || 0;
  const segments = Array.isArray(data.segments)
    ? data.segments
        .map((seg) => ({
          start: Number(seg.start) || 0,
          end: Number(seg.end) || 0,
          text: String(seg.text || "").trim(),
        }))
        .filter((seg) => seg.text && seg.end > seg.start)
    : [];

  return { text, segments, duration };
}

async function postTranscription(buffer, filename, contentType, options = {}) {
  const apiKey = process.env.SILICONFLOW_API_KEY;
  if (!apiKey) {
    throw new Error(
      "未配置 SILICONFLOW_API_KEY。请在云函数环境变量中设置 SiliconFlow API Key。"
    );
  }

  const form = new FormData();
  form.append("file", buffer, { filename, contentType });
  form.append("model", ASR_MODEL);

  if (options.verbose) {
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
  }

  const response = await axios.post(ASR_URL, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `Bearer ${apiKey}`,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: ASR_REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });

  return response;
}

function extractAsrError(data, status) {
  if (data && typeof data === "object") {
    const msg = data.message || data.error;
    if (typeof msg === "string" && msg) return msg;
  }
  return `ASR 请求失败 (${status})`;
}

/**
 * 调用 SiliconFlow 语音转文本
 * 优先 verbose_json；仅 verbose 请求失败或空结果时回退 plain（避免重复计费）
 */
async function transcribe(buffer, filename, contentType) {
  const verboseResp = await postTranscription(buffer, filename, contentType, {
    verbose: true,
  });

  if (verboseResp.status === 200) {
    const parsed = parseTranscriptionBody(verboseResp.data);
    if (parsed.text || parsed.segments.length) {
      return parsed;
    }
    console.warn("verbose_json 返回空结果，回退 plain text");
  } else {
    console.warn(
      "verbose_json 失败，回退 plain text:",
      verboseResp.status,
      verboseResp.data
    );
  }

  const plainResp = await postTranscription(buffer, filename, contentType, {
    verbose: false,
  });

  if (plainResp.status !== 200) {
    throw new Error(extractAsrError(plainResp.data, plainResp.status));
  }

  const parsed = parseTranscriptionBody(plainResp.data);
  if (!parsed.text && !parsed.segments.length) {
    throw new Error("未识别到有效内容");
  }
  return parsed;
}

async function loadAudioBuffer(event) {
  const { fileBase64, audio, format, fileName } = event;

  if (fileBase64) {
    const buffer = Buffer.from(fileBase64, "base64");
    const fmt = resolveFormat(format || fileName);
    return { buffer, format: fmt };
  }

  // wx.cloud.CDN 标记后，云函数收到的是临时 CDN URL
  if (audio) {
    const url = typeof audio === "string" ? audio : audio.url || audio.fileID;
    if (!url) {
      throw new Error("无效的音频地址");
    }
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      maxContentLength: 50 * 1024 * 1024,
      timeout: CDN_DOWNLOAD_TIMEOUT_MS,
    });
    const buffer = Buffer.from(resp.data);
    const fmt = resolveFormat(format || fileName || url);
    return { buffer, format: fmt };
  }

  throw new Error("缺少音频数据（fileBase64 或 audio）");
}

exports.main = async (event) => {
  try {
    const { buffer, format } = await loadAudioBuffer(event);

    if (!buffer.length) {
      return { success: false, error: "音频数据为空" };
    }

    if (buffer.length > 50 * 1024 * 1024) {
      return { success: false, error: "音频过大（上限 50MB）" };
    }

    const filename = `audio.${format}`;
    const contentType = CONTENT_TYPES[format] || "audio/mpeg";
    const { text, segments, duration } = await transcribe(
      buffer,
      filename,
      contentType
    );

    return {
      success: true,
      text,
      segments,
      duration,
    };
  } catch (err) {
    console.error("speechToText error", err);
    return {
      success: false,
      error: err.message || "语音识别失败",
    };
  }
};
