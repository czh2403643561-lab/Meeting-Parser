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

function sendRuntimeMessage(message) {
  try {
    const response = chrome.runtime.sendMessage(message, () => {
      // Reading lastError prevents Chrome from reporting a rejected message
      // when this page still has the previous extension context.
      void chrome.runtime.lastError;
    });
    if (response && typeof response.catch === "function") {
      response.catch(() => undefined);
    }
  } catch {
    // The page can outlive an extension reload. Refreshing the page loads the new context.
  }
}

function sendMetadata() {
  sendRuntimeMessage({
    type: "pageMetadata",
    pageUrl: location.href,
    pageTitle: document.title,
    userAgent: navigator.userAgent,
    videoUrls: collectVideoUrls()
  });
}

function pathnameFor(value) {
  const url = toAbsoluteHttpUrl(value);
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function videoMatchesPathname(video, mediaPathname) {
  const values = [video.currentSrc, video.src, video.getAttribute("src")];
  for (const source of video.querySelectorAll("source")) {
    values.push(source.src, source.getAttribute("src"));
  }
  return values.some((value) => pathnameFor(value) === mediaPathname);
}

async function prepareMediaContext(mediaPathname, timeoutMs = 4000) {
  if (typeof mediaPathname !== "string" || !mediaPathname) return { prepared: false };
  const video = [...document.querySelectorAll("video")].find((item) => videoMatchesPathname(item, mediaPathname));
  if (!video) return { prepared: false };

  video.preload = "metadata";
  if (!video.paused) return { prepared: true };

  await new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("error", finish);
      resolve();
    };
    timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 3000), 5000));
    video.addEventListener("loadedmetadata", finish, { once: true });
    video.addEventListener("error", finish, { once: true });
    video.load();
  });
  return { prepared: true };
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "scanPageMedia") {
    sendMetadata();
  }
  if (message?.type === "prepareMediaContext") {
    prepareMediaContext(message.mediaPathname, message.timeoutMs)
      .then((result) => {
        sendMetadata();
        sendResponse(result);
      })
      .catch(() => sendResponse({ prepared: false }));
    return true;
  }
});

sendMetadata();
