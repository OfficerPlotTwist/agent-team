import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskNode } from "../task-graph.js";
import type { ContextProvider } from "../context-provider.js";
import { NotImplementedError } from "../context-provider.js";
import type { ContextEnvelope, ContextModality, EditorState } from "../context-envelope.js";

const CTX_DIR = ".agent-team";
const CTX_FILE = "editor-context.md";

/**
 * Materializes the `text` modality: writes a gitignored
 * `.agent-team/editor-context.md` describing the human's editor state. Non-text
 * modalities are the forward-compat runway — they throw NotImplementedError.
 * Never `git add`s (the .agent-team/ dir is gitignored by repo convention).
 */
export class TextContextProvider implements ContextProvider {
  async hydrate(
    _node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality: ContextModality = "text",
  ): Promise<void> {
    if (modality !== "text") throw new NotImplementedError(modality);
    const editor = envelope?.editor;
    if (!editor) return; // nothing to hydrate; degrades to Noop

    const md = renderEditorContext(editor);
    const dir = join(worktreePath, CTX_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CTX_FILE), md, "utf8");
  }
}

function pos(p: { line: number; col: number }): string {
  return `${p.line}:${p.col}`;
}

function renderEditorContext(e: EditorState): string {
  const lines: string[] = ["# Live editor context", ""];
  if (e.activeFile) lines.push(`- Active file: \`${e.activeFile}\``);
  if (e.cursor) lines.push(`- Cursor (line:col, 0-based): ${pos(e.cursor)}`);
  if (e.selection) {
    lines.push(`- Selection: ${pos(e.selection.start)} → ${pos(e.selection.end)}`);
  }
  lines.push("");
  return lines.join("\n");
}
