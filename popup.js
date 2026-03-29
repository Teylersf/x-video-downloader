const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("status");
const maxVideosInput = document.getElementById("maxVideos");
const scrollSpeedSelect = document.getElementById("scrollSpeed");

// Load saved settings
chrome.storage.local.get(["maxVideos", "scrollSpeed"], (data) => {
  if (data.maxVideos) maxVideosInput.value = data.maxVideos;
  if (data.scrollSpeed) scrollSpeedSelect.value = data.scrollSpeed;
});

// Poll status from content script
function pollStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "getStatus" }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      statusEl.textContent = resp.text;
      statusEl.className = "status " + resp.state;
    });
  });
}

setInterval(pollStatus, 1000);
pollStatus();

startBtn.addEventListener("click", () => {
  const maxVideos = parseInt(maxVideosInput.value) || 100;
  const scrollSpeed = scrollSpeedSelect.value;

  chrome.storage.local.set({ maxVideos, scrollSpeed });

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    const url = tabs[0].url || "";
    if (!url.includes("x.com") && !url.includes("twitter.com")) {
      statusEl.textContent = "Not on X/Twitter! Navigate there first.";
      statusEl.className = "status stopped";
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, {
      action: "start",
      maxVideos,
      scrollSpeed
    }, (resp) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Reloading page to inject script...";
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          files: ["content.js"]
        }, () => {
          setTimeout(() => {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "start",
              maxVideos,
              scrollSpeed
            });
          }, 500);
        });
        return;
      }
      pollStatus();
    });
  });

  statusEl.textContent = "Starting...";
  statusEl.className = "status running";
});

stopBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action: "stop" });
  });
  statusEl.textContent = "Stopped";
  statusEl.className = "status stopped";
});
