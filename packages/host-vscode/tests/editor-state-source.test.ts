import { it, expect, vi, beforeEach } from "vitest";

// vi.mock must precede any import that pulls in 'vscode'.
let activeEditorHandler: (ed: unknown) => void = () => {};
let selectionHandler: (e: unknown) => void = () => {};

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() { return undefined; },
    onDidChangeActiveTextEditor: (fn: (ed: unknown) => void) => {
      activeEditorHandler = fn;
      return { dispose: vi.fn() };
    },
    onDidChangeTextEditorSelection: (fn: (e: unknown) => void) => {
      selectionHandler = fn;
      return { dispose: vi.fn() };
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
    // Real vscode.workspace.asRelativePath accepts a string OR a Uri; the source
    // passes the Uri, so the stub must handle both (it received a Uri here).
    asRelativePath: (u: { fsPath: string } | string) =>
      (typeof u === "string" ? u : u.fsPath).replace(/^\/repo\//, ""),
  },
}));

import { EditorStateSource } from "../src/editor-state-source.js";

// A synthetic vscode TextEditor + Selection shape (only the fields the source reads).
function fakeEditor(relPath: string, sel: { sl: number; sc: number; el: number; ec: number }) {
  return {
    document: { uri: { fsPath: `/repo/${relPath}`, scheme: "file" } },
    selection: {
      active: { line: sel.el, character: sel.ec },
      start: { line: sel.sl, character: sel.sc },
      end: { line: sel.el, character: sel.ec },
      isEmpty: sel.sl === sel.el && sel.sc === sel.ec,
    },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

it("current() is undefined before any editor event", () => {
  const src = new EditorStateSource();
  expect(src.current()).toBeUndefined();
  src.dispose();
});

it("captures active file + cursor on active-editor change (0-based, repo-relative POSIX)", () => {
  const src = new EditorStateSource();
  activeEditorHandler(fakeEditor("src/app.ts", { sl: 4, sc: 0, el: 4, ec: 0 }));
  const state = src.current();
  expect(state?.activeFile).toBe("src/app.ts");
  expect(state?.cursor).toEqual({ line: 4, col: 0 });
  expect(state?.selection).toBeUndefined(); // empty selection => no box
  src.dispose();
});

it("captures selection box on selection change", () => {
  const src = new EditorStateSource();
  selectionHandler({ textEditor: fakeEditor("src/app.ts", { sl: 2, sc: 1, el: 5, ec: 3 }) });
  const state = src.current();
  expect(state?.activeFile).toBe("src/app.ts");
  expect(state?.cursor).toEqual({ line: 5, col: 3 }); // active end of selection
  expect(state?.selection).toEqual({
    start: { line: 2, col: 1 },
    end: { line: 5, col: 3 },
  });
  src.dispose();
});

it("omits activeFile for a non-file editor (e.g. output channel)", () => {
  const src = new EditorStateSource();
  activeEditorHandler({
    document: { uri: { fsPath: "/foo", scheme: "output" } },
    selection: {
      active: { line: 0, character: 0 },
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
      isEmpty: true,
    },
  });
  const state = src.current();
  expect(state?.activeFile).toBeUndefined();
  src.dispose();
});

it("clears snapshot when active editor becomes undefined", () => {
  const src = new EditorStateSource();
  activeEditorHandler(fakeEditor("src/app.ts", { sl: 0, sc: 0, el: 0, ec: 0 }));
  activeEditorHandler(undefined);
  expect(src.current()).toBeUndefined();
  src.dispose();
});
