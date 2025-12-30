export interface TranscriberSettings {
  provider: 'openai' | 'local';
  localApiUrl: string;
  language: string;
  enableCleanup: boolean;
  cleanupModel: 'gpt-4.1-nano' | 'gpt-4.1-mini' | 'gpt-4.1';
}

export const defaultSettings: TranscriberSettings = {
  provider: 'openai',
  localApiUrl: 'http://localhost:8000/v1/audio/transcriptions',
  language: '',
  enableCleanup: true,
  cleanupModel: 'gpt-4.1-nano',
};

export interface HistoryEntry {
  id: string;
  date: string;
  text: string;
  preview: string;
  duration: number;
}

export interface RecordingSession {
  startTime: number;
  audioData: string;
  isPaused: boolean;
  elapsedTime: number;
}

export interface RecordingCapabilities {
  hasNativeRecording: boolean;
  hasBrowserFallback: boolean;
  installInstructions: string;
  platform: string;
}

export type MessageToWebview =
  | { type: 'settingsLoaded'; data: TranscriberSettings }
  | { type: 'historyLoaded'; data: HistoryEntry[] }
  | { type: 'apiKeyLoaded'; hasKey: boolean }
  | { type: 'uiStateLoaded'; data: Record<string, unknown> }
  | { type: 'recordingCapabilities'; data: RecordingCapabilities }
  | { type: 'recordingStarted' }
  | { type: 'recordingStopped' }
  | { type: 'recordingError'; message: string; showBrowserFallback: boolean }
  | { type: 'recordingTime'; elapsed: number }
  | { type: 'transcriptionStart' }
  | { type: 'transcriptionProgress'; message: string }
  | { type: 'transcriptionComplete'; text: string; cleaned?: string }
  | { type: 'transcriptionError'; message: string }
  | { type: 'sessionRecovery'; session: RecordingSession }
  | { type: 'copied' }
  | { type: 'permissionDenied'; platform: string };

export type MessageFromWebview =
  | { type: 'ready' }
  | { type: 'saveSettings'; data: Partial<TranscriberSettings> }
  | { type: 'saveApiKey'; key: string }
  | { type: 'getApiKey' }
  | { type: 'saveUiState'; data: Record<string, unknown> }
  | { type: 'startRecording' }
  | { type: 'stopRecording' }
  | { type: 'cancelRecording' }
  | { type: 'startBrowserRecording' }
  | { type: 'transcribe'; audioData: string; mimeType: string }
  | { type: 'saveSession'; session: RecordingSession | null }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'saveAudio'; audioData: string; mimeType: string }
  | { type: 'addToHistory'; entry: Omit<HistoryEntry, 'id'> }
  | { type: 'clearHistory' }
  | { type: 'showError'; message: string }
  | { type: 'microphonePermissionDenied' };

export const LANGUAGES = [
  { code: '', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'pl', label: 'Polish' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];
