import { StorageService } from './storageService';
import { TranscriberSettings } from '../types';

const MAX_FILE_SIZE = 24 * 1024 * 1024; // 24MB (leaving margin for 25MB limit)

export class WhisperService {
  constructor(private readonly storage: StorageService) {}

  async transcribe(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    onProgress?: (message: string) => void
  ): Promise<string> {
    const apiKey = await this.storage.getApiKey();

    if (settings.provider === 'openai' && !apiKey) {
      throw new Error('Please enter your OpenAI API key in Settings.');
    }

    if (audioBuffer.length > MAX_FILE_SIZE) {
      return this.transcribeChunked(audioBuffer, mimeType, settings, apiKey, onProgress);
    }

    return this.transcribeSingle(audioBuffer, mimeType, settings, apiKey);
  }

  private async transcribeSingle(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    apiKey: string | undefined
  ): Promise<string> {
    const extension = this.getExtension(mimeType);
    const blob = new Blob([audioBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append('file', blob, `audio.${extension}`);
    formData.append('model', 'whisper-1');

    if (settings.language) {
      formData.append('language', settings.language);
    }

    const url =
      settings.provider === 'openai'
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : settings.localApiUrl;

    const headers: Record<string, string> = {};
    if (apiKey && settings.provider === 'openai') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log('[WhisperService] Sending request to:', url);
    console.log('[WhisperService] Audio size:', audioBuffer.length, 'bytes');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
      });
    } catch (fetchError) {
      console.error('[WhisperService] Fetch error:', fetchError);
      console.error('[WhisperService] Error name:', (fetchError as Error).name);
      console.error('[WhisperService] Error message:', (fetchError as Error).message);
      console.error('[WhisperService] Error stack:', (fetchError as Error).stack);
      throw new Error(`Network error: ${(fetchError as Error).message}`);
    }

    console.log('[WhisperService] Response status:', response.status);

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      const errorMessage =
        errorData.error?.message ||
        `Transcription failed with status ${response.status}`;
      console.error('[WhisperService] API error:', errorMessage);
      throw new Error(errorMessage);
    }

    const result = (await response.json()) as { text: string };
    console.log('[WhisperService] Transcription successful, length:', result.text.length);
    return result.text;
  }

  private async transcribeChunked(
    audioBuffer: Buffer,
    mimeType: string,
    settings: TranscriberSettings,
    apiKey: string | undefined,
    onProgress?: (message: string) => void
  ): Promise<string> {
    const chunks = this.splitBuffer(audioBuffer, MAX_FILE_SIZE);
    const transcriptions: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (onProgress) {
        onProgress(`Processing chunk ${i + 1}/${chunks.length}...`);
      }

      const text = await this.transcribeSingle(chunks[i], mimeType, settings, apiKey);
      transcriptions.push(text);
    }

    return transcriptions.join(' ');
  }

  private splitBuffer(buffer: Buffer, chunkSize: number): Buffer[] {
    const chunks: Buffer[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      const end = Math.min(offset + chunkSize, buffer.length);
      chunks.push(buffer.subarray(offset, end));
      offset = end;
    }

    return chunks;
  }

  private getExtension(mimeType: string): string {
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3';
    if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('webm')) return 'webm';
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('flac')) return 'flac';
    throw new Error(`Unsupported audio format: ${mimeType}. Supported: wav, mp3, m4a, webm, ogg, flac`);
  }
}
