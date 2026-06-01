#!/usr/bin/env node
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger, BusEvent } from "@agent-team/core";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "./compose-ambient.js";
import { CommitWatcher } from "./commit-watcher.js";

interface Args {
  repo: string;
  model: string;
  maxTurns: number;
  once?: string;
}

function parseArgs(argv: string[]): Args {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    repo: getOpt("--repo") ?? process.cwd(),
    model: getOpt("--model") ?? "claude-opus-4-8",
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    once: getOpt("--once"),
  };
}

function printFeed(e: BusEvent): void {
  if (e.kind === "file_change") stdout.write(`  ~ ${e.from} ${e.path}\n`);
  else if (e.kind === "done") stdout.write(`  ✓ ${e.from}: ${e.summary}\n`);
  else if (e.kind === "error") stdout.write(`  ✗ ${e.from}: ${e.message}\n`);
  else if (e.kind === "ambient_report")
    stdout.write(`  ⚑ ${e.from} [${e.trigger.commitSha.slice(0, 7)}] ${e.summary}${e.branch ? ` → ${e.branch}` : ""}\n`);
}

async function changedFiles(git: NodeGitRunner, repo: string, sha: string): Promise<string[]> {
  const res = await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repo);
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const git = new NodeGitRunner();
  const host = composeAmbient({
    repoRoot: args.repo,
    query: query as unknown as QueryFn,
    model: args.model,
    maxTurns: args.maxTurns,
    permTimeoutMs: 60_000,
    git,
  });
  host.bus.subscribe(printFeed);

  if (args.once) {
    const sha = (await git.run(["rev-parse", args.once], args.repo)).stdout.trim();
    const scope = await changedFiles(git, args.repo, sha);
    const trigger: AmbientTrigger = { reason: "commit", commitSha: sha, scope };
    await host.fire(trigger);
    return;
  }

  const watcher = new CommitWatcher(git, args.repo, async (t) => {
    await host.fire(t);
  });
  await watcher.seed();
  watcher.start();
  stdout.write(`agent-team-ambient watching ${args.repo} — commit to trigger a review (Ctrl-C to stop)\n`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { watcher.stop(); resolve(); });
  });
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
