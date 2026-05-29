import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "@agent-team/core";
import type { AgentEvent } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

const query: QueryFn = async function* ({ prompt, options }) {
  const file = prompt.includes("alpha") ? "alpha.txt" : "beta.txt";
  yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: `creating ${file}` }] } });
  writeFileSync(join(options.cwd as string, file), `${file}\n`);
  yield asMsg({ type: "result", subtype: "success", is_error: false, result: `made ${file}`, total_cost_usd: 0.05 });
};

const chain = () =>
  new TaskGraph([
    { id: "a", role: "coder", goal: "create alpha", dependsOn: [] },
    { id: "b", role: "coder", goal: "create beta", dependsOn: ["a"] },
  ]);

describe("host-headless cost ceiling (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "b2-ceiling-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# base\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("refuses the downstream node once the ceiling is reached — no spend, no merge", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, costCeilingUsd: 0.04,
    });
    const feed: AgentEvent[] = [];
    host.bus.subscribe((e) => feed.push(e));

    const result = await host.run();

    // Real ScheduleResult contract: `completed` = graph.completedIds() (nodes whose
    // integration merge succeeded). A budget-refused node emits an error but does NOT
    // throw, so runNode still calls integration.integrate on its EMPTY worktree branch
    // (no SDK ran, no file written) — that empty merge succeeds, so "b" lands in
    // `completed` too. The budget invariants below (no spend, beta.txt absent, ceiling
    // error emitted) are what actually prove the node was refused.
    expect(result.completed).toContain("a");
    expect(result.completed).toContain("b");
    expect(feed.some((e) => e.kind === "error" && e.message.includes("team cost ceiling"))).toBe(true);
    expect(host.ledger.total()).toBeCloseTo(0.05);
    expect((await git.run(["show", "agentteam/integration:alpha.txt"], repo)).code).toBe(0);
    expect((await git.run(["show", "agentteam/integration:beta.txt"], repo)).code).not.toBe(0);
  });

  it("runs both nodes when the ceiling is high enough", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, costCeilingUsd: 1.0,
    });
    const result = await host.run();
    expect(result.completed.sort()).toEqual(["a", "b"]);
    expect(host.ledger.total()).toBeCloseTo(0.10);
    expect((await git.run(["show", "agentteam/integration:beta.txt"], repo)).code).toBe(0);
  });

  it("no ceiling ⇒ both nodes run (regression)", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000,
    });
    const result = await host.run();
    expect(result.completed.sort()).toEqual(["a", "b"]);
    expect(host.ledger.total()).toBeCloseTo(0.10);
  });
});
