export type Provider = 'openai' | 'openrouter' | 'local';

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderConfig {
  label: string;
  requiresApiKey: boolean;
  keyPlaceholder: string;
  keysUrl: string;
  /** null → transcription URL comes from the user's localApiUrl setting */
  transcriptionUrl: string | null;
  /** null → provider has no chat endpoint, so LLM cleanup is unavailable */
  chatUrl: string | null;
  extraHeaders: Record<string, string>;
  /** Audio seconds per chunk when a file has to be split — bounded by the provider's request timeout */
  chunkSeconds: number;
  transcriptionModels: ModelOption[];
  cleanupModels: ModelOption[];
}

const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/mrbuslov/extension-voice-transcriber',
  'X-Title': 'Voice Transcriber',
};

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    keysUrl: 'https://platform.openai.com/api-keys',
    transcriptionUrl: 'https://api.openai.com/v1/audio/transcriptions',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    extraHeaders: {},
    chunkSeconds: 600,
    transcriptionModels: [{ id: 'whisper-1', label: 'whisper-1' }],
    cleanupModels: [
      { id: 'gpt-4.1-nano', label: 'gpt-4.1-nano (default)' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    requiresApiKey: true,
    keyPlaceholder: 'sk-or-v1-...',
    keysUrl: 'https://openrouter.ai/keys',
    transcriptionUrl: 'https://openrouter.ai/api/v1/audio/transcriptions',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    extraHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    // OpenRouter aborts upstream calls at 60s, so keep chunks well under what Whisper needs for 10 min
    chunkSeconds: 300,
    transcriptionModels: [
      { id: 'openai/whisper-1', label: 'Whisper 1 (default)' },
      { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' },
      { id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe' },
      { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe' },
      { id: 'deepgram/nova-3', label: 'Deepgram Nova-3' },
      { id: 'mistralai/voxtral-mini-transcribe', label: 'Voxtral Mini Transcribe' },
    ],
    cleanupModels: [
      { id: 'openai/gpt-4.1-nano', label: 'gpt-4.1-nano (default)' },
      { id: 'openai/gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { id: 'google/gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite' },
      { id: 'anthropic/claude-haiku-4.5', label: 'claude-haiku-4.5' },
      { id: 'meta-llama/llama-3.3-70b-instruct', label: 'llama-3.3-70b' },
    ],
  },
  local: {
    label: 'Local/Custom',
    requiresApiKey: false,
    keyPlaceholder: '',
    keysUrl: '',
    transcriptionUrl: null,
    chatUrl: null,
    extraHeaders: {},
    chunkSeconds: 600,
    transcriptionModels: [{ id: 'whisper-1', label: 'whisper-1' }],
    cleanupModels: [],
  },
};

export function defaultModel(models: ModelOption[]): string {
  if (models.length === 0) {
    throw new Error('Provider has no models configured');
  }
  return models[0].id;
}

export function assertModelSupported(
  models: ModelOption[],
  modelId: string,
  provider: Provider,
  kind: string
): void {
  if (!models.some((model) => model.id === modelId)) {
    throw new Error(
      `${modelId} is not a valid ${kind} model for ${PROVIDERS[provider].label}. Pick one in Settings.`
    );
  }
}

export interface TranscriberSettings {
  provider: Provider;
  localApiUrl: string;
  language: string;
  enableCleanup: boolean;
  cleanupModel: string;
  transcriptionModel: string;
}

export const defaultSettings: TranscriberSettings = {
  provider: 'openai',
  localApiUrl: 'http://localhost:8000/v1/audio/transcriptions',
  language: '',
  enableCleanup: false,
  cleanupModel: defaultModel(PROVIDERS.openai.cleanupModels),
  transcriptionModel: defaultModel(PROVIDERS.openai.transcriptionModels),
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
  | { type: 'apiKeyLoaded'; provider: Provider; hasKey: boolean }
  | { type: 'uiStateLoaded'; data: Record<string, unknown> }
  | { type: 'recordingCapabilities'; data: RecordingCapabilities }
  | { type: 'recordingStarted' }
  | { type: 'recordingStopped'; audioData?: string; mimeType?: string }
  | { type: 'recordingError'; message: string; showBrowserFallback: boolean }
  | { type: 'recordingTime'; elapsed: number }
  | { type: 'transcriptionStart' }
  | { type: 'transcriptionProgress'; message: string; progress?: number }
  | { type: 'transcriptionComplete'; text: string; cleaned?: string }
  | { type: 'transcriptionError'; message: string }
  | { type: 'partialTranscription'; text: string }
  | { type: 'sessionRecovery'; session: RecordingSession }
  | { type: 'copied' }
  | { type: 'permissionDenied'; platform: string };

export type MessageFromWebview =
  | { type: 'ready' }
  | { type: 'saveSettings'; data: Partial<TranscriberSettings> }
  | { type: 'saveApiKey'; provider: Provider; key: string }
  | { type: 'deleteApiKey'; provider: Provider }
  | { type: 'getApiKey'; provider: Provider }
  | { type: 'saveUiState'; data: Record<string, unknown> }
  | { type: 'startRecording' }
  | { type: 'stopRecording' }
  | { type: 'cancelRecording' }
  | { type: 'startBrowserRecording' }
  | { type: 'transcribe'; audioData: string; mimeType: string }
  | { type: 'saveSession'; session: RecordingSession | null }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'insertToEditor'; text: string }
  | { type: 'saveAudio'; audioData: string; mimeType: string }
  | { type: 'uploadAudio'; audioData: string; mimeType: string; filename: string }
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
