# Changelog

All notable changes to the Voice Transcriber extension will be documented in this file.

## [0.1.8] - 2026-02-25

### Added
- Native OpenRouter audio transcription support using multimodal models (like `google/gemini-2.5-flash`) via the `/chat/completions` endpoint

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
