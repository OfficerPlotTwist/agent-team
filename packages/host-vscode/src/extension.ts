import * as vscode from "vscode";
import { ControlRoomPanel } from "./control-room/panel.js";
import { composeVscode } from "./compose.js";
import { EditorStateSource } from "./editor-state-source.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-team.run", async () => {
      const panel = ControlRoomPanel.create(context.extensionUri);
      context.subscriptions.push({ dispose: () => panel.dispose() });

      const editorStateSource = new EditorStateSource();
      editorStateSource.register(context.subscriptions);

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Task Graph": ["json"] },
        title: "Select a task graph JSON file",
      });
      if (!uris?.[0]) {
        panel.dispose();
        return;
      }

      try {
        const result = await composeVscode(uris[0].fsPath, panel, editorStateSource);
        void vscode.window.showInformationMessage(
          `Agent Team done — status: ${result.status} | completed: ${result.completed.join(", ") || "none"} | blocked: ${result.blocked.join(", ") || "none"}`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Agent Team error: ${String(err)}`);
      }
    }),
  );
}

export function deactivate(): void {
  // No persistent state to clean up — each run is self-contained
}
