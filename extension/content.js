function toAbsoluteHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value, document.baseURI);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function collectVideoUrls() {
  const urls = new Set();
  for (const video of document.querySelectorAll("video")) {
    for (const value of [video.currentSrc, video.src, video.getAttribute("src")]) {
      const url = toAbsoluteHttpUrl(value);
      if (url) urls.add(url);
    }
    for (const source of video.querySelectorAll("source")) {
      const url = toAbsoluteHttpUrl(source.src || source.getAttribute("src"));
      if (url) urls.add(url);
    }
  }
  return [...urls];
}

function isTencentRecordingPage() {
  return /(^|\.)meeting\.tencent\.com$/i.test(location.hostname)
    && /^\/(?:crm|cw)\//i.test(location.pathname);
}

const TRANSCRIPT_EXCLUDED_TAGS = new Set([
  "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "NOSCRIPT", "SVG"
]);

function visibleTranscriptElement(element) {
  if (!element || TRANSCRIPT_EXCLUDED_TAGS.has(element.tagName)) return false;
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

function transcriptElementLooksLikeUi(element) {
  const semantic = [
    element.tagName,
    element.id,
    element.className,
    element.getAttribute?.("role"),
    element.getAttribute?.("aria-label")
  ].filter((value) => typeof value === "string").join(" ");
  return /(?:button|navigation|nav|toolbar|pagination|timeline|share|search|menu|breadcrumb|tablist)/iu.test(semantic)
    || ["button", "navigation", "menu", "tab", "tablist"].includes(element.getAttribute?.("role"));
}

function chineseCharacterCount(value) {
  return (String(value || "").match(/[\u3400-\u9fff]/g) || []).length;
}

function transcriptLineLooksLikeUi(line) {
  const value = String(line || "").trim();
  if (!value || value.length < 4) return true;
  if (/^(?:逐字稿|纪要|时间轴|分享|搜索|请输入关键词|总结会议重点|分发言人观点)$/u.test(value)) return true;
  if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[\u4e00-\u9fff\w-]{0,20})?$/u.test(value)) return true;
  if (value.length <= 20 && !/[，。！？；：,.!?;:]/u.test(value)) return true;
  return false;
}

function normalizeTranscriptText(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !transcriptLineLooksLikeUi(line) && chineseCharacterCount(line) >= 4)
    .join("\n");
}

function transcriptCandidate(element) {
  if (!visibleTranscriptElement(element) || transcriptElementLooksLikeUi(element)) return null;
  const rawText = element.innerText || element.textContent || "";
  const text = normalizeTranscriptText(rawText);
  const chineseCount = chineseCharacterCount(text);
  if (text.length < 80 || chineseCount < 20 || chineseCount / Math.max(text.length, 1) < 0.22) return null;
  const labelBonus = /逐字稿/iu.test(rawText) ? 900 : 0;
  const sizeBonus = Math.min(text.length, 12000) / 20;
  return { element, text, score: labelBonus + sizeBonus + chineseCount };
}

function detectTranscript() {
  const candidates = [];
  const labelElements = [...document.querySelectorAll("body *")]
    .filter((element) => /逐字稿/iu.test(element.textContent || "") && (element.textContent || "").length < 120);
  for (const label of labelElements) {
    let current = label;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const candidate = transcriptCandidate(current);
      if (candidate) candidates.push(candidate);
    }
  }

  for (const element of document.querySelectorAll("main, section, article, div")) {
    const candidate = transcriptCandidate(element);
    if (candidate) candidates.push(candidate);
  }

  const best = candidates.sort((left, right) => right.score - left.score)[0];
  if (!best) {
    console.info("[diagnostic] transcriptFound", false);
    console.info("[diagnostic] textLength", 0);
    return { transcriptFound: false };
  }

  const lines = best.text.split("\n").filter(Boolean);
  const result = {
    transcriptFound: true,
    blockCount: lines.length,
    textLength: best.text.length,
    preview: best.text.slice(0, 500)
  };
  console.info("[diagnostic] transcriptFound", true);
  console.info("[diagnostic] textLength", result.textLength);
  return result;
}

function runPageDiagnostic() {
  const result = {
    pageUrl: location.href,
    pageTitle: document.title,
    pageDetected: isTencentRecordingPage(),
    videoCount: document.querySelectorAll("video").length
  };
  console.info("[diagnostic] pageDetected", result.pageDetected);
  return { ...result, ...detectTranscript() };
}

function visibleTitleElement(element) {
  if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

function titleElementScore(element, text, order) {
  const tagName = String(element.tagName || "").toLowerCase();
  const semantic = [
    element.id,
    element.className,
    element.getAttribute?.("data-testid"),
    element.getAttribute?.("data-test"),
    element.getAttribute?.("aria-label")
  ].filter(Boolean).join(" ");
  const rect = typeof element.getBoundingClientRect === "function"
    ? element.getBoundingClientRect()
    : { top: 0 };
  let score = Math.max(0, 36 - Math.min(Math.max(rect.top || 0, 0), 360) / 12);
  if (["h1", "h2", "h3"].includes(tagName)) score += 40;
  if (element.getAttribute?.("role") === "heading") score += 34;
  if (/(title|subject|topic|record|name)/iu.test(semantic)) score += 20;
  if (text.length >= 4 && text.length <= 120) score += 12;
  if (text.length > 180) score -= 18;
  return score - order / 1000;
}

function extractRecordingTitleDetails() {
  const candidates = new Map();
  if (isTencentRecordingPage()) {
    const selectors = [
      "h1",
      "h2",
      "h3",
      '[role="heading"]',
      '[data-testid*="title" i]',
      '[data-test*="title" i]',
      '[class*="record" i][class*="title" i]',
      '[class*="meeting" i][class*="title" i]',
      '[class*="title" i]'
    ];
    let order = 0;
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = normalizeRecordingTitle(element.textContent);
        if (!visibleTitleElement(element) || !text) {
          order += 1;
          continue;
        }
        const score = titleElementScore(element, text, order);
        if (!candidates.has(text) || candidates.get(text).score < score) {
          candidates.set(text, { score, title: text });
        }
        order += 1;
      }
    }
  }

  const best = [...candidates.values()].sort((left, right) => right.score - left.score)[0];
  if (best?.title) return { title: best.title, source: "录制标题" };

  const documentTitle = normalizeRecordingTitle(cleanDocumentTitle(document.title));
  if (documentTitle) return { title: documentTitle, source: "document.title" };
  return { title: "录制文件", source: "fallback" };
}

function extractRecordingTitle() {
  return extractRecordingTitleDetails().title;
}

function sendRuntimeMessage(message) {
  try {
    const response = chrome.runtime.sendMessage(message, () => {
      // Reading lastError prevents Chrome from reporting a rejected message
      // when this page still has the previous extension context.
      void chrome.runtime.lastError;
    });
    if (response && typeof response.catch === "function") {
      response.catch(() => undefined);
    }
  } catch {
    // The page can outlive an extension reload. Refreshing the page loads the new context.
  }
}

function sendMetadata() {
  const titleDetails = extractRecordingTitleDetails();
  sendRuntimeMessage({
    type: "pageMetadata",
    pageUrl: location.href,
    pageTitle: document.title,
    recordingTitle: titleDetails.title,
    recordingTitleSource: titleDetails.source,
    userAgent: navigator.userAgent,
    videoUrls: collectVideoUrls()
  });
}

function pathnameFor(value) {
  const url = toAbsoluteHttpUrl(value);
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function videoMatchesPathname(video, mediaPathname) {
  const values = [video.currentSrc, video.src, video.getAttribute("src")];
  for (const source of video.querySelectorAll("source")) {
    values.push(source.src, source.getAttribute("src"));
  }
  return values.some((value) => pathnameFor(value) === mediaPathname);
}

async function prepareMediaContext(mediaPathname, timeoutMs = 4000) {
  if (typeof mediaPathname !== "string" || !mediaPathname) return { prepared: false };
  const video = [...document.querySelectorAll("video")].find((item) => videoMatchesPathname(item, mediaPathname));
  if (!video) return { prepared: false };

  video.preload = "metadata";
  if (!video.paused) return { prepared: true };

  await new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 3000), 5000));
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    video.load();
  });
  return { prepared: true };
}

let timer;
function scheduleMetadata() {
  clearTimeout(timer);
  timer = setTimeout(sendMetadata, 150);
}

document.addEventListener("loadedmetadata", scheduleMetadata, true);
document.addEventListener("play", scheduleMetadata, true);
new MutationObserver(scheduleMetadata).observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "scanPageMedia") {
    sendMetadata();
  }
  if (message?.type === "runPageDiagnostic") {
    sendResponse(runPageDiagnostic());
  }
  if (message?.type === "prepareMediaContext") {
    prepareMediaContext(message.mediaPathname, message.timeoutMs)
      .then((result) => {
        sendMetadata();
        sendResponse(result);
      })
      .catch(() => sendResponse({ prepared: false }));
    return true;
  }
});

sendMetadata();
