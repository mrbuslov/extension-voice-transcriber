import * as http from 'http';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class BrowserRecorderService {
  private server: http.Server | null = null;
  private port: number = 0;
  private resolveRecording: ((data: { buffer: Buffer; mimeType: string }) => void) | null = null;
  private rejectRecording: ((error: Error) => void) | null = null;
  private extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;
  }

  /**
   * Start recording via browser
   * Opens browser with recording page, waits for audio data
   */
  async record(): Promise<{ buffer: Buffer; mimeType: string }> {
    return new Promise((resolve, reject) => {
      this.resolveRecording = resolve;
      this.rejectRecording = reject;

      this.startServer()
        .then(() => this.openBrowser())
        .catch(reject);
    });
  }

  /**
   * Cancel the recording session
   */
  cancel(): void {
    this.stopServer();
    if (this.rejectRecording) {
      this.rejectRecording(new Error('Recording cancelled'));
    }
    this.cleanup();
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      // Find available port
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address !== 'string') {
          this.port = address.port;
          resolve();
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', reject);
    });
  }

  private stopServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private async openBrowser(): Promise<void> {
    const url = `http://127.0.0.1:${this.port}/`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      // Serve the recording page
      this.serveRecordingPage(res);
    } else if (req.method === 'POST' && req.url === '/upload') {
      // Handle audio upload
      this.handleAudioUpload(req, res);
    } else if (req.method === 'POST' && req.url === '/cancel') {
      // Handle cancel
      this.handleCancel(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  private serveRecordingPage(res: http.ServerResponse): void {
    const html = this.getRecordingPageHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private handleAudioUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const data = JSON.parse(body);

        if (data.audio && data.mimeType) {
          // Decode base64 audio
          const buffer = Buffer.from(data.audio, 'base64');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));

          // Resolve the promise
          if (this.resolveRecording) {
            this.resolveRecording({ buffer, mimeType: data.mimeType });
          }

          // Clean up after a short delay to let browser receive response
          setTimeout(() => {
            this.stopServer();
            this.cleanup();
          }, 500);
        } else {
          throw new Error('Invalid audio data');
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

    req.on('error', (err) => {
      res.writeHead(500);
      res.end('Server error');
      if (this.rejectRecording) {
        this.rejectRecording(err);
      }
    });
  }

  private handleCancel(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));

    if (this.rejectRecording) {
      this.rejectRecording(new Error('Recording cancelled by user'));
    }

    setTimeout(() => {
      this.stopServer();
      this.cleanup();
    }, 500);
  }

  private cleanup(): void {
    this.resolveRecording = null;
    this.rejectRecording = null;
    this.port = 0;
  }

  private getRecordingPageHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Voice Transcriber - Recording</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .container {
      text-align: center;
      padding: 40px;
      max-width: 400px;
    }

    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      font-weight: 600;
    }

    .subtitle {
      color: #888;
      margin-bottom: 40px;
      font-size: 14px;
    }

    .timer {
      font-size: 48px;
      font-family: 'Courier New', monospace;
      font-weight: bold;
      margin-bottom: 30px;
      color: #4fc3f7;
    }

    .controls {
      display: flex;
      gap: 16px;
      justify-content: center;
      margin-bottom: 30px;
    }

    button {
      padding: 16px 32px;
      font-size: 16px;
      border: none;
      border-radius: 50px;
      cursor: pointer;
      transition: all 0.2s ease;
      font-weight: 600;
    }

    button:hover {
      transform: scale(1.05);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    .btn-record {
      background: #ef5350;
      color: white;
    }

    .btn-record.recording {
      animation: pulse 1.5s infinite;
    }

    .btn-stop {
      background: #66bb6a;
      color: white;
    }

    .btn-cancel {
      background: transparent;
      color: #888;
      border: 1px solid #444;
    }

    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(239, 83, 80, 0.7); }
      50% { box-shadow: 0 0 0 15px rgba(239, 83, 80, 0); }
    }

    .status {
      color: #888;
      font-size: 14px;
    }

    .status.recording {
      color: #ef5350;
    }

    .status.success {
      color: #66bb6a;
    }

    .visualizer {
      width: 100%;
      height: 60px;
      background: rgba(255,255,255,0.1);
      border-radius: 8px;
      margin-bottom: 30px;
      overflow: hidden;
    }

    canvas {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Voice Transcriber</h1>
    <p class="subtitle">Recording audio for VS Code</p>

    <div class="visualizer">
      <canvas id="visualizer"></canvas>
    </div>

    <div class="timer" id="timer">00:00:00</div>

    <div class="controls">
      <button class="btn-record" id="recordBtn">Start Recording</button>
      <button class="btn-stop" id="stopBtn" disabled>Stop & Send</button>
    </div>

    <button class="btn-cancel" id="cancelBtn">Cancel</button>

    <p class="status" id="status">Click "Start Recording" to begin</p>
  </div>

  <script>
    let mediaRecorder = null;
    let audioChunks = [];
    let startTime = 0;
    let timerInterval = null;
    let audioContext = null;
    let analyser = null;
    let animationId = null;

    const recordBtn = document.getElementById('recordBtn');
    const stopBtn = document.getElementById('stopBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const timerEl = document.getElementById('timer');
    const statusEl = document.getElementById('status');
    const canvas = document.getElementById('visualizer');
    const ctx = canvas.getContext('2d');

    // Set canvas size
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;

    recordBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    cancelBtn.addEventListener('click', cancelRecording);

    async function startRecording() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
          }
        });

        // Setup audio context for visualization
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        startVisualization();

        // Find supported mime type
        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/mp4',
        ];

        let mimeType = '';
        for (const type of mimeTypes) {
          if (MediaRecorder.isTypeSupported(type)) {
            mimeType = type;
            break;
          }
        }

        mediaRecorder = new MediaRecorder(stream, {
          mimeType: mimeType || undefined,
          audioBitsPerSecond: 64000
        });

        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunks.push(e.data);
          }
        };

        mediaRecorder.start(1000);
        startTime = Date.now();
        startTimer();

        recordBtn.disabled = true;
        recordBtn.classList.add('recording');
        stopBtn.disabled = false;
        statusEl.textContent = 'Recording...';
        statusEl.className = 'status recording';
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
        statusEl.className = 'status';
      }
    }

    async function stopRecording() {
      if (!mediaRecorder) return;

      return new Promise((resolve) => {
        mediaRecorder.onstop = async () => {
          stopTimer();
          stopVisualization();

          const mimeType = mediaRecorder.mimeType;
          const blob = new Blob(audioChunks, { type: mimeType });

          statusEl.textContent = 'Sending to VS Code...';
          statusEl.className = 'status';

          try {
            // Convert to base64
            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64 = reader.result.split(',')[1];

              // Send to server
              const response = await fetch('/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio: base64, mimeType })
              });

              if (response.ok) {
                statusEl.textContent = 'Done! You can close this tab.';
                statusEl.className = 'status success';
                recordBtn.disabled = true;
                stopBtn.disabled = true;
                cancelBtn.disabled = true;

                // Auto-close after short delay
                setTimeout(() => window.close(), 1500);
              } else {
                throw new Error('Upload failed');
              }
            };
            reader.readAsDataURL(blob);
          } catch (err) {
            statusEl.textContent = 'Error sending: ' + err.message;
            statusEl.className = 'status';
          }

          resolve();
        };

        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
      });
    }

    async function cancelRecording() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
      }

      stopTimer();
      stopVisualization();

      try {
        await fetch('/cancel', { method: 'POST' });
      } catch {}

      statusEl.textContent = 'Cancelled. You can close this tab.';
      statusEl.className = 'status';

      setTimeout(() => window.close(), 1000);
    }

    function startTimer() {
      timerInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        timerEl.textContent = formatTime(elapsed);
      }, 100);
    }

    function stopTimer() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    }

    function formatTime(ms) {
      const totalSeconds = Math.floor(ms / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return String(hours).padStart(2, '0') + ':' +
             String(minutes).padStart(2, '0') + ':' +
             String(seconds).padStart(2, '0');
    }

    function startVisualization() {
      if (!analyser) return;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      function draw() {
        animationId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);

        ctx.fillStyle = 'rgba(26, 26, 46, 0.3)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const barCount = 32;
        const barWidth = canvas.width / barCount - 2;

        ctx.fillStyle = '#4fc3f7';

        for (let i = 0; i < barCount; i++) {
          const index = Math.floor(i * (bufferLength / barCount));
          const barHeight = (dataArray[index] / 255) * canvas.height;
          const x = i * (barWidth + 2);
          const y = canvas.height - barHeight;
          ctx.fillRect(x, y, barWidth, barHeight);
        }
      }

      draw();
    }

    function stopVisualization() {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }

      if (audioContext) {
        audioContext.close();
        audioContext = null;
      }

      ctx.fillStyle = 'rgba(26, 26, 46, 1)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  </script>
</body>
</html>`;
  }
}
