import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StorageService } from './storageService';
import { PROVIDERS, TranscriberSettings, assertModelSupported } from '../types';
import { isFfmpegAvailable, runFfmpeg } from './ffmpeg';

const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24MB (leaving margin for 25MB limit)
const FAST_PATH_THRESHOLD = 5 * 1024 * 1024; // ≤5MB → single API call (fast path, no ffmpeg needed)
const CHUNK_BITRATE = '128k';
const MAX_PARALLEL_CHUNKS = 5; // Higher values trigger OpenAI rate limits (429), wasting time on retries
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1000;

export class WhisperService {
  constructor(private readonly storage: StorageService) {}

  async transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    onProgress?: (message: string, progress?: number) => void
  ): Promise<string> {
    const config = PROVIDERS[settings.provider];
    const apiKey = await this.storage.getApiKey(settings.provider);

    if (config.requiresApiKey && !apiKey) {
      throw new Error(`Please enter your ${config.label} API key in Settings.`);
    }
    assertModelSupported(
      config.transcriptionModels,
      settings.transcriptionModel,
      settings.provider,
      'transcription'
    );

    // Fast path: tiny file in a format Whisper accepts directly. Larger files always go
    // through ffmpeg so they get chunked + transcribed in parallel with progress feedback.
    if (audioBuffer.length <= FAST_PATH_THRESHOLD && isWhisperCompatible(mimeType)) {
      return this.transcribeSingle(audioBuffer, mimeType, settings, apiKey, 'single');
    }

    if (!isFfmpegAvailable()) {
      if (audioBuffer.length > MAX_FILE_SIZE) {
        throw new Error('Files over 24 MB require ffmpeg for chunking. Install ffmpeg to process this file.');
      }
      // Mid-sized file but no ffmpeg — try sending as-is, Whisper will reject if format unsupported
      return this.transcribeSingle(audioBuffer, mimeType, settings, apiKey, 'single');
    }

    return this.transcribeViaFfmpeg(audioBuffer, mimeType, settings, apiKey, onProgress);
  }

  private async transcribeSingle(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    apiKey: string | undefined,
    label: string = 'audio'
  ): Promise<string> {
    const extension = getExtension(mimeType);
    const config = PROVIDERS[settings.provider];
    const url = resolveTranscriptionUrl(settings);
    const requestTimeoutMs = config.requestTimeoutMs;

    const headers: Record<string, string> = { ...config.extraHeaders };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`[WhisperService:${label}] Sending ${audioBuffer.length} bytes to ${url}`);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Build fresh FormData per attempt - Blob + FormData aren't reliably reusable
      const blob = new Blob([audioBuffer], { type: mimeType });
      const formData = new FormData();
      formData.append('file', blob, `audio.${extension}`);
      formData.append('model', settings.transcriptionModel);
      if (settings.language) {
        formData.append('language', settings.language);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: formData,
          signal: controller.signal,
        });
      } catch (fetchError) {
        clearTimeout(timeoutId);
        const err = fetchError as Error;
        const elapsed = Date.now() - startedAt;
        const isTimeout = err.name === 'AbortError' || elapsed >= requestTimeoutMs - 100;
        const reason = isTimeout ? `timeout after ${elapsed}ms` : err.message;
        console.error(`[WhisperService:${label}] Fetch error (attempt ${attempt + 1}): ${reason}`);
        if (attempt < MAX_RETRIES) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw new Error(isTimeout ? `Request timed out after ${requestTimeoutMs}ms` : `Network error: ${err.message}`);
      }
      clearTimeout(timeoutId);

      if (response.ok) {
        const result = (await response.json()) as { text: string };
        console.log(`[WhisperService:${label}] Success in ${Date.now() - startedAt}ms, ${result.text.length} chars`);
        return result.text;
      }

      const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      const errorMessage =
        errorData.error?.message ||
        `Transcription failed with status ${response.status}`;

      const isRetryable = response.status === 429 || response.status >= 500;
      if (isRetryable && attempt < MAX_RETRIES) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        const delay = retryAfter ?? backoffDelay(attempt);
        console.warn(`[WhisperService:${label}] ${response.status} (attempt ${attempt + 1}), retrying in ${delay}ms: ${errorMessage}`);
        await sleep(delay);
        continue;
      }

      console.error(`[WhisperService:${label}] API error:`, errorMessage);
      throw new Error(errorMessage);
    }

    throw new Error('Transcription failed after maximum retries');
  }

  private async transcribeViaFfmpeg(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    apiKey: string | undefined,
    onProgress?: (message: string, progress?: number) => void
  ): Promise<string> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-transcriber-chunks-'));
    const inputExt = getExtension(mimeType) || 'bin';
    const inputPath = path.join(workDir, `input.${inputExt}`);
    const transcodedPath = path.join(workDir, 'audio.mp3');

    try {
      fs.writeFileSync(inputPath, audioBuffer);

      if (onProgress) onProgress('Extracting audio...');

      // Stage 1: transcode to MP3 (strips video, normalizes format)
      await runFfmpeg(
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', inputPath,
          '-vn',
          '-acodec', 'libmp3lame',
          '-b:a', CHUNK_BITRATE,
          '-ar', '16000',
          '-ac', '1',
          '-y',
          transcodedPath,
        ],
        { captureStderr: true }
      );

      // Stage 2: always split into time-based chunks. Even if the whole transcoded file
      // would fit in one request, chunking gives parallelism + progress feedback + safe
      // per-request timeouts (chunk length is capped per provider, see chunkSeconds).
      if (onProgress) onProgress('Splitting audio into chunks...', 0);
      const chunkPattern = path.join(workDir, 'chunk-%03d.mp3');
      await runFfmpeg(
        [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', transcodedPath,
          '-f', 'segment',
          '-segment_time', String(PROVIDERS[settings.provider].chunkSeconds),
          '-c', 'copy',
          '-y',
          chunkPattern,
        ],
        { captureStderr: true }
      );

      const chunkFiles = fs
        .readdirSync(workDir)
        .filter((name) => /^chunk-\d{3}\.mp3$/.test(name))
        .sort();

      if (chunkFiles.length === 0) {
        throw new Error('ffmpeg produced no chunks');
      }

      // Stage 3: transcribe chunks in parallel (bounded concurrency)
      const total = chunkFiles.length;
      let completed = 0;
      if (onProgress) onProgress(`Transcribing ${total} chunks in parallel...`, 0);

      const results = await this.mapWithConcurrency(
        chunkFiles,
        MAX_PARALLEL_CHUNKS,
        async (name, idx) => {
          const chunkBuffer = fs.readFileSync(path.join(workDir, name));
          const text = await this.transcribeSingle(
            chunkBuffer,
            'audio/mpeg',
            settings,
            apiKey,
            `chunk-${idx + 1}/${total}`
          );
          completed++;
          if (onProgress) {
            onProgress(`Transcribed ${completed}/${total} chunks...`, completed / total);
          }
          return text;
        }
      );

      return results.join(' ');
    } finally {
      // Best-effort cleanup
      try {
        for (const name of fs.readdirSync(workDir)) {
          try { fs.unlinkSync(path.join(workDir, name)); } catch {}
        }
        fs.rmdirSync(workDir);
      } catch {}
    }
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    };

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }
}

function resolveTranscriptionUrl(settings: TranscriberSettings): string {
  const { transcriptionUrl } = PROVIDERS[settings.provider];
  if (transcriptionUrl) {
    return transcriptionUrl;
  }
  if (!settings.localApiUrl) {
    throw new Error('Set the Whisper API URL in Settings for the Local/Custom provider.');
  }
  return settings.localApiUrl;
}

function getExtension(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('webm')) return 'webm';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('flac')) return 'flac';
  if (mimeType.includes('mkv') || mimeType.includes('matroska')) return 'mkv';
  if (mimeType.includes('quicktime') || mimeType.includes('mov')) return 'mov';
  if (mimeType.includes('avi')) return 'avi';
  throw new Error(`Unsupported audio format: ${mimeType}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (+ up to 500ms jitter)
  const base = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 30000);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!isNaN(seconds)) return Math.min(seconds * 1000, 30000);
  const date = Date.parse(header);
  if (!isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 30000));
  return null;
}

function isWhisperCompatible(mimeType: string): boolean {
  // Formats Whisper API accepts directly (no ffmpeg needed):
  // flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm
  const m = mimeType.toLowerCase();
  return (
    m.includes('wav') ||
    m.includes('mp3') || m.includes('mpeg') || m.includes('mpga') ||
    m.includes('m4a') || m.includes('mp4') ||
    m.includes('webm') ||
    m.includes('ogg') || m.includes('oga') ||
    m.includes('flac')
  );
}
