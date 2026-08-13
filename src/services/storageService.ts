import * as vscode from 'vscode';
import {
  Provider,
  TranscriberSettings,
  defaultSettings,
  HistoryEntry,
  RecordingSession,
} from '../types';

export class StorageService {
  private static readonly SETTINGS_KEY = 'voiceTranscriber.settings';
  private static readonly HISTORY_KEY = 'voiceTranscriber.history';
  private static readonly SESSION_KEY = 'voiceTranscriber.session';
  private static readonly UI_STATE_KEY = 'voiceTranscriber.uiState';
  private static readonly LEGACY_API_KEY_KEY = 'voiceTranscriber.apiKey';

  private migration: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  private static apiKeySecret(provider: Provider): string {
    return `voiceTranscriber.apiKey.${provider}`;
  }

  /**
   * Runs lazily on first key access rather than at activation — a stalled system keychain
   * would otherwise stall the whole extension.
   */
  private ensureMigrated(): Promise<void> {
    if (!this.migration) {
      this.migration = this.migrateLegacyApiKey().catch((error) => {
        this.migration = undefined;
        throw error;
      });
    }
    return this.migration;
  }

  /** Keys used to live under a single provider-less secret; move them to the OpenAI slot. */
  private async migrateLegacyApiKey(): Promise<void> {
    const legacy = await this.context.secrets.get(StorageService.LEGACY_API_KEY_KEY);
    if (!legacy) {
      return;
    }
    const existing = await this.context.secrets.get(StorageService.apiKeySecret('openai'));
    if (!existing) {
      await this.context.secrets.store(StorageService.apiKeySecret('openai'), legacy);
    }
    await this.context.secrets.delete(StorageService.LEGACY_API_KEY_KEY);
  }

  async getApiKey(provider: Provider): Promise<string | undefined> {
    await this.ensureMigrated();
    return this.context.secrets.get(StorageService.apiKeySecret(provider));
  }

  async setApiKey(provider: Provider, key: string): Promise<void> {
    await this.ensureMigrated();
    await this.context.secrets.store(StorageService.apiKeySecret(provider), key);
  }

  async deleteApiKey(provider: Provider): Promise<void> {
    await this.context.secrets.delete(StorageService.apiKeySecret(provider));
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
