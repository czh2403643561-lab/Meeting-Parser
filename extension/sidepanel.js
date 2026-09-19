const candidatesElement = document.querySelector("#candidates");
const statusElement = document.querySelector("#status");
const pageTitleElement = document.querySelector("#page-title");
const refreshButton = document.querySelector("#refresh");
const pageDiagnostic = document.querySelector("#page-diagnostic");
const runPageDiagnosticButton = document.querySelector("#run-page-diagnostic");
const diagnosticFeedback = document.querySelector("#diagnostic-feedback");
const diagnosticResults = document.querySelector("#diagnostic-results");
const diagnosticPage = document.querySelector("#diagnostic-page");
const diagnosticVideo = document.querySelector("#diagnostic-video");
const diagnosticStatus = document.querySelector("#diagnostic-status");
const diagnosticTranscript = document.querySelector("#diagnostic-transcript");
const diagnosticParagraphCount = document.querySelector("#diagnostic-paragraph-count");
const diagnosticTextLength = document.querySelector("#diagnostic-text-length");
const diagnosticPreview = document.querySelector("#diagnostic-preview");
const diagnosticActions = document.querySelector("#diagnostic-actions");
const copyTranscriptButton = document.querySelector("#copy-transcript");
const exportTranscriptButton = document.querySelector("#export-transcript");
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
const batchTaskType = document.querySelector("#batch-task-type");
const mediaPreference = document.querySelector("#media-preference");
const mediaPreferenceControl = document.querySelector("#media-preference-control");
const transcriptExportControl = document.querySelector("#transcript-export-control");
const transcriptExportMode = document.querySelector("#transcript-export-mode");
const batchProgress = document.querySelector("#batch-progress");
const batchCurrent = document.querySelector("#batch-current");
const batchStatus = document.querySelector("#batch-status");
const batchFileProgress = document.querySelector("#batch-file-progress");
const batchSize = document.querySelector("#batch-size");
const batchOutputPath = document.querySelector("#batch-output-path");
const startBatchButton = document.querySelector("#start-batch");
const pauseBatchButton = document.querySelector("#pause-batch");
const resumeBatchButton = document.querySelector("#resume-batch");
const batchTotalProgress = document.querySelector("#batch-total-progress");
const batchTotalLabel = document.querySelector("#batch-total-label");
const batchTotalBar = document.querySelector("#batch-total-bar");
const batchTotalCount = document.querySelector("#batch-total-count");
const batchCompleteCount = document.querySelector("#batch-complete-count");
const batchFailedCount = document.querySelector("#batch-failed-count");
const batchPendingCount = document.querySelector("#batch-pending-count");
const batchListCount = document.querySelector("#batch-list-count");
const batchFeedback = document.querySelector("#batch-feedback");
const toggleBatchLogsButton = document.querySelector("#toggle-batch-logs");
const exportBatchLogsButton = document.querySelector("#export-batch-logs");
const clearBatchLogsButton = document.querySelector("#clear-batch-logs");
const batchLogOutput = document.querySelector("#batch-log-output");
const localServiceStatus = document.querySelector("#local-service-status");
const companionOnboarding = document.querySelector("#companion-onboarding");
const installLocalComponentButton = document.querySelector("#install-local-component");
const recheckLocalComponentButton = document.querySelector("#recheck-local-component");
const onboardingFeedback = document.querySelector("#onboarding-feedback");
const onboardingTitle = document.querySelector("#onboarding-title");
const onboardingDescription = document.querySelector("#onboarding-description");

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
let batchDraft = { items: [], duplicateCount: 0, invalidCount: 0 };
let batchMonitorTimer = null;
let localComponentState = "checking";
let setupPollTimer = null;
let setupPollDeadline = 0;
let setupDownloadInProgress = false;
const setupDownloadWaiters = new Map();
let onboardingNeedsUpdate = false;
const COLLAPSE_STATE_KEY = "sidePanelCollapseState";
let collapseState = {};
let latestTranscript = null;
let diagnosticTabId = null;

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    const waiter = setupDownloadWaiters.get(delta.id);
    if (!waiter) return;
    if (delta.state?.current === "complete") {
      setupDownloadWaiters.delete(delta.id);
      waiter.resolve();
    } else if (delta.state?.current === "interrupted") {
      setupDownloadWaiters.delete(delta.id);
      waiter.reject(new Error("安装程序下载失败，请重新下载。"));
    }
  });
}

function activeTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}

function showStatus(message) {
  statusElement.textContent = message;
}

function showBatchFeedback(message) {
  batchFeedback.textContent = message || "";
}

function renderLocalServiceStatus(state) {
  const messages = {
    ready: "本地下载组件已就绪",
    checking: "正在检查本地组件…",
    starting: "正在启动本地下载组件…",
    "not-installed": "需要安装本地组件",
    "update-required": "本地组件需要更新",
    "waiting-install": "正在等待安装完成…",
    unavailable: "本地组件启动失败"
  };
  const normalized = messages[state] ? state : "unavailable";
  localComponentState = normalized;
  localServiceStatus.dataset.state = normalized;
  localServiceStatus.textContent = messages[normalized];
  if (normalized === "not-installed") onboardingNeedsUpdate = false;
  if (normalized === "update-required") onboardingNeedsUpdate = true;
  const onboardingVisible = ["not-installed", "update-required", "waiting-install"].includes(normalized);
  companionOnboarding.hidden = !onboardingVisible;
  onboardingTitle.textContent = onboardingNeedsUpdate ? "本地组件需要更新" : "首次使用准备";
  onboardingDescription.textContent = onboardingNeedsUpdate
    ? "当前本地组件版本较旧，需要更新一次，之后会自动启动。"
    : "需要安装一个本地下载组件来保存视频。只需安装一次，之后会自动启动。";
  if (["not-installed", "update-required"].includes(normalized) && !setupPollTimer && !setupDownloadInProgress) {
    installLocalComponentButton.hidden = false;
    installLocalComponentButton.disabled = false;
    installLocalComponentButton.textContent = onboardingNeedsUpdate ? "更新本地组件" : "安装本地组件";
    recheckLocalComponentButton.hidden = true;
    onboardingFeedback.textContent = "";
  }
  updateDownloadControls();
}

function updateDownloadControls() {
  const ready = localComponentState === "ready";
  document.querySelectorAll(".download-candidate").forEach((button) => {
    button.disabled = !ready;
  });
  if (!startBatchButton.dataset.busy) startBatchButton.disabled = !ready;
}

async function refreshLocalServiceStatus() {
  renderLocalServiceStatus("checking");
  try {
    const result = await chrome.runtime.sendMessage({ type: "checkLocalDownloader" });
    renderLocalServiceStatus(result?.ok ? "ready" : result?.state || "unavailable");
    return result;
  } catch {
    renderLocalServiceStatus("unavailable");
    return { ok: false, state: "unavailable" };
  }
}

function stopSetupPolling() {
  if (setupPollTimer) clearTimeout(setupPollTimer);
  setupPollTimer = null;
  setupPollDeadline = 0;
}

function downloadSetupFile(info) {
  return new Promise((resolve, reject) => {
    if (!chrome.downloads?.download || !info?.url) {
      reject(new Error("暂未配置安装程序下载地址。"));
      return;
    }
    chrome.downloads.download({
      url: info.url,
      filename: info.filename || "MeetingParserSetup.exe",
      saveAs: false,
      conflictAction: "uniquify"
    }, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error("安装程序下载失败，请重新下载。"));
        return;
      }

      const finish = (callback) => {
        setupDownloadWaiters.delete(downloadId);
        callback();
      };
      setupDownloadWaiters.set(downloadId, {
        resolve: () => finish(resolve),
        reject: () => finish(() => reject(new Error("安装程序下载失败，请重新下载。")))
      });
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (chrome.runtime.lastError || !results?.[0]) return;
        const state = results[0].state;
        if (state === "complete") {
          setupDownloadWaiters.get(downloadId)?.resolve();
        } else if (state === "interrupted") {
          setupDownloadWaiters.get(downloadId)?.reject();
        }
      });
    });
  });
}

async function pollForCompanionInstallation() {
  if (Date.now() >= setupPollDeadline) {
    stopSetupPolling();
    setupDownloadInProgress = false;
    renderLocalServiceStatus(onboardingNeedsUpdate ? "update-required" : "not-installed");
    installLocalComponentButton.hidden = false;
    installLocalComponentButton.disabled = false;
    installLocalComponentButton.textContent = "重新下载安装程序";
    recheckLocalComponentButton.hidden = false;
    onboardingFeedback.textContent = "暂未检测到安装完成，可重新检测或重新下载安装程序。";
    return;
  }

  const result = await refreshLocalServiceStatus();
  if (result?.ok) {
    stopSetupPolling();
    setupDownloadInProgress = false;
    companionOnboarding.hidden = false;
    onboardingTitle.textContent = "环境已准备好";
    onboardingDescription.textContent = "本地下载组件已安装完成，之后会自动启动。";
    installLocalComponentButton.hidden = true;
    recheckLocalComponentButton.hidden = true;
    onboardingFeedback.textContent = "环境已准备好。";
    setTimeout(() => {
      if (localComponentState === "ready") companionOnboarding.hidden = true;
    }, 4000);
    return;
  }

  setupDownloadInProgress = true;
  renderLocalServiceStatus("waiting-install");
  installLocalComponentButton.disabled = true;
  installLocalComponentButton.textContent = "安装程序已下载";
  recheckLocalComponentButton.hidden = true;
  onboardingFeedback.textContent = "安装程序已下载，请运行 MeetingParserSetup.exe。";
  setupPollTimer = setTimeout(() => void pollForCompanionInstallation(), 10000);
}

async function beginCompanionInstallation({ redownload = false } = {}) {
  if (setupDownloadInProgress && !redownload) return;
  stopSetupPolling();
  setupDownloadInProgress = true;
  installLocalComponentButton.disabled = true;
  installLocalComponentButton.textContent = "正在下载安装程序…";
  recheckLocalComponentButton.hidden = true;
  onboardingFeedback.textContent = "正在检查安装程序…";
  try {
    const info = await chrome.runtime.sendMessage({ type: "checkCompanionSetupAvailability" });
    if (info?.state === "not-published") {
      setupDownloadInProgress = false;
      installLocalComponentButton.disabled = false;
      installLocalComponentButton.textContent = onboardingNeedsUpdate ? "更新本地组件" : "安装本地组件";
      onboardingFeedback.textContent = "安装程序暂未发布，请稍后重试。";
      return;
    }
    if (info?.state === "network-unavailable" || !info?.ok) {
      setupDownloadInProgress = false;
      installLocalComponentButton.disabled = false;
      installLocalComponentButton.textContent = onboardingNeedsUpdate ? "更新本地组件" : "安装本地组件";
      onboardingFeedback.textContent = "无法连接安装程序下载服务，请检查网络后重试。";
      return;
    }
    const update = await chrome.runtime.sendMessage({ type: "beginCompanionUpdate" });
    if (update?.error) throw new Error(update.error);
    await downloadSetupFile(info);
    await chrome.runtime.sendMessage({ type: "armCompanionInstallProbe" });
    setupPollDeadline = Date.now() + 5 * 60 * 1000;
    onboardingFeedback.textContent = "安装程序已下载，请运行 MeetingParserSetup.exe。";
    await pollForCompanionInstallation();
  } catch (error) {
    setupDownloadInProgress = false;
    installLocalComponentButton.disabled = false;
    installLocalComponentButton.textContent = "重新下载安装程序";
    recheckLocalComponentButton.hidden = false;
    onboardingFeedback.textContent = error.message || "安装程序下载失败，请重新下载。";
  }
}

async function recheckCompanionInstallation() {
  stopSetupPolling();
  setupDownloadInProgress = true;
  setupPollDeadline = Date.now() + 5 * 60 * 1000;
  await chrome.runtime.sendMessage({ type: "armCompanionInstallProbe" });
  recheckLocalComponentButton.hidden = true;
  onboardingFeedback.textContent = "正在等待安装完成…";
  await pollForCompanionInstallation();
}

async function restoreCollapseState() {
  try {
    const result = await chrome.storage.session.get(COLLAPSE_STATE_KEY);
    collapseState = result[COLLAPSE_STATE_KEY] && typeof result[COLLAPSE_STATE_KEY] === "object"
      ? result[COLLAPSE_STATE_KEY]
      : {};
  } catch {
    collapseState = {};
  }
}

function bindCollapsible(element, key) {
  element.dataset.collapseId = key;
  element.open = collapseState[key] === true;
  element.addEventListener("toggle", () => {
    collapseState[key] = element.open;
    void chrome.storage.session.set({ [COLLAPSE_STATE_KEY]: collapseState });
  });
}

function safeLogExportText(value) {
  return String(value || "")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted URL]")
    .replace(/(?:token|cookie|authorization|referer|origin)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 240);
}

function logExportTimestamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
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
  starting: "正在启动批量任务",
  idle: "等待开始",
  pending: "待处理",
  navigating: "正在打开页面",
  detecting: "正在发现 MP4",
  extracting: "正在采集逐字稿",
  preparing: "正在准备下载上下文",
  downloading: "下载中",
  complete: "已完成",
  failed: "失败"
};

function batchTaskStatusLabel(item) {
  if (batchState?.taskType === "transcript") {
    if (item.status === "navigating" || item.status === "detecting") return "加载中";
    if (item.status === "extracting") return "采集中";
    if (item.status === "complete") return "完成";
    if (item.status === "failed") return "失败";
    if (item.status === "pending") return "等待";
  }
  return batchStatusLabels[item.status] || item.status || "待处理";
}

function updateBatchModeControls() {
  const transcript = batchTaskType.value === "transcript";
  mediaPreferenceControl.hidden = transcript;
  transcriptExportControl.hidden = !transcript;
  if (!startBatchButton.dataset.busy) startBatchButton.textContent = transcript ? "开始批量提取" : "开始批量下载";
}

function renderBatchDraft(draft) {
  batchDraft = draft || batchDraft;
  batchOutputPath.textContent = "";
  const count = batchDraft.items?.length || 0;
  renderBatchOverview({ total: count, complete: 0, failed: 0, pending: count });
  batchListCount.textContent = count ? `${count} 条任务` : "暂无任务";
  batchSummary.textContent = count
    ? `已解析 ${count} 条，等待开始 · 重复 ${batchDraft.duplicateCount || 0} 条 · 无效 ${batchDraft.invalidCount || 0} 条`
    : "尚未解析";
  if (!batchState?.tasks?.length) renderBatchItems(batchDraft.items || []);
  updateBatchModeControls();
}

function renderBatchItems(items) {
  batchList.replaceChildren();
  for (const item of items) {
    const row = document.createElement("li");
    const title = item.recordingTitle || item.pageTitle || item.pageUrl || item.url;
    row.textContent = truncateUrl(title);
    row.title = item.pageUrl || item.url || title;
    const state = document.createElement("small");
    const progress = item.status === "downloading" && Number.isFinite(item.progress) ? ` · ${item.progress.toFixed(1)}%` : "";
    const textLength = Number(item.textLength) > 0 ? ` · ${item.textLength} 字` : "";
    const error = item.status === "failed" && item.error ? `：${item.error}` : "";
    state.textContent = `${batchTaskStatusLabel(item)}${progress}${textLength}${error}`;
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

function renderBatchOverview(counts) {
  batchTotalCount.textContent = counts.total || 0;
  batchCompleteCount.textContent = counts.complete || 0;
  batchFailedCount.textContent = counts.failed || 0;
  batchPendingCount.textContent = counts.pending || 0;
}

function renderBatchState(state) {
  batchState = state;
  const tasks = state?.tasks || [];
  if (!tasks.length && batchDraft.items?.length) {
    batchTotalProgress.hidden = true;
    batchProgress.hidden = true;
    renderBatchDraft(batchDraft);
    return;
  }
  const counts = batchCounts({ tasks });
  const waiting = (counts.pending || 0) + (counts.navigating || 0) + (counts.detecting || 0) + (counts.extracting || 0) + (counts.preparing || 0) + (counts.downloading || 0);
  const current = tasks[state?.currentIndex] || null;
  renderBatchOverview({ ...counts, pending: waiting });
  batchListCount.textContent = counts.total ? `${counts.total} 条任务` : "暂无任务";
  batchSummary.textContent = `总数 ${counts.total} · 完成 ${counts.complete || 0} · 失败 ${counts.failed || 0} · 待处理 ${waiting}`;
  renderBatchItems(tasks);

  batchTotalProgress.hidden = counts.total === 0;
  if (counts.total) {
    const processed = (counts.complete || 0) + (counts.failed || 0);
    const percent = (processed / counts.total) * 100;
    batchTotalBar.value = percent;
    batchTotalLabel.textContent = `批量进度：${processed} / ${counts.total} · ${percent.toFixed(0)}%`;
  }

  batchProgress.hidden = !current;
  if (current) {
    batchCurrent.textContent = `当前第 ${current.index + 1} / ${counts.total}`;
    batchStatus.textContent = state.statusMessage || `${batchTaskStatusLabel(current)}${current.filename ? `：${current.filename}` : current.recordingTitle || current.pageTitle ? `：${current.recordingTitle || current.pageTitle}` : ""}`;
    const totalBytes = Number.isFinite(current.totalBytes) ? current.totalBytes : null;
    if (totalBytes !== null && current.status === "downloading") {
      const progress = Number.isFinite(current.progress) ? current.progress : 0;
      batchFileProgress.hidden = false;
      batchFileProgress.value = progress;
      batchSize.textContent = `${formatBytes(Number(current.bytes) || 0)} / ${formatBytes(totalBytes)} · ${progress.toFixed(1)}%`;
    } else {
      batchFileProgress.hidden = true;
      batchSize.textContent = state.taskType === "transcript"
        ? `段落：${current.paragraphCount || 0} · 字数：${current.textLength || 0}`
        : current.status === "downloading" ? `已下载 ${formatBytes(Number(current.bytes) || 0)}` : "";
    }
    if (state.taskType === "transcript" && current.status === "complete") {
      batchSize.textContent = `段落：${current.paragraphCount || 0} · 字数：${current.textLength || 0}`;
    }
  }

  batchTaskType.value = ["video", "transcript"].includes(state?.taskType) ? state.taskType : "video";
  mediaPreference.value = ["auto", "screen", "speaker"].includes(state?.mediaPreference) ? state.mediaPreference : "auto";
  transcriptExportMode.value = ["unified", "hierarchical"].includes(state?.transcriptExportMode) ? state.transcriptExportMode : "hierarchical";
  batchOutputPath.textContent = state?.transcriptOutputDirectory
    ? `输出目录：下载目录/${state.transcriptOutputDirectory}/`
    : state?.transcriptOutputFile ? `输出文件：下载目录/${state.transcriptOutputFile}` : "";
  updateBatchModeControls();
  startBatchButton.hidden = ["starting", "running"].includes(state?.status);
  pauseBatchButton.hidden = state?.status !== "running";
  resumeBatchButton.hidden = state?.status !== "paused";
  startBatchButton.textContent = state?.status === "completed"
    ? (state.taskType === "transcript" ? "重新开始批量提取" : "重新开始批量下载")
    : (state.taskType === "transcript" ? "开始批量提取" : "开始批量下载");
  if (state?.status === "paused" && !current?.taskId) {
    batchStatus.textContent = "批量已暂停。";
  }
}

function formatBatchLog(entry) {
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString("zh-CN", { hour12: false }) : "未知时间";
  const current = Number.isInteger(entry.currentIndex) ? entry.currentIndex + 1 : 0;
  const total = Number.isInteger(entry.totalTasks) ? entry.totalTasks : 0;
  const state = entry.batchStatus || "idle";
  const taskState = entry.taskStatus ? `/${entry.taskStatus}` : "";
  const message = safeLogExportText(entry.message);
  const error = entry.taskStatus === "failed" || /error|fail/i.test(entry.event || "") ? ` error=${message || "未知错误"}` : "";
  const detail = error || (message ? ` message=${message}` : "");
  return `${time}  event=${entry.event || "event"}  status=${state}${taskState}  task=${current}/${total}${detail}`;
}

async function refreshBatchLogs() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "getBatchLogs" });
    if (result?.error) throw new Error(result.error);
    const entries = result.entries || [];
    batchLogOutput.textContent = entries.slice(-30).map(formatBatchLog).join("\n") || "当前没有运行日志";
    return entries;
  } catch (error) {
    batchLogOutput.textContent = `日志读取失败：${error.message || "未知错误"}`;
    return [];
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
      if (["starting", "running"].includes(state?.status) || state?.tasks?.[state.currentIndex]?.status === "downloading") {
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
  if (status.status === "failed") return `下载失败：${status.error || "本地下载组件报告失败。"}`;
  if (status.status === "preparing") return "正在准备下载上下文…";
  if (status.status === "queued") return "下载已开始";
  if (status.status === "connecting") return "正在连接本地下载组件…";
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

async function restoreActiveDownload() {
  const result = await chrome.runtime.sendMessage({ type: "getActiveDownload" });
  if (!result) return;
  activeDownload = result;
  renderDownload(result);
}

function createCandidateCard(candidate, page, tabId) {
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
    download.className = "download-candidate";
    download.type = "button";
    download.disabled = localComponentState !== "ready";
    download.textContent = "下载 MP4";
    download.addEventListener("click", async () => {
      download.disabled = true;
      const displayTitle = page.recordingTitle || page.title || "media";
      pendingFilename = `${displayTitle}.mp4`;
      renderDownload({ status: "preparing", filename: pendingFilename, bytes: 0 });
      try {
        const health = await chrome.runtime.sendMessage({ type: "checkLocalDownloader" });
        renderLocalServiceStatus(health?.ok ? "ready" : health?.state || "unavailable");
        if (!health?.ok) {
          renderDownload({
            status: "failed",
            filename: pendingFilename,
            bytes: 0,
            error: health?.error || "本地组件暂时不可用，请稍后重试。"
          });
          return;
        }

        const result = await chrome.runtime.sendMessage({
          type: "downloadMp4",
          candidateId: candidate.id,
          contentType: candidate.contentType,
          recordingTitle: page.recordingTitle || "",
          pageTitle: page.title || "",
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
      } catch (error) {
        renderDownload({
          status: "failed",
          filename: pendingFilename,
          bytes: 0,
          error: error.message || "本地下载组件通信失败。"
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

  const details = document.createElement("details");
  details.className = "advanced-info";
  const collapseKey = `candidate-${candidate.id || `${candidate.mediaFilename || "media"}-${candidate.variant || candidate.kind || "other"}`}`;
  bindCollapsible(details, collapseKey);

  const summary = document.createElement("summary");
  summary.textContent = "高级信息";

  const advancedContent = document.createElement("div");
  advancedContent.className = "advanced-content";
  const url = document.createElement("code");
  url.textContent = candidate.url || "未提供 URL";
  url.title = candidate.url || "";

  const source = document.createElement("p");
  source.textContent = `来源：${candidate.sources?.join("、") || "未知来源"}${candidate.contentType ? ` · ${candidate.contentType}` : ""}`;

  const context = document.createElement("p");
  context.className = "context-diagnostic";
  context.textContent = `请求上下文：${formatContextPresence(candidate.context)}`;

  advancedContent.append(url, source, context);
  details.append(summary, advancedContent);

  card.append(heading, filename, details);
  return card;
}

function renderCandidates(candidates, page, tabId) {
  candidatesElement.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "尚未捕获到媒体资源。请播放视频后点击刷新。";
    candidatesElement.append(empty);
    return;
  }
  for (const candidate of candidates) {
    candidatesElement.append(createCandidateCard(candidate, page, tabId));
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
    const page = result.page || {};
    pageTitleElement.textContent = page.recordingTitle || page.title || tab.title || "当前页面";
    renderCandidates(result.candidates || [], page, tab.id);
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

function renderPageDiagnostic(result, tab) {
  const transcript = result?.transcriptFound ? result : null;
  latestTranscript = transcript;
  const pageTitle = result?.pageTitle || tab?.title || "未读取";
  const pageUrl = result?.pageUrl || tab?.url || "";
  const pageKind = result?.pageDetected ? "是" : "否";
  diagnosticPage.textContent = `${pageTitle}\n${pageUrl}\n腾讯会议录制页面：${pageKind}`;
  diagnosticPage.title = result?.pageUrl || tab?.url || "";
  diagnosticVideo.textContent = `${result?.videoCount ?? 0} 个视频元素`;
  diagnosticStatus.textContent = transcript ? "完成" : "未找到逐字稿";
  diagnosticTranscript.textContent = transcript ? "已发现疑似正文" : "未发现疑似正文";
  diagnosticParagraphCount.textContent = transcript ? String(transcript.paragraphCount ?? 0) : "—";
  diagnosticTextLength.textContent = transcript ? String(transcript.textLength ?? 0) : "—";
  diagnosticPreview.textContent = transcript?.fullText?.slice(0, 500) || transcript?.preview || "—";
  diagnosticActions.hidden = !transcript;
  diagnosticResults.hidden = false;
}

function renderTranscriptProgress(progress) {
  if (!progress) return;
  diagnosticResults.hidden = false;
  diagnosticStatus.textContent = progress.stage || "滚动采集中";
  diagnosticTranscript.textContent = progress.stage === "完成" ? "已发现疑似正文" : "正在采集正文";
  diagnosticParagraphCount.textContent = String(progress.paragraphCount ?? 0);
  diagnosticTextLength.textContent = String(progress.textLength ?? 0);
  diagnosticPreview.textContent = progress.stage === "完成" ? diagnosticPreview.textContent : "正在收集逐字稿…";
  diagnosticFeedback.textContent = `${progress.stage || "滚动采集中"}：已采集 ${progress.paragraphCount ?? 0} 段，${progress.textLength ?? 0} 字。`;
}

async function runPageDiagnostic() {
  runPageDiagnosticButton.disabled = true;
  diagnosticResults.hidden = true;
  diagnosticStatus.textContent = "解析中";
  diagnosticFeedback.textContent = "正在提取逐字稿…";
  try {
    const tab = await activeTab();
    if (!tab?.id) throw new Error("无法读取当前页面。");
    diagnosticTabId = tab.id;
    diagnosticPage.textContent = `${tab.title || "录制文件"}\n${tab.url || ""}\n腾讯会议录制页面：检测中`;
    diagnosticVideo.textContent = "检测中";
    diagnosticResults.hidden = false;
    const result = await chrome.tabs.sendMessage(tab.id, { type: "runPageDiagnostic" });
    if (!result) throw new Error("当前页面暂不支持诊断。");
    renderPageDiagnostic(result, tab);
    diagnosticFeedback.textContent = result.transcriptFound
      ? `提取完成，共 ${result.paragraphCount} 段，${result.textLength} 字。`
      : "提取完成，暂未找到逐字稿正文。";
  } catch (error) {
    diagnosticStatus.textContent = "失败";
    diagnosticFeedback.textContent = error.message || "当前页面不可读取。";
  } finally {
    runPageDiagnosticButton.disabled = false;
  }
}

copyTranscriptButton.addEventListener("click", async () => {
  if (!latestTranscript?.fullText) return;
  copyTranscriptButton.disabled = true;
  try {
    await navigator.clipboard.writeText(latestTranscript.fullText);
    diagnosticFeedback.textContent = "逐字稿全文已复制。";
  } catch {
    diagnosticFeedback.textContent = "复制失败，请检查浏览器剪贴板权限。";
  } finally {
    copyTranscriptButton.disabled = false;
  }
});

exportTranscriptButton.addEventListener("click", () => {
  if (!latestTranscript?.fullText) return;
  exportTranscriptButton.disabled = true;
  const objectUrl = URL.createObjectURL(new Blob(["\uFEFF", latestTranscript.fullText], { type: "text/plain;charset=utf-8" }));
  const filename = `meeting-transcript-${logExportTimestamp()}.txt`;
  chrome.downloads.download({ url: objectUrl, filename, saveAs: true }, () => {
    const error = chrome.runtime.lastError;
    URL.revokeObjectURL(objectUrl);
    diagnosticFeedback.textContent = error ? "导出失败，请重试。" : `已导出：${filename}`;
    exportTranscriptButton.disabled = false;
  });
});

clearDownloadButton.addEventListener("click", async () => {
  stopMonitoring();
  await chrome.runtime.sendMessage({ type: "clearActiveDownload" });
  activeDownload = null;
  renderDownload(null);
  showStatus("已清除下载记录；不会中止本地下载。");
});

singleTab.addEventListener("click", () => setMode("single"));
batchTab.addEventListener("click", () => setMode("batch"));
batchTaskType.addEventListener("change", updateBatchModeControls);

async function parseAndSaveBatchDraft() {
  const result = parseBatchLinks(batchLinks.value);
  try {
    const draft = await chrome.runtime.sendMessage({
      type: "saveBatchDraft",
      items: result.items,
      duplicateCount: result.duplicateCount,
      invalidCount: result.invalidCount
    });
    if (draft?.error) throw new Error(draft.error);
    batchDraft = draft;
    if (draft.acceptedCount !== result.items.length) {
      throw new Error(`解析状态异常：前端 ${result.items.length} 条，后台接受 ${draft.acceptedCount || 0} 条`);
    }
    batchState = null;
    renderBatchDraft(draft);
    await refreshBatchLogs();
    showBatchFeedback(result.items.length ? `已解析 ${result.items.length} 条链接。` : "当前没有可处理的腾讯会议链接。");
    parseBatchButton.textContent = "重新解析";
    return true;
  } catch (error) {
    batchSummary.textContent = error.message || "解析链接失败。";
    showBatchFeedback("解析失败，请检查链接格式。");
    return false;
  }
}

batchFile.addEventListener("change", async () => {
  const file = batchFile.files?.[0];
  if (!file) return;
  parseBatchButton.disabled = true;
  showBatchFeedback("正在读取并解析 TXT…");
  try {
    batchLinks.value = await file.text();
    const parsed = await parseAndSaveBatchDraft();
    if (parsed) showBatchFeedback(batchDraft.items?.length ? `已从 ${file.name} 自动解析 ${batchDraft.items.length} 条链接。` : "TXT 中没有可处理的腾讯会议链接。");
  } catch {
    batchSummary.textContent = "TXT 读取失败，请确认文件是 UTF-8 文本。";
    showBatchFeedback("TXT 读取失败，请确认文件是 UTF-8 文本。");
  } finally {
    parseBatchButton.disabled = false;
  }
});

parseBatchButton.addEventListener("click", async () => {
  parseBatchButton.disabled = true;
  showBatchFeedback("正在解析链接…");
  try {
    await parseAndSaveBatchDraft();
  } finally {
    parseBatchButton.disabled = false;
  }
});

startBatchButton.addEventListener("click", async () => {
  if (batchTaskType.value === "video" && localComponentState !== "ready") {
    showBatchFeedback("请先安装或更新本地组件。");
    companionOnboarding.hidden = false;
    return;
  }
  startBatchButton.dataset.busy = "true";
  startBatchButton.disabled = true;
  batchProgress.hidden = false;
  batchStatus.textContent = "正在启动批量任务…";
  showBatchFeedback("正在启动批量任务…");
  if (batchTaskType.value === "video") renderLocalServiceStatus("starting");
  try {
    const state = await chrome.runtime.sendMessage({
      type: "startBatch",
      taskType: batchTaskType.value,
      mediaPreference: mediaPreference.value,
      transcriptExportMode: transcriptExportMode.value,
      items: batchDraft.items
    });
    if (state?.error) throw new Error(state.error);
    renderBatchState(state);
    monitorBatchState();
    showBatchFeedback("批量任务已开始。");
  } catch (error) {
    batchSummary.textContent = error.message || "批量启动失败。";
    showBatchFeedback("批量启动失败，请查看运行日志。");
    await refreshBatchLogs();
    if (batchTaskType.value === "video") await refreshLocalServiceStatus();
  } finally {
    delete startBatchButton.dataset.busy;
    updateDownloadControls();
  }
});

pauseBatchButton.addEventListener("click", async () => {
  pauseBatchButton.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "pauseBatch" });
    if (state?.error) throw new Error(state.error);
    renderBatchState(state);
    showBatchFeedback("批量任务已暂停。");
  } catch (error) {
    showBatchFeedback(error.message || "暂停失败。");
  } finally {
    pauseBatchButton.disabled = false;
  }
});

resumeBatchButton.addEventListener("click", async () => {
  resumeBatchButton.disabled = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "resumeBatch", mediaPreference: mediaPreference.value });
    if (state?.error) throw new Error(state.error);
    renderBatchState(state);
    monitorBatchState();
    showBatchFeedback("批量任务已继续。");
  } catch (error) {
    batchSummary.textContent = error.message || "继续失败。";
    showBatchFeedback("继续失败，请查看运行日志。");
  } finally {
    resumeBatchButton.disabled = false;
  }
});

toggleBatchLogsButton.addEventListener("click", async () => {
  const visible = batchLogOutput.hidden;
  batchLogOutput.hidden = !visible;
  toggleBatchLogsButton.textContent = visible ? "收起日志" : "查看日志";
  collapseState["batch-logs"] = visible;
  void chrome.storage.session.set({ [COLLAPSE_STATE_KEY]: collapseState });
  if (visible) await refreshBatchLogs();
});

exportBatchLogsButton.addEventListener("click", async () => {
  exportBatchLogsButton.disabled = true;
  showBatchFeedback("正在准备日志文件…");
  let objectUrl = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "getBatchLogs" });
    if (result?.error) throw new Error(result.error);
    const entries = Array.isArray(result.entries) ? result.entries : [];
    if (!entries.length) {
      showBatchFeedback("当前没有可导出的日志。");
      return;
    }
    const content = `${entries.map(formatBatchLog).join("\n")}\n`;
    const blob = new Blob(["\uFEFF", content], { type: "text/plain;charset=utf-8" });
    objectUrl = URL.createObjectURL(blob);
    const filename = `meeting-parser-log-${logExportTimestamp()}.txt`;
    await new Promise((resolve, reject) => {
      if (!chrome.downloads?.download) {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        link.click();
        resolve();
        return;
      }
      chrome.downloads.download({ url: objectUrl, filename, saveAs: false }, (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(downloadId);
      });
    });
    showBatchFeedback(`日志已导出：${filename}`);
  } catch (error) {
    showBatchFeedback(`日志导出失败：${error.message || "未知错误"}`);
  } finally {
    exportBatchLogsButton.disabled = false;
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
});

clearBatchLogsButton.addEventListener("click", async () => {
  clearBatchLogsButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "clearBatchLogs" });
    if (result?.error) throw new Error(result.error);
    await refreshBatchLogs();
    showBatchFeedback("运行日志已清空。");
  } catch (error) {
    showBatchFeedback(`清空日志失败：${error.message || "未知错误"}`);
  } finally {
    clearBatchLogsButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "transcriptProgress" && message.tabId === diagnosticTabId) {
    renderTranscriptProgress(message.progress);
  }
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
  if (message?.type === "batchLogChanged" && !batchLogOutput.hidden) void refreshBatchLogs();
  if (message?.type === "localDownloaderStateChanged") renderLocalServiceStatus(message.state);
  if (message?.type === "localDownloadStatusChanged" && message.status?.taskId) {
    if (!activeDownload || activeDownload.taskId === message.status.taskId) {
      activeDownload = { ...(activeDownload || {}), ...message.status };
      renderDownload(activeDownload);
    }
  }
});

refreshButton.addEventListener("click", refresh);
runPageDiagnosticButton.addEventListener("click", () => void runPageDiagnostic());
installLocalComponentButton.addEventListener("click", () => void beginCompanionInstallation());
recheckLocalComponentButton.addEventListener("click", () => void recheckCompanionInstallation());
void restoreCollapseState().then(() => {
  const logsVisible = collapseState["batch-logs"] === true;
  batchLogOutput.hidden = !logsVisible;
  toggleBatchLogsButton.textContent = logsVisible ? "收起日志" : "查看日志";
  bindCollapsible(pageDiagnostic, "page-diagnostic");
  return Promise.all([
    chrome.runtime.sendMessage({ type: "getBatchDraft" }),
    chrome.runtime.sendMessage({ type: "getBatchState" })
  ]).then(([draft, state]) => {
    if (!draft?.error) renderBatchDraft(draft);
    if (!state?.error) {
      renderBatchState(state);
      if (["starting", "running"].includes(state.status) || state.tasks?.[state.currentIndex]?.status === "downloading") monitorBatchState();
    }
    void refreshLocalServiceStatus();
    void refresh();
    updateDownloadControls();
  });
});
