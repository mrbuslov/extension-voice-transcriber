# Changelog

All notable changes to the Voice Transcriber extension will be documented in this file.

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
