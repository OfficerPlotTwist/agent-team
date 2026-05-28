#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent, ActionRequestEvent } from "@agent-team/core";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "./compose.js";

interface Args {
  goal: string;
  repo: string;
  model: string;
  maxTurns: number;
  role: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def?: string): string => {
    const i = argv.indexOf(flag);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    if (def !== undefined) return def;
    throw new Error(`missing required flag ${flag}`);
  };
  return {
    goal: get("--goal"),
    repo: get("--repo", process.cwd()),
    model: get("--model", "claude-opus-4-6"),
    maxTurns: Number(get("--max-turns", "50")),
    role: get("--role", "coder"),
  };
}

async function ensureIntegrationBranch(repo: string): Promise<void> {
  const { NodeGitRunner } = await import("@agent-team/core/node");
  const git = new NodeGitRunner();
  const exists = await git.run(["rev-parse", "--verify", "agentteam/integration"], repo);
  if (exists.code !== 0) {
    await git.run(["branch", "agentteam/integration"], repo);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureIntegrationBranch(args.repo);

  const graph = new TaskGraph([
    { id: "n1", role: args.role as never, goal: args.goal, dependsOn: [] },
  ]);

  const rl = createInterface({ input: stdin, output: stdout });
  const host = composeHeadless({
    repoRoot: args.repo,
    graph,
    query: query as unknown as QueryFn,
    model: args.model,
    maxTurns: args.maxTurns,
    permTimeoutMs: 60_000,
    onGate: async (req: ActionRequestEvent) => {
      const ans = await rl.question(`GATE [${req.category}] ${req.summary} — allow? [y/N] `);
      return ans.trim().toLowerCase() === "y";
    },
  });

  host.bus.subscribe((e: BusEvent) => {
    if (e.kind === "message") stdout.write(`  ${e.from}: ${e.text}\n`);
    else if (e.kind === "tool_call") stdout.write(`  ${e.from} → ${e.name}\n`);
    else if (e.kind === "file_change") stdout.write(`  ~ ${e.path}\n`);
    else if (e.kind === "action_request") stdout.write(`  ? ${e.from} [${e.category}] ${e.summary}\n`);
    else if (e.kind === "done") stdout.write(`  ✓ ${e.from}: ${e.summary}\n`);
    else if (e.kind === "error") stdout.write(`  ✗ ${e.from}: ${e.message}\n`);
  });

  const result = await host.run();
  rl.close();
  stdout.write(`\nstatus: ${result.status}\n`);
  stdout.write(`completed: ${result.completed.join(", ") || "(none)"}\n`);
  stdout.write(`blocked: ${result.blocked.join(", ") || "(none)"}\n`);
  stdout.write(`total cost: $${host.ledger.total().toFixed(4)}\n`);
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
