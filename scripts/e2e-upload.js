#!/usr/bin/env node
/**
 * Drives the real VS Code Extension Development Host: opens the panel, optionally switches the
 * provider, uploads a file through the webview's file input, and prints every progress/toast change.
 *
 * Usage:
 *   npm run compile && node scripts/e2e-upload.js <provider|-> <file> [waitSeconds]
 *   node scripts/e2e-upload.js docker ~/Downloads/talk.mov 1800
 *
 * Exits 0 when a transcript appears, 1 on an error toast or timeout.
 * Env: VSCODE_BIN (default: macOS VS Code), E2E_CDP_PORT (default 9419).
 */
const { chromium } = require('playwright-core');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VSCODE_BIN = process.env.VSCODE_BIN || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9419);
const STARTUP_ATTEMPTS = 60;

const [, , provider, file, waitArg] = process.argv;
if (!provider || !file) {
  console.error('Usage: node scripts/e2e-upload.js <provider|-> <file> [waitSeconds]');
  process.exit(2);
}
const waitSeconds = Number(waitArg || 120);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launchVsCode(userData) {
  // Launched from inside VS Code, ELECTRON_RUN_AS_NODE would make Code start as plain node
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_'))
  );
  return spawn(
    VSCODE_BIN,
    [
      `--extensionDevelopmentPath=${REPO}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(userData, 'ext')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
      `--remote-debugging-port=${CDP_PORT}`,
      REPO,
    ],
    { stdio: 'ignore', env }
  );
}

async function connectWorkbench() {
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
      const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
      if (page) {
        return page;
      }
      await browser.close();
    } catch {
      // VS Code hasn't opened the debug port yet
    }
    await sleep(1000);
  }
  throw new Error(`No VS Code workbench on CDP port ${CDP_PORT} after ${STARTUP_ATTEMPTS}s`);
}

async function findWebviewFrame(page) {
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt++) {
    for (const frame of page.frames()) {
      if (await frame.$('#audio-file-input').catch(() => null)) {
        return frame;
      }
    }
    await sleep(500);
  }
  throw new Error('Voice Transcriber webview did not appear');
}

/** Playwright refuses files over 50 MB over CDP, so the path goes straight to DOM.setFileInputFiles. */
async function setInputFile(page, frame, filePath) {
  for (const [target, expression] of [
    [frame, "document.getElementById('audio-file-input')"],
    [frame.parentFrame(), "document.querySelector('iframe').contentDocument.getElementById('audio-file-input')"],
  ]) {
    const session = await page.context().newCDPSession(target).catch(() => null);
    if (!session) {
      continue;
    }
    const { result } = await session.send('Runtime.evaluate', { expression });
    if (result.objectId) {
      await session.send('DOM.setFileInputFiles', { files: [filePath], objectId: result.objectId });
      return;
    }
  }
  throw new Error('Could not reach the webview file input over CDP');
}

async function readPanelState(page, frame) {
  const panel = await frame.evaluate(() => {
    const visible = (id) => document.getElementById(id).style.display !== 'none';
    return {
      progress: visible('progress-container') ? document.getElementById('progress-message').textContent : null,
      text: visible('transcription-section') ? document.getElementById('transcription-text').value : null,
      hasTimestamps: visible('copy-timestamps-btn'),
    };
  });
  const toasts = await page.$$eval('.notification-toast .notification-list-item-message', (els) =>
    els.map((el) => el.textContent)
  );
  return { ...panel, toasts };
}

async function run(page) {
  await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  await sleep(3000);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  await page.keyboard.type('Voice Transcriber: Open Panel');
  await sleep(800);
  await page.keyboard.press('Enter');
  const frame = await findWebviewFrame(page);

  if (provider !== '-') {
    await frame.selectOption('#provider', provider);
    await sleep(500);
  }

  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  await setInputFile(page, frame, path.resolve(file));

  let lastLine = '';
  while (Date.now() - startedAt < waitSeconds * 1000) {
    const state = await readPanelState(page, frame);
    const line = JSON.stringify({ progress: state.progress, toasts: state.toasts });
    if (line !== lastLine) {
      console.log(`[${elapsed()}] ${line}`);
      lastLine = line;
    }
    if (state.text) {
      console.log(`DONE in ${elapsed()}, timestamps=${state.hasTimestamps}, ${state.text.length} chars`);
      console.log(state.text.slice(0, 300));
      return 0;
    }
    if (!state.progress && state.toasts.length > 0) {
      console.log(`FAILED in ${elapsed()}`);
      return 1;
    }
    await sleep(1000);
  }
  console.log(`TIMEOUT after ${waitSeconds}s`);
  return 1;
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-e2e-'));
  const vscode = launchVsCode(userData);
  try {
    const page = await connectWorkbench();
    const exitCode = await run(page);
    const screenshot = path.join(userData, 'final.png');
    await page.screenshot({ path: screenshot });
    console.log(`Screenshot: ${screenshot}`);
    return exitCode;
  } finally {
    // SIGTERM leaves VS Code holding the debug port; helpers like crashpad outlive the main process
    vscode.kill('SIGKILL');
    spawnSync('pkill', ['-9', '-f', userData]);
  }
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
