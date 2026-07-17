/**
 * 微信原生抽音轨：不重编码画面，只导出音频轨。
 * 导出后拷贝到用户目录，并把 mp4 容器规范为 m4a，便于试听/转发/ASR。
 */

function destroyContainer(mc, track) {
  try {
    if (track) mc.removeTrack(track);
  } catch (_) {}
  try {
    mc.destroy();
  } catch (_) {}
}

function pickAudioTrack(tracks) {
  const list = tracks || [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.kind === "audio") return t;
  }
  return null;
}

function getFileSize(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size || 0),
      fail: reject,
    });
  });
}

function copyFile(src, dest) {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    // 优先 copyFile；不支持时读写作兜底
    if (typeof fs.copyFile === "function") {
      fs.copyFile({
        srcPath: src,
        destPath: dest,
        success: () => resolve(dest),
        fail: () => {
          fs.readFile({
            filePath: src,
            success: (r) => {
              fs.writeFile({
                filePath: dest,
                data: r.data,
                success: () => resolve(dest),
                fail: reject,
              });
            },
            fail: reject,
          });
        },
      });
      return;
    }
    fs.readFile({
      filePath: src,
      success: (r) => {
        fs.writeFile({
          filePath: dest,
          data: r.data,
          success: () => resolve(dest),
          fail: reject,
        });
      },
      fail: reject,
    });
  });
}

/**
 * MediaContainer 常导出 .mp4（仅音轨）。统一成稳定路径 + ASR 友好 format。
 */
async function normalizeExport(tempPath) {
  const rawExt = String(tempPath || "")
    .split(".")
    .pop()
    .toLowerCase();
  let format = "m4a";
  if (["aac", "m4a", "mp3", "wav"].includes(rawExt)) {
    format = rawExt;
  } else if (rawExt === "mp4") {
    format = "m4a";
  }

  const dest = `${wx.env.USER_DATA_PATH}/extract_${Date.now()}.${format}`;
  await copyFile(tempPath, dest);
  let size = 0;
  try {
    size = await getFileSize(dest);
  } catch (_) {}

  return { path: dest, format, size };
}

/**
 * @param {string} videoPath
 * @param {{ onProgress?: (p: { phase: string, percent: number }) => void }} [options]
 */
function extractAudioWithMediaContainer(videoPath, options = {}) {
  const onProgress = options.onProgress;
  const report = (phase, percent) => {
    if (onProgress) {
      onProgress({
        phase,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
      });
    }
  };

  return new Promise((resolve, reject) => {
    if (typeof wx.createMediaContainer !== "function") {
      reject(new Error("当前基础库不支持 MediaContainer"));
      return;
    }

    report("native", 10);
    const mc = wx.createMediaContainer();

    mc.extractDataSource({
      source: videoPath,
      success: (res) => {
        report("native", 40);
        const audioTrack = pickAudioTrack(res && res.tracks);
        if (!audioTrack) {
          destroyContainer(mc);
          reject(new Error("未找到音频轨道"));
          return;
        }

        mc.addTrack(audioTrack);
        report("native", 60);

        mc.export({
          success: async (exportRes) => {
            const outPath = exportRes && exportRes.tempFilePath;
            destroyContainer(mc, audioTrack);
            if (!outPath) {
              reject(new Error("原生导出失败"));
              return;
            }

            try {
              report("native", 85);
              const normalized = await normalizeExport(outPath);
              report("done", 100);
              resolve({
                ...normalized,
                engine: "media-container",
              });
            } catch (err) {
              reject(
                new Error(
                  (err && err.message) || "导出文件保存失败"
                )
              );
            }
          },
          fail: (err) => {
            destroyContainer(mc, audioTrack);
            const msg =
              (err && (err.errMsg || err.errDesc || err.message)) ||
              "原生导出失败";
            reject(new Error(msg));
          },
        });
      },
      fail: (err) => {
        destroyContainer(mc);
        const msg =
          (err && (err.errMsg || err.errDesc || err.message)) ||
          "解析视频轨道失败";
        reject(new Error(msg));
      },
    });
  });
}

module.exports = {
  extractAudioWithMediaContainer,
  extractAudioFromVideo: extractAudioWithMediaContainer,
};
