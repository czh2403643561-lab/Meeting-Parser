const MAX_CANDIDATES_PER_TAB = 80;
const tabWriteQueue = new Map();
const requestContexts = new Map();
const REQUEST_CONTEXT_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_CONTEXTS = 250;
const MEDIA_CONTEXT_HEADERS = new Set(["accept", "origin", "referer", "range"]);
const SENSITIVE_CONTEXT_HEADERS = new Set(["cookie", "authorization"]);
const LOCAL_FORWARD_HEADERS = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "user-agent"
]);
const ACTIVE_DOWNLOAD_KEY = "activeDownload";
const candidateIdsByUrl = new Map();
const candidateUrlsById = new Map();
const tabPageStates = new Map();

if (chrome.sidePanel?.setPanelBehavior) {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

function candidatesKey(tabId) {
  return `mediaCandidates:${tabId}`;
}

function pageKey(tabId) {
  return `mediaPage:${tabId}`;
}

function pageScopeFromUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function isCurrentPage(tabId, pageScope, generation) {
  const state = tabPageStates.get(tabId);
  return Boolean(state && state.scope === pageScope && state.generation === generation);
}

function clearTabMemory(tabId) {
  const prefix = `${tabId}:`;
  for (const [key, candidateId] of candidateIdsByUrl) {
    if (key.startsWith(prefix)) {
      candidateIdsByUrl.delete(key);
      candidateUrlsById.delete(candidateId);
    }
  }
  for (const [key, context] of requestContexts) {
    if (context.tabId === tabId) requestContexts.delete(key);
  }
}

async function initializeTabPageState(tabId) {
  const existing = tabPageStates.get(tabId);
  if (existing) return existing;
  const page = await getPageInfo(tabId);
  const state = {
    scope: typeof page.scope === "string" ? page.scope : "",
    generation: Number.isInteger(page.generation) ? page.generation : 0
  };
  tabPageStates.set(tabId, state);
  return state;
}

async function activatePageScope(tabId, pageScope) {
  if (typeof pageScope !== "string") return null;
  const previous = await initializeTabPageState(tabId);
  if (previous.scope === pageScope) return previous;

  const next = { scope: pageScope, generation: previous.generation + 1 };
  tabPageStates.set(tabId, next);
  clearTabMemory(tabId);
  void chrome.runtime.sendMessage({ type: "pageScopeChanged", tabId }).catch(() => undefined);
  void queueTabWrite(tabId, async () => {
    if (!isCurrentPage(tabId, pageScope, next.generation)) return;
    await chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
    if (!isCurrentPage(tabId, pageScope, next.generation)) return;
    await chrome.storage.session.set({
      [pageKey(tabId)]: { scope: pageScope, generation: next.generation }
    });
  });
  return next;
}

async function pageStateForRequest(tabId, pageScope) {
  if (!pageScope) return null;
  const current = await initializeTabPageState(tabId);
  if (current.scope && current.scope !== pageScope) return null;
  return current.scope === pageScope ? current : activatePageScope(tabId, pageScope);
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

function redactedUrl(value) {
  try {
    const url = new URL(value);
    const names = [...new Set([...url.searchParams.keys()])];
    url.search = names.map((name) => `${encodeURIComponent(name)}=[redacted]`).join("&");
    url.hash = "";
    return url.href;
  } catch {
    return "[redacted URL]";
  }
}

function newCandidateId() {
  if (globalThis.crypto?.randomUUID) return `media-${crypto.randomUUID()}`;
  return `media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function candidateIdForUrl(tabId, url) {
  const normalized = normalizeUrl(url);
  const key = requestContextKey(tabId, normalized);
  let id = candidateIdsByUrl.get(key);
  if (!id) {
    id = newCandidateId();
    candidateIdsByUrl.set(key, id);
  }
  candidateUrlsById.set(id, normalized);
  return id;
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

function mediaFilenameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const value = decodeURIComponent(pathname.split("/").pop() || "");
    return value.replace(/[\r\n]/g, "").slice(0, 180);
  } catch {
    return "";
  }
}

function mediaVariantFromFilename(filename) {
  if (/(?:^|[_-])screen\.mp4$/i.test(filename)) return "screen";
  if (/(?:^|[_-])speaker\.mp4$/i.test(filename)) return "speaker";
  return "other";
}

function mediaDetails(url) {
  const mediaFilename = mediaFilenameFromUrl(url);
  return {
    mediaFilename,
    variant: mediaVariantFromFilename(mediaFilename)
  };
}

function requestContextKey(tabId, url) {
  return `${tabId}:${normalizeUrl(url)}`;
}

function inspectContextHeaders(headers = []) {
  const selected = {};
  const sensitive = { cookie: false, authorization: false };
  for (const header of headers) {
    const name = header.name?.toLowerCase();
    const value = header.value;
    if (SENSITIVE_CONTEXT_HEADERS.has(name)) {
      sensitive[name] = true;
      if (typeof value === "string" && value && value.length <= 4096 && !/[\r\n]/.test(value)) {
        selected[name] = value;
      }
      continue;
    }
    if (!MEDIA_CONTEXT_HEADERS.has(name) && !LOCAL_FORWARD_HEADERS.has(name)) continue;
    if (typeof value !== "string") continue;
    if (!value || value.length > 4096 || /[\r\n]/.test(value)) continue;
    selected[name] = value;
  }
  return { selected, sensitive };
}

function contextPresence(context) {
  return {
    referer: Boolean(context?.headers?.referer),
    origin: Boolean(context?.headers?.origin),
    accept: Boolean(context?.headers?.accept),
    range: Boolean(context?.headers?.range),
    cookie: Boolean(context?.sensitive?.cookie),
    authorization: Boolean(context?.sensitive?.authorization)
  };
}

function hasUsableRequestContext(context) {
  return Boolean(
    context &&
      (context.headers.referer || context.headers.origin || context.headers.accept || context.headers.range)
  );
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

function pageScopeForRequest(details) {
  return (
    pageScopeFromUrl(details.documentUrl) ||
    pageScopeFromUrl(details.initiator) ||
    tabPageStates.get(details.tabId)?.scope ||
    ""
  );
}

async function rememberRequestContext(details) {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  const kind = detectMediaKind(details.url);
  if (!kind && details.type !== "media") return;
  const pageScope = pageScopeForRequest(details);
  const state = await pageStateForRequest(details.tabId, pageScope);
  if (!state || !isCurrentPage(details.tabId, pageScope, state.generation)) return;

  const inspected = inspectContextHeaders(details.requestHeaders);
  if (!Object.keys(inspected.selected).length && !Object.values(inspected.sensitive).some(Boolean)) return;

  const key = requestContextKey(details.tabId, details.url);
  const previous = requestContexts.get(key);
  requestContexts.set(key, {
    tabId: details.tabId,
    url: normalizeUrl(details.url),
    kind: kind || previous?.kind || "other",
    headers: { ...(previous?.headers || {}), ...inspected.selected },
    sensitive: {
      ...(previous?.sensitive || {}),
      ...inspected.sensitive
    },
    requestId: details.requestId,
    pageScope,
    generation: state.generation,
    updatedAt: Date.now()
  });
  void updateCandidateContext(details.tabId, details.url, pageScope, state.generation, requestContexts.get(key));
  pruneRequestContexts();
}

function getRequestContext(tabId, url) {
  pruneRequestContexts();
  return requestContexts.get(requestContextKey(tabId, url));
}

function localDownloadHeaders(context) {
  if (!context) return {};
  const headers = {};
  for (const name of LOCAL_FORWARD_HEADERS) {
    if (context.headers[name]) headers[name] = context.headers[name];
  }
  return headers;
}

function moreSpecificKind(current, next) {
  if (next && next !== "other") return next;
  return current || next || "other";
}

async function getCandidates(tabId) {
  const state = await initializeTabPageState(tabId);
  const result = await chrome.storage.session.get(candidatesKey(tabId));
  const stored = Array.isArray(result[candidatesKey(tabId)])
    ? result[candidatesKey(tabId)].filter((candidate) => candidate.pageScope === state.scope)
    : [];
  let migrated = false;
  const candidates = stored.map((candidate) => {
    if (candidate.id) return candidate;
    migrated = true;
    const id = isHttpUrl(candidate.url) ? candidateIdForUrl(tabId, candidate.url) : newCandidateId();
    return {
      ...candidate,
      id,
      url: redactedUrl(candidate.url),
      pageScope: state.scope,
      contextReady: false
    };
  });

  if (migrated) {
    await chrome.storage.session.set({ [candidatesKey(tabId)]: candidates });
  }

  return candidates.map((candidate) => {
    const actualUrl = candidateUrlsById.get(candidate.id);
    const context = actualUrl ? getRequestContext(tabId, actualUrl) : undefined;
    return {
      ...candidate,
      context: contextPresence(context) || candidate.context,
      contextReady: hasUsableRequestContext(context) || Boolean(candidate.contextReady)
    };
  });
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

function updateCandidateContext(tabId, url, pageScope, generation, context) {
  const candidateId = candidateIdsByUrl.get(requestContextKey(tabId, url));
  if (!candidateId) return;
  return queueTabWrite(tabId, async () => {
    if (!isCurrentPage(tabId, pageScope, generation)) return;
    const candidates = await getCandidates(tabId);
    if (!isCurrentPage(tabId, pageScope, generation)) return;
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    candidate.context = contextPresence(context);
    candidate.contextReady = hasUsableRequestContext(context);
    await chrome.storage.session.set({ [candidatesKey(tabId)]: candidates });
  });
}

function upsertCandidate(tabId, incoming) {
  const pageScope = incoming.pageScope || tabPageStates.get(tabId)?.scope || "";
  const generation = Number.isInteger(incoming.generation)
    ? incoming.generation
    : tabPageStates.get(tabId)?.generation;
  if (!pageScope || !Number.isInteger(generation)) return Promise.resolve();

  return queueTabWrite(tabId, async () => {
    if (!isCurrentPage(tabId, pageScope, generation)) return;
    const candidates = await getCandidates(tabId);
    if (!isCurrentPage(tabId, pageScope, generation)) return;
    const now = new Date().toISOString();
    const url = normalizeUrl(incoming.url);
    const id = candidateIdForUrl(tabId, url);
    const context = getRequestContext(tabId, url);
    const details = mediaDetails(url);
    const existing = candidates.find((candidate) => candidate.id === id);

    if (existing) {
      existing.kind = moreSpecificKind(existing.kind, incoming.kind);
      existing.contentType = incoming.contentType || existing.contentType || "";
      existing.sources = [...new Set([...(existing.sources || []), incoming.source])];
      existing.context = contextPresence(context);
      existing.contextReady = hasUsableRequestContext(context);
      existing.mediaFilename = details.mediaFilename || existing.mediaFilename || "";
      existing.variant = details.variant || existing.variant || "other";
      existing.pageScope = pageScope;
      existing.lastSeen = now;
      if (!isCurrentPage(tabId, pageScope, generation)) return;
      await chrome.storage.session.set({ [candidatesKey(tabId)]: candidates });
      return existing;
    }

    const candidate = {
      id,
      url: redactedUrl(url),
      kind: incoming.kind || "other",
      contentType: incoming.contentType || "",
      mediaFilename: details.mediaFilename,
      variant: details.variant,
      pageScope,
      sources: [incoming.source],
      context: contextPresence(context),
      contextReady: hasUsableRequestContext(context),
      firstSeen: now,
      lastSeen: now
    };
    candidates.unshift(candidate);
    if (!isCurrentPage(tabId, pageScope, generation)) return;
    await chrome.storage.session.set({
      [candidatesKey(tabId)]: candidates.slice(0, MAX_CANDIDATES_PER_TAB)
    });
    return candidate;
  });
}

async function observeRequest(details, contentType = "") {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  if (details.statusCode && details.statusCode >= 400) return;

  const kind = detectMediaKind(details.url, contentType);
  if (!kind && details.type !== "media") return;
  const pageScope = pageScopeForRequest(details);
  const state = await pageStateForRequest(details.tabId, pageScope);
  if (!state || !isCurrentPage(details.tabId, pageScope, state.generation)) return;

  void upsertCandidate(details.tabId, {
    url: details.url,
    kind: kind || "other",
    contentType,
    source: "network",
    pageScope,
    generation: state.generation
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
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => rememberRequestContext(details),
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
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

const LOCAL_DOWNLOADER_BASE = "http://127.0.0.1:8765";

async function localDownloaderRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${LOCAL_DOWNLOADER_BASE}${path}`, {
      cache: "no-store",
      ...options
    });
  } catch {
    throw new Error("本地下载器未启动，请先运行 local_downloader.py");
  }

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(body.error || `本地下载器返回 HTTP ${response.status}。`);
  }
  return body;
}

async function checkLocalDownloader() {
  try {
    const result = await localDownloaderRequest("/health");
    return { ok: result.ok === true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function startLocalDownload(message) {
  const url = candidateUrlsById.get(message.candidateId);
  if (!url || !Number.isInteger(message.tabId)) {
    throw new Error("未捕获播放器请求上下文，请重新播放视频后再试。");
  }
  if (detectMediaKind(url, message.contentType) !== "mp4") {
    throw new Error("该资源不是可直接下载的 MP4。");
  }

  const context = getRequestContext(message.tabId, url);
  if (!hasUsableRequestContext(context)) {
    throw new Error("未捕获播放器请求上下文，请重新播放视频后再试。");
  }

  await localDownloaderRequest("/health");
  const result = await localDownloaderRequest("/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      filename: filenameForDownload(url, message.pageTitle),
      headers: localDownloadHeaders(context)
    })
  });
  await saveActiveDownload({
    taskId: result.taskId,
    tabId: message.tabId,
    filename: result.filename,
    startedAt: new Date().toISOString(),
    status: result.status || "queued"
  });
  return { taskId: result.taskId, filename: result.filename, status: result.status };
}

async function getLocalDownloadStatus(taskId) {
  if (typeof taskId !== "string" || !/^[a-f0-9]{32}$/.test(taskId)) {
    throw new Error("本地下载任务编号无效。");
  }
  return localDownloaderRequest(`/status?id=${encodeURIComponent(taskId)}`);
}

async function saveActiveDownload(activeDownload) {
  await chrome.storage.session.set({ [ACTIVE_DOWNLOAD_KEY]: activeDownload });
}

async function updateActiveDownloadStatus(taskId, status) {
  const result = await chrome.storage.session.get(ACTIVE_DOWNLOAD_KEY);
  const active = result[ACTIVE_DOWNLOAD_KEY];
  if (!active || active.taskId !== taskId || !status?.status) return;
  await saveActiveDownload({ ...active, status: status.status });
}

async function getActiveDownload() {
  const result = await chrome.storage.session.get(ACTIVE_DOWNLOAD_KEY);
  const active = result[ACTIVE_DOWNLOAD_KEY];
  if (!active?.taskId) return null;

  try {
    const latest = await getLocalDownloadStatus(active.taskId);
    await updateActiveDownloadStatus(active.taskId, latest);
    return { ...active, ...latest };
  } catch {
    return {
      ...active,
      serviceError: "本地下载器已停止，无法获取当前任务状态。"
    };
  }
}

async function clearActiveDownload() {
  await chrome.storage.session.remove(ACTIVE_DOWNLOAD_KEY);
  return { ok: true };
}

async function savePageMetadata(tabId, metadata, senderPageUrl = "") {
  const pageScope = pageScopeFromUrl(metadata.pageUrl);
  const senderScope = pageScopeFromUrl(senderPageUrl);
  const knownState = await initializeTabPageState(tabId);
  if (knownState.scope && knownState.scope !== pageScope && senderScope !== pageScope) return;
  const state = await activatePageScope(tabId, pageScope);
  if (!state || !isCurrentPage(tabId, pageScope, state.generation)) return;
  const current = await getPageInfo(tabId);
  if (!isCurrentPage(tabId, pageScope, state.generation)) return;
  await queueTabWrite(tabId, async () => {
    if (!isCurrentPage(tabId, pageScope, state.generation)) return;
    await setPageInfo(tabId, {
      url: redactedUrl(metadata.pageUrl),
      title: metadata.pageTitle || current.title || "",
      scope: pageScope,
      generation: state.generation,
      updatedAt: new Date().toISOString()
    });
  });
  if (!isCurrentPage(tabId, pageScope, state.generation)) return;

  for (const url of metadata.videoUrls || []) {
    if (!isHttpUrl(url)) continue;
    const kind = detectMediaKind(url);
    if (kind) {
      await upsertCandidate(tabId, {
        url,
        kind,
        source: "video element",
        pageScope,
        generation: state.generation
      });
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pageMetadata" && sender.tab?.id >= 0) {
    savePageMetadata(sender.tab.id, message, sender.tab.url).catch(() => undefined);
    return;
  }

  if (message?.type === "getCandidates" && Number.isInteger(message.tabId)) {
    Promise.all([getCandidates(message.tabId), getPageInfo(message.tabId)])
      .then(([candidates, page]) => sendResponse({ candidates, page }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "checkLocalDownloader") {
    checkLocalDownloader()
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getLocalDownloadStatus") {
    getLocalDownloadStatus(message.taskId)
      .then(async (status) => {
        await updateActiveDownloadStatus(message.taskId, status);
        sendResponse(status);
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getActiveDownload") {
    getActiveDownload()
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "clearActiveDownload") {
    clearActiveDownload()
      .then((status) => sendResponse(status))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "downloadMp4") {
    startLocalDownload(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const updatedUrl = changeInfo.url || tab?.url;
  if (updatedUrl) void activatePageScope(tabId, pageScopeFromUrl(updatedUrl));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabPageStates.delete(tabId);
  clearTabMemory(tabId);
  void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
});
