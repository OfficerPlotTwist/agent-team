import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RingBuffer } from "./ring-buffer.js";
import type { UnstampedBroadcast } from "./ring-buffer.js";
import { parseClientCommand } from "./protocol.js";
import type { ClientCommand, DirectEnvelope, ServerEnvelope } from "./protocol.js";

export interface ControlServerOptions {
  /** Absolute path to the built UI (vite outDir). Missing ⇒ 503 with build hint. */
  uiDist: string;
  /** 0 = ephemeral (tests). Default 7340. Always binds 127.0.0.1 (spec §9). */
  port?: number;
  ringCapacity?: number; // default 5000
  heartbeatMs?: number; // default 15000
  runState: () => "running" | "settled";
  onCommand: (cmd: ClientCommand, reply: (env: DirectEnvelope) => void) => void;
  onClientConnected?: () => void;
  onClientDisconnected?: () => void;
}

export interface ControlServer {
  broadcast(env: UnstampedBroadcast): void;
  port(): number;
  clientCount(): number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

function send(ws: WebSocket, env: ServerEnvelope): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
}

async function serveStatic(uiDist: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(join(uiDist, "index.html"))) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI not built — run: npm run build:ui -w @agent-team/host-web");
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const path = normalize(join(uiDist, rel));
  if (!path.startsWith(normalize(uiDist))) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

export function createControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const ring = new RingBuffer(opts.ringCapacity ?? 5_000);
  const http = createHttpServer((req, res) => {
    void serveStatic(opts.uiDist, req, res);
  });
  const wss = new WebSocketServer({ server: http });
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate(); // missed a pong — counts as a disconnect via 'close'
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 15_000);

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    opts.onClientConnected?.();
    send(ws, { seq: 0, type: "hello", latestSeq: ring.latestSeq(), runState: opts.runState() });

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return; // garbage frames are dropped, not fatal
      }
      const cmd = parseClientCommand(parsed);
      if (cmd === null) return;
      if (cmd.type === "resume") {
        const { items, gapped } = ring.after(cmd.afterSeq);
        if (gapped) {
          send(ws, { seq: 0, type: "hello", latestSeq: ring.latestSeq(), runState: opts.runState(), gapped: true });
        }
        for (const env of items) send(ws, env);
        return;
      }
      opts.onCommand(cmd, (env) => send(ws, env));
    });

    ws.on("close", () => opts.onClientDisconnected?.());
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 7340, "127.0.0.1", () => {
      resolve({
        broadcast: (env) => {
          const stamped = ring.stamp(env);
          for (const ws of wss.clients) send(ws, stamped);
        },
        port: () => (http.address() as AddressInfo).port,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => {
              http.close(() => done());
            });
          }),
      });
    });
  });
}
