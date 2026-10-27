import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DOCKER_WHISPER, DockerWhisperModel } from '../types';
import { findExecutable, runProcess } from './executables';

const BUILD_CONTEXT_FILES = ['Dockerfile', 'requirements.txt', 'server.py'];
const DOCKER_INSTALL_DIRS = [
  '/Applications/Docker.app/Contents/Resources/bin',
  path.join(os.homedir(), '.docker', 'bin'),
  path.join(os.homedir(), '.orbstack', 'bin'),
  path.join(os.homedir(), '.rd', 'bin'),
];
const SPEC_LABEL = 'voice-transcriber.spec';
const HEALTH_POLL_MS = 1000;
// Covers the first-run model download on a slow connection
const STARTUP_TIMEOUT_MS = 15 * 60_000;
const LOG_TAIL_LINES = 20;

interface ContainerState {
  status: string;
  image: string;
  spec: string;
}

/**
 * Runs work against one named Whisper container: created on first use, recreated when its spec changes,
 * and stopped as soon as the last job finishes so it holds no CPU or RAM between transcriptions.
 */
export class DockerWhisperService {
  private activeJobs = 0;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly buildContextDir: string) {}

  async withRunningContainer<T>(
    model: DockerWhisperModel,
    cpuThreads: number,
    onProgress: (message: string) => void,
    work: () => Promise<T>
  ): Promise<T> {
    this.activeJobs++;
    try {
      if (!this.starting) {
        this.starting = this.bringUp(model, cpuThreads, onProgress).finally(() => {
          this.starting = undefined;
        });
      }
      await this.starting;
      return await work();
    } finally {
      this.activeJobs--;
      if (this.activeJobs === 0) {
        this.stopInBackground();
      }
    }
  }

  private stopInBackground(): void {
    this.stopping = Promise.resolve()
      // Detached so the stop still lands if VS Code quits right after the transcript arrives
      .then(() => this.dockerCli().run(['stop', DOCKER_WHISPER.containerName], { detached: true }))
      .then(() => undefined)
      // Optional cleanup after the transcript is already delivered; a failed stop only leaves the container idle
      .catch((error) => console.error(`[DockerWhisper] Failed to stop container: ${(error as Error).message}`))
      .finally(() => {
        this.stopping = undefined;
      });
  }

  private async bringUp(
    model: DockerWhisperModel,
    cpuThreads: number,
    onProgress: (message: string) => void
  ): Promise<void> {
    await this.stopping;
    const docker = this.dockerCli();
    onProgress('Checking Docker...');
    await this.assertCpuBudget(docker, cpuThreads);

    const image = `${DOCKER_WHISPER.imageRepository}:${this.buildContextHash()}`;
    const spec = createHash('sha256')
      .update(JSON.stringify({ image, cpuThreads, model, ...DOCKER_WHISPER }))
      .digest('hex')
      .slice(0, 12);

    const state = await this.containerState(docker);
    if (state && state.spec === spec) {
      if (state.status !== 'running') {
        onProgress('Starting the Whisper container...');
        await docker.run(['start', DOCKER_WHISPER.containerName]);
      }
      await this.waitUntilHealthy(docker, model, onProgress);
      return;
    }

    if (state) {
      onProgress('Updating the Whisper container...');
      await docker.run(['rm', '--force', DOCKER_WHISPER.containerName]);
      if (state.image !== image && state.image.startsWith(`${DOCKER_WHISPER.imageRepository}:`)) {
        await docker.run(['rmi', state.image]);
      }
    }
    if (!(await this.imageExists(docker, image))) {
      onProgress('Building the Whisper Docker image (first run only, 1-3 min)...');
      await docker.run(['build', '--tag', image, this.buildContextDir]);
    }
    onProgress('Starting the Whisper container...');
    await docker.run([
      'run', '--detach',
      // tini forwards SIGTERM, so "docker stop" takes a second instead of the 10s kill timeout
      '--init',
      '--name', DOCKER_WHISPER.containerName,
      '--label', `${SPEC_LABEL}=${spec}`,
      '--publish', `127.0.0.1:${DOCKER_WHISPER.hostPort}:${DOCKER_WHISPER.containerPort}`,
      '--volume', `${DOCKER_WHISPER.modelsVolume}:/models`,
      '--env', `WHISPER_MODEL=${model.id}`,
      '--env', `WHISPER_CPU_THREADS=${cpuThreads}`,
      '--cpus', String(cpuThreads),
      '--memory', model.memoryLimit,
      image,
    ]);
    await this.waitUntilHealthy(docker, model, onProgress);
  }

  private dockerCli(): DockerCli {
    const executable = findExecutable(process.platform === 'win32' ? 'docker.exe' : 'docker', DOCKER_INSTALL_DIRS);
    if (!executable) {
      throw new Error('Docker is not installed. Install Docker Desktop (https://docs.docker.com/get-docker/) or pick another provider.');
    }
    return new DockerCli(executable);
  }

  private async assertCpuBudget(docker: DockerCli, cpuThreads: number): Promise<void> {
    let output: string;
    try {
      output = await docker.run(['info', '--format', '{{.NCPU}}']);
    } catch (error) {
      throw new Error(`Docker is installed but not running. Start Docker Desktop and try again. (${(error as Error).message})`);
    }
    const dockerCpus = Number(output.trim());
    if (!Number.isInteger(dockerCpus) || dockerCpus < 1) {
      throw new Error(`Unexpected CPU count from "docker info": ${JSON.stringify(output)}`);
    }
    // --cpus 0 would mean "no limit", so a bad value must never reach docker run
    if (!Number.isInteger(cpuThreads) || cpuThreads < 1) {
      throw new Error(`CPU threads must be a whole number from 1 to ${dockerCpus}, got ${cpuThreads}. Pick one in Advanced Settings.`);
    }
    if (cpuThreads > dockerCpus) {
      throw new Error(`Docker has ${dockerCpus} CPUs but CPU threads is set to ${cpuThreads}. Lower it in Advanced Settings.`);
    }
  }

  private buildContextHash(): string {
    const hash = createHash('sha256');
    for (const name of BUILD_CONTEXT_FILES) {
      hash.update(name).update(fs.readFileSync(path.join(this.buildContextDir, name)));
    }
    return hash.digest('hex').slice(0, 12);
  }

  private async containerState(docker: DockerCli): Promise<ContainerState | null> {
    const output = await docker.run([
      'ps', '--all',
      '--filter', `name=^/${DOCKER_WHISPER.containerName}$`,
      '--format', `{{.State}} {{.Image}} {{.Label "${SPEC_LABEL}"}}`,
    ]);
    const line = output.trim();
    if (!line) {
      return null;
    }
    const [status, image, spec] = line.split(' ');
    if (!status || !image) {
      throw new Error(`Unexpected "docker ps" output for ${DOCKER_WHISPER.containerName}: ${JSON.stringify(line)}`);
    }
    // A container without our label was created by hand or by an older version: treat it as stale
    return { status, image, spec: spec ?? '' };
  }

  private async imageExists(docker: DockerCli, image: string): Promise<boolean> {
    const output = await docker.run(['images', '--quiet', image]);
    return output.trim() !== '';
  }

  private async waitUntilHealthy(
    docker: DockerCli,
    model: DockerWhisperModel,
    onProgress: (message: string) => void
  ): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
      const health = await readHealth();
      if (health.state === 'ready') {
        return;
      }
      if (health.state === 'failed') {
        throw new Error(`Whisper could not load ${model.id}: ${health.error}`);
      }
      const container = await this.containerState(docker);
      if (container?.status !== 'running') {
        const logs = await docker.run(['logs', '--tail', String(LOG_TAIL_LINES), DOCKER_WHISPER.containerName], { stderrToo: true });
        throw new Error(`Whisper container stopped (${container ? container.status : 'removed'}). Last logs:\n${logs.trim()}`);
      }
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      onProgress(`${progressMessage(health.state, model)} ${seconds}s`);
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    throw new Error(`Whisper container did not become healthy within ${STARTUP_TIMEOUT_MS / 60_000} min. Check "docker logs ${DOCKER_WHISPER.containerName}".`);
  }
}

class DockerCli {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly executable: string) {
    // docker shells out to credential helpers that live next to the real binary, which VS Code's PATH may lack
    const binDir = path.dirname(fs.realpathSync(executable));
    this.env = { ...process.env, PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter) };
  }

  async run(args: string[], options: { stderrToo?: boolean; detached?: boolean } = {}): Promise<string> {
    const { stdout, stderr } = await runProcess(this.executable, args, { env: this.env, detached: options.detached });
    return options.stderrToo ? stdout + stderr : stdout;
  }
}

type ServerHealth =
  | { state: 'starting' | 'loading' | 'downloading' | 'ready' }
  | { state: 'failed'; error: string };

function progressMessage(state: 'starting' | 'loading' | 'downloading', model: DockerWhisperModel): string {
  switch (state) {
    case 'starting':
      return 'Starting the Whisper server...';
    case 'loading':
      return `Loading Whisper ${model.id} into memory...`;
    case 'downloading':
      return `Downloading Whisper ${model.id} (${model.downloadSize}, first time only)...`;
  }
}

async function readHealth(): Promise<ServerHealth> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${DOCKER_WHISPER.hostPort}/health`, {
      signal: AbortSignal.timeout(HEALTH_POLL_MS),
    });
  } catch {
    return { state: 'starting' }; // connection refused until the server process is listening
  }
  const body = (await response.json()) as { state?: string; error?: { message?: string } };
  if (body.state === 'ready' || body.state === 'loading' || body.state === 'downloading') {
    return { state: body.state };
  }
  if (body.state === 'failed' && body.error?.message) {
    return { state: 'failed', error: body.error.message };
  }
  throw new Error(`Unexpected /health response from the Whisper server (HTTP ${response.status}): ${JSON.stringify(body)}`);
}
