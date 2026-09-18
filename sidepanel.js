const candidatesElement = document.querySelector("#candidates");
const statusElement = document.querySelector("#status");
const pageTitleElement = document.querySelector("#page-title");
const refreshButton = document.querySelector("#refresh");
const downloadArea = document.querySelector("#download-area");
const downloadStatusElement = document.querySelector("#download-status");
const downloadProgress = document.querySelector("#download-progress");
const downloadSizeElement = document.querySelector("#download-size");
const clearDownloadButton = document.querySelector("#clear-download");
const singleTab = document.querySelector("#single-tab");
const batchTab = document.querySelector("#batch-tab");
const singleView = document.querySelector("#single-view");
const batchView = document.querySelector("#batch-view");
const batchFile = document.querySelector("#batch-file");
const batchLinks = document.querySelector("#batch-links");
const parseBatchButton = document.querySelector("#parse-batch");
const batchSummary = document.querySelector("#batch-summary");
const batchList = document.querySelector("#batch-list");
const mediaPreference = document.querySelector("#media-preference");
const batchProgress = document.querySelector("#batch-progress");
const batchCurrent = document.querySelector("#batch-current");
const batchStatus = document.querySelector("#batch-status");
const batchFileProgress = document.querySelector("#batch-file-progress");
const batchSize = document.querySelector("#batch-size");
const startBatchButton = document.querySelector("#start-batch");
const pauseBatchButton = document.querySelector("#pause-batch");
const resumeBatchButton = document.querySelector("#resume-batch");

const labels = {
  mp4: "MP4",
  hls: "HLS · m3u8",
  dash: "DASH · mpd",
  other: "其他媒体"
};
const variantLabels = {
  screen: "屏幕画面",
  speaker: "发言人画面",
  other: "录制视频"
};

let activeDownload = null;
let monitorTimer = null;
let monitorToken = 0;
let pendingFilename = "";
let batchState = null;
let batchMonitorTimer = null;

function activeTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}

function showStatus(message) {
  statusElement.textContent = message;
}

function setMode(mode) {
  const batch = mode === "batch";
  singleView.hidden = batch;
  batchView.hidden = !batch;
  singleTab.classList.toggle("active", !batch);
  batchTab.classList.toggle("active", batch);
  singleTab.setAttribute("aria-selected", String(!batch));
  batchTab.setAttribute("aria-selected", String(batch));
}

function truncateUrl(value, maxLength = 72) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function extractBatchUrlTokens(line) {
  return (line.match(/https?:\/\/[^\s<>"']+/gi) || []).map((value) =>
    value.replace(/[),.;!?，。；！？）】]+$/g, "")
  );
}

function acceptedBatchUrl(value) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname.toLowerCase() === "meeting.tencent.com" &&
      (url.pathname.startsWith("/crm/") || url.pathname.startsWith("/cw/"))
    );
  } catch {
    return false;
  }
}

function parseBatchLinks(text) {
  const items = [];
  const seen = new Set();
  let duplicateCount = 0;
  let invalidCount = 0;

  for (const line of text.split(/\r?\n/)) {
    const tokens = extractBatchUrlTokens(line.trim());
    if (!tokens.length) {
      if (line.trim()) invalidCount += 1;
      continue;
    }
    for (const value of tokens) {
      if (!acceptedBatchUrl(value)) {
        invalidCount += 1;
        continue;
      }
      if (seen.has(value)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(value);
      items.push({ url: value, status: "待处理" });
    }
  }

  return { items, duplicateCount, invalidCount };
}

const batchStatusLabels = {
  pending: "待处理",
  navigating: "正在打开页面",
  detecting: "正在发现 MP4",
  preparing: "正在准备下载上下文",
  downloading: "下载中",
  complete: "已完成",
  failed: "失败"
};

function renderBatchItems(items) {
  batchList.replaceChildren();
  for (const item of items) {
    const row = document.createElement("li");
    const title = item.pageTitle || item.pageUrl || item.url;
    row.textContent = truncateUrl(title);
    row.title = item.pageUrl || item.url || title;
    const state = document.createElement("small");
    const progress = item.status === "downloading" && Number.isFinite(item.progress) ? ` · ${item.progress.toFixed(1)}%` : "";
    const error = item.status === "failed" && item.error ? `：${item.error}` : "";
    state.textContent = `${batchStatusLabels[item.status] || item.status || "待处理"}${progress}${error}`;
    row.append(state);
    if (item.status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-button retry-batch";
      retry.textContent = "重试";
      retry.addEventListener("click", async () => {
        const result = await chrome.runtime.sendMessage({ type: "retryBatchTask", index: item.index });
        if (result?.error) {
          batchSummary.textContent = result.error;
          return;
        }
        renderBatchState(result);
      });
      row.append(retry);
    }
    batchList.append(row);
  }
}

function batchCounts(state) {
  return state.tasks.reduce(
    (counts, task) => {
      counts.total += 1;
      counts[task.status] = (counts[task.status] || 0) + 1;
      return counts;
    },
    { total: 0 }
  );
}

function renderBatchState(state) {
  batchState = state;
  const tasks = state?.tasks || [];
  const counts = batchCounts({ tasks });
  const waiting = (counts.pending || 0) + (counts.navigating || 0) + (counts.detecting || 0) + (counts.preparing || 0) + (counts.downloading || 0);
  const current = tasks[state?.currentIndex] || null;
  batchSummary.textContent = `总数 ${counts.total} · 完成 ${counts.complete || 0} · 失败 ${counts.failed || 0} · 待处理 ${waiting}`;
  renderBatchItems(tasks);

  batchProgress.hidden = !current;
  if (current) {
    batchCurrent.textContent = `当前第 ${current.index + 1} / ${counts.total}`;
    batchStatus.textContent = `${batchStatusLabels[current.status] || current.status}${current.filename ? `：${current.filename}` : current.pageTitle ? `：${current.pageTitle}` : ""}`;
    const totalBytes = Number.isFinite(current.totalBytes) ? current.totalBytes : null;
    if (totalBytes !== null && current.status === "downloading") {
      const progress = Number.isFinite(current.progress) ? current.progress : 0;
      batchFileProgress.hidden = false;
      batchFileProgress.value = progress;
      batchSize.textContent = `${formatBytes(Number(current.bytes) || 0)} / ${formatBytes(totalBytes)} · ${progress.toFixed(1)}%`;
    } else {
      batchFileProgress.hidden = true;
      batchSize.textContent = current.status === "downloading" ? `已下载 ${formatBytes(Number(current.bytes) || 0)}` : "";
    }
  }

  mediaPreference.value = ["auto", "screen", "speaker"].includes(state?.mediaPreference) ? state.mediaPreference : "auto";
  startBatchButton.hidden = state?.status === "running";
  pauseBatchButton.hidden = state?.status !== "running";
  resumeBatchButton.hidden = state?.status !== "paused";
  startBatchButton.textContent = state?.status === "completed" ? "重新开始批量下载" : "开始批量下载";
  if (state?.status === "paused" && !current?.taskId) {
    batchStatus.textContent = "批量已暂停。";
  }
}

function stopBatchMonitoring() {
  if (batchMonitorTimer) clearTimeout(batchMonitorTimer);
  batchMonitorTimer = null;
}

function monitorBatchState() {
  stopBatchMonitoring();
  const poll = async () => {
    try {
      const state = await chrome.runtime.sendMessage({ type: "getBatchState" });
      if (!state?.error) renderBatchState(state);
      if (state?.status === "running" || state?.tasks?.[state.currentIndex]?.status === "downloading") {
        batchMonitorTimer = setTimeout(poll, 800);
      }
    } catch {
      batchMonitorTimer = setTimeout(poll, 1000);
    }
  };
  void poll();
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "0 B";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(unit >= 1 ? 1 : 0)} ${units[unit]}`;
}

function isTerminal(status) {
  return ["complete", "failed"].includes(status?.status);
}

function downloadLabel(status) {
  if (status.message) return status.message;
  if (status.serviceError) return status.serviceError;
  if (status.status === "complete") return `下载完成：${status.filename || "MP4 文件"}`;
  if (status.status === "failed") return `下载失败：${status.error || "本地下载器报告失败。"}`;
  if (status.status === "preparing") return "正在准备下载上下文…";
  if (status.status === "queued") return "下载已开始";
  if (status.status === "connecting") return "正在连接本地下载器…";
  if (status.status === "submitting") return "正在提交任务…";
  return `下载中：${status.filename || "MP4 文件"}`;
}

function renderDownload(status) {
  activeDownload = status?.taskId ? status : activeDownload;
  if (!status) {
    downloadArea.hidden = true;
    downloadStatusElement.textContent = "";
    downloadSizeElement.textContent = "";
    downloadProgress.hidden = true;
    clearDownloadButton.hidden = true;
    return;
  }

  downloadArea.hidden = false;
  downloadStatusElement.textContent = downloadLabel(status);
  clearDownloadButton.hidden = !isTerminal(status);

  const bytes = Number(status.bytes) || 0;
  const totalBytes = Number.isFinite(status.totalBytes) ? status.totalBytes : null;
  if (totalBytes !== null) {
    const progress = Number.isFinite(status.progress)
      ? Math.min(100, Math.max(0, status.progress))
      : Math.min(100, (bytes / Math.max(totalBytes, 1)) * 100);
    downloadProgress.hidden = false;
    downloadProgress.value = progress;
    downloadSizeElement.textContent = `${formatBytes(bytes)} / ${formatBytes(totalBytes)} · ${progress.toFixed(1)}%`;
  } else {
    downloadProgress.hidden = true;
    downloadSizeElement.textContent = `已下载 ${formatBytes(bytes)}`;
  }
}

function formatContextPresence(context = {}) {
  const item = (label, present) => `${label} ${present ? "✓" : "—"}`;
  return [
    item("Referer", context.referer),
    item("Origin", context.origin),
    item("Accept", context.accept),
    item("Range", context.range),
    item("Cookie", context.cookie)
  ].join(" · ");
}

function stopMonitoring() {
  monitorToken += 1;
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
}

function monitorLocalDownload(taskId) {
  stopMonitoring();
  const token = monitorToken;

  const poll = async () => {
    if (token !== monitorToken) return;
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "getLocalDownloadStatus", taskId });
    } catch {
      result = { error: "service-unavailable" };
    }
    if (token !== monitorToken) return;

    if (result?.error) {
      renderDownload({
        ...(activeDownload || { taskId, filename: "MP4 文件", status: "downloading", bytes: 0 }),
        serviceError: "本地下载器已停止，无法获取当前任务状态。"
      });
      monitorTimer = setTimeout(poll, 1000);
      return;
    }

    activeDownload = { ...(activeDownload || {}), ...result };
    renderDownload(activeDownload);
    if (isTerminal(result)) return;
    monitorTimer = setTimeout(poll, 700);
  };

  void poll();
}

async function restoreActiveDownload() {
  const result = await chrome.runtime.sendMessage({ type: "getActiveDownload" });
  if (!result) return;
  activeDownload = result;
  renderDownload(result);
  if (!isTerminal(result)) monitorLocalDownload(result.taskId);
}

function createCandidateCard(candidate, pageTitle, tabId) {
  const card = document.createElement("article");
  card.className = "candidate";

  const heading = document.createElement("div");
  heading.className = "candidate-heading";
  const type = document.createElement("strong");
  const mediaLabel = labels[candidate.kind] || labels.other;
  const variantLabel = candidate.kind === "mp4" ? variantLabels[candidate.variant] || variantLabels.other : "";
  type.textContent = variantLabel ? `${mediaLabel} · ${variantLabel}` : mediaLabel;
  heading.append(type);

  if (candidate.kind === "mp4") {
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载 MP4";
    download.addEventListener("click", async () => {
      download.disabled = true;
      pendingFilename = `${pageTitle || "media"}.mp4`;
      renderDownload({ status: "preparing", filename: pendingFilename, bytes: 0 });
      try {
        const health = await chrome.runtime.sendMessage({ type: "checkLocalDownloader" });
        if (!health?.ok) {
          renderDownload({
            status: "failed",
            filename: pendingFilename,
            bytes: 0,
            error: health?.error || "本地下载器未启动，请先运行 local_downloader.py"
          });
          return;
        }

        const result = await chrome.runtime.sendMessage({
          type: "downloadMp4",
          candidateId: candidate.id,
          contentType: candidate.contentType,
          pageTitle,
          tabId
        });
        if (result?.error) {
          renderDownload({
            status: "failed",
            filename: result.filename || pendingFilename,
            bytes: 0,
            error: result.error
          });
          return;
        }

        activeDownload = {
          taskId: result.taskId,
          filename: result.filename,
          status: result.status || "queued",
          bytes: 0,
          totalBytes: null,
          progress: null
        };
        pendingFilename = result.filename || pendingFilename;
        renderDownload(activeDownload);
        monitorLocalDownload(result.taskId);
      } catch (error) {
        renderDownload({
          status: "failed",
          filename: pendingFilename,
          bytes: 0,
          error: error.message || "本地下载器通信失败。"
        });
      } finally {
        download.disabled = false;
      }
    });
    heading.append(download);
  }

  const filename = document.createElement("strong");
  filename.className = "media-filename";
  filename.textContent = candidate.mediaFilename || candidate.url;
  filename.title = candidate.mediaFilename || candidate.url;

  const url = document.createElement("code");
  url.textContent = candidate.url;
  url.title = candidate.url;

  const details = document.createElement("p");
  const source = candidate.sources?.join("、") || "未知来源";
  details.textContent = `${source}${candidate.contentType ? ` · ${candidate.contentType}` : ""}`;

  const context = document.createElement("p");
  context.className = "context-diagnostic";
  context.textContent = `请求上下文：${formatContextPresence(candidate.context)}`;

  card.append(heading, filename, url, details, context);
  return card;
}

function renderCandidates(candidates, pageTitle, tabId) {
  candidatesElement.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "尚未捕获到媒体资源。请播放视频后点击刷新。";
    candidatesElement.append(empty);
    return;
  }
  for (const candidate of candidates) {
    candidatesElement.append(createCandidateCard(candidate, pageTitle, tabId));
  }
}

async function refresh() {
  refreshButton.disabled = true;
  showStatus("正在检查当前页面…");
  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("无法读取当前页面。");

    await chrome.tabs.sendMessage(tab.id, { type: "scanPageMedia" }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const result = await chrome.runtime.sendMessage({ type: "getCandidates", tabId: tab.id });
    if (result?.error) throw new Error(result.error);
    const pageTitle = result.page?.title || tab.title || "当前页面";
    pageTitleElement.textContent = pageTitle;
    renderCandidates(result.candidates || [], pageTitle, tab.id);
    showStatus(result.candidates?.length ? `已找到 ${result.candidates.length} 个候选资源。` : "未发现可识别的媒体请求。");
    await restoreActiveDownload();
  } catch (error) {
    pageTitleElement.textContent = "当前页面不可读取";
    renderCandidates([], "", null);
    showStatus(error.message || "读取失败。");
  } finally {
    refreshButton.disabled = false;
  }
}

clearDownloadButton.addEventListener("click", async () => {
  stopMonitoring();
  await chrome.runtime.sendMessage({ type: "clearActiveDownload" });
  activeDownload = null;
  renderDownload(null);
  showStatus("已清除下载记录；不会中止本地下载。");
});

singleTab.addEventListener("click", () => setMode("single"));
batchTab.addEventListener("click", () => setMode("batch"));

batchFile.addEventListener("change", async () => {
  const file = batchFile.files?.[0];
  if (!file) return;
  try {
    batchLinks.value = await file.text();
    batchSummary.textContent = "TXT 已载入，请点击“解析链接”。";
  } catch {
    batchSummary.textContent = "TXT 读取失败，请确认文件是 UTF-8 文本。";
  }
});

parseBatchButton.addEventListener("click", async () => {
  const result = parseBatchLinks(batchLinks.value);
  const state = await chrome.runtime.sendMessage({ type: "setBatchTasks", items: result.items });
  if (state?.error) {
    batchSummary.textContent = state.error;
    return;
  }
  renderBatchState(state);
  batchSummary.textContent = `已识别 ${result.items.length} 条 · 重复 ${result.duplicateCount} 条 · 无效 ${result.invalidCount} 条`;
});

startBatchButton.addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "startBatch", mediaPreference: mediaPreference.value });
  if (state?.error) {
    batchSummary.textContent = state.error;
    return;
  }
  renderBatchState(state);
  monitorBatchState();
});

pauseBatchButton.addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "pauseBatch" });
  if (!state?.error) renderBatchState(state);
});

resumeBatchButton.addEventListener("click", async () => {
  const state = await chrome.runtime.sendMessage({ type: "startBatch", mediaPreference: mediaPreference.value });
  if (state?.error) {
    batchSummary.textContent = state.error;
    return;
  }
  renderBatchState(state);
  monitorBatchState();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "downloadPreparation") {
    void activeTab().then((tab) => {
      if (tab?.id === message.tabId) {
        renderDownload({ status: message.stage, filename: pendingFilename || "MP4 文件", bytes: 0 });
      }
    });
  }
  if (message?.type === "pageScopeChanged") {
    void activeTab().then((tab) => {
      if (tab?.id === message.tabId) void refresh();
    });
  }
  if (message?.type === "batchStateChanged") {
    void chrome.runtime.sendMessage({ type: "getBatchState" }).then((state) => {
      if (!state?.error) renderBatchState(state);
    });
  }
});

refreshButton.addEventListener("click", refresh);
void chrome.runtime.sendMessage({ type: "getBatchState" }).then((state) => {
  if (!state?.error) {
    renderBatchState(state);
    if (state.status === "running" || state.tasks?.[state.currentIndex]?.status === "downloading") monitorBatchState();
  }
});
void refresh();
