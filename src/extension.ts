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
        VoiceTranscriberPanel.revive(webviewPanel, context);
      },
    });
  }
}

export function deactivate() {}
