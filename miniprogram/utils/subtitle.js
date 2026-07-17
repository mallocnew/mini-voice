/** 字幕：仅使用 ASR verbose_json 返回的 segments */

function normalizeApiSegments(apiSegments) {
  if (!Array.isArray(apiSegments) || !apiSegments.length) return [];

  return apiSegments
    .map((seg) => ({
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: String(seg.text || "").trim(),
    }))
    .filter((seg) => seg.text && seg.end > seg.start);
}

function buildSubtitleSegments(apiSegments) {
  return normalizeApiSegments(apiSegments);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

function formatSrtTime(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

function formatVttTime(seconds) {
  return formatSrtTime(seconds).replace(",", ".");
}

function formatDisplayTime(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${pad2(m)}:${pad2(s)}`;
}

function toSrt(segments) {
  return segments
    .map((seg, index) => {
      return [
        String(index + 1),
        `${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`,
        seg.text,
        "",
      ].join("\n");
    })
    .join("\n")
    .trim();
}

function toVtt(segments) {
  const body = segments
    .map((seg) => {
      return [
        `${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`,
        seg.text,
        "",
      ].join("\n");
    })
    .join("\n")
    .trim();
  return `WEBVTT\n\n${body}`;
}

function decorateSegments(segments) {
  return segments.map((seg) => ({
    ...seg,
    startLabel: formatDisplayTime(seg.start),
    endLabel: formatDisplayTime(seg.end),
  }));
}

function findActiveIndex(segments, currentTime) {
  if (!segments || !segments.length) return -1;
  const t = Number(currentTime) || 0;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (t >= seg.start && t < seg.end) return i;
  }
  if (t >= segments[segments.length - 1].end) {
    return segments.length - 1;
  }
  return -1;
}

module.exports = {
  buildSubtitleSegments,
  normalizeApiSegments,
  decorateSegments,
  toSrt,
  toVtt,
  formatDisplayTime,
  findActiveIndex,
};
