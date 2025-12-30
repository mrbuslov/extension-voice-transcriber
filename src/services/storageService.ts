import * as vscode from 'vscode';
import {
  TranscriberSettings,
  defaultSettings,
  HistoryEntry,
  RecordingSession,
} from '../types';

export class StorageService {
  private static readonly SETTINGS_KEY = 'voiceTranscriber.settings';
  private static readonly HISTORY_KEY = 'voiceTranscriber.history';
  private static readonly SESSION_KEY = 'voiceTranscriber.session';
  private static readonly API_KEY_KEY = 'voiceTranscriber.apiKey';
  private static readonly UI_STATE_KEY = 'voiceTranscriber.uiState';

  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(StorageService.API_KEY_KEY);
  }

  async setApiKey(key: string): Promise<void> {
    await this.context.secrets.store(StorageService.API_KEY_KEY, key);
  }

  async deleteApiKey(): Promise<void> {
    await this.context.secrets.delete(StorageService.API_KEY_KEY);
  }

  getSettings(): TranscriberSettings {
    const saved = this.context.globalState.get<Partial<TranscriberSettings>>(
      StorageService.SETTINGS_KEY,
      {}
    );
    // Merge with defaults to ensure all fields exist
    return { ...defaultSettings, ...saved };
  }

  async updateSettings(settings: Partial<TranscriberSettings>): Promise<void> {
    const current = this.getSettings();
    await this.context.globalState.update(StorageService.SETTINGS_KEY, {
      ...current,
      ...settings,
    });
  }

  getHistory(): HistoryEntry[] {
    return this.context.globalState.get<HistoryEntry[]>(StorageService.HISTORY_KEY, []);
  }

  async addToHistory(entry: HistoryEntry): Promise<void> {
    const history = this.getHistory();
    history.unshift(entry);
    if (history.length > 10) {
      history.pop();
    }
    await this.context.globalState.update(StorageService.HISTORY_KEY, history);
  }

  async clearHistory(): Promise<void> {
    await this.context.globalState.update(StorageService.HISTORY_KEY, []);
  }

  getRecordingSession(): RecordingSession | null {
    return this.context.globalState.get<RecordingSession | null>(
      StorageService.SESSION_KEY,
      null
    );
  }

  async saveRecordingSession(session: RecordingSession | null): Promise<void> {
    await this.context.globalState.update(StorageService.SESSION_KEY, session);
  }

  getUiState(): Record<string, unknown> {
    return this.context.globalState.get<Record<string, unknown>>(
      StorageService.UI_STATE_KEY,
      {}
    );
  }

  async saveUiState(state: Record<string, unknown>): Promise<void> {
    const current = this.getUiState();
    await this.context.globalState.update(StorageService.UI_STATE_KEY, {
      ...current,
      ...state,
    });
  }
}
