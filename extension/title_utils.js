const MAX_RECORDING_TITLE_LENGTH = 200;
const MAX_FILENAME_STEM_LENGTH = 220;

const FILENAME_SAFE_REPLACEMENTS = {
  "<": "＜",
  ">": "＞",
  ":": "：",
  '"': "＂",
  "/": "／",
  "\\": "＼",
  "|": "｜",
  "?": "？",
  "*": "＊"
};

const GENERIC_RECORDING_TITLES = new Set([
  "腾讯会议",
  "tencent meeting",
  "会议",
  "录制文件",
  "回放",
  "当前页面",
  "media",
  "纪要",
  "时间轴",
  "逐字稿",
  "字幕",
  "聊天",
  "成员",
  "详情"
]);

function collapseTitleWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function toUnicodeSlice(value, limit) {
  return Array.from(value).slice(0, limit).join("");
}

function isLikelyInvalidRecordingTitle(value) {
  const title = collapseTitleWhitespace(value);
  if (!title) return true;
  const lowered = title.toLocaleLowerCase();
  if (GENERIC_RECORDING_TITLES.has(lowered)) return true;
  if (/^(?:纪要|时间轴|逐字稿|字幕|聊天|成员|详情)(?:\s|$)/u.test(title)) return true;
  if (/^[\d\s._:/：-]+$/u.test(title) && /\d/u.test(title)) return true;
  if (/^(?:meeting|会议)[\s#_-]*\d+$/iu.test(title)) return true;
  if (/^\d{4}[年./-]\d{1,2}(?:[月./-]\d{1,2}(?:日)?)?$/u.test(title)) return true;
  return false;
}

function normalizeRecordingTitle(value) {
  const title = toUnicodeSlice(collapseTitleWhitespace(value), MAX_RECORDING_TITLE_LENGTH);
  return isLikelyInvalidRecordingTitle(title) ? "" : title;
}

function cleanDocumentTitle(value) {
  return collapseTitleWhitespace(value)
    .replace(/\s*[-|｜—–]\s*(?:腾讯会议|tencent meeting).*$/iu, "")
    .replace(/^(?:腾讯会议|tencent meeting)\s*[-|｜—–]\s*/iu, "");
}

function normalizeFilenamePart(value, fallback = "") {
  let result = typeof value === "string" ? value : "";
  result = [...result]
    .map((character) => FILENAME_SAFE_REPLACEMENTS[character] || character)
    .join("")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "");
  result = toUnicodeSlice(result, MAX_FILENAME_STEM_LENGTH);
  return result || fallback;
}
