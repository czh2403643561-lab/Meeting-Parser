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

function sendMetadata() {
  chrome.runtime.sendMessage({
    type: "pageMetadata",
    pageUrl: location.href,
    pageTitle: document.title,
    videoUrls: collectVideoUrls()
  }, () => void chrome.runtime.lastError);
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "scanPageMedia") {
    sendMetadata();
  }
});

sendMetadata();
