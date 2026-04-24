import * as vscode from 'vscode';
import { StorageService } from './services/storageService';
import { WhisperService } from './services/whisperService';
import { OpenAIService } from './services/openaiService';
import { AudioRecorderService } from './services/audioRecorderService';
import { BrowserRecorderService } from './services/browserRecorderService';
import {
  MessageFromWebview,
  MessageToWebview,
  HistoryEntry,
  RecordingCapabilities,
} from './types';

export class VoiceTranscriberPanel {
  public static readonly viewType = 'voiceTranscriber.panel';
  private static currentPanel: VoiceTranscriberPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _storage: StorageService;
  private readonly _whisper: WhisperService;
  private readonly _openai: OpenAIService;
  private readonly _audioRecorder: AudioRecorderService;
  private readonly _browserRecorder: BrowserRecorderService;
  private _recordingTimer: NodeJS.Timeout | null = null;
  private _lastAudioBuffer: Buffer | null = null;
  private _lastAudioMimeType: string | null = null;
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
    this._whisper = new WhisperService(this._storage);
    this._openai = new OpenAIService(this._storage);
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
        await this._storage.setApiKey(message.key);
        break;

      case 'getApiKey':
        const hasKey = !!(await this._storage.getApiKey());
        this._postMessage({ type: 'apiKeyLoaded', hasKey });
        break;

      case 'transcribe':
        await this._handleTranscription(message.audioData, message.mimeType);
        break;

      case 'saveSession':
        await this._storage.saveRecordingSession(message.session);
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
        await this._handleTranscription(message.audioData, message.mimeType);
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

    // Load API key status async (don't block UI)
    this._loadApiKeyStatus();
  }

  private async _loadApiKeyStatus() {
    try {
      const hasKey = !!(await Promise.race([
        this._storage.getApiKey(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
      ]));
      this._postMessage({ type: 'apiKeyLoaded', hasKey });
    } catch {
      this._postMessage({ type: 'apiKeyLoaded', hasKey: false });
    }
  }

  private async _startRecording(): Promise<void> {
    try {
      this._lastAudioBuffer = null;
      this._lastAudioMimeType = null;
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
      const audioData = buffer.toString('base64');

      // Log WAV duration for diagnostics (16kHz, 16-bit mono = 32000 bytes/sec, minus 44-byte header)
      const wavHeaderSize = 44;
      const bytesPerSecond = 16000 * 2; // 16kHz * 16-bit
      const audioDurationSec = Math.max(0, (buffer.length - wavHeaderSize) / bytesPerSecond);
      console.log(`[VoiceTranscriber] WAV file: ${buffer.length} bytes, ~${audioDurationSec.toFixed(1)}s duration`);

      // Notify webview that recording stopped (no audio data — kept in extension)
      this._postMessage({ type: 'recordingStopped' });

      await this._handleTranscription(audioData, mimeType);
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

      // Proceed to transcription
      const audioData = buffer.toString('base64');
      await this._handleTranscription(audioData, mimeType);
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

  private async _handleTranscription(audioData: string, mimeType: string) {
    try {
      this._postMessage({ type: 'transcriptionStart' });

      const settings = this._storage.getSettings();
      const audioBuffer = Buffer.from(audioData, 'base64');

      this._postMessage({ type: 'transcriptionProgress', message: 'Transcribing audio...' });

      const rawText = await this._whisper.transcribe(audioBuffer, mimeType, settings, (message, progress) => {
        this._postMessage({ type: 'transcriptionProgress', message, progress });
      });

      let cleanedText: string | undefined;

      if (settings.enableCleanup && settings.provider === 'openai') {
        this._postMessage({ type: 'transcriptionProgress', message: 'Cleaning up text...' });
        try {
          cleanedText = await this._openai.cleanupText(rawText, settings.cleanupModel);
        } catch {
          vscode.window.showWarningMessage('Text cleanup failed. Showing original transcription.');
        }
      }

      this._postMessage({
        type: 'transcriptionComplete',
        text: rawText,
        cleaned: cleanedText,
      });

      await this._storage.saveRecordingSession(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transcription failed';
      this._postMessage({ type: 'transcriptionError', message });
      vscode.window.showErrorMessage(message);
    }
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
    <!-- Settings Section -->
    <section class="collapsible" id="settings-section">
      <header class="section-header" data-toggle="settings-content">
        <span class="section-icon">&#9881;</span>
        <span>Settings</span>
        <span class="toggle-icon">&#9660;</span>
      </header>
      <div class="section-content" id="settings-content">
        <div class="form-group">
          <label for="provider">Provider</label>
          <select id="provider">
            <option value="openai">OpenAI</option>
            <option value="local">Local/Custom</option>
          </select>
        </div>

        <div class="form-group" id="api-key-group">
          <label for="api-key">API Key</label>
          <div class="api-key-row">
            <input type="password" id="api-key" placeholder="Enter your OpenAI API key">
            <button id="toggle-api-key" class="icon-button" title="Show/Hide">&#128065;</button>
            <button id="save-api-key" class="icon-button" title="Save">&#128190;</button>
          </div>
          <span id="api-key-status" class="status-text"></span>
        </div>

        <div class="form-group" id="local-url-group" style="display: none;">
          <label for="local-url">Whisper API URL</label>
          <input type="text" id="local-url" placeholder="http://localhost:8000/v1/audio/transcriptions">
          <small class="hint">Must be Whisper-compatible API</small>
        </div>

        <div class="form-group" id="cleanup-group">
          <label class="checkbox-label">
            <input type="checkbox" id="enable-cleanup">
            Clean up text with LLM
          </label>
        </div>

        <details class="advanced-settings">
          <summary>Advanced Settings</summary>
          <div class="form-group" id="cleanup-model-group">
            <label for="cleanup-model">LLM Model</label>
            <select id="cleanup-model">
              <option value="gpt-4.1-nano">gpt-4.1-nano (default)</option>
              <option value="gpt-4.1-mini">gpt-4.1-mini</option>
              <option value="gpt-4.1">gpt-4.1</option>
            </select>
          </div>
          <div class="form-group">
            <label for="language">Language</label>
            <select id="language">
              <option value="">Auto-detect</option>
              <option value="en">English</option>
              <option value="ru">Russian</option>
              <option value="uk">Ukrainian</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="pl">Polish</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese</option>
            </select>
          </div>
        </details>
      </div>
    </section>

    <!-- Recording Section -->
    <section id="recording-section">
      <div id="recording-header">
        <div id="recording-status">Ready to Record</div>
        <button id="download-audio-btn" class="icon-button" style="display: none;" title="Download Audio">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
          </svg>
        </button>
      </div>
      <div id="timer">00:00:00</div>
      <div id="recording-controls">
        <button id="start-btn" class="record-btn primary" title="Start Recording">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </button>
        <button id="pause-btn" class="record-btn" style="display: none;" title="Pause">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
          </svg>
        </button>
        <button id="resume-btn" class="record-btn" style="display: none;" title="Resume">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </button>
        <button id="stop-btn" class="record-btn danger" style="display: none;" title="Stop">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h12v12H6z"/>
          </svg>
        </button>
        <button id="save-audio-btn" class="record-btn" style="display: none;" title="Save Audio">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z"/>
          </svg>
        </button>
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
        <div class="permission-error-icon">&#9888;</div>
        <div class="permission-error-title">Microphone Access Denied</div>
        <div id="permission-error-instructions" class="permission-error-instructions"></div>
        <button id="permission-error-dismiss" class="text-button">Dismiss</button>
      </div>
    </section>

    <!-- Transcription Section -->
    <section id="transcription-section" style="display: none;">
      <header class="section-header">
        <span class="section-icon">&#128221;</span>
        <span>Transcription</span>
        <div class="section-header-actions">
          <button id="edit-toggle-btn" class="icon-button active" title="Edit transcription">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
            </svg>
          </button>
          <button id="insert-btn" class="icon-button" title="Insert text into active file">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
            </svg>
          </button>
          <button id="copy-btn" class="icon-button" title="Copy text to clipboard">&#128203;</button>
        </div>
      </header>
      <div id="transcription-content">
        <textarea id="transcription-text" placeholder="Transcription will appear here..."></textarea>
      </div>
    </section>

    <!-- Upload Audio Section -->
    <section class="collapsible" id="upload-section">
      <header class="section-header" data-toggle="upload-content">
        <span class="section-icon">&#128228;</span>
        <span>Upload Audio</span>
        <span class="toggle-icon">&#9660;</span>
      </header>
      <div class="section-content collapsed" id="upload-content">
        <div class="upload-area" id="upload-area">
          <input type="file" id="audio-file-input" accept=".mp3,.wav,.m4a,.mp4,.webm,.ogg,.oga,.flac,.mkv,.mov,.avi,audio/*,video/*" style="display: none;">
          <label for="audio-file-input" class="upload-label">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9 16h6v-6h4l-7-7-7 7h4v6zm-4 2h14v2H5v-2z"/>
            </svg>
            <span>Click to upload audio file</span>
            <span class="upload-formats">Audio: MP3, WAV, M4A, WebM, OGG, FLAC &nbsp;&middot;&nbsp; Video: MP4, MKV, MOV, AVI</span>
          </label>
        </div>
      </div>
    </section>

    <!-- History Section -->
    <section class="collapsible" id="history-section">
      <header class="section-header" data-toggle="history-content">
        <span class="section-icon">&#128218;</span>
        <span>History</span>
        <span class="toggle-icon">&#9660;</span>
      </header>
      <div class="section-content collapsed" id="history-content">
        <div id="history-list"></div>
        <button id="clear-history-btn" class="text-button" style="display: none;">Clear History</button>
      </div>
    </section>

    <!-- Session Recovery Modal -->
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
