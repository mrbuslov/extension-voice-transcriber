import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getFfmpegPath,
  isFfmpegAvailable,
  getInstallInstructions as getFfmpegInstallInstructions,
  detectWindowsAudioDevice,
  detectLinuxAudioBackend,
} from './ffmpeg';

export class AudioRecorderService {
  private process: ChildProcess | null = null;
  private tempFile: string | null = null;
  private isRecording = false;
  private startTime = 0;
  private stderrTail = '';

  /**
   * Check if ffmpeg is available for recording
   */
  static isAvailable(): boolean {
    return isFfmpegAvailable();
  }

  /**
   * Get platform-specific installation instructions for ffmpeg
   */
  static getInstallInstructions(): string {
    return getFfmpegInstallInstructions();
  }

  private buildRecordArgs(tempFile: string): string[] {
    const platform = process.platform;
    const commonOutput = [
      '-ar', '16000',            // 16kHz sample rate
      '-ac', '1',                // mono
      '-acodec', 'pcm_s16le',    // 16-bit PCM
      '-f', 'wav',               // WAV container
      '-y',                      // overwrite output
      tempFile,
    ];

    if (platform === 'darwin') {
      return [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'avfoundation',
        '-i', ':0',              // no video, first audio device (default input)
        ...commonOutput,
      ];
    }

    if (platform === 'win32') {
      const device = detectWindowsAudioDevice() || 'Microphone';
      return [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'dshow',
        '-i', `audio=${device}`,
        ...commonOutput,
      ];
    }

    // Linux
    const backend = detectLinuxAudioBackend();
    return [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', backend,
      '-i', 'default',
      ...commonOutput,
    ];
  }

  /**
   * Start recording audio to a temporary file
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Already recording');
    }

    const ffmpegPath = getFfmpegPath();
    if (!ffmpegPath) {
      throw new Error('NO_RECORDING_TOOL');
    }

    this.tempFile = path.join(os.tmpdir(), `voice-transcriber-${Date.now()}.wav`);
    this.stderrTail = '';
    const args = this.buildRecordArgs(this.tempFile);

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(ffmpegPath, args, {
          stdio: ['pipe', 'ignore', 'pipe'],
        });

        const proc = this.process;

        if (proc.stderr) {
          proc.stderr.on('data', (chunk: Buffer) => {
            this.stderrTail += chunk.toString('utf8');
            // Keep last 4KB to avoid unbounded memory
            if (this.stderrTail.length > 4096) {
              this.stderrTail = this.stderrTail.slice(this.stderrTail.length - 4096);
            }
          });
        }

        let settled = false;

        const onEarlyExit = (code: number | null) => {
          if (settled) return;
          settled = true;
          const stderr = this.stderrTail.trim();
          this.cleanup();
          // Classify: device/permission issue vs other
          if (this.looksLikeMicError(stderr)) {
            reject(new Error('NO_MIC_DEVICE'));
          } else {
            reject(new Error(`Failed to start recording (exit ${code}): ${stderr || 'unknown error'}`));
          }
        };

        proc.on('error', (err) => {
          if (settled) return;
          settled = true;
          this.cleanup();
          reject(new Error(`Failed to start recording: ${err.message}`));
        });

        proc.on('exit', onEarlyExit);

        // Give ffmpeg time to initialize the audio device (slower than sox)
        setTimeout(() => {
          if (settled) return;
          if (proc.exitCode !== null) {
            // Process already exited during grace period — onEarlyExit will handle it
            return;
          }
          settled = true;
          // Remove the early-exit listener — from now on, exit is normal stop flow
          proc.removeListener('exit', onEarlyExit);
          this.isRecording = true;
          this.startTime = Date.now();
          resolve();
        }, 500);
      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
  }

  private looksLikeMicError(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return (
      s.includes('permission denied') ||
      s.includes('input/output error') ||
      s.includes('no such device') ||
      s.includes('could not open') ||
      s.includes('unknown input format') ||
      s.includes('cannot open') ||
      s.includes('device or resource busy')
    );
  }

  async stop(): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!this.isRecording || !this.process) {
      throw new Error('Not recording');
    }

    return new Promise((resolve, reject) => {
      const tempFile = this.tempFile!;
      const proc = this.process!;
      let resolved = false;
      let killTimeout: NodeJS.Timeout | null = null;

      const handleClose = () => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);

        try {
          if (fs.existsSync(tempFile)) {
            const buffer = fs.readFileSync(tempFile);
            fs.unlinkSync(tempFile);
            this.cleanup();
            resolve({ buffer, mimeType: 'audio/wav' });
          } else {
            this.cleanup();
            reject(new Error('Recording file not found'));
          }
        } catch (err) {
          this.cleanup();
          reject(err);
        }
      };

      proc.on('close', handleClose);
      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        if (killTimeout) clearTimeout(killTimeout);
        this.cleanup();
        reject(err);
      });

      // Send SIGINT (Ctrl+C) — ffmpeg handles this as the standard stop signal,
      // properly flushing all internal audio buffers and updating the WAV header.
      // On Windows, Node translates SIGINT to a terminate; the last ~0.5s may be lost.
      proc.kill('SIGINT');

      // If SIGINT doesn't work within 5 seconds, escalate to SIGKILL
      killTimeout = setTimeout(() => {
        if (!resolved) {
          try { proc.kill('SIGKILL'); } catch {}
          setTimeout(() => {
            if (!resolved) {
              handleClose();
            }
          }, 2000);
        }
      }, 5000);
    });
  }

  /**
   * Cancel recording without saving
   */
  cancel(): void {
    if (this.process) {
      try { this.process.kill('SIGKILL'); } catch {}
    }

    if (this.tempFile && fs.existsSync(this.tempFile)) {
      try {
        fs.unlinkSync(this.tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    this.cleanup();
  }

  /**
   * Get elapsed recording time in milliseconds
   */
  getElapsedTime(): number {
    if (!this.isRecording) return 0;
    return Date.now() - this.startTime;
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  private cleanup(): void {
    this.process = null;
    this.tempFile = null;
    this.isRecording = false;
    this.startTime = 0;
    this.stderrTail = '';
  }
}
