# X Video Downloader - Chrome Extension

**Bulk download videos from X (Twitter) with one click.** Auto-scroll your feed and save every video, or download individual videos with the built-in button on each tweet.

[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-brightgreen)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Features

- **Download button on every video tweet** — A download button appears in the action bar of every tweet with a video. One click to save.
- **Bulk auto-download** — Set a max number (e.g. 100), hit Start, and the extension scrolls your feed and downloads every video it finds.
- **Smart file naming** — Videos are named using the tweet author and post text so you can identify them: `001_username_tweet text here.mp4`
- **Highest quality** — Automatically selects the highest bitrate MP4 variant available.
- **Adjustable scroll speed** — Slow, medium, or fast depending on your connection.
- **Rate limit handling** — Auto-retries on Twitter API rate limits with exponential backoff.
- **Works on For You & Following** — Operates on any X/Twitter timeline or feed page.
- **No third-party services** — Everything runs locally using Twitter's own API. No data sent anywhere.

## Screenshots

### Download Button on Tweets
Every video tweet gets a blue **Download** button in the action bar. Click it and the button shows progress, then turns green when saved.

### Popup Controls
Set your max video count and scroll speed, then hit **Start Downloading** to bulk download.

## Installation

1. **Download** — Clone this repo or [download the ZIP](../../archive/refs/heads/main.zip)
   ```bash
   git clone https://github.com/Teylersf/x-video-downloader.git
   ```
2. **Open Chrome Extensions** — Navigate to `chrome://extensions/`
3. **Enable Developer Mode** — Toggle the switch in the top right corner
4. **Load Extension** — Click "Load unpacked" and select the downloaded folder
5. **Navigate to X** — Go to [x.com](https://x.com) and you'll see download buttons on video tweets

## Usage

### Download a Single Video
1. Browse X/Twitter normally
2. Find a tweet with a video
3. Click the **Download** button in the tweet's action bar
4. Video saves to your `Downloads/x-videos/` folder

### Bulk Download Videos
1. Navigate to your **For You** or **Following** feed on X
2. Click the extension icon in the toolbar
3. Set the **max number of videos** to download
4. Choose a **scroll speed** (slow is more reliable)
5. Click **Start Downloading**
6. The extension auto-scrolls your feed, finds video tweets, and downloads them
7. Click **Stop** at any time

### File Naming

Videos are saved to `Downloads/x-videos/` with descriptive filenames:

```
x-videos/
  001_username_First part of the tweet text.mp4
  002_anotheruser_Some other tweet content.mp4
  003_handle_Video description from post.mp4
```

## How It Works

1. **Authentication** — Extracts Twitter's Bearer token from the page's JavaScript bundle and reads your session cookies (CSRF token). No passwords or API keys needed — it uses your existing logged-in session.
2. **Video Discovery** — When you click download (or during bulk mode), it calls Twitter's v1.1 REST API (`statuses/show.json`) with the tweet ID to get the video's MP4 URL and selects the highest quality variant.
3. **Download** — The background service worker fetches the video file (bypassing CORS restrictions) and saves it via Chrome's downloads API.
4. **DOM Integration** — A MutationObserver watches for new tweets appearing in the virtualized timeline and injects download buttons automatically.

## Permissions

| Permission | Why |
|-----------|-----|
| `cookies` | Read the `ct0` CSRF token for API authentication |
| `downloads` | Save video files to disk |
| `storage` | Remember your settings (max videos, scroll speed) |
| `activeTab` + `scripting` | Inject download buttons and read page scripts |
| `webRequest` | Capture video CDN URLs as a fallback |

**No data leaves your browser.** All API calls go directly to Twitter's servers using your existing session.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Auth error" on download | Refresh the X page and try again |
| Button says "Protected/N/A" | Tweet is from a private account or was deleted |
| Downloads are slow | Use "Slow" scroll speed, Twitter rate limits aggressive usage |
| No download button appears | Make sure you're on x.com and the extension is enabled |
| Extension not working after update | Go to `chrome://extensions`, click reload on the extension, then refresh X |

## Tech Stack

- **Chrome Extension Manifest V3**
- **Twitter v1.1 REST API** (statuses/show.json)
- **GraphQL API fallback** (TweetResultByRestId)
- Vanilla JavaScript — no frameworks, no build step, no dependencies

## Contributing

Contributions are welcome! Feel free to:

- Open an issue for bugs or feature requests
- Submit a pull request with improvements
- Star the repo if you find it useful

## Disclaimer

This tool is for personal use. Respect content creators' rights and Twitter's Terms of Service. Downloaded videos remain the intellectual property of their original creators. Use responsibly.

## License

[MIT](LICENSE)
