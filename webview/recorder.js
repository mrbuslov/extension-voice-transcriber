class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioContext = null;
    this.analyser = null;
    this.stream = null;
    this.chunks = [];
    this.startTime = 0;
    this.pausedTime = 0;
    this.pausedDuration = 0;
    this.timerInterval = null;
    this.animationId = null;
    this.isPaused = false;
    this.isRecording = false;

    this.onTimeUpdate = null;
    this.onLevelUpdate = null;
  }

  async start() {
    try {
      console.log('[Voice Transcriber] Checking mediaDevices availability...');
      console.log('[Voice Transcriber] navigator.mediaDevices:', !!navigator.mediaDevices);
      console.log('[Voice Transcriber] getUserMedia:', !!navigator.mediaDevices?.getUserMedia);

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('MediaDevices API not available in this context');
      }

      console.log('[Voice Transcriber] Requesting microphone access...');
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 44100,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });
      console.log('[Voice Transcriber] Microphone access granted!');

      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      const mimeTypes = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];

      let selectedMimeType = '';
      for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          break;
        }
      }

      if (!selectedMimeType) {
        throw new Error('No supported audio format found');
      }

      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: selectedMimeType,
        audioBitsPerSecond: 64000,
      });

      this.chunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      this.mediaRecorder.start(1000);
      this.startTime = Date.now();
      this.pausedDuration = 0;
      this.isRecording = true;
      this.isPaused = false;

      this.startTimer();
      this.startVisualization();

      return { success: true, mimeType: selectedMimeType };
    } catch (error) {
      throw new Error(this.getErrorMessage(error));
    }
  }

  pause() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.pausedTime = Date.now();
      this.isPaused = true;
      cancelAnimationFrame(this.animationId);
    }
  }

  resume() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.pausedDuration += Date.now() - this.pausedTime;
      this.isPaused = false;
      this.startVisualization();
    }
  }

  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('No recording in progress'));
        return;
      }

      this.mediaRecorder.onstop = async () => {
        try {
          const mimeType = this.mediaRecorder.mimeType;
          const blob = new Blob(this.chunks, { type: mimeType });
          this.cleanup();
          resolve({ blob, mimeType });
        } catch (error) {
          reject(error);
        }
      };

      this.mediaRecorder.onerror = (event) => {
        this.cleanup();
        reject(new Error('Recording error'));
      };

      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    });
  }

  getElapsedTime() {
    if (!this.isRecording) return 0;
    const now = this.isPaused ? this.pausedTime : Date.now();
    return now - this.startTime - this.pausedDuration;
  }

  startVisualization() {
    if (!this.analyser) return;

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      this.analyser.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      const level = Math.min(average / 128, 1);

      if (this.onLevelUpdate) {
        this.onLevelUpdate(level, dataArray);
      }
    };

    draw();
  }

  startTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      if (this.onTimeUpdate) {
        this.onTimeUpdate(this.getElapsedTime());
      }
    }, 100);
  }

  cleanup() {
    this.isRecording = false;
    this.isPaused = false;

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.analyser = null;
    this.mediaRecorder = null;
    this.chunks = [];
  }

  getErrorMessage(error) {
    console.error('[Voice Transcriber] Error details:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      constraint: error.constraint,
    });

    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'PERMISSION_DENIED';
    }
    if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      return 'No microphone found. Please connect a microphone and try again.';
    }
    if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
      return 'Microphone is in use by another application.';
    }
    if (error.name === 'SecurityError') {
      return 'PERMISSION_DENIED';
    }
    return error.message || 'Failed to start recording';
  }

  static formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
}

window.AudioRecorder = AudioRecorder;
