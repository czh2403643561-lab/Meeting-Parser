const candidatesElement = document.querySelector("#candidates");
const statusElement = document.querySelector("#status");
const pageTitleElement = document.querySelector("#page-title");
const refreshButton = document.querySelector("#refresh");

const labels = {
  mp4: "MP4",
  hls: "HLS · m3u8",
  dash: "DASH · mpd",
  other: "其他媒体"
};

function activeTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => tab);
}

function showStatus(message) {
  statusElement.textContent = message;
}

function formatLocalDownloadStatus(status) {
  if (!status) return "";
  if (status.status === "complete") return `下载完成：${status.filename || "MP4 文件"}`;
  if (status.status === "failed") return `下载失败：${status.error || "本地下载器报告失败。"}`;
  if (status.status === "queued") return `已提交：${status.filename || "MP4 文件"}`;
  return `下载中：${status.filename || "MP4 文件"}`;
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

async function monitorLocalDownload(taskId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await chrome.runtime.sendMessage({ type: "getLocalDownloadStatus", taskId });
    if (result?.status) {
      showStatus(formatLocalDownloadStatus(result));
      if (["complete", "failed"].includes(result.status)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  showStatus("下载仍在进行，稍后点击刷新可查看最终结果。");
}

function createCandidateCard(candidate, pageTitle, tabId) {
  const card = document.createElement("article");
  card.className = "candidate";

  const heading = document.createElement("div");
  heading.className = "candidate-heading";
  const type = document.createElement("strong");
  type.textContent = labels[candidate.kind] || labels.other;
  heading.append(type);

  if (candidate.kind === "mp4") {
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载 MP4";
    download.addEventListener("click", async () => {
      download.disabled = true;
      try {
        const health = await chrome.runtime.sendMessage({ type: "checkLocalDownloader" });
        if (!health?.ok) {
          showStatus(health?.error || "本地下载器未启动，请先运行 local_downloader.py");
          return;
        }

        showStatus("本地下载器已连接，正在提交…");
        const result = await chrome.runtime.sendMessage({
          type: "downloadMp4",
          candidateId: candidate.id,
          contentType: candidate.contentType,
          pageTitle,
          tabId
        });
        if (result?.error) {
          showStatus(`下载未提交：${result.error}`);
        } else {
          showStatus(`已提交：${result.filename || "MP4 文件"}`);
          void monitorLocalDownload(result.taskId);
        }
      } catch (error) {
        showStatus(`下载未提交：${error.message || "本地下载器通信失败。"}`);
      } finally {
        download.disabled = false;
      }
    });
    heading.append(download);
  }

  const url = document.createElement("code");
  url.textContent = candidate.url;
  url.title = candidate.url;

  const details = document.createElement("p");
  const source = candidate.sources?.join("、") || "未知来源";
  details.textContent = `${source}${candidate.contentType ? ` · ${candidate.contentType}` : ""}`;

  const context = document.createElement("p");
  context.className = "context-diagnostic";
  context.textContent = `请求上下文：${formatContextPresence(candidate.context)}`;

  card.append(heading, url, details, context);
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
  } catch (error) {
    pageTitleElement.textContent = "当前页面不可读取";
    renderCandidates([], "", null);
    showStatus(error.message || "读取失败。");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", refresh);
void refresh();
