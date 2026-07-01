# StreamVault
<img width="1918" height="931" alt="{1E2A5324-E24B-4A68-8EA2-76634899593F}" src="https://github.com/user-attachments/assets/9c40d25c-1cc6-48f4-b9f6-94579c3340ad" />


**StreamVault** is a self-hosted, Stremio-style torrent streaming web app. Search for movies and TV shows, pick a torrent, and start watching directly in your browser — on your PC, phone, Smart TV, or Chromecast.

No cloud streaming subscriptions. Your machine runs a local Node.js backend that handles BitTorrent networking, memory-efficient background buffering, and real-time FFmpeg transcoding to serve flawless video to any device on your network.

---

## 🔥 Killer Features

- **Smart Pre-buffering (Binge Mode)** — True Netflix-style autoplay. Reaches 80% of an episode? The server silently finds and pre-buffers the next episode in the background. When the countdown ends, the next episode plays instantly with zero loading screen.
- **Chromecast & AirPlay** — Cast directly from your custom web player to your living room TV. Automatically resolves your LAN IP so external receivers can connect without `localhost` issues.
- **Auto Subtitles & Live Sync** — Searches and downloads subtitles automatically ([Wyzie Subs](https://sub.wyzie.io)). Converts SRT to native VTT on the fly, with full UI customization (size, color, background) and live synchronization (`[`/`]`).
- **Server-First Streaming** — Node.js WebTorrent handles the heavy lifting (UDP/TCP). Connects to all peers and manages memory safely without choking your browser.
- **Live FFmpeg Transcoding** — Adaptive playback. Direct HTTP streams for supported devices, or on-the-fly progressive MP4/HLS transcoding for incompatible MKV/HEVC containers.
- **Smart TV Optimized** — Auto-detects LG webOS and Samsung Tizen browsers to serve tailored HLS streams with remote-friendly UI navigation.
- **Discover & Multi-Source** — Browse catalogs via Cinemeta. Scrapes The Pirate Bay, 1337x, and more (optional FlareSolverr support for Cloudflare bypass).
- **Privacy First (Memory-Only)** — Default storage keeps nothing on disk. Torrents are streamed directly from RAM.
---

## Features

- **Discover** — Browse and search movies & TV shows (metadata via [Cinemeta](https://github.com/Stremio/stremio-addon-sdk))
- **Multi-source torrent search** — The Pirate Bay, 1337x (optional: UIndex, EXT.to via FlareSolverr)
- **Server-first streaming** — Node.js WebTorrent connects to all peers (UDP/TCP); browser P2P is a desktop fallback only
- **Smart piece prioritization** — Fast start and responsive seeking via `playback-priority.js`
- **Seek support** — Jump to any timestamp; server re-prioritizes torrent pieces and transcodes from that point
- **Adaptive playback** — Direct stream, ffmpeg MP4 transcode, or HLS depending on device and container
- **Subtitles** — Online search ([Wyzie Subs](https://sub.wyzie.io)) + local `.srt` / `.vtt` upload, with sync controls
- **Mobile support** — iPhone Safari (native HLS) and Android Chrome (MP4 transcode), with touch-friendly player UI
- **Smart TV friendly** — LG webOS and Samsung Tizen: remote navigation, CC button, subtitle size, frame-based fullscreen
- **LAN access** — Watch from any device on your home network
- **Memory-only mode** — Default storage keeps nothing on disk (optional disk cache)
- **Watch history** — Optional local history of recently streamed magnets

---

## How it works

```
┌─────────────┐   HTTP :9091 (UI + API)   ┌──────────────┐
│   Browser   │ ◄──────────────────────►│  server.js   │
│ PC / Phone  │                         │  WebTorrent  │
│  / Smart TV │                         │  + ffmpeg    │
└─────────────┘                         └──────┬───────┘
                                               │ P2P
                                               ▼
                                        ┌─────────────┐
                                        │   Peers     │
                                        └─────────────┘
```

The UI is a single-page app (`main.html`). The backend (`server.js`) handles torrents, HTTP range streaming, ffmpeg transcoding, HLS packaging, discover APIs, and subtitle fetching.

**Recommended:** open the app at `http://<your-pc-ip>:9091` — the server serves both the UI and API on the same origin. This is required for reliable playback on iPhone Safari.

**Optional:** serve static files separately on port 3000 with `npx serve` (see [Quick start](#quick-start)).

When you click **Stream**, the app checks if the local server is running. If yes, it hands off immediately (server mode). Mobile and TV devices require the server — they cannot fall back to browser WebTorrent.

---

## Playback by device

StreamVault picks the best path automatically based on your browser and file format.

| Device | MP4 / WebM (native) | MKV / AVI / etc. (needs transcode) |
|--------|---------------------|-------------------------------------|
| **Desktop Chrome / Firefox / Edge** | Direct HTTP stream | ffmpeg progressive MP4 (`/api/transcode`) |
| **iPhone / iPad (Safari)** | Direct HTTP stream | HLS with libx264 transcode (`/api/hls`) — tap **▶** to start |
| **Android (Chrome)** | Direct HTTP stream | ffmpeg progressive MP4 (`/api/transcode`) |
| **LG webOS / Samsung Tizen** | Direct or HLS | HLS — stream copy on TV, libx264 transcode in desktop browsers |

**HLS profiles** (server-side):

- **`transcode`** — libx264 + AAC segments for browsers (iOS, desktop). Fast-start tuned (~5 s / 4 MB buffer, 2 s segments).
- **`tv`** — video stream copy + AAC audio for Smart TV browsers (faster, less CPU).

MKV files with HEVC/x265 may take longer to start while the first torrent pieces download and ffmpeg probes the file — this is normal.

---

## Requirements

- **Node.js** 18+ (20+ recommended)
- **npm**
- A modern browser (Chrome, Firefox, Edge, Safari; Smart TV browsers supported with limitations)
- **ffmpeg** — bundled automatically via `ffmpeg-static` (no separate install needed)

---

## Quick start

### For Windows Users (Easiest)
1. Extract the folder.
2. Double-click **`start.bat`**.
*This script automatically verifies Node.js, installs dependencies if they are missing, runs the server, and opens the app in your web browser.*

### For macOS / Linux / Manual Setup
#### 1. Clone and install
```bash
git clone <your-repo-url>
cd torrentweb
npm install
```

#### 2. Start the server
```bash
npm start
```

You should see:

```
✅  StreamVault server running
   Local :  http://localhost:9091
   LAN   :  http://<your-ip>:9091

   📡  On phone / TV open:  http://<your-ip>:9091
```

### 3. Open in your browser

| Where | URL |
|-------|-----|
| This PC | http://localhost:9091 |
| Phone / TV on same Wi‑Fi | http://\<your-pc-ip\>:9091 |

> **Important:** Do not open `main.html` as a `file://` URL. Always use HTTP. On iPhone, use port **9091** directly (same-origin) — not a separate static server.

### Optional: separate static server (port 3000)

If you prefer serving the UI on a different port during development:

```bash
npx serve -l tcp://0.0.0.0:3000 .
```

Then open `http://localhost:3000/main.html`. The UI will still call the API on port 9091.

---

## Usage

### Stream a magnet link

1. Open **Stream**
2. Paste a `magnet:?xt=urn:btih:…` link (or drop a `.torrent` file)
3. Click **Stream**
4. Pick a video file from the list (or auto-play the largest video if enabled in Settings)

Demo magnets (Creative Commons films) are available on the Stream page.

### Discover a show or movie

1. Open **Discover**
2. Browse catalogs or search for a title (e.g. *Breaking Bad*, *Inception*)
3. Pick a result → choose a season/episode (TV) or **Find torrents** (movie)
4. Select a torrent → **Stream**

### History

Open **History** to re-stream recently watched magnets (stored locally in your browser).

### Subtitles

1. While playing, open the subtitle button (**CC** on TV, icon on desktop/mobile player bar).
2. **Search online** (needs Wyzie API key — see [Configuration](#configuration)) or **Upload** a `.srt` / `.vtt` file.
3. Fine-tune sync with `[` / `]` keys (earlier / later).
4. **Style Panel**: Customize the look of your subtitles inside the CC modal:
   * **Size**: Scale font size from `0.5x` up to `2.5x` dynamically.
   * **Color**: Select White, Yellow, or Cyan text presets.
   * **Box**: Toggle a semi-transparent dark contrast background block for readability.
   * *Styles are saved automatically in your browser's local storage.*

On **LG / Samsung TV**: use the **CC** button and **A− / A+** for subtitle size. Use the **⛶** button on the TV bar for fullscreen (keeps subtitles visible).

On **iPhone in native fullscreen**: subtitles are injected as a native text track. Inline playback uses the HTML overlay.

---

## Mobile setup

1. Run `npm start` on your PC.
2. Connect your phone to the **same Wi‑Fi / LAN**.
3. Open `http://<your-pc-ip>:9091` in the browser.
4. Use **Discover** or paste a magnet in **Stream**.

**iPhone Safari**

- Transcoded MKV files use HLS — wait for "Preparing stream…" then tap the large **▶** button once.
- Autoplay is blocked by Safari; manual play is required.

**Android Chrome**

- Transcoded files use progressive MP4 — no HLS.
- Playback should start automatically once enough data is buffered.

---

## Smart TV setup

1. Run the server on your PC (port **9091**).
2. Make sure the TV is on the **same Wi‑Fi / LAN**.
3. On the TV browser, open: `http://<your-pc-ip>:9091`
4. Use the remote arrows to navigate (sidebar and buttons are focusable).
5. For fullscreen on LG webOS, use the **⛶** button in the player bar — not the native video fullscreen control.

The app auto-detects TV browsers and enables HLS playback, native play controls, and TV-optimized subtitle layout.

---

## Configuration

### Environment variables (server)

| Variable | Default | Description |
|----------|---------|-------------|
| `WYZIE_API_KEY` | — | Free key from [store.wyzie.io/redeem](https://store.wyzie.io/redeem) for online subtitles |
| `TORRENT_SOURCES` | `tpb,1337x` | Comma-separated: `tpb`, `1337x`, `uindex`, `ext` |
| `FLARESOLVERR_URL` | — | e.g. `http://localhost:8191` — unlocks UIndex/EXT.to behind Cloudflare |
| `FLARESOLVERR_TIMEOUT_MS` | `25000` | FlareSolverr request timeout |
| `WEBTORRENT_STORE` | `memory` | `memory` (no disk) or `disk` |
| `WEBTORRENT_PATH` | OS temp | Cache folder when `WEBTORRENT_STORE=disk` |
| `WEBTORRENT_CACHE_SLOTS` | `128` | In-memory piece cache slots per torrent |
| `WEBTORRENT_CLEAR_ON_START` | — | Set to `1` to wipe disk cache on server start |
| `TPB_PROVIDERS` | TPB mirrors | Comma-separated TPB mirror URLs |
| `X1337_PROVIDERS` | 1337x mirrors | Comma-separated 1337x base URLs |
| `UINDEX_BASE` | `https://uindex.org` | UIndex base URL |
| `EXT_TO_BASE` | `https://ext.to` | EXT.to base URL |
| `SOURCE_SEARCH_TIMEOUT_MS` | `20000` | Per-source torrent search timeout |
| `TORRENT_FETCH_TIMEOUT_MS` | `12000` | HTTP timeout for scraper requests |
| `FFPROBE_PATH` | bundled | Override ffprobe binary path |

Example (PowerShell):

```powershell
$env:WYZIE_API_KEY = "wyzie-your-key-here"
$env:TORRENT_SOURCES = "tpb,1337x"
npm start
```

Example (bash):

```bash
WYZIE_API_KEY=wyzie-your-key-here TORRENT_SOURCES=tpb,1337x npm start
```

### FlareSolverr Setup (optional)

If you enable the `uindex` or `ext` torrent sources, they are often protected by Cloudflare. You can run [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) to bypass this protection:

1. **Run FlareSolverr** via Docker:
   ```bash
   docker run -d \
     --name=flaresolverr \
     -p 8191:8191 \
     -e LOG_LEVEL=info \
     --restart unless-stopped \
     ghcr.io/flaresolverr/flaresolverr:latest
   ```
2. **Launch StreamVault** configured with FlareSolverr:
   ```bash
   FLARESOLVERR_URL=http://localhost:8191 TORRENT_SOURCES=tpb,1337x,uindex,ext npm start
   ```

### In-app settings

Open **Settings** in the sidebar:

- Save watch history (on/off)
- Auto-play largest video file (on/off)
- Preferred subtitle languages (ISO codes, e.g. `en, he, es`)
- Optional Wyzie API key (overrides server env for that browser)
- Storage info & cache clear

---

## Project structure

```
torrentweb/
├── main.html            # Full UI (player, discover, subtitles, TV/mobile support)
├── server.js            # Express API + WebTorrent + ffmpeg/HLS
├── discover.js          # Cinemeta metadata + torrent search orchestration
├── torrent-sources.js   # TPB, 1337x, UIndex, EXT.to scrapers
├── torrent-store.js     # Memory vs disk torrent storage
├── subtitles.js         # Wyzie Subs integration
├── playback-priority.js # Piece priority for playback & seek
├── media-index.js       # Keyframe index for smarter seeking
├── hls.min.js           # HLS.js (fallback for non-native HLS browsers)
├── webtorrent.min.js    # Browser P2P fallback (desktop only)
└── package.json
```

---

## API overview

| Endpoint | Description |
|----------|-------------|
| `GET /` | Serve `main.html` |
| `GET /api/ping` | Health check |
| `GET /api/discover/sources` | List enabled torrent sources |
| `GET /api/discover/catalogs?type=` | Browse catalogs (all / series / movie) |
| `GET /api/discover/search?q=&type=` | Search Cinemeta catalog |
| `GET /api/discover/meta/:type/:id` | Show/movie metadata + episodes |
| `GET /api/discover/torrents?q=` | Search torrents by query |
| `POST /api/discover/episode-torrents` | Search torrents for an episode |
| `POST /api/discover/movie-torrents` | Search torrents for a movie |
| `GET /api/subtitles/search` | Search Wyzie subtitles |
| `POST /api/subtitles/fetch` | Download & convert subtitle to VTT |
| `POST /api/add` | Add magnet to server |
| `GET /api/stream/:hash/:file` | Direct file stream (range requests) |
| `GET /api/transcode/:hash/:file` | ffmpeg fMP4 transcode stream |
| `GET /api/hls/:hash/:file/playlist.m3u8` | HLS playlist |
| `GET /api/hls/:hash/:file/:segment` | HLS segment (`.ts`) |
| `DELETE /api/hls/:hash/:file` | Stop HLS session |
| `POST /api/prioritize/:hash/:file` | Shift piece priority on seek |
| `GET /api/probe/:hash/:file` | Duration & codec probe |
| `GET /api/stats/:hash` | Download progress & peer count |
| `GET /api/storage` | Storage mode info |
| `POST /api/storage/clear` | Clear all torrents & cache |
| `DELETE /api/torrent/:hash` | Remove torrent from server |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Server unreachable" on phone / TV | Ensure `npm start` is running; open `http://<ip>:9091`, not `file://` |
| iPhone: long "Preparing stream…" | Normal for MKV — wait for counter, then tap **▶** once. Ensure torrent has peers. |
| iPhone: black screen | Use port **9091** directly (same origin). Hard-refresh Safari after server updates. |
| Android: playback errors | Android uses MP4 transcode, not HLS. Restart server after updates; hard-refresh Chrome. |
| `[hls transcode error]` in server logs | ffmpeg failed — often not enough torrent data yet, or codec unsupported. Wait for download progress and retry. |
| Torrent search stuck / empty | Check server console; TPB/1337x mirrors may be down — try again or set `TPB_PROVIDERS` |
| Black screen on LG TV | Use Discover → server stream path; HLS mode is enabled automatically on TVs |
| No subtitles online | Set `WYZIE_API_KEY` on the server or in Settings |
| Seek is slow first time | Normal — ffmpeg restarts from keyframe; piece priority speeds up buffering |
| Fullscreen loses subs on TV | Use the **⛶** button in the app bar, not the native player fullscreen |
| Port 9091 already in use | Stop the existing process: `Get-NetTCPConnection -LocalPort 9091` (PowerShell) or `lsof -i :9091` (macOS/Linux) |

---

## Legal disclaimer

**StreamVault is for educational and personal use only.**

- You are responsible for complying with copyright laws in your country.
- Only stream content you have the legal right to access.
- The authors do not host, index, or distribute copyrighted content — the app connects to public torrent indexes and peer networks configured by the user.
- Use a VPN and understand the risks of torrenting in your jurisdiction.

---

## Credits

Built with:

- [WebTorrent](https://webtorrent.io) — BitTorrent in Node.js / browser
- [ffmpeg](https://ffmpeg.org) — transcoding (via `ffmpeg-static`)
- [Cinemeta](https://api.strem.io) — movie/TV metadata
- [Wyzie Subs](https://sub.wyzie.io) — subtitle aggregation
- [hls.js](https://github.com/video-dev/hls.js) — HLS playback in browsers

Inspired by [Stremio](https://www.stremio.com) — self-hosted, no account required.

---

## License

MIT — add a `LICENSE` file before publishing if you want an explicit open-source license.

Contributions, issues, and pull requests are welcome.
