#!/usr/bin/env node
/**
 * End-to-end check of a real provider: runs the compiled WhisperService + CleanupService
 * against the live API with real audio. Only VS Code's secret vault is stubbed.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node scripts/check-provider.js openrouter [audio-file]
 *   OPENAI_API_KEY=sk-...        node scripts/check-provider.js openai     [audio-file]
 *
 * Without an audio file, a short spoken sample is generated (macOS `say` + ffmpeg).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PROVIDERS, defaultSettings, defaultModel } = require('../out/types');
const { WhisperService } = require('../out/services/whisperService');
const { CleanupService } = require('../out/services/cleanupService');

const SAMPLE_SENTENCE =
  'Um, this is, uh, a test recording for the voice transcriber extension, you know, testing one two three.';

function buildSampleAudio() {
  if (os.platform() !== 'darwin') {
    throw new Error('Sample generation needs macOS `say`. Pass an audio file path as the 2nd argument.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-check-'));
  const aiff = path.join(dir, 'sample.aiff');
  const mp3 = path.join(dir, 'sample.mp3');
  execFileSync('say', ['-o', aiff, SAMPLE_SENTENCE]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', '-y', mp3]);
  return mp3;
}

function mimeFor(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const byExt = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/m4a', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
  if (!byExt[ext]) {
    throw new Error(`Unsupported sample extension: .${ext}`);
  }
  return byExt[ext];
}

async function main() {
  const provider = process.argv[2];
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }

  const envVar = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = process.env[envVar];
  if (PROVIDERS[provider].requiresApiKey && !apiKey) {
    throw new Error(`${envVar} is not set`);
  }

  const audioFile = process.argv[3] || buildSampleAudio();
  const audioBuffer = fs.readFileSync(audioFile);
  const storage = { getApiKey: async () => apiKey };

  const settings = {
    ...defaultSettings,
    provider,
    enableCleanup: true,
    transcriptionModel: defaultModel(PROVIDERS[provider].transcriptionModels),
    cleanupModel: defaultModel(PROVIDERS[provider].cleanupModels),
  };

  console.log(`provider=${provider} stt=${settings.transcriptionModel} llm=${settings.cleanupModel}`);
  console.log(`audio=${audioFile} (${audioBuffer.length} bytes)\n`);

  const started = Date.now();
  const raw = await new WhisperService(storage).transcribe(audioBuffer, mimeFor(audioFile), settings, (m, p) =>
    console.log(`  [progress] ${m}${typeof p === 'number' ? ` ${(p * 100).toFixed(0)}%` : ''}`)
  );
  console.log(`\nTRANSCRIPT (${Date.now() - started}ms):\n${raw}\n`);

  const cleanStarted = Date.now();
  const cleaned = await new CleanupService(storage).cleanupText(raw, settings);
  console.log(`CLEANED (${Date.now() - cleanStarted}ms):\n${cleaned}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
