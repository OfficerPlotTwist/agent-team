import type { ServerEnvelope, ClientCommand } from "../../src/protocol.js";
import { FeedPane } from "./feed.js";
import { GatesPane } from "./gates.js";
import { ProposalsPane } from "./proposals.js";

const connbar = document.getElementById("connbar")!;
const feed = new FeedPane(document.getElementById("feed")!);
const gates = new GatesPane(document.getElementById("gates")!, (cmd) => send(cmd));
const proposals = new ProposalsPane(document.getElementById("proposals")!, (cmd) => send(cmd));

let ws: WebSocket | null = null;
let lastSeq = 0;
let backoffMs = 500;

function send(cmd: ClientCommand): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function setConn(state: "connected" | "reconnecting" | "gapped", text: string): void {
  connbar.className = state;
  connbar.textContent = text;
}

function onEnvelope(env: ServerEnvelope): void {
  if (env.seq > 0) lastSeq = env.seq;
  switch (env.type) {
    case "hello":
      if (env.gapped) {
        feed.markGap();
        setConn("gapped", `reconnected — missed events (server seq ${env.latestSeq})`);
      } else {
        setConn("connected", `connected — run ${env.runState}`);
      }
      return;
    case "event":
      feed.append(env.payload);
      return;
    case "gate":
      gates.add(env);
      return;
    case "gate_resolved":
      gates.resolve(env.requestId);
      return;
    case "proposals":
      proposals.render(env.items);
      return;
    case "proposal_diff":
      proposals.showDiff(env.branch, env.diff);
      return;
    case "proposal_outcome":
      proposals.outcome(env.branch, env.outcome as { status: string; files?: string[] });
      return;
  }
}

function connect(): void {
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () => {
    backoffMs = 500;
    setConn("connected", "connected");
    send({ type: "resume", afterSeq: lastSeq }); // afterSeq 0 on first connect = full backfill
  };
  ws.onmessage = (e) => onEnvelope(JSON.parse(String(e.data)) as ServerEnvelope);
  ws.onclose = () => {
    setConn("reconnecting", `reconnecting in ${(backoffMs / 1000).toFixed(1)}s…`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 8_000);
  };
  ws.onerror = () => ws?.close();
}

connect();
