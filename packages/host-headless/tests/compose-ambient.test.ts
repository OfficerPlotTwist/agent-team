import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger, BusEvent } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "../src/compose-ambient.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

async function headSha(git: NodeGitRunner, repo: string): Promise<string> {
  return (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
}

describe("composeAmbient (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s4-ambient-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: add x"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("stages a proposal + posts ambient_report; base branch NOT advanced", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);

    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      writeFileSync(join(cwd, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "tightened x", total_cost_usd: 0.01 });
    };

    const host = composeAmbient({
      repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });

    const reports: BusEvent[] = [];
    const fileChanges: BusEvent[] = [];
    host.bus.subscribe((e) => {
      if (e.kind === "ambient_report") reports.push(e);
      if (e.kind === "file_change") fileChanges.push(e);
    });

    const trigger: AmbientTrigger = { reason: "commit", commitSha: sha, scope: ["app.ts"] };
    const result = await host.fire(trigger);

    expect(result.status).toBe("complete");
    expect(fileChanges.length).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
    const report = reports[0] as Extract<BusEvent, { kind: "ambient_report" }>;
    expect(report.trigger.commitSha).toBe(sha);
    expect(report.branch).toBe(`agentteam/reviewer-${sha7}`);

    // The proposal commit exists on the agent branch.
    const onBranch = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    expect(onBranch.code).toBe(0);

    // The human branch (main) was NOT advanced — never merged.
    expect((await git.run(["rev-parse", "main"], repo)).stdout.trim()).toBe(sha);
  });

  it("no changes ⇒ ambient_report with no branch, no proposal branch created", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);

    const query: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "looks fine", total_cost_usd: 0.01 });
    };

    const host = composeAmbient({
      repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });
    const reports: Array<Extract<BusEvent, { kind: "ambient_report" }>> = [];
    host.bus.subscribe((e) => { if (e.kind === "ambient_report") reports.push(e); });

    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    // The load-bearing invariant: no diff ⇒ the report carries NO proposal branch.
    expect(reports).toHaveLength(1);
    expect(reports[0].branch).toBeUndefined();
    // WorktreeManager.create makes the branch via `worktree add -b` BEFORE the agent
    // runs, and remove() keeps the branch — so an empty branch may persist. What must
    // hold is that it carries NO proposal commit: if present, it still points at base.
    const onBranch = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    if (onBranch.code === 0) {
      expect(onBranch.stdout.trim()).toBe(sha); // empty branch == base, no proposal commit
    }
  });

  it("writes the reviewer finding as an Ambient-Finding trailer on the proposal commit", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "x should be a const enum for clarity", total_cost_usd: 0.01 });
    };
    const host = composeAmbient({ repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });
    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    const trailer = await git.run(
      ["show", "-s", "--format=%(trailers:key=Ambient-Finding,valueonly)", `agentteam/reviewer-${sha7}`],
      repo,
    );
    expect(trailer.stdout.trim()).toBe("x should be a const enum for clarity");
  });
});
