import { execSync } from 'child_process';
import * as fs from 'fs';
import { findExecutable, runProcess, ProcessOutput } from './executables';

export function getFfmpegPath(): string | null {
  return findExecutable('ffmpeg');
}

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null;
}

export function getInstallInstructions(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return 'brew install ffmpeg';
  }
  if (platform === 'win32') {
    return 'winget install ffmpeg\nor: choco install ffmpeg';
  }
  return 'sudo apt install ffmpeg';
}

export function runFfmpeg(args: string[]): Promise<ProcessOutput> {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) {
    return Promise.reject(new Error('FFMPEG_NOT_FOUND'));
  }
  return runProcess(ffmpegPath, args);
}

/**
 * Detect default audio device name on Windows via DirectShow.
 * Returns the first audio device name, or null if enumeration fails.
 */
export function detectWindowsAudioDevice(): string | null {
  const ffmpegPath = getFfmpegPath();
  if (!ffmpegPath) return null;

  // ffmpeg -list_devices prints to stderr and exits non-zero; capture both
  try {
    execSync(`"${ffmpegPath}" -hide_banner -list_devices true -f dshow -i dummy`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8') || '';
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8') || '';
    return parseWindowsAudioDevice(stderr + stdout);
  }
}

function parseWindowsAudioDevice(output: string): string | null {
  // Look for audio device section. Format:
  // [dshow @ ...] "Device Name" (audio)
  const audioSection = output.split(/DirectShow audio devices/i)[1];
  if (!audioSection) {
    // Fallback: scan entire output for "..." (audio)
    const match = output.match(/"([^"]+)"\s*\(audio\)/);
    return match ? match[1] : null;
  }
  const match = audioSection.match(/"([^"]+)"/);
  return match ? match[1] : null;
}

/**
 * Detect Linux audio backend. Returns 'pulse' if PulseAudio/PipeWire socket is available,
 * 'alsa' otherwise.
 */
export function detectLinuxAudioBackend(): 'pulse' | 'alsa' {
  if (process.env.PULSE_SERVER) return 'pulse';
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const pulseSocket = `/run/user/${uid}/pulse/native`;
    if (fs.existsSync(pulseSocket)) return 'pulse';
  }
  return 'alsa';
}
