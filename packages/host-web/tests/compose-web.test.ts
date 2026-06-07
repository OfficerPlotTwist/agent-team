import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeWeb } from "../src/compose.js";
import type { ServerEnvelope } from "../src/protocol.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

async function until(fn: () => boolean, ms = 5000): Promise<void> {
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

/** Stage a reviewer proposal branch the way composeAmbient does (manual git). */
async function stageProposal(git: NodeGitRunner, repo: string): Promise<string> {
  const sha = (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
  const branch = `agentteam/reviewer-${sha.slice(0, 7)}`;
  const wt = join(repo, ".stage-wt");
  await git.run(["worktree", "add", "-b", branch, wt, sha], repo);
  writeFileSync(join(wt, "app.ts"), "export const x = 2; // reviewed\n");
  await git.run(["add", "."], wt);
  await git.run(["commit", "-m", "review: tighten x\n\nAmbient-Finding: tightened x"], wt);
  await git.run(["worktree", "remove", "--force", wt], repo);
  return branch;
}

describe("composeWeb offline integration", () => {
  let repo: string;
  let git: NodeGitRunner;
  const sockets: WebSocket[] = [];
  let closeHost: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "hw-compose-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await closeHost?.();
    closeHost = undefined;
    rmSync(repo, { recursive: true, force: true });
  });

  it("streams bus events to a connected browser and merges the run", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "hello.txt"), "from web host\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "wrote hello", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "write hello", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 2000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "hello"));

    const result = await host.run();
    expect(result.status).toBe("complete");
    await until(() =>
      received.some((e) => e.type === "event" && (e.payload as BusEvent).kind === "done"),
    );
    const show = await git.run(["show", "agentteam/integration:hello.txt"], repo);
    expect(show.code).toBe(0);
  });

  it("routes a destructive Bash to a browser gate; allow lets the work proceed", async () => {
    const query: QueryFn = async function* ({ options }) {
      const canUseTool = (
        options as {
          canUseTool?: (n: string, i: Record<string, unknown>, o: never) => Promise<{ behavior: string }>;
        }
      ).canUseTool;
      // "rm -rf" classifies destructive ⇒ GATE under autopilot
      const decision = await canUseTool!("Bash", { command: "rm -rf ./scratch" }, {} as never);
      if (decision.behavior === "allow") {
        writeFileSync(join(options.cwd as string, "gated.txt"), "allowed from browser\n");
      }
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "gated work", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 5000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "hello"));

    const runP = host.run();
    await until(() => received.some((e) => e.type === "gate"));
    const gate = received.find((e) => e.type === "gate") as Extract<ServerEnvelope, { type: "gate" }>;
    expect(gate.category).toBe("destructive");
    ws.send(JSON.stringify({ type: "allow", requestId: gate.requestId }));

    const result = await runP;
    expect(result.status).toBe("complete");
    await until(() => received.some((e) => e.type === "gate_resolved"));
    const show = await git.run(["show", "agentteam/integration:gated.txt"], repo);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("allowed from browser");
  });

  it("pushes proposals on connect and accepts one over the socket", async () => {
    const branch = await stageProposal(git, repo);
    const query: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "noop", total_cost_usd: 0 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "noop", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 2000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "proposals"));
    const push = received.find((e) => e.type === "proposals") as Extract<ServerEnvelope, { type: "proposals" }>;
    expect(push.items).toHaveLength(1);
    expect(push.items[0]).toMatchObject({ branch, finding: "tightened x" });

    ws.send(JSON.stringify({ type: "proposal_show", branch }));
    await until(() => received.some((e) => e.type === "proposal_diff"));
    expect(
      (received.find((e) => e.type === "proposal_diff") as Extract<ServerEnvelope, { type: "proposal_diff" }>).diff,
    ).toContain("reviewed");

    ws.send(JSON.stringify({ type: "proposal_accept", branch }));
    await until(() => received.some((e) => e.type === "proposal_outcome"));
    const outcome = received.find((e) => e.type === "proposal_outcome") as Extract<
      ServerEnvelope,
      { type: "proposal_outcome" }
    >;
    expect(outcome.outcome).toMatchObject({ status: "merged" });
    expect((await git.run(["show", "main:app.ts"], repo)).stdout).toContain("reviewed");
    // refreshed list after the accept
    await until(() =>
      received.some((e) => e.type === "proposals" && e.items.length === 0),
    );
  });
});
