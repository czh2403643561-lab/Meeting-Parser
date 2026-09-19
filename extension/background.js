importScripts("title_utils.js");

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
const BATCH_DRAFT_KEY = "batchDraft";
const BATCH_STATE_KEY = "batchState";
const BATCH_LOG_KEY = "batchEventLog";
const BATCH_SESSION_KEY = "batchBrowserSessionActive";
const NATIVE_HOST_NAME = "com.meetingparser.helper";
const RELEASE_SETUP_URL = "https://github.com/czh2403643561-lab/Meeting-Parser/releases/latest/download/MeetingParserSetup.exe";
const MIN_COMPANION_VERSION = "0.6.0";
const MAX_BATCH_LOGS = 300;
const BATCH_ALARM_NAME = "batchDownloadTick";
const PAGE_LOAD_TIMEOUT_MS = 30 * 1000;
const MEDIA_DETECT_TIMEOUT_MS = 20 * 1000;
const TRANSCRIPT_EXTRACT_TIMEOUT_MS = 3 * 60 * 1000;
const candidateIdsByUrl = new Map();
const candidateUrlsById = new Map();
const tabPageStates = new Map();
const pageRequestInfoByTab = new Map();
let batchAdvancing = false;
let batchLogQueue = Promise.resolve();
let localDownloaderStarting = null;
let localDownloaderState = "checking";
let keepAwakeRequested = false;
let nativePort = null;
let nativeHelloPromise = null;
let nativeHelloWaiter = null;
const nativeDownloadStates = new Map();
const nativePendingStarts = new Map();
const nativePendingTools = new Map();
let companionInstallationMode = false;
let companionInstallProbeArmed = false;
let lastCompanionProbeAt = 0;

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
  return normalizeFilenamePart(value, "");
}

function filenameForDownload(url, recordingTitle, pageTitle) {
  let filePart = "";
  try {
    filePart = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  } catch {
    filePart = "";
  }
  filePart = safeFilenamePart(filePart).replace(/\.mp4$/i, "");
  const title = normalizeRecordingTitle(recordingTitle) || normalizeRecordingTitle(pageTitle);
  return `${safeFilenamePart(title || filePart || "media") || "media"}.mp4`;
}

function setLocalDownloaderState(state) {
  if (localDownloaderState === state) return;
  localDownloaderState = state;
  void chrome.runtime.sendMessage({ type: "localDownloaderStateChanged", state }).catch(() => undefined);
}

function versionAtLeast(actual, required) {
  const parse = (value) => String(value || "").split(".").map((part) => Number.parseInt(part, 10));
  const actualParts = parse(actual);
  const requiredParts = parse(required);
  if (actualParts.some((part) => !Number.isInteger(part)) || requiredParts.some((part) => !Number.isInteger(part))) return false;
  for (let index = 0; index < requiredParts.length; index += 1) {
    const left = actualParts[index] || 0;
    const right = requiredParts[index] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

function nativeHostMissing(error) {
  return /native messaging host|host.*not found|未找到|找不到/i.test(error?.message || "");
}

function nativeTaskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/.test(value);
}

function nativeDisconnectError(message = "") {
  return new Error(message || "本地下载组件连接已中断，当前任务未自动重试。");
}

function handleNativeMessage(message) {
  if (message?.type === "hello") {
    nativeHelloWaiter?.resolve(message);
    nativeHelloWaiter = null;
    return;
  }
  if (nativeHelloWaiter) {
    nativeHelloWaiter.reject(new Error("检测到旧版本地组件。"));
    nativeHelloWaiter = null;
    return;
  }
  if (message?.type === "toolStatus" && nativeTaskId(message.requestId)) {
    const pending = nativePendingTools.get(message.requestId);
    if (!pending) return;
    nativePendingTools.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.status === "launched") pending.resolve({ ok: true });
    else pending.reject(new Error(message.error || "本地工具启动失败。"));
    return;
  }
  if (message?.type !== "downloadStatus" || !nativeTaskId(message.requestId)) return;
  const state = {
    taskId: message.requestId,
    status: message.status || "failed",
    filename: message.filename || "",
    bytes: Number(message.bytes) || 0,
    totalBytes: Number.isFinite(message.totalBytes) ? Number(message.totalBytes) : null,
    progress: Number.isFinite(message.progress) ? Number(message.progress) : null,
    error: typeof message.error === "string" ? message.error : ""
  };
  nativeDownloadStates.set(state.taskId, state);
  void updateActiveDownloadStatus(state.taskId, state);
  void chrome.runtime.sendMessage({ type: "localDownloadStatusChanged", status: state }).catch(() => undefined);
  const pending = nativePendingStarts.get(state.taskId);
  if (pending) {
    nativePendingStarts.delete(state.taskId);
    clearTimeout(pending.timer);
    pending.resolve(state);
  }
  if (["complete", "failed"].includes(state.status)) void chrome.runtime.sendMessage({ type: "localDownloaderStateChanged", state: "ready" }).catch(() => undefined);
}

function handleNativeDisconnect(disconnectMessage = "") {
  nativePort = null;
  nativeHelloPromise = null;
  nativeHelloWaiter?.reject(nativeDisconnectError(disconnectMessage));
  nativeHelloWaiter = null;
  for (const [taskId, pending] of nativePendingStarts) {
    clearTimeout(pending.timer);
    pending.reject(nativeDisconnectError(disconnectMessage));
    nativePendingStarts.delete(taskId);
  }
  for (const [requestId, pending] of nativePendingTools) {
    clearTimeout(pending.timer);
    pending.reject(nativeDisconnectError(disconnectMessage));
    nativePendingTools.delete(requestId);
  }
  for (const [taskId, state] of nativeDownloadStates) {
    if (["complete", "failed"].includes(state.status)) continue;
    const failed = { ...state, status: "failed", error: "本地下载组件连接中断，当前任务未自动重试。" };
    nativeDownloadStates.set(taskId, failed);
    void updateActiveDownloadStatus(taskId, failed);
  }
  if (!companionInstallationMode) setLocalDownloaderState("unavailable");
}

function connectNativePort() {
  if (nativePort) return nativePort;
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener(handleNativeMessage);
  port.onDisconnect.addListener(() => handleNativeDisconnect(chrome.runtime.lastError?.message || ""));
  return port;
}

function requestNativeHello(port) {
  if (nativeHelloPromise) return nativeHelloPromise;
  nativeHelloPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativeHelloWaiter = null;
      reject(new Error("本地下载组件没有响应。"));
    }, 3000);
    nativeHelloWaiter = {
      resolve: (message) => {
        clearTimeout(timer);
        resolve(message);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    };
    try {
      port.postMessage({ type: "hello" });
    } catch (error) {
      clearTimeout(timer);
      nativeHelloWaiter = null;
      reject(error);
    }
  }).finally(() => {
    nativeHelloPromise = null;
  });
  return nativeHelloPromise;
}

function disconnectNativePort() {
  const port = nativePort;
  nativePort = null;
  nativeHelloPromise = null;
  nativeHelloWaiter = null;
  if (port) {
    try {
      port.disconnect();
    } catch {
      // The port may already be disconnected.
    }
  }
}

async function ensureLocalDownloader() {
  if (companionInstallationMode && !companionInstallProbeArmed) {
    setLocalDownloaderState("waiting-install");
    return { ok: false, state: "waiting-install" };
  }
  if (companionInstallProbeArmed && Date.now() - lastCompanionProbeAt < 8000) {
    return { ok: false, state: "waiting-install" };
  }
  if (nativePort && localDownloaderState === "ready") return { ok: true, state: "ready" };
  if (localDownloaderStarting) return localDownloaderStarting;

  localDownloaderStarting = (async () => {
    setLocalDownloaderState("starting");
    lastCompanionProbeAt = Date.now();
    let response;
    try {
      const port = connectNativePort();
      response = await requestNativeHello(port);
    } catch (error) {
      disconnectNativePort();
      const missing = nativeHostMissing(error);
      const oldVersion = /旧版本/.test(error?.message || "");
      setLocalDownloaderState(missing ? "not-installed" : oldVersion ? "update-required" : "unavailable");
      throw new Error(
        missing ? "本地组件尚未安装，请先完成一次安装。" : oldVersion ? "本地组件需要更新，请下载安装程序。" : "本地组件启动失败，请稍后重试。"
      );
    }
    const version = typeof response?.version === "string" ? response.version : "";
    if (response?.type !== "hello" || !versionAtLeast(version, MIN_COMPANION_VERSION)) {
      disconnectNativePort();
      setLocalDownloaderState("update-required");
      throw new Error("本地组件需要更新，请下载安装程序。");
    }
    companionInstallationMode = false;
    companionInstallProbeArmed = false;
    setLocalDownloaderState("ready");
    return { ok: true, state: "ready", version };
  })();

  try {
    return await localDownloaderStarting;
  } finally {
    localDownloaderStarting = null;
  }
}

async function checkLocalDownloader() {
  try {
    return await ensureLocalDownloader();
  } catch (error) {
    return { ok: false, error: error.message, state: localDownloaderState };
  }
}

async function openLocalTool() {
  const health = await ensureLocalDownloader();
  if (!health.ok || !nativePort) throw new Error("本地组件暂时不可用，请先完成安装。");
  const requestId = globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativePendingTools.delete(requestId);
      reject(new Error("本地工具启动响应超时。"));
    }, 5000);
    nativePendingTools.set(requestId, { resolve, reject, timer });
  });
  try {
    nativePort.postMessage({ type: "openTool", requestId });
  } catch (error) {
    const pending = nativePendingTools.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      nativePendingTools.delete(requestId);
      pending.reject(error);
    }
  }
  return result;
}

async function startNativeDownload(payload) {
  const health = await ensureLocalDownloader();
  if (!health.ok || !nativePort) throw new Error("本地下载组件暂时不可用。");
  const requestId = globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const firstStatus = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      nativePendingStarts.delete(requestId);
      reject(new Error("本地下载组件响应超时。"));
    }, 10000);
    nativePendingStarts.set(requestId, { resolve, reject, timer });
  });
  try {
    nativePort.postMessage({ type: "startDownload", requestId, ...payload });
  } catch (error) {
    const pending = nativePendingStarts.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      nativePendingStarts.delete(requestId);
      pending.reject(error);
    }
  }
  const status = await firstStatus;
  if (status.status === "failed") throw new Error(status.error || "本地下载失败。");
  return status;
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
  await ensureLocalDownloader();
  notifyDownloadStage(message.tabId, message.candidateId, "submitting");
  const result = await startNativeDownload({
    url,
    filename: message.filename || filenameForDownload(url, message.recordingTitle, message.pageTitle),
    headers: localDownloadHeaders(context)
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
  if (!nativeTaskId(taskId)) {
    throw new Error("本地下载任务编号无效。");
  }
  const status = nativeDownloadStates.get(taskId);
  if (!status) throw new Error("本地下载任务状态暂不可用。");
  return status;
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
      serviceError: "本地下载组件连接已中断，当前任务未自动重试。"
    };
  }
}

async function clearActiveDownload() {
  await chrome.storage.session.remove(ACTIVE_DOWNLOAD_KEY);
  return { ok: true };
}

async function checkCompanionSetupAvailability() {
  if (!RELEASE_SETUP_URL) {
    return { ok: false, state: "not-published" };
  }

  try {
    const response = await fetch(RELEASE_SETUP_URL, {
      method: "HEAD",
      redirect: "follow",
      cache: "no-store"
    });
    if (response.status === 404) {
      return { ok: false, state: "not-published" };
    }
    if (!response.ok) {
      return { ok: false, state: "network-unavailable" };
    }
    if (response.headers.get("content-length") === "0") {
      return { ok: false, state: "not-published" };
    }
    return {
      ok: true,
      url: RELEASE_SETUP_URL,
      filename: "MeetingParserSetup.exe"
    };
  } catch {
    return { ok: false, state: "network-unavailable" };
  }
}

async function beginCompanionUpdate() {
  const activeResult = await chrome.storage.session.get(ACTIVE_DOWNLOAD_KEY);
  const active = activeResult[ACTIVE_DOWNLOAD_KEY];
  const batch = await getBatchState();
  const batchTaskState = batchTask(batch)?.status;
  if (["queued", "connecting", "downloading"].includes(active?.status) || batch.status === "running" || batchTaskState === "downloading") {
    throw new Error("当前有下载任务正在进行，请等待完成后再更新本地组件。");
  }
  companionInstallationMode = true;
  companionInstallProbeArmed = false;
  disconnectNativePort();
  setLocalDownloaderState("waiting-install");
  return { ok: true, state: "waiting-install" };
}

function armCompanionInstallProbe() {
  companionInstallProbeArmed = true;
  lastCompanionProbeAt = 0;
  return { ok: true };
}

function emptyBatchState() {
  return {
    status: "idle",
    workerTabId: null,
    currentIndex: 0,
    startedAt: "",
    taskType: "video",
    mediaPreference: "auto",
    transcriptExportMode: "hierarchical",
    transcriptOutputDirectory: "",
    transcriptOutputFile: "",
    statusMessage: "",
    error: "",
    tasks: []
  };
}

function safeBatchLogText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted URL]")
    .replace(/(cookie|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 240);
}

function persistedBatchTask(task, index) {
  return {
    index,
    pageUrl: typeof task?.pageUrl === "string" ? task.pageUrl : "",
    status: typeof task?.status === "string" ? task.status : "pending",
    pageTitle: typeof task?.pageTitle === "string" ? task.pageTitle.slice(0, 240) : "",
    recordingTitle: typeof task?.recordingTitle === "string" ? task.recordingTitle.slice(0, MAX_RECORDING_TITLE_LENGTH) : "",
    filename: typeof task?.filename === "string" ? task.filename.slice(0, 240) : "",
    transcriptText: typeof task?.transcriptText === "string" ? task.transcriptText.slice(0, 2000000) : "",
    paragraphCount: Number.isFinite(task?.paragraphCount) ? Math.max(0, Number(task.paragraphCount)) : 0,
    textLength: Number.isFinite(task?.textLength) ? Math.max(0, Number(task.textLength)) : 0,
    transcriptProgressBucket: Number.isFinite(task?.transcriptProgressBucket) ? Number(task.transcriptProgressBucket) : -1,
    taskId: nativeTaskId(task?.taskId) ? task.taskId : "",
    bytes: Number.isFinite(task?.bytes) ? Math.max(0, Number(task.bytes)) : 0,
    totalBytes: Number.isFinite(task?.totalBytes) ? Math.max(0, Number(task.totalBytes)) : null,
    progress: Number.isFinite(task?.progress) ? Math.max(0, Math.min(100, Number(task.progress))) : null,
    error: safeBatchLogText(task?.error || ""),
    phaseStartedAt: Number.isFinite(task?.phaseStartedAt) ? Number(task.phaseStartedAt) : 0,
    mediaScanLogged: Boolean(task?.mediaScanLogged),
    lastCandidateLogCount: Number.isFinite(task?.lastCandidateLogCount) ? Number(task.lastCandidateLogCount) : -1,
    lastLoggedProgressBucket: Number.isFinite(task?.lastLoggedProgressBucket) ? Number(task.lastLoggedProgressBucket) : -1
  };
}

function persistedBatchState(state) {
  return {
    status: typeof state?.status === "string" ? state.status : "idle",
    workerTabId: Number.isInteger(state?.workerTabId) ? state.workerTabId : null,
    currentIndex: Number.isInteger(state?.currentIndex) ? Math.max(0, state.currentIndex) : 0,
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : "",
    taskType: ["video", "transcript"].includes(state?.taskType) ? state.taskType : "video",
    mediaPreference: ["auto", "screen", "speaker"].includes(state?.mediaPreference) ? state.mediaPreference : "auto",
    transcriptExportMode: ["unified", "hierarchical"].includes(state?.transcriptExportMode) ? state.transcriptExportMode : "hierarchical",
    transcriptOutputDirectory: typeof state?.transcriptOutputDirectory === "string" ? state.transcriptOutputDirectory.slice(0, 240) : "",
    transcriptOutputFile: typeof state?.transcriptOutputFile === "string" ? state.transcriptOutputFile.slice(0, 240) : "",
    statusMessage: safeBatchLogText(state?.statusMessage || ""),
    error: safeBatchLogText(state?.error || ""),
    tasks: Array.isArray(state?.tasks) ? state.tasks.map(persistedBatchTask) : []
  };
}

function persistedBatchDraft(draft) {
  const items = Array.isArray(draft?.items) ? draft.items : [];
  return {
    items: items
      .filter((item) => typeof item?.url === "string" && /^https?:\/\/meeting\.tencent\.com\/(?:crm|cw)\//i.test(item.url))
      .map((item) => ({ url: item.url })),
    duplicateCount: Number.isFinite(draft?.duplicateCount) ? Math.max(0, Number(draft.duplicateCount)) : 0,
    invalidCount: Number.isFinite(draft?.invalidCount) ? Math.max(0, Number(draft.invalidCount)) : 0,
    updatedAt: typeof draft?.updatedAt === "string" ? draft.updatedAt : ""
  };
}

function updateBatchKeepAwake(state) {
  const shouldKeepAwake = state?.status === "running";
  if (shouldKeepAwake && !keepAwakeRequested) {
    chrome.power.requestKeepAwake("system");
    keepAwakeRequested = true;
  } else if (!shouldKeepAwake && keepAwakeRequested) {
    chrome.power.releaseKeepAwake();
    keepAwakeRequested = false;
  }
}

async function appendBatchLog(event, state, message = "", details = {}) {
  const write = batchLogQueue.catch(() => undefined).then(async () => {
    const result = await chrome.storage.session.get(BATCH_LOG_KEY);
    const previous = Array.isArray(result[BATCH_LOG_KEY]) ? result[BATCH_LOG_KEY] : [];
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      batchStatus: state?.status || "idle",
      currentIndex: Number.isInteger(state?.currentIndex) ? state.currentIndex : 0,
      totalTasks: Array.isArray(state?.tasks) ? state.tasks.length : 0,
      taskStatus: batchTask(state)?.status || "",
      workerTabId: Number.isInteger(state?.workerTabId) ? state.workerTabId : null,
      message: safeBatchLogText(message)
    };
    if (Number.isInteger(details.count)) entry.count = details.count;
    if (typeof details.variant === "string") entry.variant = details.variant;
    if (typeof details.mediaFilename === "string") entry.mediaFilename = safeBatchLogText(details.mediaFilename);
    await chrome.storage.session.set({ [BATCH_LOG_KEY]: [...previous, entry].slice(-MAX_BATCH_LOGS) });
    void chrome.runtime.sendMessage({ type: "batchLogChanged" }).catch(() => undefined);
  });
  batchLogQueue = write;
  return write;
}

async function getBatchDraft() {
  let result = await chrome.storage.local.get(BATCH_DRAFT_KEY);
  let draft = result[BATCH_DRAFT_KEY];
  if (!draft) {
    const legacy = await chrome.storage.session.get(BATCH_DRAFT_KEY);
    draft = legacy[BATCH_DRAFT_KEY];
    if (draft) {
      draft = persistedBatchDraft(draft);
      await chrome.storage.local.set({ [BATCH_DRAFT_KEY]: draft });
      await chrome.storage.session.remove(BATCH_DRAFT_KEY);
    }
  }
  return draft && Array.isArray(draft.items)
    ? persistedBatchDraft(draft)
    : { items: [], duplicateCount: 0, invalidCount: 0, updatedAt: "" };
}

async function getBatchState() {
  let result = await chrome.storage.local.get(BATCH_STATE_KEY);
  let saved = result[BATCH_STATE_KEY];
  if (!saved) {
    const legacy = await chrome.storage.session.get(BATCH_STATE_KEY);
    saved = legacy[BATCH_STATE_KEY];
    if (saved) {
      const migrated = persistedBatchState(saved);
      await chrome.storage.local.set({ [BATCH_STATE_KEY]: migrated });
      await chrome.storage.session.remove(BATCH_STATE_KEY);
      saved = migrated;
    }
  }
  if (!saved || !Array.isArray(saved.tasks)) return emptyBatchState();
  return {
    ...emptyBatchState(),
    ...persistedBatchState(saved),
    tasks: saved.tasks.map((task, index) => ({ index, ...persistedBatchTask(task, index) }))
  };
}

async function saveBatchState(state) {
  const saved = persistedBatchState(state);
  updateBatchKeepAwake(saved);
  await chrome.storage.local.set({ [BATCH_STATE_KEY]: saved });
  if (saved.status === "running") await chrome.storage.session.set({ [BATCH_SESSION_KEY]: true });
  void chrome.runtime.sendMessage({ type: "batchStateChanged" }).catch(() => undefined);
}

function batchTask(state) {
  return state.tasks[state.currentIndex] || null;
}

function nextPendingBatchIndex(state) {
  return state.tasks.findIndex((task) => task.status === "pending");
}

function batchFilename(task, candidate) {
  const recordingTitle = normalizeRecordingTitle(task.recordingTitle);
  const pageTitle = normalizeRecordingTitle(task.pageTitle);
  const mediaName = safeFilenamePart((candidate.mediaFilename || "").replace(/\.mp4$/i, ""));
  let pageId = "meeting";
  try {
    pageId = safeFilenamePart(new URL(task.pageUrl).pathname.split("/").filter(Boolean).pop() || "meeting");
  } catch {
    // The batch parser only accepts valid meeting URLs; keep a safe fallback.
  }
  const name = recordingTitle || pageTitle || mediaName || pageId || "meeting";
  return `${String(task.index + 1).padStart(3, "0")} - ${name}.mp4`;
}

function batchPageLabel(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "腾讯会议页面";
  }
}

function transcriptExportTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function transcriptTaskTitle(task) {
  return normalizeRecordingTitle(task.recordingTitle)
    || normalizeRecordingTitle(task.pageTitle)
    || `第${task.index + 1}个视频`;
}

function transcriptFilename(task) {
  return `${safeFilenamePart(transcriptTaskTitle(task)) || `第${task.index + 1}个视频`}.txt`;
}

function transcriptUnifiedFilename(state) {
  return state.transcriptOutputFile || `腾讯会议逐字稿_${transcriptExportTimestamp()}.txt`;
}

function transcriptOutputFolder(state) {
  return state.transcriptOutputDirectory || `腾讯会议逐字稿_${transcriptExportTimestamp()}`;
}

function downloadBatchText(text, filename) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }));
    chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      URL.revokeObjectURL(objectUrl);
      if (error || !Number.isInteger(downloadId)) {
        reject(new Error(error?.message || "TXT 导出失败。"));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function exportTranscriptTask(state, task) {
  if (state.transcriptExportMode !== "hierarchical") return;
  const filename = `${transcriptOutputFolder(state)}/${transcriptFilename(task)}`;
  await downloadBatchText(task.transcriptText, filename);
  task.filename = transcriptFilename(task);
  await appendBatchLog("transcript_exported", state, `已导出：${filename}`);
}

async function finalizeTranscriptExport(state) {
  if (state.taskType !== "transcript") return;
  if (state.transcriptExportMode === "hierarchical") {
    state.transcriptOutputFile = "";
    return;
  }
  const completedTasks = state.tasks.filter((task) => task.status === "complete");
  if (!completedTasks.length) return;
  const content = completedTasks
    .map((task) => `===== 视频${task.index + 1}${transcriptTaskTitle(task)} =====\n\n${task.transcriptText || ""}`)
    .join("\n\n");
  const filename = transcriptUnifiedFilename(state);
  await downloadBatchText(content, filename);
  state.transcriptOutputFile = filename;
  await appendBatchLog("transcript_exported", state, `已导出统一文件：${filename}`);
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
  await appendBatchLog("worker_tab_creating", state, "正在创建工作标签页");
  const tab = await chrome.tabs.create({ url: task.pageUrl, active: false });
  state.workerTabId = tab.id;
  task.status = "navigating";
  task.phaseStartedAt = Date.now();
  state.statusMessage = `正在打开第 ${task.index + 1} / ${state.tasks.length} 条…`;
  await saveBatchState(state);
  await appendBatchLog("worker_tab_created", state, "工作标签页已创建");
  await appendBatchLog("worker_navigating", state, `正在打开第 ${task.index + 1} 条：${batchPageLabel(task.pageUrl)}`);
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
  await appendBatchLog("task_failed", state, error);
  queueBatchAdvance();
}

async function extractBatchTranscript(state, task, workerTabId) {
  if (Date.now() - Number(task.phaseStartedAt || 0) > TRANSCRIPT_EXTRACT_TIMEOUT_MS) {
    return failBatchTask(state, task, "逐字稿提取超时。");
  }

  task.status = "extracting";
  task.phaseStartedAt = Date.now();
  state.statusMessage = `正在采集第 ${task.index + 1} / ${state.tasks.length} 条逐字稿…`;
  await saveBatchState(state);
  await appendBatchLog("transcript_extract_started", state, `开始提取：${batchPageLabel(task.pageUrl)}`);

  try {
    const result = await chrome.tabs.sendMessage(workerTabId, { type: "runBatchTranscript" });
    if (!result?.transcriptFound || typeof result.fullText !== "string" || !result.fullText.trim()) {
      return failBatchTask(state, task, "页面中未找到逐字稿正文。");
    }
    const page = await getPageInfo(workerTabId);
    task.pageTitle = result.pageTitle || page.title || task.pageTitle || "";
    task.recordingTitle = result.recordingTitle || page.recordingTitle || task.recordingTitle || "";
    task.transcriptText = result.fullText.trim();
    task.paragraphCount = Number(result.paragraphCount) || 0;
    task.textLength = task.transcriptText.length;
    await appendBatchLog("transcript_extracted", state, `提取完成：${task.textLength} 字，${task.paragraphCount} 段`);
    await exportTranscriptTask(state, task);
    task.status = "complete";
    task.error = "";
    task.phaseStartedAt = 0;
    state.statusMessage = `第 ${task.index + 1} / ${state.tasks.length} 条逐字稿已完成。`;
    await saveBatchState(state);
    await appendBatchLog("task_complete", state, `逐字稿任务完成：${transcriptTaskTitle(task)}`);
    queueBatchAdvance();
  } catch (error) {
    await failBatchTask(state, task, error?.message || "逐字稿提取失败。");
  }
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
        try {
          await finalizeTranscriptExport(state);
        } catch (error) {
          state.error = safeBatchLogText(error?.message || "统一 TXT 导出失败。");
          state.statusMessage = `批量完成，但导出失败：${state.error}`;
          await saveBatchState(state);
          await appendBatchLog("transcript_export_failed", state, state.error);
        }
        state.status = "completed";
        if (!state.error) {
          const failedCount = state.tasks.filter((item) => item.status === "failed").length;
          state.statusMessage = failedCount ? `批量任务已完成，但有 ${failedCount} 个任务失败。` : "批量任务已完成。";
        }
        await appendBatchLog("queue_complete", state, "全部任务已处理");
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
        const terminal = ["complete", "failed"].includes(task.status);
        const progressBucket = Number.isFinite(task.progress) ? Math.floor(task.progress / 5) : -1;
        const shouldLogProgress = terminal || progressBucket !== task.lastLoggedProgressBucket;
        if (shouldLogProgress) task.lastLoggedProgressBucket = progressBucket;
        await saveBatchState(state);
        if (shouldLogProgress) {
          await appendBatchLog(
            terminal ? (task.status === "complete" ? "task_complete" : "task_failed") : "local_download_progress",
            state,
            task.error || "本地下载状态已更新"
          );
        }
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

    if (state.taskType === "transcript") {
      if (task.status === "detecting" || task.status === "extracting") {
        return extractBatchTranscript(state, task, workerTabId);
      }
      return;
    }

    if (task.status !== "detecting" && task.status !== "preparing") return;
    if (Date.now() - Number(task.phaseStartedAt || 0) > MEDIA_DETECT_TIMEOUT_MS) {
        return failBatchTask(state, task, task.status === "preparing" ? "媒体上下文准备失败。" : "未发现 MP4。");
    }

    state.statusMessage = "正在检测 MP4…";
    await saveBatchState(state);
    if (!task.mediaScanLogged) {
      task.mediaScanLogged = true;
      await appendBatchLog("media_scan", state, "正在扫描媒体资源");
    }
    await chrome.tabs.sendMessage(workerTabId, { type: "scanPageMedia" }).catch(() => undefined);
    const [candidates, page] = await Promise.all([getCandidates(workerTabId), getPageInfo(workerTabId)]);
    task.pageTitle = page.title || task.pageTitle || "";
    task.recordingTitle = page.recordingTitle || task.recordingTitle || "";
    const mp4Count = candidates.filter((candidate) => candidate.kind === "mp4").length;
    if (task.lastCandidateLogCount !== mp4Count) {
      task.lastCandidateLogCount = mp4Count;
      await appendBatchLog("media_candidates_found", state, `发现 ${mp4Count} 个 MP4`, { count: candidates.length });
    }
    const selected = selectBatchCandidate(candidates, state.mediaPreference);
    if (selected.error) return failBatchTask(state, task, selected.error);
    if (!selected.candidate) {
      await saveBatchState(state);
      scheduleBatchTick();
      return;
    }

    await appendBatchLog("media_candidate_selected", state, "已选择 MP4", {
      variant: selected.candidate.variant || "other",
      mediaFilename: selected.candidate.mediaFilename || ""
    });
    task.status = "preparing";
    task.phaseStartedAt = Date.now();
    task.filename = batchFilename(task, selected.candidate);
    state.statusMessage = "正在准备下载…";
    await saveBatchState(state);
    await appendBatchLog("media_prepare_started", state, "正在准备下载上下文");
    if ((await getBatchState()).status !== "running") return;
    try {
      const started = await prepareCandidateAndStartDownload(
        {
          tabId: workerTabId,
          candidateId: selected.candidate.id,
          contentType: selected.candidate.contentType,
          recordingTitle: task.recordingTitle,
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
      state.statusMessage = "下载中…";
      await saveBatchState(state);
      await appendBatchLog("local_download_submitted", state, "已提交本地下载组件");
      queueBatchAdvance();
    } catch (error) {
      await failBatchTask(state, task, error.message === "自动准备失败，请播放视频后重试。" ? "媒体上下文准备失败。" : error.message);
    }
  } catch (error) {
    const state = await getBatchState();
    state.status = "failed";
    state.error = safeBatchLogText(error?.message || "批量调度发生未知错误。");
    state.statusMessage = `启动失败：${state.error}`;
    await saveBatchState(state);
    await appendBatchLog("unexpected_error", state, state.error);
  } finally {
    batchAdvancing = false;
  }
}

async function saveBatchDraft(message) {
  const items = Array.isArray(message.items) ? message.items : [];
  const accepted = items
    .filter((item) => typeof item?.url === "string" && /^https?:\/\/meeting\.tencent\.com\/(?:crm|cw)\//i.test(item.url))
    .map((item) => ({ url: item.url }));
  const draft = {
    items: accepted,
    duplicateCount: Number(message.duplicateCount) || 0,
    invalidCount: Number(message.invalidCount) || 0,
    updatedAt: new Date().toISOString()
  };
  const existing = await getBatchState();
  if (existing.status === "running") throw new Error("批量下载正在运行，不能替换任务列表。");
  await appendBatchLog("batch_parse_received", existing, `前端提交 ${items.length} 条`);
  await chrome.storage.local.set({ [BATCH_DRAFT_KEY]: persistedBatchDraft(draft) });
  await appendBatchLog("batch_draft_saved", existing, `后台接受 ${accepted.length} 条`);
  return { ...draft, acceptedCount: accepted.length };
}

async function startBatch(message) {
  const requestedItems = Array.isArray(message.items) ? message.items : (await getBatchDraft()).items;
  const accepted = requestedItems
    .filter((item) => typeof item?.url === "string" && /^https?:\/\/meeting\.tencent\.com\/(?:crm|cw)\//i.test(item.url))
    .map((item) => item.url);
  const previous = await getBatchState();
  const taskType = ["video", "transcript"].includes(message.taskType) ? message.taskType : previous.taskType || "video";
  const transcriptExportMode = ["unified", "hierarchical"].includes(message.transcriptExportMode)
    ? message.transcriptExportMode
    : previous.transcriptExportMode || "hierarchical";
  await appendBatchLog("batch_start_requested", previous, `请求启动 ${accepted.length} 条`);
  if (!accepted.length) throw new Error("请先解析至少一条腾讯会议链接。");
  if (previous.status === "running") return previous;
  if (previous.status === "paused" && previous.tasks.length) return resumeBatch(message.mediaPreference);
  if (taskType === "video") {
    const health = await checkLocalDownloader();
    if (!health.ok) {
      await appendBatchLog("batch_health_failed", previous, health.error || "本地组件不可用");
      throw new Error(health.error || "本地组件暂时不可用，请稍后重试。");
    }
    await appendBatchLog("batch_health_ok", previous, "本地下载组件已就绪");
  }
  const exportTimestamp = transcriptExportTimestamp();
  const state = {
    ...emptyBatchState(),
    status: "starting",
    startedAt: new Date().toISOString(),
    taskType,
    transcriptExportMode,
    transcriptOutputDirectory: taskType === "transcript" && transcriptExportMode === "hierarchical"
      ? `腾讯会议逐字稿_${exportTimestamp}`
      : "",
    transcriptOutputFile: taskType === "transcript" && transcriptExportMode === "unified"
      ? `腾讯会议逐字稿_${exportTimestamp}.txt`
      : "",
    tasks: accepted.map((pageUrl, index) => ({
      index, pageUrl, status: "pending", pageTitle: "", recordingTitle: "", filename: "", taskId: "", bytes: 0,
      totalBytes: null, progress: null, error: "", transcriptText: "", paragraphCount: 0, textLength: 0
    }))
  };
  state.mediaPreference = ["auto", "screen", "speaker"].includes(message.mediaPreference)
    ? message.mediaPreference
    : previous.mediaPreference || "auto";
  await saveBatchState(state);
  await appendBatchLog("batch_state_created", state, `已创建 ${state.tasks.length} 条执行任务`);
  const verified = await getBatchState();
  if (verified.tasks.length !== accepted.length) {
    await appendBatchLog("unexpected_error", verified, `输入 ${accepted.length} 条，实际保存 ${verified.tasks.length} 条`);
    throw new Error(`批量队列创建失败：输入 ${accepted.length} 条，实际保存 ${verified.tasks.length} 条。`);
  }
  await appendBatchLog("batch_state_verified", verified, `已校验 ${verified.tasks.length} 条任务`);
  verified.status = "running";
  verified.statusMessage = "正在创建工作标签页…";
  await saveBatchState(verified);
  await chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 0.5 });
  await advanceBatchQueue();
  return getBatchState();
}

async function pauseBatch() {
  const state = await getBatchState();
  if (state.status === "running") {
    state.status = "paused";
    state.statusMessage = "批量已暂停。";
    await saveBatchState(state);
    await appendBatchLog("queue_paused", state, "批量已暂停");
  }
  return state;
}

async function resumeBatch(preference) {
  const state = await getBatchState();
  if (state.status !== "paused") return state;
  state.status = "running";
  state.statusMessage = "正在继续批量任务…";
  if (["auto", "screen", "speaker"].includes(preference)) state.mediaPreference = preference;
  await saveBatchState(state);
  await appendBatchLog("queue_resumed", state, "批量任务已继续");
  await chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 0.5 });
  await advanceBatchQueue();
  return getBatchState();
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

async function notifyBatchMetadata(tabId, metadata) {
  const state = await getBatchState();
  const task = batchTask(state);
  if (state.status !== "running" || state.workerTabId !== tabId || !task) return;
  task.pageTitle = metadata.pageTitle || task.pageTitle || "";
  task.recordingTitle = metadata.recordingTitle || task.recordingTitle || "";
  if (task.status === "extracting" || task.status === "complete") return;
  if (task.status === "navigating") {
    task.status = "detecting";
    task.phaseStartedAt = Date.now();
  }
  state.statusMessage = state.taskType === "transcript" ? "页面已加载，准备采集逐字稿…" : "正在检测 MP4…";
  await saveBatchState(state);
  await appendBatchLog("metadata_received", state, state.taskType === "transcript" ? `已收到页面信息：${batchPageLabel(metadata.pageUrl)}` : "已收到页面信息");
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
      recordingTitle: metadata.recordingTitle || current.recordingTitle || "",
      recordingTitleSource: metadata.recordingTitleSource || current.recordingTitleSource || "",
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
  void notifyBatchMetadata(tabId, metadata);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "pageMetadata" && sender.tab?.id >= 0) {
    savePageMetadata(sender.tab.id, message, sender.tab.url, sender.documentId).catch(() => undefined);
    return;
  }

  if (message?.type === "transcriptProgress" && sender.tab?.id >= 0) {
    void (async () => {
      const state = await getBatchState();
      const task = batchTask(state);
      const progress = message.progress || {};
      if (state.status !== "running" || state.taskType !== "transcript" || state.workerTabId !== sender.tab.id || !task) {
        void chrome.runtime.sendMessage({
          type: "transcriptProgress",
          tabId: sender.tab.id,
          progress
        }).catch(() => undefined);
        return;
      }
      task.status = "extracting";
      task.paragraphCount = Math.max(0, Number(progress.paragraphCount) || 0);
      task.textLength = Math.max(0, Number(progress.textLength) || 0);
      state.statusMessage = `正在采集第 ${task.index + 1} / ${state.tasks.length} 条逐字稿：${task.paragraphCount} 段，${task.textLength} 字。`;
      const bucket = Math.floor(task.textLength / 1000);
      const shouldLog = bucket !== task.transcriptProgressBucket;
      task.transcriptProgressBucket = bucket;
      await saveBatchState(state);
      if (shouldLog) await appendBatchLog("transcript_progress", state, state.statusMessage);
      void chrome.runtime.sendMessage({
        type: "transcriptProgress",
        tabId: sender.tab.id,
        progress: {
          stage: progress.stage || "滚动采集中",
          paragraphCount: task.paragraphCount,
          textLength: task.textLength
        }
      }).catch(() => undefined);
    })().catch(() => undefined);
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

  if (message?.type === "openLocalTool") {
    openLocalTool()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "checkCompanionSetupAvailability") {
    checkCompanionSetupAvailability()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, state: "network-unavailable" }));
    return true;
  }

  if (message?.type === "getCompanionSetup") {
    checkCompanionSetupAvailability()
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, state: "network-unavailable" }));
    return true;
  }

  if (message?.type === "beginCompanionUpdate") {
    beginCompanionUpdate()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "armCompanionInstallProbe") {
    sendResponse(armCompanionInstallProbe());
    return;
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
    saveBatchDraft(message)
      .then((draft) => sendResponse(draft))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "saveBatchDraft") {
    saveBatchDraft(message)
      .then((draft) => sendResponse(draft))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getBatchDraft") {
    getBatchDraft()
      .then((draft) => sendResponse(draft))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "getBatchLogs") {
    chrome.storage.session
      .get(BATCH_LOG_KEY)
      .then((result) => sendResponse({ entries: Array.isArray(result[BATCH_LOG_KEY]) ? result[BATCH_LOG_KEY] : [] }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (message?.type === "clearBatchLogs") {
    chrome.storage.session
      .remove(BATCH_LOG_KEY)
      .then(() => sendResponse({ ok: true }))
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

  if (message?.type === "resumeBatch") {
    resumeBatch(message.mediaPreference)
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
      state.statusMessage = state.taskType === "transcript" ? "页面加载完成，准备采集逐字稿…" : "正在检测 MP4…";
      await saveBatchState(state);
      await appendBatchLog("page_loaded", state, state.taskType === "transcript" ? `页面加载完成：${batchPageLabel(tab?.url || task.pageUrl)}` : "页面加载完成");
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

async function recoverInterruptedBatch(state) {
  state.workerTabId = null;
  const current = batchTask(state);
  if (current && current.status === "downloading" && current.taskId) {
    try {
      const download = await getLocalDownloadStatus(current.taskId);
      if (download.status === "complete") {
        Object.assign(current, {
          status: "complete",
          filename: download.filename || current.filename,
          bytes: Number(download.bytes) || current.bytes,
          totalBytes: Number.isFinite(download.totalBytes) ? download.totalBytes : current.totalBytes,
          progress: 100,
          error: ""
        });
      } else if (download.status === "failed") {
        current.status = "failed";
        current.error = safeBatchLogText(download.error || "本地下载失败。");
      } else {
        Object.assign(current, { status: "pending", taskId: "", phaseStartedAt: 0 });
      }
    } catch {
      Object.assign(current, { status: "pending", taskId: "", phaseStartedAt: 0 });
    }
  } else if (current && !["pending", "complete", "failed"].includes(current.status)) {
    Object.assign(current, { status: "pending", taskId: "", phaseStartedAt: 0 });
  }

  const hasUnfinishedTask = state.tasks.some((task) => !["complete", "failed"].includes(task.status));
  state.status = hasUnfinishedTask ? "paused" : "completed";
  state.statusMessage = hasUnfinishedTask ? "发现未完成批量任务，请点击继续。" : "批量任务已完成。";
  await saveBatchState(state);
}

function restoreBatchQueue() {
  void (async () => {
    const state = await getBatchState();
    if (!["running", "starting"].includes(state.status)) {
      updateBatchKeepAwake(state);
      return;
    }
    const session = await chrome.storage.session.get(BATCH_SESSION_KEY);
    if (!session[BATCH_SESSION_KEY]) {
      await recoverInterruptedBatch(state);
      return;
    }
    updateBatchKeepAwake(state);
    await chrome.alarms.create(BATCH_ALARM_NAME, { periodInMinutes: 0.5 });
    queueBatchAdvance();
  })();
}

chrome.runtime.onStartup.addListener(restoreBatchQueue);
chrome.runtime.onInstalled.addListener(restoreBatchQueue);
restoreBatchQueue();
