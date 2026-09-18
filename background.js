const MAX_CANDIDATES_PER_TAB = 80;
const tabWriteQueue = new Map();

function candidatesKey(tabId) {
  return `mediaCandidates:${tabId}`;
}

function pageKey(tabId) {
  return `mediaPage:${tabId}`;
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch {
    return value;
  }
}

function isHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function contentTypeFromHeaders(headers = []) {
  const header = headers.find((item) => item.name?.toLowerCase() === "content-type");
  return header?.value?.split(";", 1)[0].trim().toLowerCase() || "";
}

function detectMediaKind(url, contentType = "") {
  const normalizedType = contentType.toLowerCase();
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();

  if (normalizedType.includes("video/mp4") || normalizedType.includes("application/mp4") || /\.mp4$/.test(pathname)) {
    return "mp4";
  }
  if (
    normalizedType.includes("application/vnd.apple.mpegurl") ||
    normalizedType.includes("application/x-mpegurl") ||
    normalizedType.includes("application/mpegurl") ||
    /\.m3u8$/.test(pathname)
  ) {
    return "hls";
  }
  if (normalizedType.includes("application/dash+xml") || /\.mpd$/.test(pathname)) {
    return "dash";
  }
  return "";
}

function moreSpecificKind(current, next) {
  if (next && next !== "other") return next;
  return current || next || "other";
}

async function getCandidates(tabId) {
  const result = await chrome.storage.session.get(candidatesKey(tabId));
  return Array.isArray(result[candidatesKey(tabId)]) ? result[candidatesKey(tabId)] : [];
}

async function getPageInfo(tabId) {
  const result = await chrome.storage.session.get(pageKey(tabId));
  return result[pageKey(tabId)] || {};
}

async function setPageInfo(tabId, pageInfo) {
  await chrome.storage.session.set({ [pageKey(tabId)]: pageInfo });
}

function queueTabWrite(tabId, task) {
  const previous = tabWriteQueue.get(tabId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  tabWriteQueue.set(tabId, next);
  return next.finally(() => {
    if (tabWriteQueue.get(tabId) === next) {
      tabWriteQueue.delete(tabId);
    }
  });
}

function upsertCandidate(tabId, incoming) {
  return queueTabWrite(tabId, async () => {
    const candidates = await getCandidates(tabId);
    const now = new Date().toISOString();
    const url = normalizeUrl(incoming.url);
    const existing = candidates.find((candidate) => candidate.url === url);

    if (existing) {
      existing.kind = moreSpecificKind(existing.kind, incoming.kind);
      existing.contentType = incoming.contentType || existing.contentType || "";
      existing.sources = [...new Set([...(existing.sources || []), incoming.source])];
      existing.lastSeen = now;
      await chrome.storage.session.set({ [candidatesKey(tabId)]: candidates });
      return existing;
    }

    const candidate = {
      url,
      kind: incoming.kind || "other",
      contentType: incoming.contentType || "",
      sources: [incoming.source],
      firstSeen: now,
      lastSeen: now
    };
    candidates.unshift(candidate);
    await chrome.storage.session.set({
      [candidatesKey(tabId)]: candidates.slice(0, MAX_CANDIDATES_PER_TAB)
    });
    return candidate;
  });
}

function observeRequest(details, contentType = "") {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  if (details.statusCode && details.statusCode >= 400) return;

  const kind = detectMediaKind(details.url, contentType);
  if (!kind && details.type !== "media") return;

  void upsertCandidate(details.tabId, {
    url: details.url,
    kind: kind || "other",
    contentType,
    source: "network"
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => observeRequest(details),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => observeRequest(details, contentTypeFromHeaders(details.responseHeaders)),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function safeFilenamePart(value) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function filenameForDownload(url, pageTitle) {
  const title = safeFilenamePart(pageTitle || "media");
  const fallback = "media";
  let filePart = "";
  try {
    filePart = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    filePart = "";
  }
  filePart = safeFilenamePart(filePart).replace(/\.mp4$/i, "");
  return `${title || filePart || fallback}.mp4`;
}

async function savePageMetadata(tabId, metadata) {
  const current = await getPageInfo(tabId);
  await setPageInfo(tabId, {
    url: metadata.pageUrl,
    title: metadata.pageTitle || current.title || "",
    updatedAt: new Date().toISOString()
  });

  for (const url of metadata.videoUrls || []) {
    if (!isHttpUrl(url)) continue;
    const kind = detectMediaKind(url);
    if (kind) {
      await upsertCandidate(tabId, { url, kind, source: "video element" });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pageMetadata" && sender.tab?.id >= 0) {
    savePageMetadata(sender.tab.id, message).catch(() => undefined);
    return;
  }

  if (message?.type === "getCandidates" && Number.isInteger(message.tabId)) {
    Promise.all([getCandidates(message.tabId), getPageInfo(message.tabId)])
      .then(([candidates, page]) => sendResponse({ candidates, page }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "downloadMp4") {
    const url = message.url;
    if (!isHttpUrl(url) || detectMediaKind(url, message.contentType) !== "mp4") {
      sendResponse({ error: "该资源不是可直接下载的 MP4。" });
      return;
    }
    chrome.downloads
      .download({
        url,
        filename: filenameForDownload(url, message.pageTitle),
        saveAs: true,
        conflictAction: "uniquify"
      })
      .then((downloadId) => sendResponse({ downloadId }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
});
