// Cache for Twitter auth
let bearerToken = null;
let csrfToken = null;
let cookieStr = null;
let envTimestamp = 0;

async function refreshAuth(tabId) {
  // Refresh CSRF token + cookies every time
  csrfToken = await getCookie("ct0");
  cookieStr = await getAllCookies();

  // Only re-extract bearer token if stale
  if (bearerToken && Date.now() - envTimestamp < 60 * 60 * 1000) {
    return { ok: true };
  }

  console.log("[X-DL BG] Extracting Bearer token from page...");

  // Get all script URLs from the page
  let scriptUrls;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return Array.from(document.querySelectorAll('script[src]'))
          .map(s => s.src)
          .filter(s => s.includes('.js'));
      }
    });
    scriptUrls = results?.[0]?.result || [];
  } catch (e) {
    return { ok: false, error: "Failed to read page scripts: " + e.message };
  }

  // Find main bundle
  const mainUrl = scriptUrls.find(u => /main\.[a-f0-9]+/.test(u));
  if (!mainUrl) {
    return { ok: false, error: "Could not find main.js. Scripts found: " + scriptUrls.length };
  }

  console.log("[X-DL BG] Fetching:", mainUrl);

  try {
    const resp = await fetch(mainUrl);
    const text = await resp.text();

    // Try multiple patterns for Bearer token
    const patterns = [
      /"Bearer (AAAAAAA[a-zA-Z0-9%_-]+)"/,
      /Bearer (AAAAAAA[a-zA-Z0-9%_-]+)/,
      /"(AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D[^"]*)"/
    ];

    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) {
        bearerToken = m[1];
        break;
      }
    }

    if (!bearerToken) {
      // Hardcoded fallback — this is Twitter's public app-level token
      bearerToken = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
      console.log("[X-DL BG] Using fallback Bearer token");
    } else {
      console.log("[X-DL BG] Extracted Bearer token:", bearerToken.substring(0, 30) + "...");
    }

    envTimestamp = Date.now();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Failed to fetch main.js: " + e.message };
  }
}

function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: "https://x.com", name }, (c) => {
      if (c) return resolve(c.value);
      chrome.cookies.get({ url: "https://twitter.com", name }, (c2) => {
        resolve(c2?.value || null);
      });
    });
  });
}

function getAllCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url: "https://x.com" }, (cookies) => {
      const str = (cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
      resolve(str);
    });
  });
}

function makeHeaders() {
  return {
    "authorization": "Bearer " + bearerToken,
    "x-csrf-token": csrfToken,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "cookie": cookieStr
  };
}

// PRIMARY: Use v1.1 REST API (simpler, no query IDs needed)
async function getVideoUrl_v1(tweetId) {
  const url = `https://x.com/i/api/1.1/statuses/show.json?id=${tweetId}&tweet_mode=extended&include_entities=true`;

  console.log("[X-DL BG] v1.1 API call for tweet:", tweetId);

  // Retry up to 3 times on 503 (over capacity) / 429 (rate limit)
  let resp;
  for (let attempt = 0; attempt < 3; attempt++) {
    resp = await fetch(url, { headers: makeHeaders() });

    if (resp.status === 503 || resp.status === 429) {
      const wait = (attempt + 1) * 2000;
      console.log("[X-DL BG] Rate limited (" + resp.status + "), waiting " + (wait/1000) + "s (attempt " + (attempt+1) + "/3)");
      await new Promise(r => setTimeout(r, wait));
      // Refresh auth in case CSRF expired
      await refreshAuth(null);
      continue;
    }
    break;
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (resp.status === 403) {
      // Protected/deleted tweet — not an error worth retrying
      console.log("[X-DL BG] Tweet", tweetId, "not accessible (protected/deleted)");
      return { url: null, error: "protected_or_deleted" };
    }
    console.error("[X-DL BG] v1.1 API error:", resp.status, text.substring(0, 200));
    return { url: null, error: `API ${resp.status}: ${text.substring(0, 100)}` };
  }

  const json = await resp.json();

  // Look in extended_entities.media for video
  const media = json.extended_entities?.media || json.entities?.media || [];
  for (const m of media) {
    if (m.type === "video" || m.type === "animated_gif") {
      const variants = m.video_info?.variants || [];
      let bestUrl = null;
      let bestBitrate = -1;
      for (const v of variants) {
        if (v.content_type === "video/mp4") {
          const br = v.bitrate || 0;
          if (br > bestBitrate) {
            bestBitrate = br;
            bestUrl = v.url;
          }
        }
      }
      if (bestUrl) {
        console.log("[X-DL BG] v1.1 found video:", bestUrl.substring(0, 100));
        return { url: bestUrl, error: null };
      }
    }
  }

  return { url: null, error: "No video in API response (media items: " + media.length + ")" };
}

// FALLBACK: Use GraphQL TweetResultByRestId
async function getVideoUrl_graphql(tweetId) {
  // Try to find query IDs (we may not have them)
  const variables = encodeURIComponent(JSON.stringify({
    tweetId: tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false
  }));

  const features = encodeURIComponent(JSON.stringify({
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_enhance_cards_enabled: false
  }));

  // Try a few known query IDs for TweetResultByRestId
  const knownIds = [
    "Xl6aG9OyOoSCMOKCDSAOhA",
    "0hWvDhmW8YQ-S_ib3azIrw",
    "V3vfsYzNfqlCTAyjp1BLUA",
    "DJS3BdhUhcaEpZ7B7irJDg"
  ];

  for (const qid of knownIds) {
    const url = `https://x.com/i/api/graphql/${qid}/TweetResultByRestId?variables=${variables}&features=${features}`;

    try {
      const resp = await fetch(url, { headers: makeHeaders() });
      if (!resp.ok) continue;

      const json = await resp.json();
      const videoUrl = findBestVideoUrl(json);
      if (videoUrl) {
        console.log("[X-DL BG] GraphQL found video:", videoUrl.substring(0, 100));
        return { url: videoUrl, error: null };
      }
    } catch (e) {
      continue;
    }
  }

  return { url: null, error: "GraphQL fallback also failed" };
}

function findBestVideoUrl(obj, depth) {
  if (!obj || typeof obj !== "object" || (depth || 0) > 25) return null;
  const d = (depth || 0) + 1;

  if (obj.type === "video" || obj.type === "animated_gif") {
    const variants = obj.video_info?.variants || [];
    let bestUrl = null;
    let bestBitrate = -1;
    for (const v of variants) {
      if (v.content_type === "video/mp4") {
        const br = v.bitrate || 0;
        if (br > bestBitrate) {
          bestBitrate = br;
          bestUrl = v.url;
        }
      }
    }
    if (bestUrl) return bestUrl;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findBestVideoUrl(item, d);
      if (r) return r;
    }
  } else {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object" && obj[key] !== null) {
        const r = findBestVideoUrl(obj[key], d);
        if (r) return r;
      }
    }
  }
  return null;
}

// Handle messages
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.action === "initEnv") {
    refreshAuth(tabId).then((result) => {
      if (!result.ok) {
        console.error("[X-DL BG] Init failed:", result.error);
      } else {
        console.log("[X-DL BG] Auth ready. CSRF:", csrfToken ? "yes" : "NO", "Bearer:", bearerToken ? "yes" : "NO");
      }
      sendResponse(result);
    });
    return true;
  }

  if (msg.action === "getVideoUrl") {
    (async () => {
      // Ensure auth is fresh
      await refreshAuth(tabId);

      // Try v1.1 first
      let result = await getVideoUrl_v1(msg.tweetId);

      // If v1.1 fails, try GraphQL
      if (!result.url) {
        console.log("[X-DL BG] v1.1 failed:", result.error, "— trying GraphQL...");
        result = await getVideoUrl_graphql(msg.tweetId);
      }

      if (result.url) {
        sendResponse({ url: result.url });
      } else {
        sendResponse({ url: null, error: result.error });
      }
    })();
    return true;
  }

  if (msg.action === "downloadVideo") {
    const { url, filename } = msg;
    console.log("[X-DL BG] Downloading:", filename);

    fetch(url)
      .then((resp) => {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.blob();
      })
      .then((blob) => {
        const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
        console.log("[X-DL BG] Fetched", sizeMB, "MB");

        if (blob.size < 5000) {
          sendResponse({ success: false, error: "Too small: " + blob.size + " bytes" });
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          chrome.downloads.download(
            { url: reader.result, filename, conflictAction: "uniquify" },
            (downloadId) => {
              if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
              } else {
                sendResponse({ success: true, downloadId, sizeMB });
              }
            }
          );
        };
        reader.readAsDataURL(blob);
      })
      .catch((err) => {
        console.error("[X-DL BG] Fetch failed:", err.message);
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }
});
