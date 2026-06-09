#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { QueryFn } from "@agent-team/adapters-claude";
import { parseArgs } from "./cli-args.js";
import type { Variant } from "./variant.js";
import { expandTask } from "./expand.js";
import { composeExperiment } from "./compose.js";
import { MetricsCollector } from "./metrics.js";
import { renderReport } from "./report.js";
import { selectWinner } from "./selector.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variants = JSON.parse(readFileSync(args.variants, "utf8")) as Variant[];
  const git = new NodeGitRunner();

  const experiment = expandTask(
    { taskId: args.taskId, role: args.role as Role, goal: args.task },
    variants,
  );

  const host = await composeExperiment({
    repoRoot: args.repo,
    experiment,
    query: query as unknown as QueryFn,
    defaultMaxTurns: args.maxTurns,
    defaultPermTimeoutMs: 60_000,
    git,
  });

  const collector = new MetricsCollector({
    bus: host.bus,
    ledger: host.ledger,
    git,
    repoRoot: args.repo,
    base: host.base,
    variantByNodeId: experiment.variantByNodeId,
    role: experiment.baseRole,
  });

  stdout.write(`experiment: ${variants.length} variants on "${args.task}" (base ${host.base.slice(0, 7)})\n`);
  const result = await host.run();
  const rows = await collector.collect();

  // Per-variant full diff artifacts (side-by-side comparison).
  const reportDir = dirname(args.report);
  for (const r of rows) {
    const diff = (await git.run(["diff", `${host.base}..${r.branch}`], args.repo)).stdout;
    writeFileSync(join(reportDir, `${r.variant}.diff`), diff);
  }

  // Tournament: promote the winner to a stable branch (fast-forward from the frozen base).
  const winner = selectWinner(rows);
  let promoted = "(none — every variant failed)";
  if (winner) {
    const winnerBranch = `agentteam/winner-${args.taskId}`;
    await git.run(["branch", "-f", winnerBranch, winner.branch], args.repo);
    promoted = `${winner.variant} → ${winnerBranch}`;
  }

  const { markdown, json } = renderReport(rows, { taskGoal: args.task, modelId: args.model });
  writeFileSync(args.report, markdown);
  writeFileSync(args.report.replace(/\.md$/, ".json"), json);

  stdout.write(`\nrun: ${result.status}\nwinner: ${promoted}\n`);
  for (const r of [...rows].sort((a, b) => a.costUsd - b.costUsd)) {
    stdout.write(`  ${r.variant}: ${r.status} · $${r.costUsd.toFixed(4)} · ${r.turns} turns · ${r.branch}\n`);
  }
  stdout.write(`report → ${args.report} · diffs → ${reportDir}/<variant>.diff\n`);
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
