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
