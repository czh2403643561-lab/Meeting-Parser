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

function createCandidateCard(candidate, pageTitle) {
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
      const result = await chrome.runtime.sendMessage({
        type: "downloadMp4",
        url: candidate.url,
        contentType: candidate.contentType,
        pageTitle
      });
      showStatus(result?.error ? `下载未启动：${result.error}` : "已交给浏览器下载。");
      download.disabled = false;
    });
    heading.append(download);
  }

  const url = document.createElement("code");
  url.textContent = candidate.url;
  url.title = candidate.url;

  const details = document.createElement("p");
  const source = candidate.sources?.join("、") || "未知来源";
  details.textContent = `${source}${candidate.contentType ? ` · ${candidate.contentType}` : ""}`;

  card.append(heading, url, details);
  return card;
}

function renderCandidates(candidates, pageTitle) {
  candidatesElement.replaceChildren();
  if (!candidates.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "尚未捕获到媒体资源。请播放视频后点击刷新。";
    candidatesElement.append(empty);
    return;
  }
  for (const candidate of candidates) {
    candidatesElement.append(createCandidateCard(candidate, pageTitle));
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
    renderCandidates(result.candidates || [], pageTitle);
    showStatus(result.candidates?.length ? `已找到 ${result.candidates.length} 个候选资源。` : "未发现可识别的媒体请求。");
  } catch (error) {
    pageTitleElement.textContent = "当前页面不可读取";
    renderCandidates([], "");
    showStatus(error.message || "读取失败。");
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", refresh);
void refresh();
