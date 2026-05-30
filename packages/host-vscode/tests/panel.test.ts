import { it, expect, vi, beforeEach } from "vitest";

// vi.mock must be called before any import that uses 'vscode'
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn() },
  ViewColumn: { Beside: 2 },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) =>
      ({ toString: () => parts.join("/"), fsPath: parts.join("/") }),
  },
}));

import { ControlRoomPanel } from "../src/control-room/panel.js";
import * as vscode from "vscode";
import type { BusEvent, ActionRequestEvent } from "@agent-team/core";

// ── helpers ────────────────────────────────────────────────────────────────

function makeMockWebviewPanel() {
  let msgHandler: (msg: unknown) => void = () => {};
  const disposeHandlers: Array<() => void> = [];
  const posted: unknown[] = [];

  const webviewPanel = {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u: unknown) => u,
      postMessage: vi.fn((msg: unknown) => { posted.push(msg); return Promise.resolve(true); }),
      onDidReceiveMessage: (fn: (msg: unknown) => void) => {
        msgHandler = fn;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: (fn: () => void) => {
      disposeHandlers.push(fn);
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(() => { disposeHandlers.forEach(fn => fn()); }),
    reveal: vi.fn(),
  };

  return {
    webviewPanel,
    posted,
    sendFromWebview: (msg: unknown) => msgHandler(msg),
    triggerDispose: () => disposeHandlers.forEach(fn => fn()),
  };
}

function fakeExtensionUri(): vscode.Uri {
  return { fsPath: "/ext", toString: () => "/ext" } as unknown as vscode.Uri;
}

function makeDoneEvent(): BusEvent {
  return { kind: "done", from: "coder#1", summary: "ok", seq: 1, ts: 0 };
}

function makeGateReq(requestId = "req-abc"): ActionRequestEvent {
  return { kind: "action_request", from: "coder#1", requestId, category: "destructive", summary: "delete x", timeoutMs: 30_000 };
}

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

it("pushEvent posts { type: 'event', payload } to the webview", () => {
  const { webviewPanel, posted } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const event = makeDoneEvent();
  panel.pushEvent(event);
  expect(posted).toEqual([{ type: "event", payload: event }]);
});

it("askGate posts { type: 'gate', requestId, ... } then resolves true on allow", async () => {
  const { webviewPanel, posted, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const req = makeGateReq("req-1");
  const promise = panel.askGate(req);

  expect(posted.at(-1)).toMatchObject({ type: "gate", requestId: "req-1", category: "destructive" });

  sendFromWebview({ type: "allow", requestId: "req-1" });
  expect(await promise).toBe(true);
});

it("askGate resolves false when webview sends deny", async () => {
  const { webviewPanel, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const promise = panel.askGate(makeGateReq("req-2"));
  sendFromWebview({ type: "deny", requestId: "req-2" });
  expect(await promise).toBe(false);
});

it("askGate resolves false automatically when panel is disposed", async () => {
  const { webviewPanel, triggerDispose } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const promise = panel.askGate(makeGateReq("req-3"));
  triggerDispose();
  expect(await promise).toBe(false);
});

it("multiple concurrent askGate calls resolve independently", async () => {
  const { webviewPanel, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());

  const p1 = panel.askGate(makeGateReq("req-a"));
  const p2 = panel.askGate(makeGateReq("req-b"));

  // Respond in reverse order
  sendFromWebview({ type: "deny", requestId: "req-b" });
  sendFromWebview({ type: "allow", requestId: "req-a" });

  expect(await p1).toBe(true);
  expect(await p2).toBe(false);
});
