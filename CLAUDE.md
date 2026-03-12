# Voice Transcriber - VS Code Extension

## Before EVERY release (non-negotiable)

1. Update `changelog.md` with new version entry
2. Bump version in `package.json`
3. Run `npm run compile` - must pass clean
4. Commit and push to GitHub
5. Only then publish to marketplace

## Publishing

```bash
npx @vscode/vsce publish -p "<PAT>"
```

PAT is stored in `.env` file. Never commit `.env`.

## Architecture

- `src/VoiceTranscriberPanel.ts` - main panel: HTML template + message handler
- `src/types/index.ts` - all TypeScript types, message types (MessageToWebview / MessageFromWebview)
- `webview/main.js` - webview UI logic (vanilla JS, no framework)
- `webview/styles.css` - styles using VS Code CSS variables
- `webview/recorder.js` - browser-based audio recording fallback
- `src/services/` - backend services (whisper, openai, audio recorder, storage)

## When adding new webview features

1. Add HTML in `_getHtmlForWebview()` in `VoiceTranscriberPanel.ts`
2. Add element ref in `elements` object in `webview/main.js`
3. Add event listener in `setupEventListeners()`
4. If new message type needed - add to `MessageFromWebview` or `MessageToWebview` in `src/types/index.ts`
5. Handle message in `_handleMessage()` in `VoiceTranscriberPanel.ts`

## Testing

No automated tests. Test manually in Extension Development Host (F5).
After changes to .ts files: `npm run compile` + reload Extension Development Host window.
Webview .js/.css changes: just reopen the panel.
