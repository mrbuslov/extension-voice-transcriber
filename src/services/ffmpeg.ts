import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

let cachedFfmpegPath: string | null | undefined = undefined;

function checkExecutable(execPath: string): boolean {
  try {
    fs.accessSync(execPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function getFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) {
    return cachedFfmpegPath;
  }

  const platform = process.platform;

  // On macOS, check Homebrew paths directly (VS Code doesn't inherit shell PATH)
  if (platform === 'darwin') {
    const homebrewPaths = ['/opt/homebrew/bin', '/usr/local/bin'];
    for (const brewPath of homebrewPaths) {
      const ffmpegPath = path.join(brewPath, 'ffmpeg');
      if (checkExecutable(ffmpegPath)) {
        cachedFfmpegPath = ffmpegPath;
        return ffmpegPath;
      }
    }
  }

  // Fallback: use which/where
  const whichCommand = platform === 'win32' ? 'where' : 'which';
  try {
    const output = execSync(`${whichCommand} ffmpeg`, { encoding: 'utf8' }).trim();
    const firstLine = output.split(/\r?\n/)[0].trim();
    if (firstLine && checkExecutable(firstLine)) {
      cachedFfmpegPath = firstLine;
      return firstLine;
    }
  } catch {
    // Not found
  }

  cachedFfmpegPath = null;
  return null;
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

export interface RunFfmpegOptions {
  captureStderr?: boolean;
}

export interface RunFfmpegResult {
  stderr: string;
  exitCode: number;
}

/**
 * Run ffmpeg with the given arguments, returning exit code and optionally captured stderr.
 * Throws if ffmpeg is not available or exits with non-zero.
 */
export function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<RunFfmpegResult> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) {
      reject(new Error('FFMPEG_NOT_FOUND'));
      return;
    }

    const proc = spawn(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', opts.captureStderr ? 'pipe' : 'ignore'],
    });

    let stderr = '';
    if (opts.captureStderr && proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        // Keep last ~8KB to avoid unbounded memory
        if (stderr.length > 8192) {
          stderr = stderr.slice(stderr.length - 8192);
        }
      });
    }

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(new Error(`ffmpeg exited with code ${exitCode}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
        return;
      }
      resolve({ stderr, exitCode });
    });
  });
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
