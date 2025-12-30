(function () {
  const vscode = acquireVsCodeApi();

  let currentMimeType = '';
  let lastAudioBlob = null;
  let isRecording = false;
  let recordingCapabilities = null;
  let uiState = {};

  const elements = {
    provider: document.getElementById('provider'),
    apiKey: document.getElementById('api-key'),
    toggleApiKey: document.getElementById('toggle-api-key'),
    saveApiKey: document.getElementById('save-api-key'),
    apiKeyStatus: document.getElementById('api-key-status'),
    apiKeyGroup: document.getElementById('api-key-group'),
    localUrlGroup: document.getElementById('local-url-group'),
    localUrl: document.getElementById('local-url'),
    enableCleanup: document.getElementById('enable-cleanup'),
    cleanupModel: document.getElementById('cleanup-model'),
    cleanupGroup: document.getElementById('cleanup-group'),
    cleanupModelGroup: document.getElementById('cleanup-model-group'),
    language: document.getElementById('language'),
    recordingStatus: document.getElementById('recording-status'),
    timer: document.getElementById('timer'),
    startBtn: document.getElementById('start-btn'),
    pauseBtn: document.getElementById('pause-btn'),
    resumeBtn: document.getElementById('resume-btn'),
    stopBtn: document.getElementById('stop-btn'),
    saveAudioBtn: document.getElementById('save-audio-btn'),
    progressContainer: document.getElementById('progress-container'),
    progressMessage: document.getElementById('progress-message'),
    transcriptionSection: document.getElementById('transcription-section'),
    transcriptionText: document.getElementById('transcription-text'),
    copyBtn: document.getElementById('copy-btn'),
    historyList: document.getElementById('history-list'),
    clearHistoryBtn: document.getElementById('clear-history-btn'),
    recoveryModal: document.getElementById('recovery-modal'),
    recoveryMessage: document.getElementById('recovery-message'),
    recoverBtn: document.getElementById('recover-btn'),
    downloadRecoveredBtn: document.getElementById('download-recovered-btn'),
    discardBtn: document.getElementById('discard-btn'),
    permissionError: document.getElementById('permission-error'),
    permissionErrorInstructions: document.getElementById('permission-error-instructions'),
    permissionErrorDismiss: document.getElementById('permission-error-dismiss'),
  };

  
  function init() {
    setupEventListeners();
    setupCollapsibles();
    vscode.postMessage({ type: 'ready' });
  }

  function setupEventListeners() {
    elements.provider.addEventListener('change', handleProviderChange);
    elements.toggleApiKey.addEventListener('click', toggleApiKeyVisibility);
    elements.saveApiKey.addEventListener('click', saveApiKey);
    elements.localUrl.addEventListener('change', saveSettings);
    elements.enableCleanup.addEventListener('change', handleCleanupChange);
    elements.cleanupModel.addEventListener('change', saveSettings);
    elements.language.addEventListener('change', saveSettings);

    elements.startBtn.addEventListener('click', startRecording);
    elements.pauseBtn.addEventListener('click', pauseRecording);
    elements.resumeBtn.addEventListener('click', resumeRecording);
    elements.stopBtn.addEventListener('click', stopRecording);
    elements.saveAudioBtn.addEventListener('click', saveAudio);

    elements.copyBtn.addEventListener('click', copyTranscription);
    elements.clearHistoryBtn.addEventListener('click', clearHistory);

    elements.recoverBtn.addEventListener('click', recoverSession);
    elements.downloadRecoveredBtn.addEventListener('click', downloadRecoveredAudio);
    elements.discardBtn.addEventListener('click', discardSession);
    elements.permissionErrorDismiss.addEventListener('click', hidePermissionError);
  }

  function setupCollapsibles() {
    document.querySelectorAll('[data-toggle]').forEach(header => {
      const contentId = header.getAttribute('data-toggle');
      const content = document.getElementById(contentId);

      header.addEventListener('click', () => {
        content.classList.toggle('collapsed');
        header.querySelector('.toggle-icon')?.classList.toggle('collapsed');

        // Save state to extension
        const collapsedSections = uiState.collapsedSections || {};
        collapsedSections[contentId] = content.classList.contains('collapsed');
        uiState.collapsedSections = collapsedSections;
        vscode.postMessage({ type: 'saveUiState', data: { collapsedSections } });
      });
    });
  }

  function applyCollapsedState() {
    const collapsedSections = uiState.collapsedSections || {};
    document.querySelectorAll('[data-toggle]').forEach(header => {
      const contentId = header.getAttribute('data-toggle');
      const content = document.getElementById(contentId);
      if (collapsedSections[contentId]) {
        content.classList.add('collapsed');
        header.querySelector('.toggle-icon')?.classList.add('collapsed');
      }
    });
  }

  function handleProviderChange() {
    const isOpenAI = elements.provider.value === 'openai';
    elements.apiKeyGroup.style.display = isOpenAI ? 'block' : 'none';
    elements.localUrlGroup.style.display = isOpenAI ? 'none' : 'block';
    elements.cleanupGroup.style.display = isOpenAI ? 'block' : 'none';
    saveSettings();
  }

  function handleCleanupChange() {
    saveSettings();
  }

  function toggleApiKeyVisibility() {
    const input = elements.apiKey;
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  function saveApiKey() {
    const key = elements.apiKey.value.trim();
    if (key) {
      vscode.postMessage({ type: 'saveApiKey', key });
      elements.apiKeyStatus.textContent = 'API key saved';
      elements.apiKeyStatus.className = 'status-text success';
      elements.apiKey.value = '';
    }
  }

  function saveSettings() {
    vscode.postMessage({
      type: 'saveSettings',
      data: {
        provider: elements.provider.value,
        localApiUrl: elements.localUrl.value,
        enableCleanup: elements.enableCleanup.checked,
        cleanupModel: elements.cleanupModel.value,
        language: elements.language.value,
      },
    });
  }

  function startRecording() {
    // Send message to extension to start recording via Node.js
    vscode.postMessage({ type: 'startRecording' });
    elements.startBtn.disabled = true;
    elements.recordingStatus.textContent = 'Starting...';
  }

  function pauseRecording() {
    // Note: Pause/resume not supported with native recording
    // This is kept for UI consistency but may need to be hidden
  }

  function resumeRecording() {
    // Note: Pause/resume not supported with native recording
  }

  function stopRecording() {
    if (!isRecording) return;

    // Send message to extension to stop recording
    vscode.postMessage({ type: 'stopRecording' });
    elements.stopBtn.disabled = true;
    elements.recordingStatus.textContent = 'Stopping...';
  }

  function cancelRecording() {
    vscode.postMessage({ type: 'cancelRecording' });
    resetRecordingUI();
  }

  function startBrowserRecording() {
    hidePermissionError();
    vscode.postMessage({ type: 'startBrowserRecording' });
    showProgress('Opening browser for recording...');
  }

  async function saveAudio() {
    if (lastAudioBlob) {
      const base64 = await blobToBase64(lastAudioBlob);
      vscode.postMessage({
        type: 'saveAudio',
        audioData: base64,
        mimeType: currentMimeType,
      });
    }
  }

  function resetRecordingUI() {
    isRecording = false;
    elements.recordingStatus.textContent = 'Ready to Record';
    elements.recordingStatus.className = '';
    elements.timer.textContent = '00:00:00';
    elements.startBtn.style.display = 'inline-flex';
    elements.startBtn.disabled = false;
    elements.pauseBtn.style.display = 'none';
    elements.resumeBtn.style.display = 'none';
    elements.stopBtn.style.display = 'none';
    elements.stopBtn.disabled = false;
    elements.saveAudioBtn.style.display = 'none';
  }

  function showProgress(message) {
    elements.progressContainer.style.display = 'flex';
    elements.progressMessage.textContent = message;
    elements.startBtn.disabled = true;
  }

  function hideProgress() {
    elements.progressContainer.style.display = 'none';
    elements.startBtn.disabled = false;
  }

  
  function copyTranscription() {
    const text = elements.transcriptionText.value;
    if (text) {
      vscode.postMessage({ type: 'copyToClipboard', text });
    }
  }

  function showTranscription(text) {
    elements.transcriptionText.value = text;
    elements.transcriptionSection.style.display = 'block';
    elements.transcriptionSection.classList.add('visible');
  }

  function renderHistory(history) {
    elements.historyList.innerHTML = '';

    if (history.length === 0) {
      elements.historyList.innerHTML = '<div class="empty-state">No transcriptions yet</div>';
      elements.clearHistoryBtn.style.display = 'none';
      return;
    }

    elements.clearHistoryBtn.style.display = 'block';

    history.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-item-content">
          <div class="history-item-date">${formatDate(entry.date)}</div>
          <div class="history-item-preview">${escapeHtml(entry.preview)}</div>
        </div>
        <button class="icon-button history-item-copy" title="Copy">&#128203;</button>
      `;

      item.querySelector('.history-item-content').addEventListener('click', () => {
        showTranscription(entry.text);
      });

      item.querySelector('.history-item-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'copyToClipboard', text: entry.text });
      });

      elements.historyList.appendChild(item);
    });
  }

  function clearHistory() {
    vscode.postMessage({ type: 'clearHistory' });
  }

  let recoveredSession = null;

  function showRecoveryModal(session) {
    recoveredSession = session;
    const duration = formatTime(session.elapsedTime);
    elements.recoveryMessage.textContent = `A recording was interrupted (${duration}). Would you like to recover it?`;
    elements.recoveryModal.style.display = 'flex';
  }

  function hideRecoveryModal() {
    elements.recoveryModal.style.display = 'none';
    recoveredSession = null;
  }

  function recoverSession() {
    hideRecoveryModal();
    vscode.postMessage({ type: 'saveSession', session: null });
  }

  function downloadRecoveredAudio() {
    hideRecoveryModal();
    vscode.postMessage({ type: 'saveSession', session: null });
  }

  function discardSession() {
    hideRecoveryModal();
    vscode.postMessage({ type: 'saveSession', session: null });
  }

  function showRecordingError(message, showBrowserFallback) {
    let instructions = `<p><strong>Error:</strong> ${escapeHtml(message)}</p>`;

    if (showBrowserFallback && recordingCapabilities) {
      instructions += `
        <div class="browser-fallback-section">
          <p>You can record audio in your browser instead:</p>
          <button id="browser-record-btn" class="primary-button">Record in Browser</button>
        </div>
      `;
    }

    elements.permissionErrorInstructions.innerHTML = instructions;
    elements.permissionError.style.display = 'block';
    elements.permissionError.querySelector('.permission-error-title').textContent = 'Recording Error';

    // Attach event listener to browser record button if it exists
    const browserBtn = document.getElementById('browser-record-btn');
    if (browserBtn) {
      browserBtn.addEventListener('click', startBrowserRecording);
    }
  }

  function showPermissionError(platform) {
    let instructions = '';

    if (platform === 'darwin') {
      instructions = `
        <p><strong>macOS:</strong></p>
        <ol>
          <li>Open <strong>System Settings</strong></li>
          <li>Go to <strong>Privacy & Security → Microphone</strong></li>
          <li>Enable access for <strong>Visual Studio Code</strong></li>
          <li><strong>Restart VS Code</strong> after granting permission</li>
        </ol>
      `;
    } else if (platform === 'win32') {
      instructions = `
        <p><strong>Windows:</strong></p>
        <ol>
          <li>Open <strong>Settings</strong> (Win + I)</li>
          <li>Go to <strong>Privacy → Microphone</strong></li>
          <li>Enable "Allow apps to access your microphone"</li>
          <li>Make sure <strong>VS Code</strong> is allowed</li>
        </ol>
      `;
    } else {
      instructions = `
        <p><strong>Linux:</strong></p>
        <ol>
          <li>Make sure your microphone is working in system</li>
          <li>Check PulseAudio/PipeWire settings (<code>pavucontrol</code>)</li>
          <li>Ensure no other app is blocking the microphone</li>
          <li>Try restarting VS Code</li>
        </ol>
      `;
    }

    elements.permissionErrorInstructions.innerHTML = instructions;
    elements.permissionError.style.display = 'block';
  }

  function hidePermissionError() {
    elements.permissionError.style.display = 'none';
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

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.type) {
      case 'settingsLoaded':
        elements.provider.value = message.data.provider;
        elements.localUrl.value = message.data.localApiUrl || '';
        elements.enableCleanup.checked = message.data.enableCleanup;
        // Set cleanup model, fallback to first option if saved value doesn't exist
        elements.cleanupModel.value = message.data.cleanupModel;
        if (!elements.cleanupModel.value) {
          elements.cleanupModel.selectedIndex = 0;
        }
        elements.language.value = message.data.language || '';
        handleProviderChange();
        break;

      case 'historyLoaded':
        renderHistory(message.data);
        break;

      case 'apiKeyLoaded':
        elements.apiKeyStatus.textContent = message.hasKey ? 'API key is set' : 'No API key saved';
        elements.apiKeyStatus.className = message.hasKey ? 'status-text success' : 'status-text';
        break;

      case 'uiStateLoaded':
        uiState = message.data;
        applyCollapsedState();
        break;

      case 'recordingCapabilities':
        recordingCapabilities = message.data;
        break;

      case 'recordingStarted':
        isRecording = true;
        elements.recordingStatus.textContent = 'Recording...';
        elements.recordingStatus.className = 'recording';
        elements.startBtn.style.display = 'none';
        elements.startBtn.disabled = false;
        elements.pauseBtn.style.display = 'none'; // Pause not supported with native
        elements.stopBtn.style.display = 'inline-flex';
        elements.stopBtn.disabled = false;
        elements.saveAudioBtn.style.display = 'none';
        hidePermissionError();
        break;

      case 'recordingStopped':
        resetRecordingUI();
        break;

      case 'recordingError':
        resetRecordingUI();
        showRecordingError(message.message, message.showBrowserFallback);
        break;

      case 'recordingTime':
        elements.timer.textContent = formatTime(message.elapsed);
        break;

      case 'transcriptionStart':
        showProgress('Starting transcription...');
        break;

      case 'transcriptionProgress':
        showProgress(message.message);
        break;

      case 'transcriptionComplete':
        hideProgress();
        const finalText = message.cleaned || message.text;
        showTranscription(finalText);

        vscode.postMessage({
          type: 'addToHistory',
          entry: {
            date: new Date().toISOString(),
            text: finalText,
            preview: finalText.substring(0, 50) + (finalText.length > 50 ? '...' : ''),
            duration: 0,
          },
        });

        vscode.postMessage({ type: 'copyToClipboard', text: finalText });
        lastAudioBlob = null;
        break;

      case 'transcriptionError':
        hideProgress();
        break;

      case 'sessionRecovery':
        showRecoveryModal(message.session);
        break;

      case 'copied':
        elements.copyStatus.style.display = 'block';
        setTimeout(() => {
          elements.copyStatus.style.display = 'none';
        }, 2000);
        break;

      case 'permissionDenied':
        showPermissionError(message.platform);
        break;
    }
  });

  init();
})();
