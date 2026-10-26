# Voice Transcriber

A VS Code extension that records your voice and transcribes it using OpenAI Whisper, OpenRouter, Whisper running in Docker on your own machine, or a local Whisper-compatible API. Can optionally clean up the text with an LLM.

<img width="1724" alt="image" src="https://github.com/user-attachments/assets/f2600d73-98c0-42ce-ac12-d6e501078cde" />


## Features

- Record audio directly in VS Code with real-time visualization
- Upload audio or video files — audio track is extracted automatically (MP4, MKV, MOV, AVI, WebM)
- Transcribe long recordings (1hr+) — split into 10-min chunks behind the scenes
- Transcribe via OpenAI, OpenRouter (Whisper, Deepgram Nova-3, GPT-4o Transcribe, Voxtral), Whisper in Docker (offline, free), or your own local server
- Separate API key per provider — switching providers doesn't wipe the other key
- Copy the transcript with per-phrase timestamps as SRT, WebVTT, or plain `[hh:mm:ss]` lines
- Clean up filler words and fix punctuation with LLM (optional)
- Keep your last 10 transcriptions
- Auto-copy results to clipboard
- Recover recordings if VS Code crashes

## ffmpeg Installation (required for native recording and long files)

The extension uses ffmpeg for native recording, splitting long files, and extracting audio from video uploads. Without ffmpeg, recording falls back to the browser (works, but lower quality and no long-file support).

**macOS:**
```bash
brew install ffmpeg
```

**Linux:**
```bash
sudo apt install ffmpeg
```

**Windows:**
```bash
winget install ffmpeg
# or
choco install ffmpeg
```

## Usage

1. Click the microphone icon in the top-right of your editor
2. Set up your provider (OpenAI, OpenRouter, or local)
3. Hit "Start Recording" and speak
4. Hit "Stop" — text is automatically copied to clipboard

## Configuration

### OpenAI

Get an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys), select "OpenAI" as provider, paste your key, and save.

### OpenRouter

Get an API key from [openrouter.ai/keys](https://openrouter.ai/keys), select "OpenRouter" as provider, paste your key, and save. One key covers both transcription and LLM cleanup, and you can pick the speech-to-text model under Advanced Settings (Whisper 1, Whisper Large v3 Turbo, GPT-4o Transcribe, Deepgram Nova-3, Voxtral Mini).

### Docker (local Whisper)

Pick "Docker (local Whisper)" to transcribe on your own CPU, with no API key and no audio leaving your machine. Docker must be installed and running; the extension does the rest:

- The first run builds a small image (`voice-transcriber-whisper`) and downloads the Whisper `small` model (~500 MB) into the `voice-transcriber-whisper-models` volume, so later runs skip both
- Every transcription starts the `voice-transcriber-whisper` container and stops it when done, so it holds no CPU or RAM in between. Starting it and loading the model takes ~10-15 seconds
- **CPU threads** (Advanced Settings) defaults to a quarter of your cores, at most 4, and the container is capped to exactly that many CPUs and 2 GB of RAM. More threads finish sooner but load your machine harder; past 4, Whisper in Docker gets slower rather than faster
- On an Apple M4 Pro with 3 threads, a minute of speech takes about 15-25 seconds
- The server listens on `127.0.0.1:47913` only. If the extension's server files change in an update, the container is recreated automatically

### Local server

Any Whisper-compatible API works:
- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server)
- [whisper.cpp server](https://github.com/ggerganov/whisper.cpp)
- Anything with a `/v1/audio/transcriptions` endpoint

Just enter the URL, e.g. `http://localhost:8000/v1/audio/transcriptions`.

### LLM text cleanup

With OpenAI or OpenRouter you can enable "Clean up text with LLM" to remove filler words, fix punctuation, and add paragraph breaks. Not available for local servers, which have no chat endpoint.

OpenAI models: gpt-4.1-nano (default, cheapest), gpt-4.1-mini, gpt-4.1.
OpenRouter models: gpt-4.1-nano (default), gpt-4.1-mini, gemini-2.5-flash-lite, claude-haiku-4.5, llama-3.3-70b.

## Timestamps and subtitles

After a transcription finishes, a **SRT** button appears next to the copy button in the Transcription header. It offers three formats:

- **SubRip (SRT)** — the subtitle standard, read by YouTube, Premiere, DaVinci, VLC
- **WebVTT** — the web subtitle standard, for `<track>` elements and HTML5 players
- **Plain text with timestamps** — one `[hh:mm:ss] phrase` line, for notes and chat

The plain copy button is unchanged and still copies just the text, and transcriptions still auto-copy as plain text.

Timings are stitched across chunks, so an hour-long recording gives one continuous timeline. Not every model can produce them — the model picker marks those that cannot:

| model | timestamps |
|---|---|
| `whisper-1` (OpenAI and OpenRouter) | yes |
| `openai/whisper-large-v3-turbo` | yes |
| `deepgram/nova-3` | yes |
| `openai/gpt-4o-transcribe`, `openai/gpt-4o-mini-transcribe` | no |
| `mistralai/voxtral-mini-transcribe` | no |
| Docker (local Whisper) | yes |
| Local/Custom server | not wired |

With LLM cleanup enabled the timestamps come from the raw transcript, because cleanup rewrites and merges sentences and the alignment no longer holds.

## Languages

Auto-detect or pick manually: English, Russian, Ukrainian, Spanish, French, German, Italian, Portuguese, Polish, Japanese, Korean, Chinese, and more.

## Troubleshooting

### Microphone access denied

**macOS:** System Settings → Privacy & Security → Microphone → enable VS Code → restart VS Code

**Windows:** Settings → Privacy → Microphone → allow app access

**Linux:** Check PulseAudio/PipeWire settings with `pavucontrol`, make sure no other app is blocking the mic

### How to check logs

Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) → "Developer: Open Webview Developer Tools" → pick Voice Transcriber → Console tab

### Transcription fails

- Check your API key
- For local API — make sure the server is running and URL is correct
- For Docker — make sure Docker Desktop is running; `docker logs voice-transcriber-whisper` shows the server's log
- Check your internet connection

### Large files and video uploads

Recordings over 24 MB are transcoded to 128 kbps MP3 and split into chunks (10 minutes for OpenAI and local, 5 minutes for OpenRouter, whose routing overhead makes long chunks much slower, 2 minutes for Docker so progress keeps moving on a CPU), each transcribed separately and concatenated. Video uploads (MP4, MKV, MOV, AVI, WebM) have their audio track extracted automatically. Both features require ffmpeg.

## Privacy

- API keys are stored in VS Code's secure storage (system keychain)
- Audio goes directly to the provider you picked (OpenAI, OpenRouter) or your local API; with Docker it never leaves your machine
- Nothing is saved to disk

---

# For Developers

## Setup

```bash
npm install
npm run compile
```

Press F5 to launch the Extension Development Host.

## Commands

```bash
npm run compile   # build once
npm run watch     # rebuild on changes
```

## Verifying a provider end-to-end

Hits the live API with real audio through the compiled services:

```bash
npm run compile && OPENROUTER_API_KEY=sk-or-v1-... node scripts/check-provider.js openrouter
```

Swap in `OPENAI_API_KEY=sk-... node scripts/check-provider.js openai` for OpenAI, or `node scripts/check-provider.js docker` for the Docker provider (needs Docker running). Pass an audio file path as a second argument to skip the generated sample (sample generation needs macOS `say` plus ffmpeg).

To check the webview itself (file picker, upload, progress, error toasts) in a real Extension Development Host, use `node scripts/e2e-upload.js <provider|-> <file> [waitSeconds]`. It launches a throwaway VS Code profile, uploads the file through the panel and exits 0 once a transcript appears. Pass `-` to keep the default provider.

## Publishing to VS Code Marketplace

### Prerequisites

1. Microsoft account — [account.microsoft.com](https://account.microsoft.com)
2. Azure DevOps org — [dev.azure.com](https://dev.azure.com)
3. Publisher ID — [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)

### Get a Personal Access Token (PAT)

1. Go to [dev.azure.com](https://dev.azure.com) → profile → Personal access tokens → New Token
2. Organization: **All accessible organizations**
3. Scopes: Custom defined → Marketplace → **Manage**
4. Copy the token (shown only once)

### Update package.json

```json
{
  "publisher": "your-publisher-id",
  "icon": "resources/icon.png"
}
```

Icon must be a 128×128 PNG.

### Publish

```bash
npm install -g @vscode/vsce
vsce login your-publisher-id
vsce publish
```

### Update version

```bash
vsce publish patch  # 0.1.0 → 0.1.1
vsce publish minor  # 0.1.0 → 0.2.0
vsce publish major  # 0.1.0 → 1.0.0
```

### Other useful commands

```bash
vsce package                      # create .vsix without publishing
vsce show publisher.extension     # show extension info
vsce unpublish publisher.ext      # remove from marketplace
```

## License

MIT
