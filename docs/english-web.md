# HGhubX English — Windows host and iPad browser

This adds a separate English web edition to the existing repository. Run it on Windows and open the same interface from Windows or Safari on your iPad. The existing Chinese Tauri desktop application is preserved; its installer does not start this service. This is source code with a Windows launcher, not a prebuilt Windows EXE.

## Windows setup

1. Install **Node.js 22 or newer**, **pnpm 10 or newer**, and **FFmpeg**. `node --version`, `pnpm --version`, `ffmpeg -version`, and `ffprobe -version` should work in a new terminal. FFmpeg is needed for downloads, not ordinary browsing.
2. Download or clone the `feature/english-web-library` branch of this fork.
3. In the project directory, run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm web:build
   .\start-web.cmd
   ```

4. The first launch prints a randomly generated **server access password**. Save it: only its salted hash is stored, and it is not printed on later launches.
5. Open `http://localhost:17651` on Windows. Enter that password.
6. For the iPad, allow Node through Windows Firewall **on the Private profile only**, and open `http://WINDOWS-LAN-IP:17651` in Safari on your home network. The launcher listens on all interfaces for LAN access. Direct `pnpm web:start` defaults to loopback only; set `HGHUB_HOST=0.0.0.0` to enable LAN access.
7. Keep the terminal/server running while using either device. Safari can add the page to the Home Screen.

No router port forwarding is required. HTTP does not encrypt the access password or catalog traffic between the iPad and PC. Use this only on your trusted LAN, or enable HTTPS using certificates trusted by the iPad. No Internet hosting is configured.

To regenerate a forgotten access password, stop the server, delete `access.json` in the data directory, and restart. This does not delete downloads. Restarting also invalidates browser sessions.

## Enable English titles and descriptions

All interface controls are English without any translation service. Catalog titles, descriptions, and tags use a configurable translation provider. Original content remains visible while translation runs; there is a toggle to display both versions. Cached translations persist across restarts. Provider errors are shown beside the affected text instead of silently presenting untranslated text as English.

### Your Ollama server

Set these in the same PowerShell terminal before launching:

```powershell
$env:HGHUB_TRANSLATOR = 'ollama'
$env:HGHUB_TRANSLATION_URL = 'http://YOUR-OLLAMA-SERVER:11434'
$env:HGHUB_TRANSLATION_MODEL = 'qwen3:8b'
.\start-web.cmd
```

The Windows host must be able to reach Ollama. Only catalog text and search text are sent to the model. The UI loads immediately and translations run in the background, one at a time; larger descriptions can take a while on a small model. Model output is displayed as text, never executed or rendered as HTML.

### Hosted OpenAI-compatible service

```powershell
$env:HGHUB_TRANSLATOR = 'openai-compatible'
$env:HGHUB_TRANSLATION_URL = 'https://YOUR-PROVIDER/v1/chat/completions'
$env:HGHUB_TRANSLATION_MODEL = 'YOUR-MODEL'
$env:HGHUB_TRANSLATION_KEY = 'YOUR-API-KEY'
.\start-web.cmd
```

The URL is the **full chat-completions endpoint**. The key stays in the server environment, not browser storage. Hosted providers receive the text being translated and may charge for it. Do not commit keys to GitHub. There is no translation service configured or contacted by default. Settings shows whether one is configured.

English searches can be translated to Chinese before they are sent upstream. Disable the checkbox to search exact original text instead. No audio translation, transcription, or subtitles are added in this version.

## Features

- English browsing, search, video details, categories, tag browsing, and popular videos.
- Cached background translation for displayed titles, descriptions and tags; original-text toggle.
- Shared favorites and watch progress. Opening a video refreshes server progress so a second device can resume. Progress is saved every five seconds and on player close.
- Hide watched videos; block original tag names or creator names/IDs in Settings. Continue watching remains visible even with Hide watched enabled.
- Download current or explicitly selected episodes; quality choice, single-job queue, progress, cancellation, retry and duplicate detection.
- Offline MP4 library with browser playback and Save MP4 to this device. On iPad this saves via Safari; the main library remains on Windows.
- Storage quota (default 20 GB) and minimum free space (1 GB). Partial files are removed on failure/cancellation. Interrupted jobs are marked failed after restart and can be retried.
- Optional upstream account login. Its session token stays only in server memory, so you must sign in again after restarting. One server access password and one shared upstream session/library serve the household; this is not a multi-user isolation system.

## Downloads and playback limits

Downloads support finite HLS playlists, including ordinary AES-128 HLS keys that the normal playback endpoint provides. FFmpeg remuxes locally downloaded resources into MP4 without network access; it does not transcode them. DRM/SAMPLE-AES, live streams, byte-range playlists, and masters with separate audio/subtitle renditions are explicitly rejected. Jobs download one at a time, with at most 100 waiting jobs. Downloads are only initiated for episodes you select; there is no automatic site crawling.

Standard quality is the best initial choice for Safari. HEVC availability depends on upstream streams, device codec support and encoding profile. An MP4 container does not guarantee every browser can decode the streams inside it. Subtitle and audio tracks are not translated.

The new network layer validates DNS results and pins public addresses; it does not use the old client's system-proxy/FakeIP exceptions or fallback Alibaba DNS. It currently supports direct public HTTPS on port 443. If your network needs an explicit HTTP/SOCKS proxy or FakeIP DNS, the web edition needs additional proxy support; a network-level VPN may work when DNS returns public addresses.

The upstream's posts, comments, social actions, and account registration remain in the original desktop client and are not ported into this first web edition. The new edition focuses on browsing, translation, downloads and a shared video library.

## Data and configuration

Default folder: `%USERPROFILE%\HGhubX-Library`.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HGHUB_HOST` | `127.0.0.1` (`0.0.0.0` in launcher) | Listening address |
| `HGHUB_PORT` | `17651` | Server port |
| `HGHUB_DATA` | User home / `HGhubX-Library` | Library, shared state, translation cache, access hash |
| `HGHUB_QUOTA_GB` | `20` | Download storage budget, including temporary files |
| `HGHUB_FFMPEG` | `ffmpeg` | FFmpeg executable path |
| `HGHUB_TLS_CERT` / `HGHUB_TLS_KEY` | Unset | PEM certificate/key for HTTPS |
| `HGHUB_TRANSLATOR` | Off | `ollama` or `openai-compatible` |
| `HGHUB_TRANSLATION_URL` | Local Ollama or provider endpoint | Translation endpoint |
| `HGHUB_TRANSLATION_MODEL` | `qwen3:8b` | Model name |
| `HGHUB_TRANSLATION_KEY` | Unset | Hosted provider key |

Configuration comes from the process environment, not an automatically loaded `.env` file. Shared state, translations and downloaded media are local plaintext data. Protect this directory using your Windows account permissions; do not place it in a public share. Upstream tokens and entered passwords are not persisted there.

## Validation

```powershell
pnpm web:build
pnpm test:web
pnpm test:web:browser
```

Backend tests cover authentication, cross-origin rejection, blocked targets, state merging, download deduplication, cancellation, recovery, malformed playlists, and HLS-to-MP4 conversion using generated fixtures. The optional browser suite needs Chromium; set `HGHUB_CHROMIUM` to its executable path on Windows. It uses mock catalog/translation responses and tests navigation, selected-episode downloads, favorites and narrow layouts. It does not claim live upstream availability or actual iPad validation.

Keep the existing LICENSE and its required copyright notice with any distribution. This remains a noncommercial personal-use modification.
