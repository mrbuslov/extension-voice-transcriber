# Changelog

All notable changes to the Voice Transcriber extension will be documented in this file.

## [1.1.0] - 2026-08-13

### Added
- **OpenRouter provider** — pick "OpenRouter" in Settings and paste an `sk-or-v1-...` key to run both transcription and LLM cleanup through one key and one bill
- **Transcription model picker** (Advanced Settings, OpenRouter only) — Whisper 1, Whisper Large v3 Turbo, GPT-4o Transcribe, GPT-4o Mini Transcribe, Deepgram Nova-3, Voxtral Mini Transcribe
- Keys are now stored **per provider**, so switching between OpenAI and OpenRouter no longer overwrites the other key. An existing key is migrated to the OpenAI slot on first launch
- "Get an API key" link and a delete button next to the key field; Enter in the key field saves it

### Changed
- Providers, models, endpoints and languages now come from one registry in `src/types/index.ts` instead of being duplicated across the webview HTML and the services
- Long files split into 5-minute chunks on OpenRouter (down from 10) — OpenRouter cuts off upstream requests at 60 seconds
- Cleanup failures now say why in the warning instead of just "cleanup failed"

## [1.0.3] - 2026-05-01

### Added
- Drag-and-drop audio/video files onto the upload area to transcribe — no need to click and navigate the file picker. Drop zone visually highlights while dragging.

## [1.0.2] - 2026-05-01

### Changed
- UI polish during recording — pulsing red dot before "Recording..." status and animated rings expanding from the stop button make it obvious the mic is live
- Timer redesigned — switched from `Courier New` to system monospace with `tabular-nums`, so digits no longer jitter as time ticks; turns red while recording
- Drag-and-drop upload area now lifts subtly on hover with a bouncy icon, instead of a static dashed box
- History items lift on hover and show an accent line on the left
- Record buttons gained press-down feedback (scale on `:active`) for a more tactile feel
- All changes use VS Code theme variables — works correctly across dark, light, and high-contrast themes

## [1.0.1] - 2026-04-28

### Fixed
- Long files (50+ min) no longer hang on "Transcribing audio..." — all medium/large files now route through chunking instead of trying a single big API call that times out
- Lowered parallel chunk limit from 20 to 5 to stay under OpenAI rate limits and avoid wasteful 429 retries

## [1.0.0] - 2026-04-24

### Breaking
- Recording now requires **ffmpeg** instead of sox/arecord. Existing users must install ffmpeg:
  - macOS:   `brew install ffmpeg`
  - Linux:   `sudo apt install ffmpeg`
  - Windows: `winget install ffmpeg`
  Browser-based recording still works with no install required.

### Added
- **Video file upload** (MP4, MKV, MOV, AVI, WebM) — audio track is extracted automatically
- **Proper chunking for long files** — uploads over 24 MB are transcoded to 128 kbps MP3 and split into 10-minute chunks. A 1-hour recording now transcribes correctly instead of failing with "Invalid file format"
- **Parallel chunk transcription** — up to 20 chunks transcribed in parallel (a 1-hour recording now finishes in the time of one API request, not six)
- **Progress bar** — visual bar fills as chunks complete, with live "Transcribed N/M chunks..." status
- **Automatic retry** — 429 (rate limit) and 5xx errors retry with exponential backoff (up to 5 attempts), respecting the `Retry-After` header when provided
- **Request timeout** — each Whisper request aborts and retries after 60s to avoid hanging indefinitely on stuck connections
- Clearer error when microphone is unavailable (vs. ffmpeg missing)
- ffmpeg stderr is captured and surfaced on recording failures

### Changed
- Single recording tool across all platforms: macOS, Linux, and Windows all use ffmpeg
- Linux recording defaults to PulseAudio/PipeWire; falls back to ALSA if Pulse not available
- Windows auto-detects first audio input device via DirectShow

### Migration
If you had sox or arecord installed only for this extension, you can uninstall them after installing ffmpeg. The extension no longer uses sox, rec, or arecord.

## [0.1.11] - 2026-04-14

### Fixed
- Uploading M4A/MP4/OGG/FLAC files now works correctly (was rejected by Whisper API due to wrong file extension)
- Unknown audio formats now raise a clear error instead of silently sending as MP3
- Save audio dialog now uses correct file extension for all formats

## [0.1.10] - 2026-03-17

### Fixed
- Long recordings (3+ min) no longer truncate - fixed pipe buffer deadlock that caused sox to stop capturing audio
- Recording stop is now faster and more reliable (SIGINT instead of SIGTERM)
- Added WAV duration logging for diagnostics

## [0.1.9] - 2025-03-12

### Added
- Editable transcription - edit text directly after transcription (toggle between edit and read-only mode)
- Insert to Editor button - insert transcription text at cursor position in active file
- Tooltips on all transcription action buttons

## [0.1.7] - 2025-02-12

### Fixed
- Long recordings (3-5+ min) no longer hang on "Stopping..." - audio data is now kept in extension instead of being sent through webview postMessage which silently dropped large payloads
- Download button now always saves the current recording, not a stale previous one
- SIGKILL fallback now actually fires when recording process doesn't respond to SIGTERM
- Added 15-second timeout on stop operation to prevent infinite hangs
- Download button is now hidden when a new recording starts

## [0.1.6] - 2025-02-04

### Fixed
- Download audio now saves with correct file extension (.wav/.mp3/.webm)
- Buttons no longer squish at narrow window widths
- Improved error logging for transcription failures

## [0.1.5] - 2025-02-04

### Fixed
- Recording state now restores correctly when webview reloads

## [0.1.4] - 2025-02-03

### Added
- Download audio button (appears after recording stops)
- Upload audio section for transcribing existing files (MP3, WAV, M4A, WebM)
- Tab icon for the panel

### Fixed
- Panel now loads properly on VS Code restart
- Recording stop timeout with SIGKILL fallback for long recordings

## [0.1.3] - 2025-01-27

### Fixed
- Fixed recording start/stop on macOS when using full Homebrew paths for sox

## [0.1.2] - 2025-01-26

### Fixed
- Sox detection on macOS now checks Homebrew paths directly (`/opt/homebrew/bin` for Apple Silicon, `/usr/local/bin` for Intel) since VS Code extensions don't inherit shell PATH

## [0.1.1] - 2025-01-26

### Fixed
- LLM cleanup is now disabled by default
- Improved cleanup prompt

## [0.1.0] - 2024-12-30

### Added
- Initial release
- Voice recording with real-time audio visualization
- Timer display during recording (HH:MM:SS)
- Pause/resume recording support
- OpenAI Whisper API integration
- Local/custom Whisper-compatible API support
- Automatic chunking for large recordings (>25MB)
- LLM text cleanup (removes filler words, fixes punctuation)
- Model selection for cleanup (gpt-4o-mini, gpt-4o, gpt-4-turbo, gpt-3.5-turbo)
- Language selection (auto-detect + 12 languages)
- Auto-copy transcription to clipboard
- History of last 10 transcriptions
- Session recovery after unexpected VS Code closure
- Save audio as file
- Secure API key storage using VS Code secrets
- Dark/light theme support
