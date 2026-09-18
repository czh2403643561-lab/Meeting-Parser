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
const TRANSCRIPT_UI_TEXTS = new Set([
  "逐字稿", "纪要", "时间轴", "分享", "搜索", "请输入关键词", "总结会议重点", "分发言人观点",
  "提取会议待办", "另存为", "翻译", "返回"
]);
const TRANSCRIPT_METADATA_PATTERN = /(?:speaker|speaker-name|说话人|发言人|name-time|timestamp|timecode)/iu;

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
    || TRANSCRIPT_METADATA_PATTERN.test(semantic)
    || ["button", "navigation", "menu", "tab", "tablist"].includes(element.getAttribute?.("role"));
}

function chineseCharacterCount(value) {
  return (String(value || "").match(/[\u3400-\u9fff]/g) || []).length;
}

function transcriptLineLooksLikeUi(line, excludedLines = new Set()) {
  const value = String(line || "").trim();
  if (!value || excludedLines.has(value) || TRANSCRIPT_UI_TEXTS.has(value)) return true;
  if (/^(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[\u4e00-\u9fff\w-]{0,20})?$/u.test(value)) return true;
  return /^(?:speaker|说话人|发言人)\s*[\w\u4e00-\u9fff-]{0,20}$/iu.test(value);
}

function normalizeTranscriptText(value, excludedLines = new Set()) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !transcriptLineLooksLikeUi(line, excludedLines))
    .join("\n");
}

function transcriptElementText(element, excludedLines = new Set()) {
  if (!visibleTranscriptElement(element) || transcriptElementLooksLikeUi(element)) return "";
  return normalizeTranscriptText(element.innerText || element.textContent || "", excludedLines);
}

function transcriptMetadataLines(container) {
  const lines = new Set();
  const elements = [container, ...container.querySelectorAll("*")];
  for (const element of elements) {
    const semantic = [element.id, element.className, element.getAttribute?.("aria-label")]
      .filter((value) => typeof value === "string").join(" ");
    if (!TRANSCRIPT_METADATA_PATTERN.test(semantic)) continue;
    for (const line of String(element.innerText || element.textContent || "").split(/\n+/)) {
      const value = line.replace(/\s+/g, " ").trim();
      if (value && value.length <= 80) lines.add(value);
    }
  }
  return lines;
}

function isScrollableTranscriptElement(element) {
  if (!visibleTranscriptElement(element)) return false;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(element) : null;
  const overflowY = style?.overflowY || "";
  return element.clientHeight > 0
    && element.scrollHeight > element.clientHeight + 40
    && (overflowY === "auto" || overflowY === "scroll" || element.scrollHeight > element.clientHeight * 1.5);
}

function findTranscriptContainer() {
  const explicitRoot = document.querySelector("#minutes-scroll-container");
  if (explicitRoot) {
    const scopedCandidates = [explicitRoot, ...explicitRoot.querySelectorAll("*")]
      .filter((element) => isScrollableTranscriptElement(element))
      .map((element) => ({
        element,
        pidCount: element.querySelectorAll('[id^="pid-"][id$="-content"]').length,
        textLength: transcriptElementText(element).length
      }))
      .filter((candidate) => candidate.pidCount > 0 || candidate.textLength >= 40)
      .sort((left, right) => {
        if (right.pidCount !== left.pidCount) return right.pidCount - left.pidCount;
        return right.textLength - left.textLength;
      });
    return scopedCandidates[0]?.element || explicitRoot;
  }

  const labelElements = [...document.querySelectorAll("body *")]
    .filter((element) => /逐字稿/iu.test(element.textContent || "") && (element.textContent || "").length < 120);
  const roots = new Set();
  for (const label of labelElements) {
    let current = label;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) roots.add(current);
  }

  const candidates = new Set();
  for (const root of roots) {
    if (isScrollableTranscriptElement(root)) candidates.add(root);
    for (const element of root.querySelectorAll("*")) {
      if (isScrollableTranscriptElement(element)) candidates.add(element);
    }
  }
  for (const element of document.querySelectorAll("main, section, article, div")) {
    if (isScrollableTranscriptElement(element)) candidates.add(element);
  }

  const scored = [...candidates].map((element) => {
    const text = transcriptElementText(element);
    const pidCount = element.querySelectorAll?.('[id^="pid-"][id$="-content"]').length || 0;
    const chineseCount = chineseCharacterCount(text);
    const relatedToLabel = explicitRoot === element || labelElements.some((label) => element.contains(label));
    return {
      element,
      score: pidCount * 10000 + chineseCount + Math.min(text.length, 8000) / 10 + (relatedToLabel ? 900 : 0),
      pidCount,
      textLength: text.length
    };
  }).filter((candidate) => candidate.textLength >= 40
    && chineseCharacterCount(candidate.element.innerText || "") >= 20
    && (candidate.pidCount > 0 || isScrollableTranscriptElement(candidate.element)));

  const bestScrollable = scored
    .filter((candidate) => isScrollableTranscriptElement(candidate.element))
    .sort((left, right) => right.score - left.score)[0];
  if (bestScrollable) return bestScrollable.element;

  const fallback = [...roots]
    .map((element) => ({ element, text: transcriptElementText(element) }))
    .filter((candidate) => candidate.text.length >= 80)
    .sort((left, right) => right.text.length - left.text.length)[0];
  return fallback?.element || null;
}

function transcriptPidOrder(element) {
  const match = String(element.id || "").match(/^pid-(\d+)-content$/u);
  return match ? Number(match[1]) : null;
}

function collectTranscriptBlocks(container, excludedLines) {
  const pidNodes = [...container.querySelectorAll('[id^="pid-"][id$="-content"]')]
    .filter((element) => visibleTranscriptElement(element))
    .map((element) => ({
      element,
      text: transcriptElementText(element, excludedLines),
      order: transcriptPidOrder(element)
    }))
    .filter((block) => block.text.length >= 4 && chineseCharacterCount(block.text) >= 2);
  if (pidNodes.length) return pidNodes;

  const blocks = [];
  const visit = (element) => {
    if (!visibleTranscriptElement(element) || transcriptElementLooksLikeUi(element)) return;
    const text = transcriptElementText(element, excludedLines);
    if (!text) return;

    const childElements = [...element.children].filter((child) => {
      const childText = transcriptElementText(child, excludedLines);
      return childText.length >= 8 && chineseCharacterCount(childText) >= 2;
    });
    if (text.length > 80 && childElements.length) {
      for (const child of childElements) visit(child);
      return;
    }
    if (text.length >= 4 && chineseCharacterCount(text) >= 2) blocks.push({ element, text, order: null });
  };

  for (const child of container.children) visit(child);
  if (!blocks.length) visit(container);

  const deduped = [];
  for (const block of blocks) {
    if (deduped.at(-1)?.text === block.text) continue;
    deduped.push(block);
  }
  return deduped;
}

function transcriptBlockKey(block) {
  const element = block.element;
  const stableIdentity = element.id
    || element.getAttribute?.("data-pid")
    || element.getAttribute?.("data-index")
    || element.getAttribute?.("data-key");
  return stableIdentity || block.text;
}

function waitForTranscriptRender(delayMs = 280) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function reportTranscriptProgress(stage, records) {
  const textLength = records.reduce((total, record) => total + record.text.length, 0);
  try {
    const response = chrome.runtime.sendMessage({
      type: "transcriptProgress",
      progress: {
        stage,
        paragraphCount: records.length,
        textLength
      }
    });
    if (response && typeof response.catch === "function") response.catch(() => undefined);
  } catch {
    // The page can outlive an extension reload while extraction is running.
  }
}

async function extractFullTranscript() {
  const container = findTranscriptContainer();
  if (!container) return { transcriptFound: false };

  const excludedLines = transcriptMetadataLines(container);
  const originalScrollTop = container.scrollTop;
  const records = [];
  const recordIndexes = new Map();
  let fallbackOrder = 0;
  let stableBottomPasses = 0;

  try {
    reportTranscriptProgress("初始化", records);
    container.scrollTop = 0;
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    await waitForTranscriptRender();
    for (let pass = 0; pass < 160; pass += 1) {
      const blocks = collectTranscriptBlocks(container, excludedLines);
      let added = 0;
      for (const block of blocks) {
        const key = transcriptBlockKey(block);
        const existingIndex = recordIndexes.get(key);
        if (existingIndex !== undefined) {
          if (block.text.length > records[existingIndex].text.length) records[existingIndex].text = block.text;
          continue;
        }
        records.push({
          order: Number.isFinite(block.order) ? block.order : 1000000 + fallbackOrder,
          text: block.text
        });
        recordIndexes.set(key, records.length - 1);
        fallbackOrder += 1;
        added += 1;
      }
      reportTranscriptProgress("滚动采集中", records);

      const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const atBottom = container.scrollTop >= maxScrollTop - 4;
      const previousScrollHeight = container.scrollHeight;
      if (atBottom && added === 0) {
        await waitForTranscriptRender();
        stableBottomPasses = container.scrollHeight <= previousScrollHeight ? stableBottomPasses + 1 : 0;
      }
      else stableBottomPasses = 0;
      if (stableBottomPasses >= 3) break;

      const nextScrollTop = Math.min(maxScrollTop, container.scrollTop + Math.max(container.clientHeight * 0.7, 260));
      if (nextScrollTop === container.scrollTop && atBottom) {
        await waitForTranscriptRender();
      } else {
        container.scrollTop = nextScrollTop;
        container.dispatchEvent(new Event("scroll", { bubbles: true }));
        await waitForTranscriptRender();
      }
    }
  } finally {
    container.scrollTop = originalScrollTop;
  }

  records.sort((left, right) => left.order - right.order);
  const fullText = records.map((record) => record.text).join("\n\n").trim();
  if (!fullText) return { transcriptFound: false };
  reportTranscriptProgress("完成", records);
  return {
    transcriptFound: true,
    paragraphCount: records.length,
    textLength: fullText.length,
    fullText,
    preview: fullText.slice(0, 500)
  };
}

async function runPageDiagnostic() {
  const result = {
    pageUrl: location.href,
    pageTitle: document.title,
    pageDetected: isTencentRecordingPage(),
    videoCount: document.querySelectorAll("video").length
  };
  console.info("[diagnostic] pageDetected", result.pageDetected);
  const transcript = await extractFullTranscript();
  console.info("[diagnostic] transcriptFound", Boolean(transcript.transcriptFound));
  console.info("[diagnostic] textLength", transcript.textLength || 0);
  return { ...result, ...transcript };
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
    runPageDiagnostic()
      .then(sendResponse)
      .catch(() => sendResponse({ transcriptFound: false }));
    return true;
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
