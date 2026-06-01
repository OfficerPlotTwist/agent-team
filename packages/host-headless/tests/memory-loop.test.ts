import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { TaskGraph } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("shared-memory closed loop (cross-run, offline)", () => {
  let repo: string;
  let dbDir: string;
  let dbPath: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s5-repo-")).split("\\").join("/");
    dbDir = mkdtempSync(join(tmpdir(), "s5-db-")).split("\\").join("/");
    dbPath = join(dbDir, "memory.db");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "seed"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("run 1 records a decision; run 2 retrieves it into the next agent's worktree", async () => {
    // --- Run 1: node "auth" concludes; host records its done summary ---
    const q1: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "added JWT login authentication", total_cost_usd: 0.01 });
    };
    const run1 = composeHeadless({
      repoRoot: repo,
      graph: new TaskGraph([{ id: "auth", role: "coder", goal: "implement login authentication", dependsOn: [] }]),
      query: q1, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    await run1.run();
    run1.close();

    // --- Run 2: a later agent whose goal is near "auth" reads its memory file ---
    let seenMemory = "";
    const q2: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      const f = join(cwd, ".agent-team", "memory-auth.md");
      seenMemory = existsSync(f) ? readFileSync(f, "utf8") : "";
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 });
    };
    const run2 = composeHeadless({
      repoRoot: repo,
      graph: new TaskGraph([{ id: "fixauth", role: "coder", goal: "fix the login authentication bug", dependsOn: [] }]),
      query: q2, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    await run2.run();
    run2.close();

    expect(seenMemory).toContain("added JWT login authentication");
    expect(seenMemory).toContain("implement login authentication"); // the recorded goal
  });
});
