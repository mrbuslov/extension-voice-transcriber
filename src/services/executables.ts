import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// VS Code launched from the Dock doesn't inherit the shell PATH, so Homebrew dirs are probed first
const DARWIN_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const OUTPUT_TAIL_CHARS = 8192;

const foundPaths = new Map<string, string>();

/** Not-found is not cached, so installing the tool doesn't require a VS Code restart. */
export function findExecutable(name: string, extraDirs: string[] = []): string | null {
  const cached = foundPaths.get(name);
  if (cached) {
    return cached;
  }
  const dirs = [...(process.platform === 'darwin' ? DARWIN_BIN_DIRS : []), ...extraDirs];
  const found = dirs.map((dir) => path.join(dir, name)).find(isExecutable) ?? lookupOnPath(name);
  if (found) {
    foundPaths.set(name, found);
  }
  return found;
}

function isExecutable(execPath: string): boolean {
  try {
    fs.accessSync(execPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function lookupOnPath(name: string): string | null {
  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  let output: string;
  try {
    output = execFileSync(whichCommand, [name], { encoding: 'utf8' });
  } catch {
    return null; // which/where exit non-zero when the name isn't on PATH
  }
  const firstLine = output.split(/\r?\n/)[0].trim();
  return firstLine && isExecutable(firstLine) ? firstLine : null;
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

/** Rejects on a non-zero exit with the tail of stderr in the message. */
export function runProcess(
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; detached?: boolean } = {}
): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      detached: options.detached,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString('utf8'));
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = keepTail(stderr + chunk.toString('utf8'));
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(`${path.basename(executable)} exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function keepTail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? text.slice(text.length - OUTPUT_TAIL_CHARS) : text;
}
