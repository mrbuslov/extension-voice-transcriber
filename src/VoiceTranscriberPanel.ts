import * as vscode from 'vscode';
import { StorageService } from './services/storageService';
import { WhisperService } from './services/whisperService';
import { DockerWhisperService } from './services/dockerWhisperService';
import { CleanupService } from './services/cleanupService';
import { AudioRecorderService } from './services/audioRecorderService';
import { BrowserRecorderService } from './services/browserRecorderService';
import {
  MessageFromWebview,
  MessageToWebview,
  HistoryEntry,
  RecordingCapabilities,
  TranscriptSegment,
  LANGUAGES,
  PROVIDERS,
  defaultDockerCpuThreads,
} from './types';
import * as os from 'os';
import { ICONS } from './webviewIcons';
import { TRANSCRIPT_FORMATS, formatTranscript, TranscriptFormatId } from './services/transcriptFormats';

export class VoiceTranscriberPanel {
  public static readonly viewType = 'voiceTranscriber.panel';
  private static currentPanel: VoiceTranscriberPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _storage: StorageService;
  private readonly _whisper: WhisperService;
  private readonly _cleanup: CleanupService;
  private readonly _audioRecorder: AudioRecorderService;
  private readonly _browserRecorder: BrowserRecorderService;
  private _recordingTimer: NodeJS.Timeout | null = null;
  private _lastAudioBuffer: Buffer | null = null;
  private _lastAudioMimeType: string | null = null;
  private _lastSegments: TranscriptSegment[] = [];
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext) {
    const column = vscode.ViewColumn.Two;

    if (VoiceTranscriberPanel.currentPanel) {
      VoiceTranscriberPanel.currentPanel._panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VoiceTranscriberPanel.viewType,
      'Voice Transcriber',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'webview'),
          vscode.Uri.joinPath(context.extensionUri, 'webview', 'lib'),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');

    VoiceTranscriberPanel.currentPanel = new VoiceTranscriberPanel(panel, context);
  }

  public static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    VoiceTranscriberPanel.currentPanel = new VoiceTranscriberPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = context.extensionUri;

    // Set tab icon (also needed for revive)
    this._panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.png');
    this._storage = new StorageService(context);
    this._whisper = new WhisperService(
      this._storage,
      new DockerWhisperService(vscode.Uri.joinPath(context.extensionUri, 'docker', 'whisper').fsPath)
    );
    this._cleanup = new CleanupService(this._storage);
    this._audioRecorder = new AudioRecorderService();
    this._browserRecorder = new BrowserRecorderService(context.extensionUri);

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message: MessageFromWebview) => this._handleMessage(message),
      null,
      this._disposables
    );
  }

  private async _handleMessage(message: MessageFromWebview) {
    switch (message.type) {
      case 'ready':
        await this._sendInitialData();
        break;

      case 'saveSettings':
        await this._storage.updateSettings(message.data);
        break;

      case 'saveApiKey':
        await this._storage.setApiKey(message.provider, message.key);
        this._postMessage({ type: 'apiKeyLoaded', provider: message.provider, hasKey: true });
        break;

      case 'deleteApiKey':
        await this._storage.deleteApiKey(message.provider);
        this._postMessage({ type: 'apiKeyLoaded', provider: message.provider, hasKey: false });
        break;

      case 'getApiKey': {
        const hasKey = !!(await this._storage.getApiKey(message.provider));
        this._postMessage({ type: 'apiKeyLoaded', provider: message.provider, hasKey });
        break;
      }

      case 'saveSession':
        await this._storage.saveRecordingSession(message.session);
        break;

      case 'copyWithTimestamps':
        await this._copyWithTimestamps();
        break;

      case 'copyToClipboard':
        await vscode.env.clipboard.writeText(message.text);
        vscode.window.showInformationMessage('Transcription copied to clipboard');
        this._postMessage({ type: 'copied' });
        break;

      case 'insertToEditor': {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          await editor.edit(editBuilder => {
            if (editor.selection.isEmpty) {
              editBuilder.insert(editor.selection.active, message.text);
            } else {
              editBuilder.replace(editor.selection, message.text);
            }
          });
        } else {
          vscode.window.showInformationMessage('Open a file first to insert transcription');
        }
        break;
      }

      case 'saveAudio':
        if (message.audioData) {
          await this._saveAudioFile(message.audioData, message.mimeType);
        } else if (this._lastAudioBuffer) {
          await this._saveAudioFile(
            this._lastAudioBuffer.toString('base64'),
            this._lastAudioMimeType || 'audio/wav'
          );
        }
        break;

      case 'uploadAudio':
        await this._handleTranscription(
          Buffer.from(message.audio.buffer, message.audio.byteOffset, message.audio.byteLength),
          message.mimeType
        );
        break;

      case 'addToHistory':
        const entry: HistoryEntry = {
          ...message.entry,
          id: Date.now().toString(),
        };
        await this._storage.addToHistory(entry);
        const history = this._storage.getHistory();
        this._postMessage({ type: 'historyLoaded', data: history });
        break;

      case 'clearHistory':
        await this._storage.clearHistory();
        this._postMessage({ type: 'historyLoaded', data: [] });
        break;

      case 'showError':
        vscode.window.showErrorMessage(message.message);
        break;

      case 'saveUiState':
        await this._storage.saveUiState(message.data);
        break;

      case 'microphonePermissionDenied':
        this._postMessage({ type: 'permissionDenied', platform: process.platform });
        break;

      case 'startRecording':
        await this._startRecording();
        break;

      case 'stopRecording':
        await this._stopRecording();
        break;

      case 'cancelRecording':
        this._cancelRecording();
        break;

      case 'startBrowserRecording':
        await this._startBrowserRecording();
        break;
    }
  }

  private async _sendInitialData() {
    // Send synchronous data immediately (don't block on async operations)
    const settings = this._storage.getSettings();
    const history = this._storage.getHistory();
    const session = this._storage.getRecordingSession();

    const capabilities: RecordingCapabilities = {
      hasNativeRecording: AudioRecorderService.isAvailable(),
      hasBrowserFallback: true,
      installInstructions: AudioRecorderService.getInstallInstructions(),
      platform: process.platform,
    };

    this._postMessage({ type: 'recordingCapabilities', data: capabilities });
    this._postMessage({ type: 'settingsLoaded', data: settings });
    this._postMessage({ type: 'historyLoaded', data: history });
    this._postMessage({ type: 'uiStateLoaded', data: this._storage.getUiState() });

    if (session) {
      this._postMessage({ type: 'sessionRecovery', session });
    }

    // Key status is requested by the webview per provider once settings are applied.

    // Restore recording state if recording is in progress
    if (this._audioRecorder.getIsRecording()) {
      this._postMessage({ type: 'recordingStarted' });
      // Restart the timer updates
      if (!this._recordingTimer) {
        this._recordingTimer = setInterval(() => {
          const elapsed = this._audioRecorder.getElapsedTime();
          this._postMessage({ type: 'recordingTime', elapsed });
        }, 100);
      }
    }
  }

  private async _startRecording(): Promise<void> {
    try {
      this._lastAudioBuffer = null;
      this._lastAudioMimeType = null;
      this._lastSegments = [];
      await this._audioRecorder.start();
      this._postMessage({ type: 'recordingStarted' });

      // Start timer to send elapsed time updates
      this._recordingTimer = setInterval(() => {
        const elapsed = this._audioRecorder.getElapsedTime();
        this._postMessage({ type: 'recordingTime', elapsed });
      }, 100);
    } catch (error) {
      this._stopRecordingTimer();
      const message = error instanceof Error ? error.message : 'Failed to start recording';

      let displayMessage = message;
      let showBrowserFallback = false;

      if (message === 'NO_RECORDING_TOOL') {
        displayMessage = `Recording requires ffmpeg.\n\nInstall it with:\n${AudioRecorderService.getInstallInstructions()}`;
        showBrowserFallback = true;
      } else if (message === 'NO_MIC_DEVICE') {
        displayMessage = 'Microphone not available. Check OS microphone permissions for VS Code.';
        showBrowserFallback = true;
      }

      this._postMessage({
        type: 'recordingError',
        message: displayMessage,
        showBrowserFallback,
      });
    }
  }

  private async _stopRecording(): Promise<void> {
    try {
      this._stopRecordingTimer();

      const stopTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Recording stop timed out')), 15000)
      );
      const { buffer, mimeType } = await Promise.race([
        this._audioRecorder.stop(),
        stopTimeout,
      ]);

      this._lastAudioBuffer = buffer;
      this._lastAudioMimeType = mimeType;

      // Log WAV duration for diagnostics (16kHz, 16-bit mono = 32000 bytes/sec, minus 44-byte header)
      const wavHeaderSize = 44;
      const bytesPerSecond = 16000 * 2; // 16kHz * 16-bit
      const audioDurationSec = Math.max(0, (buffer.length - wavHeaderSize) / bytesPerSecond);
      console.log(`[VoiceTranscriber] WAV file: ${buffer.length} bytes, ~${audioDurationSec.toFixed(1)}s duration`);

      // Notify webview that recording stopped (no audio data — kept in extension)
      this._postMessage({ type: 'recordingStopped' });

      await this._handleTranscription(buffer, mimeType);
    } catch (error) {
      this._lastAudioBuffer = null;
      this._lastAudioMimeType = null;
      const message = error instanceof Error ? error.message : 'Failed to stop recording';
      this._postMessage({ type: 'recordingError', message, showBrowserFallback: false });
    }
  }

  private _cancelRecording(): void {
    this._stopRecordingTimer();
    this._audioRecorder.cancel();
    this._lastAudioBuffer = null;
    this._lastAudioMimeType = null;
    this._postMessage({ type: 'recordingStopped' });
  }

  private async _startBrowserRecording(): Promise<void> {
    try {
      this._postMessage({ type: 'transcriptionProgress', message: 'Recording in browser...' });

      const { buffer, mimeType } = await this._browserRecorder.record();

      await this._handleTranscription(buffer, mimeType);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser recording failed';
      if (message !== 'Recording cancelled' && message !== 'Recording cancelled by user') {
        this._postMessage({ type: 'transcriptionError', message });
      }
    }
  }

  private _stopRecordingTimer(): void {
    if (this._recordingTimer) {
      clearInterval(this._recordingTimer);
      this._recordingTimer = null;
    }
  }

  private async _handleTranscription(audioBuffer: Buffer, mimeType: string) {
    try {
      this._postMessage({ type: 'transcriptionStart' });

      const settings = this._storage.getSettings();

      this._postMessage({ type: 'transcriptionProgress', message: 'Transcribing audio...' });

      const transcription = await this._whisper.transcribe(audioBuffer, mimeType, settings, (message, progress) => {
        this._postMessage({ type: 'transcriptionProgress', message, progress });
      });
      const rawText = transcription.text;
      this._lastSegments = transcription.segments;

      let cleanedText: string | undefined;

      if (settings.enableCleanup && PROVIDERS[settings.provider].chatUrl) {
        this._postMessage({ type: 'transcriptionProgress', message: 'Cleaning up text...' });
        try {
          cleanedText = await this._cleanup.cleanupText(rawText, settings);
        } catch (cleanupError) {
          const reason = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          vscode.window.showWarningMessage(
            `Text cleanup failed (${reason}). Showing original transcription.`
          );
        }
      }

      this._postMessage({
        type: 'transcriptionComplete',
        text: rawText,
        cleaned: cleanedText,
        hasTimestamps: this._lastSegments.length > 0,
      });

      await this._storage.saveRecordingSession(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed';
      this._postMessage({ type: 'transcriptionError', message });
      vscode.window.showErrorMessage(message);
    }
  }

  private async _copyWithTimestamps(): Promise<void> {
    if (this._lastSegments.length === 0) {
      vscode.window.showWarningMessage(
        'This transcription has no timestamps. Pick a transcription model that supports them in Settings.'
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(
      TRANSCRIPT_FORMATS.map((spec) => ({
        label: spec.label,
        description: spec.description,
        formatId: spec.id,
      })),
      {
        title: `Copy ${this._lastSegments.length} timestamped segments`,
        placeHolder: 'Pick a format',
      }
    );

    if (!picked) {
      return;
    }

    const content = formatTranscript(this._lastSegments, picked.formatId as TranscriptFormatId);
    await vscode.env.clipboard.writeText(content);
    vscode.window.showInformationMessage(`Copied as ${picked.label}`);
  }

  private async _saveAudioFile(audioData: string, mimeType: string) {
    const extension = mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3'
      : mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a'
      : mimeType.includes('webm') ? 'webm'
      : mimeType.includes('ogg') ? 'ogg'
      : mimeType.includes('flac') ? 'flac'
      : 'wav';
    const defaultName = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(defaultName),
      filters: {
        'Audio Files': [extension],
      },
    });

    if (uri) {
      const buffer = Buffer.from(audioData, 'base64');
      await vscode.workspace.fs.writeFile(uri, buffer);
      vscode.window.showInformationMessage(`Audio saved to ${uri.fsPath}`);
    }
  }

  private _postMessage(message: MessageToWebview) {
    this._panel.webview.postMessage(message);
  }

  private _update() {
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'main.js')
    );
    const recorderUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'recorder.js')
    );
    const lamejsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'webview', 'lib', 'lamejs.min.js')
    );

    const nonce = getNonce();

    const providerOptions = Object.entries(PROVIDERS)
      .map(([id, config]) => `<option value="${id}">${config.label}</option>`)
      .join('\n            ');
    const defaultThreads = defaultDockerCpuThreads();
    const dockerThreadOptions = Array.from({ length: os.availableParallelism() }, (_, i) => i + 1)
      .map((n) => `<option value="${n}">${n}${n === defaultThreads ? ' (default)' : ''}</option>`)
      .join('\n              ');
    const languageOptions = LANGUAGES.map(
      (lang) => `<option value="${lang.code}">${lang.label}</option>`
    ).join('\n              ');
    // Model lists are rebuilt client-side whenever the provider changes
    const providersJson = JSON.stringify(PROVIDERS).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src ${webview.cspSource} blob:; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>Voice Transcriber</title>
</head>
<body>
  <div id="app">
    <section id="recording-section">
      <div id="recording-header">
        <div id="recording-status">Ready</div>
        <button id="download-audio-btn" class="icon-button" style="display: none;" title="Download audio">${ICONS.download}</button>
      </div>
      <div id="timer">00:00:00</div>
      <div id="recording-controls">
        <button id="start-btn" class="record-btn primary" title="Start recording">${ICONS.mic}</button>
        <button id="pause-btn" class="record-btn" style="display: none;" title="Pause">${ICONS.pause}</button>
        <button id="resume-btn" class="record-btn" style="display: none;" title="Resume">${ICONS.play}</button>
        <button id="stop-btn" class="record-btn danger" style="display: none;" title="Stop">${ICONS.stop}</button>
        <button id="save-audio-btn" class="record-btn" style="display: none;" title="Save audio">${ICONS.save}</button>
      </div>
      <div id="progress-container" style="display: none;">
        <div class="progress-header">
          <div class="spinner"></div>
          <span id="progress-message">Processing...</span>
        </div>
        <div id="progress-bar" class="progress-bar" style="display: none;">
          <div id="progress-bar-fill" class="progress-bar-fill"></div>
        </div>
      </div>
      <div id="permission-error" class="permission-error" style="display: none;">
        <div class="permission-error-title">Microphone Access Denied</div>
        <div id="permission-error-instructions" class="permission-error-instructions"></div>
        <button id="permission-error-dismiss" class="text-button">Dismiss</button>
      </div>
    </section>

    <div class="upload-area" id="upload-area">
      <input type="file" id="audio-file-input" accept=".mp3,.wav,.m4a,.mp4,.webm,.ogg,.oga,.flac,.mkv,.mov,.avi,audio/*,video/*" style="display: none;">
      <label for="audio-file-input" class="upload-label" title="MP3, WAV, M4A, WebM, OGG, FLAC, MP4, MKV, MOV, AVI">
        ${ICONS.upload}
        <span>Drop an audio or video file, or <span class="upload-browse">browse</span></span>
      </label>
    </div>

    <section id="transcription-section" style="display: none;">
      <header class="transcript-header">
        <span class="section-title">Transcript</span>
        <div class="section-header-actions">
          <button id="edit-toggle-btn" class="icon-button active" title="Edit transcript">${ICONS.edit}</button>
          <button id="insert-btn" class="icon-button" title="Insert into the active file">${ICONS.insert}</button>
          <button id="copy-timestamps-btn" class="icon-button labeled-button" style="display: none;" title="Copy with timestamps: SRT, WebVTT, or plain text">${ICONS.clock}<span>SRT</span></button>
          <button id="copy-btn" class="icon-button" title="Copy text">${ICONS.copy}</button>
        </div>
      </header>
      <textarea id="transcription-text" placeholder="Transcript will appear here..."></textarea>
    </section>

    <section class="collapsible" id="settings-section">
      <header class="section-header" data-toggle="settings-content">
        <span class="toggle-icon">${ICONS.chevron}</span>
        <span class="section-title">Settings</span>
        <span id="settings-summary" class="section-summary"></span>
      </header>
      <div class="section-content" id="settings-content">
        <div class="form-group">
          <label for="provider">Provider</label>
          <select id="provider">
            ${providerOptions}
          </select>
          <small id="provider-hint" class="hint" style="display: none;"></small>
        </div>

        <div class="form-group" id="transcription-model-group">
          <label for="transcription-model">Model</label>
          <select id="transcription-model"></select>
          <small id="transcription-model-hint" class="hint" style="display: none;"></small>
        </div>

        <div class="form-group" id="api-key-group">
          <label for="api-key"><span id="api-key-label">API Key</span></label>
          <div class="api-key-row">
            <input type="password" id="api-key" placeholder="Enter your API key">
            <button id="toggle-api-key" class="icon-button" title="Show or hide">${ICONS.eye}</button>
            <button id="save-api-key" class="icon-button" title="Save key">${ICONS.check}</button>
            <button id="clear-api-key" class="icon-button" title="Remove saved key">${ICONS.trash}</button>
          </div>
          <span id="api-key-status" class="status-text"></span>
          <a id="api-key-link" class="hint hint-link" href="#" target="_blank" rel="noreferrer">Get an API key</a>
        </div>

        <div class="form-group" id="local-url-group" style="display: none;">
          <label for="local-url">Whisper API URL</label>
          <input type="text" id="local-url" placeholder="http://localhost:8000/v1/audio/transcriptions">
          <small class="hint">Must be a Whisper-compatible API</small>
        </div>

        <div class="form-group" id="cleanup-group">
          <label class="checkbox-label">
            <input type="checkbox" id="enable-cleanup">
            Clean up text with an LLM
          </label>
        </div>

        <details class="advanced-settings">
          <summary>Advanced</summary>
          <div class="form-group">
            <label for="language">Language</label>
            <select id="language">
              ${languageOptions}
            </select>
          </div>
          <div class="form-group" id="cleanup-model-group">
            <label for="cleanup-model">LLM model</label>
            <select id="cleanup-model"></select>
          </div>
          <div class="form-group" id="docker-threads-group" style="display: none;">
            <label for="docker-threads">CPU threads for Docker</label>
            <select id="docker-threads">
              ${dockerThreadOptions}
            </select>
            <small class="hint">More threads finish sooner but load your machine harder. The container stops after each transcription.</small>
          </div>
        </details>
      </div>
    </section>

    <section class="collapsible" id="history-section">
      <header class="section-header" data-toggle="history-content">
        <span class="toggle-icon">${ICONS.chevron}</span>
        <span class="section-title">History</span>
      </header>
      <div class="section-content collapsed" id="history-content">
        <div id="history-list"></div>
        <button id="clear-history-btn" class="text-button" style="display: none;">Clear history</button>
      </div>
    </section>

    <div id="recovery-modal" class="modal" style="display: none;">
      <div class="modal-content">
        <h3>Recording Recovery</h3>
        <p id="recovery-message">A recording was interrupted. Would you like to recover it?</p>
        <div class="modal-buttons">
          <button id="recover-btn" class="primary-button">Recover & Transcribe</button>
          <button id="download-recovered-btn" class="secondary-button">Download Audio</button>
          <button id="discard-btn" class="text-button">Discard</button>
        </div>
      </div>
    </div>
  </div>

  <template id="copy-icon">${ICONS.copy}</template>

  <script nonce="${nonce}">window.__PROVIDERS__ = ${providersJson};</script>
  <script nonce="${nonce}" src="${lamejsUri}"></script>
  <script nonce="${nonce}" src="${recorderUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose() {
    VoiceTranscriberPanel.currentPanel = undefined;

    // Clean up recording if in progress
    this._stopRecordingTimer();
    if (this._audioRecorder.getIsRecording()) {
      this._audioRecorder.cancel();
    }

    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
