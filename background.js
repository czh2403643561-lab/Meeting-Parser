const MAX_CANDIDATES_PER_TAB = 80;
const tabWriteQueue = new Map();
const requestContexts = new Map();
const downloadJobs = new Map();
const DOWNLOAD_STATUS_KEY = "downloadStatuses";
const REQUEST_CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_CONTEXTS = 250;
const MEDIA_CONTEXT_HEADERS = new Set(["accept", "origin", "referer", "range"]);
const DOWNLOAD_RESOURCE_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"];
let nextRuleId = Math.max(100000, Date.now() % 1000000000);
let downloadStatusWrite = Promise.resolve();

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

function requestContextKey(tabId, url) {
  return `${tabId}:${normalizeUrl(url)}`;
}

function safeContextHeaders(headers = []) {
  const selected = {};
  for (const header of headers) {
    const name = header.name?.toLowerCase();
    const value = header.value;
    if (!MEDIA_CONTEXT_HEADERS.has(name) || typeof value !== "string") continue;
    if (!value || value.length > 4096 || /[\r\n]/.test(value)) continue;
    selected[name] = value;
  }
  return selected;
}

function pruneRequestContexts() {
  const cutoff = Date.now() - REQUEST_CONTEXT_TTL_MS;
  for (const [key, context] of requestContexts) {
    if (context.updatedAt < cutoff) requestContexts.delete(key);
  }
  while (requestContexts.size > MAX_REQUEST_CONTEXTS) {
    const oldestKey = requestContexts.keys().next().value;
    requestContexts.delete(oldestKey);
  }
}

function rememberRequestContext(details) {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  const kind = detectMediaKind(details.url);
  if (!kind && details.type !== "media") return;

  const selected = safeContextHeaders(details.requestHeaders);
  if (!Object.keys(selected).length) return;

  const key = requestContextKey(details.tabId, details.url);
  const previous = requestContexts.get(key);
  requestContexts.set(key, {
    tabId: details.tabId,
    url: normalizeUrl(details.url),
    kind: kind || previous?.kind || "other",
    headers: { ...(previous?.headers || {}), ...selected },
    requestId: details.requestId,
    updatedAt: Date.now()
  });
  pruneRequestContexts();
}

function getRequestContext(tabId, url) {
  pruneRequestContexts();
  return requestContexts.get(requestContextKey(tabId, url));
}

function directDownloadHeaders(context) {
  if (!context) return [];
  const headers = [];
  if (context.headers.accept) {
    headers.push({ name: "Accept", value: context.headers.accept });
  }

  // Do not replay a partial player range. bytes=0- is the only range that can
  // still describe the complete resource; other ranges would create a partial file.
  if (/^bytes=0-$/.test(context.headers.range?.trim() || "")) {
    headers.push({ name: "Range", value: "bytes=0-" });
  }
  return headers;
}

function deferredDownloadHeaders(context) {
  if (!context) return [];
  return ["referer", "origin"]
    .filter((name) => context.headers[name])
    .map((name) => ({ name, value: context.headers[name] }));
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function downloadUrlCondition(url) {
  const regex = `^${escapedRegex(normalizeUrl(url))}$`;
  if (regex.length <= 2000) {
    return { regexFilter: regex, resourceTypes: DOWNLOAD_RESOURCE_TYPES };
  }
  return { urlFilter: normalizeUrl(url), resourceTypes: DOWNLOAD_RESOURCE_TYPES };
}

async function allocateRuleIds(count) {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const used = new Set(existing.map((rule) => rule.id));
  const ids = [];
  while (ids.length < count) {
    nextRuleId = (nextRuleId % 2000000000) + 1;
    if (!used.has(nextRuleId)) {
      used.add(nextRuleId);
      ids.push(nextRuleId);
    }
  }
  return ids;
}

async function installTemporaryHeaderRules(url, headers) {
  if (!headers.length) return { ruleIds: [] };
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    return { ruleIds: [], warning: "浏览器不支持临时请求头规则，已仅使用可直接附带的请求头。" };
  }

  try {
    const ruleIds = await allocateRuleIds(headers.length);
    const condition = downloadUrlCondition(url);
    const rules = headers.map((header, index) => ({
      id: ruleIds[index],
      priority: 1000,
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: header.name, operation: "set", value: header.value }]
      },
      condition
    }));
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: rules });
    return { ruleIds };
  } catch (error) {
    return { ruleIds: [], warning: `临时请求头规则未启用：${error.message}` };
  }
}

async function removeTemporaryHeaderRules(ruleIds = []) {
  if (!ruleIds.length || !chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIds });
  } catch {
    // A session rule may already have been removed by extension reload.
  }
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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => rememberRequestContext(details),
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => rememberRequestContext(details),
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
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

function publicDownloadStatus(status) {
  if (!status) return null;
  const { ruleIds, ...publicStatus } = status;
  return publicStatus;
}

async function readDownloadStatuses() {
  const result = await chrome.storage.session.get(DOWNLOAD_STATUS_KEY);
  return Array.isArray(result[DOWNLOAD_STATUS_KEY]) ? result[DOWNLOAD_STATUS_KEY] : [];
}

function updateDownloadStatus(downloadId, patch) {
  const operation = downloadStatusWrite
    .catch(() => undefined)
    .then(async () => {
      const statuses = await readDownloadStatuses();
      const previous = statuses.find((status) => status.downloadId === downloadId) || { downloadId };
      const status = {
        ...previous,
        ...patch,
        downloadId,
        updatedAt: new Date().toISOString()
      };
      const nextStatuses = [
        status,
        ...statuses.filter((item) => item.downloadId !== downloadId)
      ].slice(0, 20);
      await chrome.storage.session.set({ [DOWNLOAD_STATUS_KEY]: nextStatuses });
      void chrome.runtime.sendMessage({
        type: "downloadStatus",
        status: publicDownloadStatus(status)
      }).catch(() => undefined);
      return status;
    });
  downloadStatusWrite = operation;
  return operation;
}

async function getStoredDownloadStatus(downloadId) {
  const statuses = await readDownloadStatuses();
  return statuses.find((status) => status.downloadId === downloadId);
}

function downloadErrorText(errorCode) {
  const messages = {
    FILE_FAILED: "本地文件写入失败。",
    FILE_ACCESS_DENIED: "没有权限写入目标文件。",
    FILE_NO_SPACE: "磁盘空间不足。",
    FILE_NAME_TOO_LONG: "文件名过长。",
    NETWORK_FAILED: "网络请求失败。",
    NETWORK_TIMEOUT: "网络请求超时。",
    NETWORK_DISCONNECTED: "网络连接中断。",
    NETWORK_SERVER_DOWN: "服务器不可用。",
    SERVER_FAILED: "服务器返回失败。",
    SERVER_NO_RANGE: "服务器不支持所需的范围请求。",
    SERVER_BAD_CONTENT: "服务器返回的内容不是有效的媒体文件，可能是错误文本或鉴权失败。",
    SERVER_UNAUTHORIZED: "服务器拒绝访问，可能需要在原页面保持登录。",
    SERVER_FORBIDDEN: "服务器禁止下载该资源。",
    SERVER_UNREACHABLE: "无法连接到媒体服务器。",
    SERVER_MALFORMED: "服务器响应格式异常。",
    USER_CANCELED: "下载已取消。",
    USER_SHUTDOWN: "浏览器关闭导致下载中断。",
    BLOCKED_TOO_MANY_DOWNLOADS: "浏览器阻止了过多下载。"
  };
  return `${messages[errorCode] || "下载失败。"}${errorCode ? `（${errorCode}）` : ""}`;
}

function acceptedMp4Mime(mime) {
  const normalized = mime?.split(";", 1)[0].trim().toLowerCase();
  return !normalized || ["video/mp4", "application/mp4", "application/octet-stream"].includes(normalized);
}

async function cleanupDownload(downloadId, status) {
  const job = downloadJobs.get(downloadId);
  const ruleIds = job?.ruleIds || status?.ruleIds || [];
  await removeTemporaryHeaderRules(ruleIds);
  if (job?.contextKey) requestContexts.delete(job.contextKey);
  downloadJobs.delete(downloadId);
  if (ruleIds.length) {
    await updateDownloadStatus(downloadId, { ruleIds: [] });
  }
}

async function handleDownloadChanged(downloadId, delta) {
  const stored = await getStoredDownloadStatus(downloadId);
  if (!stored) return;

  const nextState = delta.state?.current || stored.state;
  const errorCode = delta.error?.current || stored.errorCode;
  const terminal = nextState === "complete" || nextState === "interrupted" || Boolean(errorCode);
  if (!terminal) {
    if (delta.state?.current) await updateDownloadStatus(downloadId, { state: nextState });
    return;
  }

  let patch = { state: nextState, errorCode };
  if (errorCode || nextState === "interrupted") {
    patch.error = downloadErrorText(errorCode);
    patch.state = "interrupted";
  } else {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items[0];
    if (item?.mime && !acceptedMp4Mime(item.mime)) {
      patch.state = "interrupted";
      patch.errorCode = "SERVER_BAD_CONTENT";
      patch.error = `服务器返回类型为 ${item.mime}，未确认是 MP4；未将其视为成功下载。`;
    } else {
      patch.error = "";
    }
  }

  const finalStatus = await updateDownloadStatus(downloadId, patch);
  await cleanupDownload(downloadId, finalStatus);
}

async function reconcileDownload(downloadId) {
  try {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = items[0];
    if (!item || !["complete", "interrupted"].includes(item.state)) return;
    await handleDownloadChanged(downloadId, {
      state: { current: item.state },
      error: item.error ? { current: item.error } : undefined
    });
  } catch {
    // The normal onChanged event will report the result if reconciliation races it.
  }
}

async function startMp4Download(message) {
  const url = message.url;
  if (!isHttpUrl(url) || detectMediaKind(url, message.contentType) !== "mp4") {
    throw new Error("该资源不是可直接下载的 MP4。");
  }

  const context = Number.isInteger(message.tabId) ? getRequestContext(message.tabId, url) : undefined;
  const directHeaders = directDownloadHeaders(context);
  const deferredHeaders = deferredDownloadHeaders(context);
  const temporaryRules = await installTemporaryHeaderRules(url, deferredHeaders);
  const filename = filenameForDownload(url, message.pageTitle);
  const options = {
    url,
    filename,
    saveAs: true,
    conflictAction: "uniquify"
  };
  if (directHeaders.length) options.headers = directHeaders;

  let downloadId;
  try {
    downloadId = await chrome.downloads.download(options);
  } catch (error) {
    await removeTemporaryHeaderRules(temporaryRules.ruleIds);
    throw new Error(error.message || "浏览器未能启动下载。");
  }

  const contextKey = context ? requestContextKey(context.tabId, context.url) : undefined;
  downloadJobs.set(downloadId, {
    ruleIds: temporaryRules.ruleIds,
    contextKey
  });
  await updateDownloadStatus(downloadId, {
    state: "in_progress",
    filename,
    error: "",
    errorCode: "",
    ruleIds: temporaryRules.ruleIds,
    startedAt: new Date().toISOString()
  });
  void reconcileDownload(downloadId);

  return {
    downloadId,
    warning: temporaryRules.warning || (!context ? "未找到当前 MP4 的原始请求上下文，已直接尝试下载。" : "")
  };
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

  if (message?.type === "getDownloadStatus" && Number.isInteger(message.downloadId)) {
    getStoredDownloadStatus(message.downloadId)
      .then((status) => sendResponse({ status: publicDownloadStatus(status) }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getLatestDownloadStatus") {
    readDownloadStatuses()
      .then((statuses) => sendResponse({ status: publicDownloadStatus(statuses[0]) }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "downloadMp4") {
    startMp4Download(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.id >= 0) void handleDownloadChanged(delta.id, delta);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
});
