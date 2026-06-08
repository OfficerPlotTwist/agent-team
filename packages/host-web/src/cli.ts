#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent, TaskNode } from "@agent-team/core";
import type { QueryFn } from "@agent-team/adapters-claude";
import { parseArgs } from "./cli-args.js";
import { composeWeb } from "./compose.js";

async function ensureIntegrationBranch(repo: string): Promise<void> {
  const { NodeGitRunner } = await import("@agent-team/core/node");
  const git = new NodeGitRunner();
  const exists = await git.run(["rev-parse", "--verify", "agentteam/integration"], repo);
  if (exists.code !== 0) await git.run(["branch", "agentteam/integration"], repo);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureIntegrationBranch(args.repo);
  const graph = new TaskGraph(JSON.parse(readFileSync(args.graph, "utf8")) as TaskNode[]);

  const host = await composeWeb({
    repoRoot: args.repo,
    graph,
    query: query as unknown as QueryFn,
    model: args.model,
    maxTurns: args.maxTurns,
    permTimeoutMs: 60_000,
    costCeilingUsd: args.costCeiling,
    memoryDb: args.memory,
    port: args.port,
  });

  stdout.write(`Control Room: http://127.0.0.1:${host.port()}/\n`);
  host.bus.subscribe((e: BusEvent) => {
    if (e.kind === "done") stdout.write(`  ✓ ${e.from}: ${e.summary}\n`);
    else if (e.kind === "error") stdout.write(`  ✗ ${e.from}: ${e.message}\n`);
  });

  const result = await host.run();
  stdout.write(`\nrun settled: ${result.status}\n`);
  stdout.write(`completed: ${result.completed.join(", ") || "(none)"}\n`);
  stdout.write(`blocked: ${result.blocked.join(", ") || "(none)"}\n`);
  stdout.write(`total cost: $${host.ledger.total().toFixed(4)}\n`);
  stdout.write(`server stays up for gates history & proposal review — Ctrl+C to exit\n`);
  // Intentionally no process.exit(): the http server keeps the loop alive for review.
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
