import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export type RecordingTool = 'sox' | 'arecord' | 'auto';

export interface RecordingToolInfo {
  tool: RecordingTool;
  command: string;
  available: boolean;
}

export class AudioRecorderService {
  private process: ChildProcess | null = null;
  private tempFile: string | null = null;
  private isRecording = false;
  private startTime = 0;

  private static checkExecutable(execPath: string): boolean {
    try {
      fs.accessSync(execPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  static detectAvailableTools(): RecordingToolInfo[] {
    const tools: RecordingToolInfo[] = [];
    const platform = process.platform;

    // Check for arecord (Linux ALSA)
    if (platform === 'linux') {
      try {
        execSync('which arecord', { stdio: 'ignore' });
        tools.push({ tool: 'arecord', command: 'arecord', available: true });
      } catch {
        tools.push({ tool: 'arecord', command: 'arecord', available: false });
      }
    }

    // Check for sox/rec
    let soxFound = false;

    // On macOS, check Homebrew paths directly (VS Code doesn't inherit shell PATH)
    if (platform === 'darwin') {
      const homebrewPaths = [
        '/opt/homebrew/bin',  // Apple Silicon
        '/usr/local/bin'      // Intel Mac
      ];

      for (const brewPath of homebrewPaths) {
        const recPath = path.join(brewPath, 'rec');
        const soxPath = path.join(brewPath, 'sox');

        if (this.checkExecutable(recPath)) {
          tools.push({ tool: 'sox', command: recPath, available: true });
          soxFound = true;
          break;
        }
        if (this.checkExecutable(soxPath)) {
          tools.push({ tool: 'sox', command: soxPath, available: true });
          soxFound = true;
          break;
        }
      }
    }

    // Fallback: use which/where command
    if (!soxFound) {
      const soxCommand = platform === 'win32' ? 'sox' : 'rec';
      const whichCommand = platform === 'win32' ? 'where' : 'which';

      try {
        execSync(`${whichCommand} ${soxCommand}`, { stdio: 'ignore' });
        tools.push({ tool: 'sox', command: soxCommand, available: true });
      } catch {
        try {
          execSync(`${whichCommand} sox`, { stdio: 'ignore' });
          tools.push({ tool: 'sox', command: 'sox', available: true });
        } catch {
          tools.push({ tool: 'sox', command: soxCommand, available: false });
        }
      }
    }

    return tools;
  }

  /**
   * Get the best available recording tool
   */
  static getBestTool(): RecordingToolInfo | null {
    const tools = AudioRecorderService.detectAvailableTools();

    // Prefer arecord on Linux (no additional install needed)
    const arecord = tools.find(t => t.tool === 'arecord' && t.available);
    if (arecord) return arecord;

    // Fall back to sox
    const sox = tools.find(t => t.tool === 'sox' && t.available);
    if (sox) return sox;

    return null;
  }

  /**
   * Check if any recording tool is available
   */
  static isAvailable(): boolean {
    return AudioRecorderService.getBestTool() !== null;
  }

  /**
   * Get platform-specific installation instructions
   */
  static getInstallInstructions(): string {
    const platform = process.platform;

    if (platform === 'darwin') {
      return 'brew install sox';
    } else if (platform === 'win32') {
      return 'choco install sox.portable\nor download from https://sourceforge.net/projects/sox/';
    } else {
      return 'sudo apt install sox libsox-fmt-all\nor: sudo apt install alsa-utils';
    }
  }

  /**
   * Start recording audio to a temporary file
   */
  async start(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Already recording');
    }

    const toolInfo = AudioRecorderService.getBestTool();
    if (!toolInfo) {
      throw new Error('NO_RECORDING_TOOL');
    }

    // Create temp file
    this.tempFile = path.join(os.tmpdir(), `voice-transcriber-${Date.now()}.wav`);

    // Build command arguments based on tool
    let args: string[];

    if (toolInfo.tool === 'arecord') {
      // arecord: ALSA recorder (Linux)
      args = [
        '-f', 'S16_LE',      // 16-bit signed little-endian
        '-r', '16000',       // 16kHz sample rate
        '-c', '1',           // mono
        '-t', 'wav',         // WAV format
        this.tempFile
      ];
    } else {
      // sox/rec
      if (toolInfo.command.endsWith('rec')) {
        // rec command (sox wrapper)
        args = [
          '-r', '16000',     // 16kHz sample rate
          '-c', '1',         // mono
          '-b', '16',        // 16-bit
          this.tempFile
        ];
      } else {
        // sox with default input
        args = [
          '-d',              // default input device
          '-r', '16000',     // 16kHz sample rate
          '-c', '1',         // mono
          '-b', '16',        // 16-bit
          this.tempFile
        ];
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(toolInfo.command, args, {
          stdio: ['ignore', 'ignore', 'ignore']
        });

        this.process.on('error', (err) => {
          this.cleanup();
          reject(new Error(`Failed to start recording: ${err.message}`));
        });

        // Give it a moment to start
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.isRecording = true;
            this.startTime = Date.now();
            resolve();
          }
        }, 100);

      } catch (err) {
        this.cleanup();
        reject(err);
      }
    });
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

      // Send SIGINT (Ctrl+C) — sox/rec handles this as the standard stop signal,
      // properly flushing all internal audio buffers and updating the WAV header.
      // SIGTERM may cause sox to skip buffer flush, losing the last seconds of audio.
      proc.kill('SIGINT');

      // If SIGTERM doesn't work within 5 seconds, use SIGKILL
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
      this.process.kill('SIGKILL');
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
  }
}
