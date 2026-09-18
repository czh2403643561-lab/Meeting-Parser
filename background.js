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
const BATCH_STATE_KEY = "batchState";
const BATCH_ALARM_NAME = "batchDownloadTick";
const PAGE_LOAD_TIMEOUT_MS = 30 * 1000;
const MEDIA_DETECT_TIMEOUT_MS = 20 * 1000;
const candidateIdsByUrl = new Map();
const candidateUrlsById = new Map();
const tabPageStates = new Map();
const pageRequestInfoByTab = new Map();
let batchAdvancing = false;

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
  pageRequestInfoByTab.delete(tabId);
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

  const next = { scope: pageScope, generation: previous.generation + 1, documentId: "" };
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

function originFromUrl(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

async function pageStateForRequest(tabId, details) {
  const current = await initializeTabPageState(tabId);
  if (!current.scope) return null;
  if (details.documentId && current.documentId && details.documentId !== current.documentId) return null;

  const initiatorOrigin = originFromUrl(details.initiator);
  if (initiatorOrigin && initiatorOrigin !== originFromUrl(current.scope)) return null;
  return current;
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

function stableMediaIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function mediaKey(tabId, url) {
  return `${tabId}:${stableMediaIdentity(url)}`;
}

function candidateIdForUrl(tabId, url) {
  const normalized = normalizeUrl(url);
  const key = mediaKey(tabId, normalized);
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
  return mediaKey(tabId, url);
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

async function rememberRequestContext(details) {
  if (details.tabId < 0 || !isHttpUrl(details.url)) return;
  const kind = detectMediaKind(details.url);
  if (!kind && details.type !== "media") return;
  const state = await pageStateForRequest(details.tabId, details);
  if (!state || !isCurrentPage(details.tabId, state.scope, state.generation)) return;

  const inspected = inspectContextHeaders(details.requestHeaders);
  if (!Object.keys(inspected.selected).length && !Object.values(inspected.sensitive).some(Boolean)) return;

  candidateIdForUrl(details.tabId, details.url);
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
    pageScope: state.scope,
    generation: state.generation,
    updatedAt: Date.now()
  });
  void updateCandidateContext(details.tabId, details.url, state.scope, state.generation, requestContexts.get(key));
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
  const allStored = Array.isArray(result[candidatesKey(tabId)]) ? result[candidatesKey(tabId)] : [];
  const scoped = allStored.filter((candidate) => candidate.pageScope === state.scope);
  let changed = scoped.length !== allStored.length;
  const byStableMedia = new Map();

  for (const rawCandidate of scoped) {
    const candidate = rawCandidate.id
      ? rawCandidate
      : {
          ...rawCandidate,
          id: newCandidateId(),
          url: redactedUrl(rawCandidate.url),
          pageScope: state.scope,
          contextReady: false
        };
    if (!rawCandidate.id) changed = true;

    const stable = stableMediaIdentity(candidate.url) || candidate.id;
    const existing = byStableMedia.get(stable);
    if (existing) {
      changed = true;
      existing.sources = [...new Set([...(existing.sources || []), ...(candidate.sources || [])])];
      existing.contextReady = Boolean(existing.contextReady || candidate.contextReady);
      existing.context = existing.context || candidate.context;
      existing.lastSeen = existing.lastSeen || candidate.lastSeen;
      continue;
    }
    byStableMedia.set(stable, candidate);
  }

  const candidates = [...byStableMedia.values()];
  for (const candidate of candidates) {
    candidateIdsByUrl.set(mediaKey(tabId, candidate.url), candidate.id);
  }
  if (changed) await chrome.storage.session.set({ [candidatesKey(tabId)]: candidates });

  return candidates.map((candidate) => {
    const actualUrl = candidateUrlsById.get(candidate.id) || candidate.url;
    const context = getRequestContext(tabId, actualUrl);
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
      existing.url = redactedUrl(url);
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
  const state = await pageStateForRequest(details.tabId, details);
  if (!state || !isCurrentPage(details.tabId, state.scope, state.generation)) return;

  void upsertCandidate(details.tabId, {
    url: details.url,
    kind: kind || "other",
    contentType,
    source: "network",
    pageScope: state.scope,
    generation: state.generation
  }).then(() => notifyBatchMediaObserved(details.tabId));
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

function notifyDownloadStage(tabId, candidateId, stage) {
  void chrome.runtime.sendMessage({ type: "downloadPreparation", tabId, candidateId, stage }).catch(() => undefined);
}

function fallbackContext(tabId, url, state, pageInfo, cookies) {
  if (!pageInfo || pageInfo.scope !== state.scope || pageInfo.generation !== state.generation) return null;
  const headers = {};
  if (isHttpUrl(pageInfo.url)) headers.referer = pageInfo.url;
  if (pageInfo.userAgent) headers["user-agent"] = pageInfo.userAgent;
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  if (cookieHeader && cookieHeader.length <= 8192) headers.cookie = cookieHeader;
  if (!headers.referer) return null;
  return {
    tabId,
    url: normalizeUrl(url),
    headers,
    sensitive: { cookie: Boolean(headers.cookie), authorization: false },
    pageScope: state.scope,
    generation: state.generation,
    updatedAt: Date.now()
  };
}

async function buildFallbackContext(tabId, url) {
  const state = await initializeTabPageState(tabId);
  const pageInfo = pageRequestInfoByTab.get(tabId);
  if (!state.scope || !pageInfo) return null;
  let cookies = [];
  try {
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    cookies = [];
  }
  return fallbackContext(tabId, url, state, pageInfo, cookies);
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function prepareNetworkContext(tabId, url) {
  let mediaPathname = "";
  try {
    mediaPathname = new URL(url).pathname;
  } catch {
    return null;
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "prepareMediaContext",
      mediaPathname,
      timeoutMs: 4000
    });
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const context = getRequestContext(tabId, url);
    if (hasUsableRequestContext(context)) return context;
    await waitFor(250);
  }
  return null;
}

async function startLocalDownload(message) {
  const batch = await getBatchState();
  if (batch.status === "running") {
    throw new Error("批量下载正在运行，请先暂停批量任务。");
  }
  return prepareCandidateAndStartDownload(message, { trackActiveDownload: true });
}

async function prepareCandidateAndStartDownload(message, options = {}) {
  const url = candidateUrlsById.get(message.candidateId);
  if (!url || !Number.isInteger(message.tabId)) {
    throw new Error("未获取当前媒体地址，请刷新页面后再试。");
  }
  if (detectMediaKind(url, message.contentType) !== "mp4") {
    throw new Error("该资源不是可直接下载的 MP4。");
  }

  notifyDownloadStage(message.tabId, message.candidateId, "preparing");
  let context = getRequestContext(message.tabId, url);
  if (!hasUsableRequestContext(context)) {
    context = await buildFallbackContext(message.tabId, url);
  }
  if (!hasUsableRequestContext(context)) {
    context = await prepareNetworkContext(message.tabId, url);
  }
  if (!hasUsableRequestContext(context)) {
    throw new Error("自动准备失败，请播放视频后重试。");
  }

  notifyDownloadStage(message.tabId, message.candidateId, "connecting");
  await localDownloaderRequest("/health");
  notifyDownloadStage(message.tabId, message.candidateId, "submitting");
  const result = await localDownloaderRequest("/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      filename: message.filename || filenameForDownload(url, message.pageTitle),
      headers: localDownloadHeaders(context)
    })
  });
  if (options.trackActiveDownload) {
    await saveActiveDownload({
      taskId: result.taskId,
      tabId: message.tabId,
      filename: result.filename,
      startedAt: new Date().toISOString(),
      status: result.status || "queued"
    });
  }
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

function emptyBatchState() {
  return {
    status: "idle",
    workerTabId: null,
    currentIndex: 0,
    startedAt: "",
    mediaPreference: "auto",
    tasks: []
  };
}

async function getBatchState() {
  const result = await chrome.storage.session.get(BATCH_STATE_KEY);
  const saved = result[BATCH_STATE_KEY];
  if (!saved || !Array.isArray(saved.tasks)) return emptyBatchState();
  return {
    ...emptyBatchState(),
    ...saved,
    tasks: saved.tasks.map((task, index) => ({ index, ...task }))
  };
}

async function saveBatchState(state) {
  await chrome.storage.session.set({ [BATCH_STATE_KEY]: state });
  void chrome.runtime.sendMessage({ type: "batchStateChanged" }).catch(() => undefined);
}

function batchTask(state) {
  return state.tasks[state.currentIndex] || null;
}

function nextPendingBatchIndex(state) {
  return state.tasks.findIndex((task) => task.status === "pending");
}

function batchFilename(task, candidate) {
  const pageTitle = safeFilenamePart(task.pageTitle || "");
  const genericTitle = /^(腾讯会议|会议|回放|当前页面|media)$/i.test(pageTitle);
  const mediaName = safeFilenamePart((candidate.mediaFilename || "").replace(/\.mp4$/i, ""));
  let pageId = "meeting";
  try {
    pageId = safeFilenamePart(new URL(task.pageUrl).pathname.split("/").filter(Boolean).pop() || "meeting");
  } catch {
    // The batch parser only accepts valid meeting URLs; keep a safe fallback.
  }
  const name = !genericTitle && pageTitle ? pageTitle : mediaName || pageId || "meeting";
  return `${String(task.index + 1).padStart(3, "0")} - ${name}.mp4`;
}

function selectBatchCandidate(candidates, preference) {
  const mp4 = candidates.filter((candidate) => candidate.kind === "mp4");
  if (!mp4.length) return { candidate: null, waiting: true };
  let preferred = mp4;
  if (preference === "screen" || preference === "speaker") {
    preferred = mp4.filter((candidate) => candidate.variant === preference);
    if (!preferred.length) return { error: `未发现${preference === "screen" ? "屏幕画面" : "发言人画面"} MP4。` };
  } else {
    for (const variant of ["other", "screen", "speaker"]) {
      const matches = mp4.filter((candidate) => candidate.variant === variant);
      if (matches.length) {
        preferred = matches;
        break;
      }
    }
  }

  const ranked = preferred.map((candidate) => ({
    candidate,
    score: (candidateUrlsById.has(candidate.id) ? 2 : 0) + (candidate.contextReady ? 1 : 0)
  }));
  const bestScore = Math.max(...ranked.map((item) => item.score));
  const best = ranked.filter((item) => item.score === bestScore);
  if (bestScore < 2) return { candidate: null, waiting: true };
  if (best.length !== 1) return { error: "发现多个无法确定的 MP4，请单独处理。" };
  return { candidate: best[0].candidate };
}

async function closeBatchWorker(state) {
  const workerTabId = state.workerTabId;
  state.workerTabId = null;
  await saveBatchState(state);
  if (Number.isInteger(workerTabId)) {
    try {
      await chrome.tabs.remove(workerTabId);
    } catch {
      // It may already have been closed by the user.
    }
  }
}

async function ensureBatchWorker(state, task) {
  if (Number.isInteger(state.workerTabId)) {
    try {
      await chrome.tabs.get(state.workerTabId);
      return state.workerTabId;
    } catch {
      state.workerTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: task.pageUrl, active: false });
  state.workerTabId = tab.id;
  task.status = "navigating";
  task.phaseStartedAt = Date.now();
  await saveBatchState(state);
  return tab.id;
}

function queueBatchAdvance() {
  setTimeout(() => void advanceBatchQueue(), 0);
}

function scheduleBatchTick() {
  setTimeout(() => void advanceBatchQueue(), 1000);
}

async function failBatchTask(state, task, error) {
  task.status = "failed";
  task.error = error;
  task.phaseStartedAt = 0;
  await saveBatchState(state);
  queueBatchAdvance();
}

async function advanceBatchQueue() {
  if (batchAdvancing) return;
  batchAdvancing = true;
  try {
    const state = await getBatchState();
    const pausedDownload = state.status === "paused" && batchTask(state)?.status === "downloading";
    if (state.status !== "running" && !pausedDownload) return;

    let task = batchTask(state);
    if (!task || ["complete", "failed"].includes(task.status)) {
      const nextIndex = nextPendingBatchIndex(state);
      if (nextIndex < 0) {
        state.status = "completed";
        await closeBatchWorker(state);
        return;
      }
      state.currentIndex = nextIndex;
      task = state.tasks[nextIndex];
      await saveBatchState(state);
    }

    if (Number.isInteger(state.workerTabId)) {
      try {
        await chrome.tabs.get(state.workerTabId);
      } catch {
        state.workerTabId = null;
        state.status = "paused";
        await saveBatchState(state);
        return;
      }
    }
    if (!Number.isInteger(state.workerTabId) && task.status === "downloading" && state.status === "running") {
      state.status = "paused";
      await saveBatchState(state);
      return;
    }

    if (task.status === "downloading") {
      if (!task.taskId) return failBatchTask(state, task, "本地下载任务编号丢失。");
      try {
        const download = await getLocalDownloadStatus(task.taskId);
        Object.assign(task, {
          bytes: Number(download.bytes) || 0,
          totalBytes: Number.isFinite(download.totalBytes) ? download.totalBytes : null,
          progress: Number.isFinite(download.progress) ? download.progress : null,
          filename: download.filename || task.filename
        });
        if (download.status === "complete") {
          task.status = "complete";
          task.error = "";
        } else if (download.status === "failed") {
          task.status = "failed";
          task.error = download.error || "本地下载失败。";
        }
        await saveBatchState(state);
        if (["complete", "failed"].includes(task.status)) queueBatchAdvance();
        else scheduleBatchTick();
      } catch {
        // Keep the task resumable when the local service is temporarily unavailable.
      }
      return;
    }

    const workerTabId = await ensureBatchWorker(state, task);
    if (task.status === "pending") {
      task.status = "navigating";
      task.phaseStartedAt = Date.now();
      await chrome.tabs.update(workerTabId, { url: task.pageUrl });
      await saveBatchState(state);
      return;
    }
    if (task.status === "navigating") {
      if (Date.now() - Number(task.phaseStartedAt || 0) > PAGE_LOAD_TIMEOUT_MS) {
        return failBatchTask(state, task, "页面加载超时。");
      }
      scheduleBatchTick();
      return;
    }
    if (task.status !== "detecting" && task.status !== "preparing") return;
    if (Date.now() - Number(task.phaseStartedAt || 0) > MEDIA_DETECT_TIMEOUT_MS) {
        return failBatchTask(state, task, task.status === "preparing" ? "媒体上下文准备失败。" : "未发现 MP4。");
    }

    await chrome.tabs.sendMessage(workerTabId, { type: "scanPageMedia" }).catch(() => undefined);
    const [candidates, page] = await Promise.all([getCandidates(workerTabId), getPageInfo(workerTabId)]);
    task.pageTitle = page.title || task.pageTitle || "";
    const selected = selectBatchCandidate(candidates, state.mediaPreference);
    if (selected.error) return failBatchTask(state, task, selected.error);
    if (!selected.candidate) {
      await saveBatchState(state);
      scheduleBatchTick();
      return;
    }

    task.status = "preparing";
    task.phaseStartedAt = Date.now();
    task.filename = batchFilename(task, selected.candidate);
    await saveBatchState(state);
    if ((await getBatchState()).status !== "running") return;
    try {
      const started = await prepareCandidateAndStartDownload(
        {
          tabId: workerTabId,
          candidateId: selected.candidate.id,
          contentType: selected.candidate.contentType,
          pageTitle: task.pageTitle,
          filename: task.filename
        },
        { trackActiveDownload: false }
      );
      task.status = "downloading";
      task.taskId = started.taskId;
      task.filename = started.filename || task.filename;
      task.bytes = 0;
      task.totalBytes = null;
      task.progress = null;
      await saveBatchState(state);
      queueBatchAdvance();
    } catch (error) {
      await failBatchTask(state, task, error.message === "自动准备失败，请播放视频后重试。" ? "媒体上下文准备失败。" : error.message);
    }
  } finally {
    batchAdvancing = false;
  }
}

async function setBatchTasks(message) {
  const items = Array.isArray(message.items) ? message.items : [];
  const tasks = items
    .filter((item) => typeof item?.url === "string" && /^https:\/\/meeting\.tencent\.com\/(?:crm|cw)\//i.test(item.url))
    .map((item, index) => ({
      index,
      pageUrl: item.url,
      status: "pending",
      pageTitle: "",
      filename: "",
      taskId: "",
      bytes: 0,
      totalBytes: null,
      progress: null,
      error: ""
    }));
  const existing = await getBatchState();
  if (existing.status === "running") throw new Error("批量下载正在运行，不能替换任务列表。");
  const state = { ...emptyBatchState(), mediaPreference: existing.mediaPreference, tasks };
  await saveBatchState(state);
  return state;
}

async function startBatch(message) {
  const state = await getBatchState();
  if (!state.tasks.length) throw new Error("请先解析至少一条腾讯会议链接。");
  if (state.status === "running") return state;
  const health = await checkLocalDownloader();
  if (!health.ok) throw new Error(health.error || "本地下载器未启动，请先运行 local_downloader.py");
  state.status = "running";
  state.mediaPreference = ["auto", "screen", "speaker"].includes(message.mediaPreference)
    ? message.mediaPreference
    : state.mediaPreference || "auto";
  state.startedAt = state.startedAt || new Date().toISOString();
  if (!batchTask(state) || ["complete", "failed"].includes(batchTask(state).status)) {
    const nextIndex = nextPendingBatchIndex(state);
    if (nextIndex < 0) throw new Error("没有待下载任务，请先重新解析链接或重试失败项。");
    state.currentIndex = nextIndex;
  }
  await saveBatchState(state);
  await chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 0.5 });
  queueBatchAdvance();
  return state;
}

async function pauseBatch() {
  const state = await getBatchState();
  if (state.status === "running") {
    state.status = "paused";
    await saveBatchState(state);
  }
  return state;
}

async function retryBatchTask(index) {
  const state = await getBatchState();
  const task = state.tasks[index];
  if (!task || task.status !== "failed") throw new Error("只能重试失败任务。");
  Object.assign(task, { status: "pending", taskId: "", bytes: 0, totalBytes: null, progress: null, error: "", phaseStartedAt: 0 });
  if (state.status === "completed") state.status = "paused";
  await saveBatchState(state);
  return state;
}

async function notifyBatchMetadata(tabId, pageTitle) {
  const state = await getBatchState();
  const task = batchTask(state);
  if (state.status !== "running" || state.workerTabId !== tabId || !task) return;
  task.pageTitle = pageTitle || task.pageTitle || "";
  if (task.status === "navigating") {
    task.status = "detecting";
    task.phaseStartedAt = Date.now();
  }
  await saveBatchState(state);
  queueBatchAdvance();
}

async function notifyBatchMediaObserved(tabId) {
  const state = await getBatchState();
  const task = batchTask(state);
  if (state.status === "running" && state.workerTabId === tabId && task?.status === "detecting") {
    queueBatchAdvance();
  }
}

async function savePageMetadata(tabId, metadata, senderPageUrl = "", senderDocumentId = "") {
  const pageScope = pageScopeFromUrl(metadata.pageUrl);
  const senderScope = pageScopeFromUrl(senderPageUrl);
  const knownState = await initializeTabPageState(tabId);
  if (knownState.scope && knownState.scope !== pageScope && senderScope !== pageScope) return;
  const state = await activatePageScope(tabId, pageScope);
  if (!state || !isCurrentPage(tabId, pageScope, state.generation)) return;
  const boundState = {
    ...state,
    documentId: typeof senderDocumentId === "string" ? senderDocumentId : ""
  };
  tabPageStates.set(tabId, boundState);
  pageRequestInfoByTab.set(tabId, {
    url: metadata.pageUrl,
    userAgent: typeof metadata.userAgent === "string" ? metadata.userAgent.slice(0, 512) : "",
    scope: pageScope,
    generation: boundState.generation,
    documentId: boundState.documentId
  });
  const current = await getPageInfo(tabId);
  if (!isCurrentPage(tabId, pageScope, boundState.generation)) return;
  await queueTabWrite(tabId, async () => {
    if (!isCurrentPage(tabId, pageScope, boundState.generation)) return;
    await setPageInfo(tabId, {
      url: redactedUrl(metadata.pageUrl),
      title: metadata.pageTitle || current.title || "",
      scope: pageScope,
      generation: boundState.generation,
      updatedAt: new Date().toISOString()
    });
  });
  if (!isCurrentPage(tabId, pageScope, boundState.generation)) return;

  for (const url of metadata.videoUrls || []) {
    if (!isHttpUrl(url)) continue;
    const kind = detectMediaKind(url);
    if (kind) {
      await upsertCandidate(tabId, {
        url,
        kind,
        source: "video element",
        pageScope,
        generation: boundState.generation
      });
    }
  }
  void notifyBatchMetadata(tabId, metadata.pageTitle);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pageMetadata" && sender.tab?.id >= 0) {
    savePageMetadata(sender.tab.id, message, sender.tab.url, sender.documentId).catch(() => undefined);
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

  if (message?.type === "setBatchTasks") {
    setBatchTasks(message)
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getBatchState") {
    getBatchState()
      .then(async (state) => {
        if (state.status === "running" || (state.status === "paused" && batchTask(state)?.status === "downloading")) {
          void advanceBatchQueue();
        }
        sendResponse(state);
      })
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "startBatch") {
    startBatch(message)
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "pauseBatch") {
    pauseBatch()
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "retryBatchTask") {
    retryBatchTask(message.index)
      .then((state) => sendResponse(state))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const updatedUrl = changeInfo.url || tab?.url;
  if (updatedUrl) void activatePageScope(tabId, pageScopeFromUrl(updatedUrl));
  if (changeInfo.status === "complete") {
    void (async () => {
      const state = await getBatchState();
      const task = batchTask(state);
      if (state.status !== "running" || state.workerTabId !== tabId || !task || task.status !== "navigating") return;
      task.status = "detecting";
      task.phaseStartedAt = Date.now();
      await saveBatchState(state);
      queueBatchAdvance();
    })();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabPageStates.delete(tabId);
  clearTabMemory(tabId);
  void chrome.storage.session.remove([candidatesKey(tabId), pageKey(tabId)]);
  void (async () => {
    const state = await getBatchState();
    if (state.status === "running" && state.workerTabId === tabId) {
      state.status = "paused";
      state.workerTabId = null;
      await saveBatchState(state);
    }
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BATCH_ALARM_NAME) void advanceBatchQueue();
});

function restoreBatchQueue() {
  void (async () => {
    const state = await getBatchState();
    if (state.status === "running") {
      await chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 0.5 });
      queueBatchAdvance();
    }
  })();
}

chrome.runtime.onStartup.addListener(restoreBatchQueue);
chrome.runtime.onInstalled.addListener(restoreBatchQueue);
restoreBatchQueue();
