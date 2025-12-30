# Voice Transcriber

A VS Code extension that records your voice and transcribes it using OpenAI Whisper or a local Whisper-compatible API. Can optionally clean up the text with an LLM.

<img width="2724" height="3624" alt="image" src="https://github.com/user-attachments/assets/f2600d73-98c0-42ce-ac12-d6e501078cde" />


## Features

- Record audio directly in VS Code with real-time visualization
- Transcribe via OpenAI Whisper or your own local server
- Clean up filler words and fix punctuation with LLM (optional)
- Keep your last 10 transcriptions
- Auto-copy results to clipboard
- Recover recordings if VS Code crashes

## Installation

### From VSIX

1. Download the `.vsix` file
2. In VS Code: Extensions → ... → Install from VSIX

### Recording tools (recommended)

The extension works best with audio utilities installed. Without them, it falls back to browser-based recording.

**Linux:**
```bash
sudo apt install alsa-utils
# or
sudo apt install sox libsox-fmt-all
```

**macOS:**
```bash
brew install sox
```

**Windows:**
```bash
choco install sox.portable
```

## Usage

1. Click the microphone icon in the top-right of your editor
2. Set up your provider (OpenAI or local)
3. Hit "Start Recording" and speak
4. Hit "Stop" — text is automatically copied to clipboard

## Configuration

### OpenAI

Get an API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys), select "OpenAI" as provider, paste your key, and save.

### Local server

Any Whisper-compatible API works:
- [faster-whisper-server](https://github.com/fedirz/faster-whisper-server)
- [whisper.cpp server](https://github.com/ggerganov/whisper.cpp)
- Anything with a `/v1/audio/transcriptions` endpoint

Just enter the URL, e.g. `http://localhost:8000/v1/audio/transcriptions`.

### LLM text cleanup

When using OpenAI, you can enable "Clean up text with LLM" to remove filler words, fix punctuation, and add paragraph breaks.

Models available: gpt-4o-mini (default, cheapest), gpt-4o, gpt-4-turbo, gpt-3.5-turbo.

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
- Check your internet connection

### Large files

Recordings over 25MB are automatically split into chunks.

## Privacy

- API keys are stored in VS Code's secure storage (system keychain)
- Audio goes directly to OpenAI or your local API
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
