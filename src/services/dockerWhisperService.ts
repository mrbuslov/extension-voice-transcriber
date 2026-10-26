import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DOCKER_WHISPER } from '../types';
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
    cpuThreads: number,
    onProgress: (message: string) => void,
    work: () => Promise<T>
  ): Promise<T> {
    this.activeJobs++;
    try {
      if (!this.starting) {
        this.starting = this.bringUp(cpuThreads, onProgress).finally(() => {
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
      .then(() => this.dockerCli().run(['stop', DOCKER_WHISPER.containerName]))
      .then(() => undefined)
      // Optional cleanup after the transcript is already delivered; a failed stop only leaves the container idle
      .catch((error) => console.error(`[DockerWhisper] Failed to stop container: ${(error as Error).message}`))
      .finally(() => {
        this.stopping = undefined;
      });
  }

  private async bringUp(cpuThreads: number, onProgress: (message: string) => void): Promise<void> {
    await this.stopping;
    const docker = this.dockerCli();
    onProgress('Checking Docker...');
    await this.assertCpuBudget(docker, cpuThreads);

    const image = `${DOCKER_WHISPER.imageRepository}:${this.buildContextHash()}`;
    const spec = createHash('sha256').update(JSON.stringify({ image, cpuThreads, ...DOCKER_WHISPER })).digest('hex').slice(0, 12);

    const state = await this.containerState(docker);
    if (state && state.spec === spec) {
      if (state.status !== 'running') {
        onProgress('Starting the Whisper container...');
        await docker.run(['start', DOCKER_WHISPER.containerName]);
      }
      await this.waitUntilHealthy(docker, onProgress, 'Loading the Whisper model...');
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
    const modelsCached = await this.volumeExists(docker);
    onProgress('Starting the Whisper container...');
    await docker.run([
      'run', '--detach',
      // tini forwards SIGTERM, so "docker stop" takes a second instead of the 10s kill timeout
      '--init',
      '--name', DOCKER_WHISPER.containerName,
      '--label', `${SPEC_LABEL}=${spec}`,
      '--publish', `127.0.0.1:${DOCKER_WHISPER.hostPort}:${DOCKER_WHISPER.containerPort}`,
      '--volume', `${DOCKER_WHISPER.modelsVolume}:/models`,
      '--env', `WHISPER_MODEL=${DOCKER_WHISPER.model}`,
      '--env', `WHISPER_CPU_THREADS=${cpuThreads}`,
      '--cpus', String(cpuThreads),
      '--memory', DOCKER_WHISPER.memoryLimit,
      image,
    ]);
    await this.waitUntilHealthy(
      docker,
      onProgress,
      modelsCached ? 'Loading the Whisper model...' : 'Downloading the Whisper model (~500 MB, first run only)...'
    );
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

  private async volumeExists(docker: DockerCli): Promise<boolean> {
    const output = await docker.run(['volume', 'ls', '--quiet', '--filter', `name=^${DOCKER_WHISPER.modelsVolume}$`]);
    return output.trim() !== '';
  }

  private async imageExists(docker: DockerCli, image: string): Promise<boolean> {
    const output = await docker.run(['images', '--quiet', image]);
    return output.trim() !== '';
  }

  private async waitUntilHealthy(
    docker: DockerCli,
    onProgress: (message: string) => void,
    waitingMessage: string
  ): Promise<void> {
    const healthUrl = `http://127.0.0.1:${DOCKER_WHISPER.hostPort}/health`;
    const startedAt = Date.now();
    while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
      if (await isHealthy(healthUrl)) {
        return;
      }
      const state = await this.containerState(docker);
      if (state?.status !== 'running') {
        const logs = await docker.run(['logs', '--tail', String(LOG_TAIL_LINES), DOCKER_WHISPER.containerName], { stderrToo: true });
        throw new Error(`Whisper container stopped (${state ? state.status : 'removed'}). Last logs:\n${logs.trim()}`);
      }
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      onProgress(`${waitingMessage} ${seconds}s`);
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

  async run(args: string[], options: { stderrToo?: boolean } = {}): Promise<string> {
    const { stdout, stderr } = await runProcess(this.executable, args, { env: this.env });
    return options.stderrToo ? stdout + stderr : stdout;
  }
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_POLL_MS) });
    return response.ok;
  } catch {
    return false; // connection refused while the model is still loading
  }
}
