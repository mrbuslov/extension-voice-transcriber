import * as vscode from 'vscode';
import { VoiceTranscriberPanel } from './VoiceTranscriberPanel';

export function activate(context: vscode.ExtensionContext) {
  const openCommand = vscode.commands.registerCommand('voiceTranscriber.open', () => {
    VoiceTranscriberPanel.createOrShow(context);
  });

  context.subscriptions.push(openCommand);

  if (vscode.window.registerWebviewPanelSerializer) {
    vscode.window.registerWebviewPanelSerializer(VoiceTranscriberPanel.viewType, {
      async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        // Close the stale restored panel and create fresh one
        webviewPanel.dispose();
        VoiceTranscriberPanel.createOrShow(context);
      },
    });
  }
}

export function deactivate() {}
