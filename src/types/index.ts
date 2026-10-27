import * as os from 'os';

export type Provider = 'openai' | 'openrouter' | 'local' | 'docker';

export interface ModelOption {
  id: string;
  label: string;
}

export interface TranscriptionModelOption extends ModelOption {
  /** Verified against the live API, not taken from vendor docs */
  supportsTimestamps: boolean;
  hint: string | null;
}

export interface TranscriptSegment {
  /** Seconds from the start of the whole recording, already offset across chunks */
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  /** Empty when the chosen model cannot produce timestamps */
  segments: TranscriptSegment[];
}

/** openaiMultipart: OpenAI's /audio/transcriptions form. rawBody: audio bytes as the body, language as a query param. */
export type TranscriptionRequestFormat = 'openaiMultipart' | 'rawBody';

export interface ProviderConfig {
  label: string;
  hint: string | null;
  requiresApiKey: boolean;
  keyPlaceholder: string;
  keysUrl: string;
  /** null → transcription URL comes from the user's localApiUrl setting */
  transcriptionUrl: string | null;
  /** null → provider has no chat endpoint, so LLM cleanup is unavailable */
  chatUrl: string | null;
  extraHeaders: Record<string, string>;
  requestFormat: TranscriptionRequestFormat;
  /** Audio seconds per chunk when a file has to be split — bounded by the provider's request timeout */
  chunkSeconds: number;
  /** Per-request abort deadline. Must clear the provider's worst-case latency for one chunk. */
  requestTimeoutMs: number;
  /** OpenAI starts returning 429 above 5; a server that transcribes one request at a time needs 1 */
  maxParallelChunks: number;
  transcriptionModels: TranscriptionModelOption[];
  cleanupModels: ModelOption[];
}

export const DOCKER_WHISPER = {
  containerName: 'voice-transcriber-whisper',
  imageRepository: 'voice-transcriber-whisper',
  modelsVolume: 'voice-transcriber-whisper-models',
  /** Off the common 8000/9000 so it doesn't collide with other local services */
  hostPort: 47913,
  containerPort: 9000,
};

export interface DockerWhisperModel {
  /** faster-whisper model name, passed to the container as WHISPER_MODEL */
  id: string;
  label: string;
  hint: string;
  downloadSize: string;
  /** Docker --memory: weights plus decoding buffers, measured peak RSS with headroom */
  memoryLimit: string;
}

/** First entry is the default */
export const DOCKER_WHISPER_MODELS: DockerWhisperModel[] = [
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo (default)',
    hint: 'Best quality: keeps English words like Excel or DevTools in Latin inside Russian speech, with punctuation. About as fast as the audio plays on 3 threads. 1.6 GB download.',
    downloadSize: '1.6 GB',
    memoryLimit: '3g',
  },
  {
    id: 'small',
    label: 'Small',
    hint: 'About 2x faster than Turbo, but drops punctuation and spells many English words in Cyrillic. 490 MB download.',
    downloadSize: '490 MB',
    memoryLimit: '2g',
  },
  {
    id: 'base',
    label: 'Base',
    hint: 'Fastest and lightest, for short clear dictation. Garbles mixed-language speech. 150 MB download.',
    downloadSize: '150 MB',
    memoryLimit: '1g',
  },
];

export function findDockerWhisperModel(modelId: string): DockerWhisperModel {
  const model = DOCKER_WHISPER_MODELS.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`${modelId} is not a Docker Whisper model. Pick one in Settings.`);
  }
  return model;
}

/** A quarter of the cores, at most 4: past 4 threads ctranslate2 inside Docker gets slower, not faster */
export function defaultDockerCpuThreads(): number {
  return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 4)));
}

const OPENROUTER_ATTRIBUTION_HEADERS = {
  'HTTP-Referer': 'https://github.com/mrbuslov/extension-voice-transcriber',
  'X-Title': 'Voice Transcriber',
};

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  openai: {
    label: 'OpenAI',
    hint: null,
    requiresApiKey: true,
    keyPlaceholder: 'sk-...',
    keysUrl: 'https://platform.openai.com/api-keys',
    transcriptionUrl: 'https://api.openai.com/v1/audio/transcriptions',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    extraHeaders: {},
    requestFormat: 'openaiMultipart',
    chunkSeconds: 600,
    requestTimeoutMs: 60_000,
    maxParallelChunks: 5,
    transcriptionModels: [{ id: 'whisper-1', label: 'whisper-1', supportsTimestamps: true, hint: null }],
    cleanupModels: [
      { id: 'gpt-4.1-nano', label: 'gpt-4.1-nano (default)' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
      { id: 'gpt-4.1', label: 'gpt-4.1' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    hint: null,
    requiresApiKey: true,
    keyPlaceholder: 'sk-or-v1-...',
    keysUrl: 'https://openrouter.ai/keys',
    transcriptionUrl: 'https://openrouter.ai/api/v1/audio/transcriptions',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    extraHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    requestFormat: 'openaiMultipart',
    chunkSeconds: 300,
    // Routing + queueing on top of Whisper puts a 5-min chunk in the 25-60s range, and
    // measured runs exceed 60s under load — a tight deadline just burns retries
    requestTimeoutMs: 240_000,
    maxParallelChunks: 5,
    transcriptionModels: [
      { id: 'openai/whisper-1', label: 'Whisper 1 (default)', supportsTimestamps: true, hint: null },
      { id: 'openai/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo', supportsTimestamps: true, hint: null },
      { id: 'deepgram/nova-3', label: 'Deepgram Nova-3', supportsTimestamps: true, hint: null },
      { id: 'openai/gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (no timestamps)', supportsTimestamps: false, hint: null },
      { id: 'openai/gpt-4o-transcribe', label: 'GPT-4o Transcribe (no timestamps)', supportsTimestamps: false, hint: null },
      { id: 'mistralai/voxtral-mini-transcribe', label: 'Voxtral Mini Transcribe (no timestamps)', supportsTimestamps: false, hint: null },
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
    hint: null,
    requiresApiKey: false,
    keyPlaceholder: '',
    keysUrl: '',
    transcriptionUrl: null,
    chatUrl: null,
    extraHeaders: {},
    requestFormat: 'openaiMultipart',
    chunkSeconds: 600,
    requestTimeoutMs: 60_000,
    maxParallelChunks: 5,
    transcriptionModels: [{ id: 'whisper-1', label: 'whisper-1', supportsTimestamps: false, hint: null }],
    cleanupModels: [],
  },
  docker: {
    label: 'Docker (local Whisper)',
    hint:
      'Runs Whisper on your CPU in a Docker container, audio never leaves your machine. Needs Docker running. ' +
      'The first run builds the image and downloads the chosen model.',
    requiresApiKey: false,
    keyPlaceholder: '',
    keysUrl: '',
    transcriptionUrl: `http://127.0.0.1:${DOCKER_WHISPER.hostPort}/transcribe`,
    chatUrl: null,
    extraHeaders: {},
    requestFormat: 'rawBody',
    // Short chunks: CPU transcription is slow, and progress only moves once per chunk
    chunkSeconds: 120,
    requestTimeoutMs: 600_000,
    maxParallelChunks: 1,
    transcriptionModels: DOCKER_WHISPER_MODELS.map(({ id, label, hint }) => ({ id, label, hint, supportsTimestamps: true })),
    cleanupModels: [],
  },
};

export function defaultModel(models: ModelOption[]): string {
  if (models.length === 0) {
    throw new Error('Provider has no models configured');
  }
  return models[0].id;
}

export function findTranscriptionModel(provider: Provider, modelId: string): TranscriptionModelOption {
  const model = PROVIDERS[provider].transcriptionModels.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(
      `${modelId} is not a valid transcription model for ${PROVIDERS[provider].label}. Pick one in Settings.`
    );
  }
  return model;
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
  dockerCpuThreads: number;
}

export const defaultSettings: TranscriberSettings = {
  provider: 'openai',
  localApiUrl: 'http://localhost:8000/v1/audio/transcriptions',
  language: '',
  enableCleanup: false,
  cleanupModel: defaultModel(PROVIDERS.openai.cleanupModels),
  transcriptionModel: defaultModel(PROVIDERS.openai.transcriptionModels),
  dockerCpuThreads: defaultDockerCpuThreads(),
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
  | { type: 'transcriptionComplete'; text: string; cleaned?: string; hasTimestamps: boolean }
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
  | { type: 'saveSession'; session: RecordingSession | null }
  | { type: 'copyToClipboard'; text: string }
  | { type: 'copyWithTimestamps' }
  | { type: 'insertToEditor'; text: string }
  | { type: 'saveAudio'; audioData: string; mimeType: string }
  /** mimeType is "" when the browser can't map the extension; ffmpeg then probes the content */
  | { type: 'uploadAudio'; audio: Uint8Array; mimeType: string; filename: string }
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
