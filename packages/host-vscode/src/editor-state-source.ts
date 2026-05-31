import * as vscode from "vscode";
import type { EditorState, Pos } from "@agent-team/core";

/**
 * Live snapshot of the human's editor state, sourced from vscode.window events.
 * Host-only (subscribes to the vscode API) — never imported by core. Maintains a
 * single mutable latest snapshot; current() is read at each hydrate boundary.
 */
export class EditorStateSource {
  #snapshot: EditorState | undefined;
  readonly #disposables: vscode.Disposable[] = [];

  constructor() {
    this.#disposables.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => this.#onEditor(ed)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.#onEditor(e.textEditor)),
    );
    if (vscode.window.activeTextEditor) {
      this.#onEditor(vscode.window.activeTextEditor);
    }
  }

  current(): EditorState | undefined {
    return this.#snapshot;
  }

  /** Push disposables onto the extension context so the source is torn down with it. */
  register(subscriptions: { dispose(): unknown }[]): void {
    subscriptions.push({ dispose: () => this.dispose() });
  }

  dispose(): void {
    for (const d of this.#disposables.splice(0)) d.dispose();
    this.#snapshot = undefined;
  }

  #onEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.#snapshot = undefined;
      return;
    }
    const state: EditorState = {};

    const uri = editor.document.uri;
    if (uri.scheme === "file") {
      // asRelativePath yields a repo-relative path; normalize to POSIX separators.
      state.activeFile = vscode.workspace.asRelativePath(uri, false).split("\\").join("/");
    }

    const sel = editor.selection;
    state.cursor = toPos(sel.active);
    if (!sel.isEmpty) {
      state.selection = { start: toPos(sel.start), end: toPos(sel.end) };
    }

    this.#snapshot = state;
  }
}

function toPos(p: vscode.Position): Pos {
  return { line: p.line, col: p.character };
}
