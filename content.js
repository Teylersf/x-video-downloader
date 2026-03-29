// Content script — runs in ISOLATED world, has chrome.* APIs
(() => {
  if (window.__xdl_active !== undefined) {
    console.log("[X-DL] Already injected");
    return;
  }
  window.__xdl_active = false;
  console.log("[X-DL] Content script loaded on:", window.location.href);

  let downloaded = 0;
  let maxVideos = 100;
  let scrollSpeed = "medium";
  let running = false;
  let statusText = "Ready";
  let statusState = "";
  const processedTweets = new Set();
  let envReady = false;

  const SCROLL_CONFIG = {
    slow: { distance: 400, interval: 3500 },
    medium: { distance: 600, interval: 2200 },
    fast: { distance: 900, interval: 1400 }
  };

  // ---------------------------------------------------------------
  // Styles for the download button injected into tweets
  // ---------------------------------------------------------------
  const style = document.createElement("style");
  style.textContent = `
    .xdl-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 12px;
      height: 32px;
      border: none;
      border-radius: 9999px;
      background: rgba(29,155,240,0.1);
      color: rgb(29,155,240);
      font-size: 13px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .xdl-btn:hover {
      background: rgba(29,155,240,0.2);
    }
    .xdl-btn.xdl-loading {
      opacity: 0.6;
      cursor: wait;
    }
    .xdl-btn.xdl-done {
      background: rgba(0,186,124,0.1);
      color: rgb(0,186,124);
    }
    .xdl-btn.xdl-error {
      background: rgba(244,33,46,0.1);
      color: rgb(244,33,46);
    }
    .xdl-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
  `;
  document.head.appendChild(style);

  const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1zM5 20a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5z"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;

  function sanitizeFilename(text) {
    return text
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/@\w+/g, "")
      .replace(/#(\w+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 80) || "video";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getTweetInfo(article) {
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const tweetText = tweetTextEl ? tweetTextEl.innerText : "";

    let handle = "";
    const allLinks = article.querySelectorAll('a[role="link"]');
    for (const link of allLinks) {
      const href = link.getAttribute("href");
      if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        handle = href.slice(1);
        break;
      }
    }

    const timeEl = article.querySelector("time");
    const tweetLink = timeEl ? timeEl.closest("a") : null;
    const tweetHref = tweetLink ? tweetLink.getAttribute("href") : null;

    let tweetId = null;
    if (tweetHref) {
      const match = tweetHref.match(/\/status\/(\d+)/);
      if (match) tweetId = match[1];
    }

    const hasVideo =
      article.querySelector("video") !== null ||
      article.querySelector('[data-testid="videoPlayer"]') !== null ||
      article.querySelector('[data-testid="videoComponent"]') !== null;

    return { tweetText, handle, tweetId, tweetHref, hasVideo };
  }

  function getVideoUrl(tweetId) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getVideoUrl", tweetId }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("[X-DL] getVideoUrl error:", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        if (resp?.error && resp.error !== "protected_or_deleted") {
          console.error("[X-DL] API error for tweet:", tweetId, "->", resp.error);
        } else if (resp?.error) {
          console.log("[X-DL] Skipping protected/deleted tweet:", tweetId);
        }
        resolve(resp?.url || null);
      });
    });
  }

  function downloadVideo(url, filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "downloadVideo", url, filename }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error("[X-DL] download error:", chrome.runtime.lastError.message);
          resolve(false);
          return;
        }
        if (resp?.success) {
          console.log("[X-DL] Downloaded:", filename, "(" + resp.sizeMB + " MB)");
          resolve(true);
        } else {
          console.warn("[X-DL] Download failed:", resp?.error);
          resolve(false);
        }
      });
    });
  }

  function initEnv() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "initEnv" }, (resp) => {
        if (resp?.error) {
          console.error("[X-DL] Init error:", resp.error);
        }
        if (resp?.ok) {
          console.log("[X-DL] Auth initialized successfully");
          envReady = true;
        }
        resolve(!!resp?.ok);
      });
    });
  }

  // ---------------------------------------------------------------
  // Individual download button on each video tweet
  // ---------------------------------------------------------------
  async function handleSingleDownload(btn, article) {
    if (btn.classList.contains("xdl-loading")) return;

    const info = getTweetInfo(article);
    if (!info.tweetId) {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} No ID`;
      return;
    }

    btn.classList.add("xdl-loading");
    btn.innerHTML = `${DOWNLOAD_SVG} Getting URL...`;

    // Init env if not ready yet
    if (!envReady) {
      const ok = await initEnv();
      if (!ok) {
        btn.classList.remove("xdl-loading");
        btn.classList.add("xdl-error");
        btn.innerHTML = `${DOWNLOAD_SVG} Auth error`;
        setTimeout(() => resetBtn(btn), 3000);
        return;
      }
    }

    const videoUrl = await getVideoUrl(info.tweetId);
    if (!videoUrl) {
      btn.classList.remove("xdl-loading");
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} Protected/N/A`;
      setTimeout(() => resetBtn(btn), 3000);
      return;
    }

    btn.innerHTML = `${DOWNLOAD_SVG} Downloading...`;

    const safeName = sanitizeFilename(info.tweetText);
    const handle = info.handle || "unknown";
    const filename = `x-videos/${handle}_${safeName}.mp4`;

    const success = await downloadVideo(videoUrl, filename);

    btn.classList.remove("xdl-loading");
    if (success) {
      btn.classList.add("xdl-done");
      btn.innerHTML = `${CHECK_SVG} Saved`;
    } else {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} Failed`;
      setTimeout(() => resetBtn(btn), 3000);
    }
  }

  function resetBtn(btn) {
    btn.classList.remove("xdl-error", "xdl-done");
    btn.innerHTML = `${DOWNLOAD_SVG} Download`;
  }

  function injectDownloadButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      // Skip if button already added
      if (article.querySelector(".xdl-btn")) continue;

      const info = getTweetInfo(article);
      if (!info.hasVideo || !info.tweetId) continue;

      // Find the action bar (like, retweet, reply, share row)
      const actionBar = article.querySelector('[role="group"]');
      if (!actionBar) continue;

      const btn = document.createElement("button");
      btn.className = "xdl-btn";
      btn.innerHTML = `${DOWNLOAD_SVG} Download`;
      btn.title = "Download video";

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSingleDownload(btn, article);
      });

      actionBar.appendChild(btn);
    }
  }

  // Watch for new tweets appearing in the DOM (virtualized list)
  const observer = new MutationObserver(() => {
    injectDownloadButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial injection + periodic fallback (React can remove injected elements)
  injectDownloadButtons();
  setInterval(injectDownloadButtons, 2000);

  // ---------------------------------------------------------------
  // Bulk auto-scroll download (triggered from popup)
  // ---------------------------------------------------------------
  function getVisibleVideoTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const tweets = [];

    for (const article of articles) {
      const info = getTweetInfo(article);
      if (!info.hasVideo || !info.tweetId) continue;
      if (processedTweets.has(info.tweetId)) continue;

      const rect = article.getBoundingClientRect();
      if (rect.bottom < -200 || rect.top > window.innerHeight + 500) continue;

      tweets.push({ ...info, rect, article });
    }

    tweets.sort((a, b) => a.rect.top - b.rect.top);
    return tweets;
  }

  async function mainLoop() {
    console.log("[X-DL] Initializing Twitter environment...");
    statusText = "Initializing...";

    const envOk = await initEnv();
    if (!envOk) {
      console.error("[X-DL] Failed to initialize Twitter environment");
      statusText = "Error: Could not get auth tokens. Try refreshing the page.";
      statusState = "stopped";
      running = false;
      return;
    }
    console.log("[X-DL] Environment ready. Starting download loop.");

    const config = SCROLL_CONFIG[scrollSpeed] || SCROLL_CONFIG.medium;
    statusState = "running";
    let noNewCount = 0;

    while (running && downloaded < maxVideos) {
      const tweets = getVisibleVideoTweets();

      if (tweets.length > 0) {
        noNewCount = 0;
        for (const tweet of tweets) {
          if (!running || downloaded >= maxVideos) break;

          processedTweets.add(tweet.tweetId);
          statusText = `Getting video ${downloaded + 1}/${maxVideos}...`;

          console.log("[X-DL] Processing tweet:", tweet.tweetId, "by @" + tweet.handle);

          const videoUrl = await getVideoUrl(tweet.tweetId);
          if (!videoUrl) {
            console.warn("[X-DL] No video URL for tweet:", tweet.tweetId);
            continue;
          }

          const safeName = sanitizeFilename(tweet.tweetText);
          const handle = tweet.handle || "unknown";
          const index = String(downloaded + 1).padStart(3, "0");
          const filename = `x-videos/${index}_${handle}_${safeName}.mp4`;

          statusText = `Downloading ${downloaded + 1}/${maxVideos}...`;

          const success = await downloadVideo(videoUrl, filename);
          if (success) {
            downloaded++;
            statusText = `Downloaded ${downloaded}/${maxVideos}`;

            // Mark the button on this tweet as done if it exists
            const btn = tweet.article.querySelector(".xdl-btn");
            if (btn) {
              btn.classList.add("xdl-done");
              btn.innerHTML = `${CHECK_SVG} Saved`;
            }
          }

          await sleep(500);
        }
      } else {
        noNewCount++;
      }

      if (!running || downloaded >= maxVideos) break;

      window.scrollBy({ top: config.distance, behavior: "smooth" });
      statusText = `Scrolling... ${downloaded}/${maxVideos} downloaded`;
      await sleep(config.interval);

      if (noNewCount > 3) {
        console.log("[X-DL] No new video tweets, scrolling more... (attempt", noNewCount + ")");
        window.scrollBy({ top: 1500, behavior: "instant" });
        await sleep(2500);
      }
      if (noNewCount > 20) {
        console.log("[X-DL] No new video tweets after extended scrolling, stopping");
        break;
      }
    }

    running = false;
    window.__xdl_active = false;
    statusState = downloaded >= maxVideos ? "done" : "stopped";
    statusText = downloaded >= maxVideos
      ? `Done! Downloaded ${downloaded} videos.`
      : `Stopped at ${downloaded} videos.`;
    console.log("[X-DL]", statusText);
  }

  // Listen for popup messages
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "start") {
      if (running) {
        sendResponse({ ok: false, reason: "Already running" });
        return;
      }
      maxVideos = msg.maxVideos || 100;
      scrollSpeed = msg.scrollSpeed || "medium";
      downloaded = 0;
      running = true;
      window.__xdl_active = true;
      processedTweets.clear();
      statusText = "Starting...";
      statusState = "running";
      console.log("[X-DL] STARTED. Max:", maxVideos, "Speed:", scrollSpeed);
      sendResponse({ ok: true });
      mainLoop();
      return;
    }

    if (msg.action === "stop") {
      running = false;
      window.__xdl_active = false;
      statusText = `Stopped at ${downloaded} videos.`;
      statusState = "stopped";
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "getStatus") {
      sendResponse({ text: statusText, state: statusState, downloaded });
      return;
    }
  });

  console.log("[X-DL] Ready — download buttons active, waiting for start command");
})();
