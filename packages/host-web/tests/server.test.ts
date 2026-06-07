import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createControlServer } from "../src/server.js";
import type { ControlServer } from "../src/server.js";
import type { ServerEnvelope, ClientCommand, DirectEnvelope } from "../src/protocol.js";
import type { BusEvent } from "@agent-team/core";

const evt = (text: string) =>
  ({ type: "event", payload: { kind: "message", from: "lead#1", text } as BusEvent }) as const;

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connect(port: number): { ws: WebSocket; received: ServerEnvelope[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: ServerEnvelope[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d)) as ServerEnvelope));
  return { ws, received };
}

describe("createControlServer", () => {
  let server: ControlServer | undefined;
  let tmp: string | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await server?.close();
    server = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const baseOpts = (over: Partial<Parameters<typeof createControlServer>[0]> = {}) => ({
    uiDist: join(tmpdir(), "definitely-missing-dist"),
    port: 0,
    runState: () => "running" as const,
    onCommand: (_cmd: ClientCommand, _reply: (env: DirectEnvelope) => void) => {},
    ...over,
  });

  it("binds 127.0.0.1 and answers 503 with build hint when ui/dist is missing", async () => {
    server = await createControlServer(baseOpts());
    const res = await fetch(`http://127.0.0.1:${server.port()}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("build:ui");
  });

  it("serves index.html and assets from uiDist", async () => {
    tmp = mkdtempSync(join(tmpdir(), "hw-dist-"));
    writeFileSync(join(tmp, "index.html"), "<html>control room</html>");
    mkdirSync(join(tmp, "assets"));
    writeFileSync(join(tmp, "assets", "app.js"), "console.log(1)");
    server = await createControlServer(baseOpts({ uiDist: tmp }));
    const page = await fetch(`http://127.0.0.1:${server.port()}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("control room");
    const js = await fetch(`http://127.0.0.1:${server.port()}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const traversal = await fetch(`http://127.0.0.1:${server.port()}/../secret`);
    expect([403, 404]).toContain(traversal.status);
  });

  it("sends hello on connect and broadcasts stamped envelopes in order", async () => {
    server = await createControlServer(baseOpts());
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1);
    expect(received[0]).toMatchObject({ seq: 0, type: "hello", latestSeq: 0, runState: "running" });
    server.broadcast(evt("a"));
    server.broadcast(evt("b"));
    await until(() => received.length >= 3);
    expect(received[1]).toMatchObject({ seq: 1, type: "event" });
    expect(received[2]).toMatchObject({ seq: 2, type: "event" });
  });

  it("resume replays exactly the gap", async () => {
    server = await createControlServer(baseOpts());
    server.broadcast(evt("a")); // 1
    server.broadcast(evt("b")); // 2
    server.broadcast(evt("c")); // 3
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1); // hello with latestSeq 3
    expect(received[0]).toMatchObject({ type: "hello", latestSeq: 3 });
    ws.send(JSON.stringify({ type: "resume", afterSeq: 1 }));
    await until(() => received.length >= 3);
    expect(received.slice(1).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("a resume past the ring capacity gets a gapped hello first", async () => {
    server = await createControlServer(baseOpts({ ringCapacity: 2 }));
    for (const t of ["a", "b", "c", "d"]) server.broadcast(evt(t)); // buffer holds 3,4
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1);
    ws.send(JSON.stringify({ type: "resume", afterSeq: 0 }));
    await until(() => received.length >= 4);
    expect(received[1]).toMatchObject({ type: "hello", gapped: true });
    expect(received.slice(2).map((e) => e.seq)).toEqual([3, 4]);
  });

  it("routes commands to onCommand and replies only to the sender", async () => {
    const seen: ClientCommand[] = [];
    server = await createControlServer(
      baseOpts({
        onCommand: (cmd, reply) => {
          seen.push(cmd);
          if (cmd.type === "proposal_show") {
            reply({ seq: 0, type: "proposal_diff", branch: cmd.branch, diff: "DIFF" });
          }
        },
      }),
    );
    const a = connect(server.port());
    const b = connect(server.port());
    sockets.push(a.ws, b.ws);
    await until(() => a.received.length >= 1 && b.received.length >= 1);
    a.ws.send(JSON.stringify({ type: "proposal_show", branch: "x" }));
    await until(() => a.received.length >= 2);
    expect(a.received[1]).toMatchObject({ type: "proposal_diff", diff: "DIFF" });
    expect(b.received).toHaveLength(1); // hello only — reply was direct
    expect(seen).toEqual([{ type: "proposal_show", branch: "x" }]);
  });

  it("notifies client connect/disconnect and emits heartbeat pings", async () => {
    let connects = 0;
    let disconnects = 0;
    server = await createControlServer(
      baseOpts({
        heartbeatMs: 25,
        onClientConnected: () => connects++,
        onClientDisconnected: () => disconnects++,
      }),
    );
    const { ws } = connect(server.port());
    sockets.push(ws);
    let pinged = false;
    ws.on("ping", () => (pinged = true));
    await until(() => connects === 1);
    await until(() => pinged);
    ws.close();
    await until(() => disconnects === 1);
  });
});
