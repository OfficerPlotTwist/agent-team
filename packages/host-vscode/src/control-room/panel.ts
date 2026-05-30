import * as vscode from "vscode";
import type { BusEvent, ActionRequestEvent } from "@agent-team/core";

export class ControlRoomPanel {
  readonly #panel: vscode.WebviewPanel;
  readonly #pending = new Map<string, (allow: boolean) => void>();

  private constructor(panel: vscode.WebviewPanel) {
    this.#panel = panel;

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string; requestId?: string };
      if ((m.type !== "allow" && m.type !== "deny") || typeof m.requestId !== "string") return;
      const resolve = this.#pending.get(m.requestId);
      if (!resolve) return;
      this.#pending.delete(m.requestId);
      resolve(m.type === "allow");
    });

    panel.onDidDispose(() => {
      for (const resolve of this.#pending.values()) resolve(false);
      this.#pending.clear();
    });
  }

  static create(extensionUri: vscode.Uri): ControlRoomPanel {
    const panel = vscode.window.createWebviewPanel(
      "agentTeamControlRoom",
      "Agent Team — Control Room",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.webview.html = ControlRoomPanel.#getHtml(panel.webview, extensionUri);
    return new ControlRoomPanel(panel);
  }

  pushEvent(event: BusEvent): void {
    void this.#panel.webview.postMessage({ type: "event", payload: event });
  }

  askGate(req: ActionRequestEvent): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pending.set(req.requestId, resolve);
      void this.#panel.webview.postMessage({
        type: "gate",
        requestId: req.requestId,
        category: req.category,
        summary: req.summary,
        payload: req.payload,
      });
    });
  }

  dispose(): void {
    this.#panel.dispose();
  }

  static #getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "control-room.js"),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "control-room.css"),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${String(cssUri)}">
  <title>Agent Team Control Room</title>
</head>
<body>
  <section id="feed-section">
    <h2>Live Feed</h2>
    <ul id="feed"></ul>
  </section>
  <section id="inbox-section">
    <h2>Action Inbox</h2>
    <div id="inbox"></div>
  </section>
  <script src="${String(scriptUri)}"></script>
</body>
</html>`;
  }
}
