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

describe("host-headless single-node integration (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "b1-single-"));
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

  it("runs one node end-to-end: file_change emitted, committed, merged to integration, cost recorded", async () => {
    const query: QueryFn = async function* ({ options }) {
      yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: "creating feature.txt" }] } });
      writeFileSync(join(options.cwd as string, "feature.txt"), "the feature\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "made feature.txt", total_cost_usd: 0.03 });
    };

    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "build the feature", dependsOn: [] }]);
    const host = composeHeadless({ repoRoot: repo, graph, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });

    const feed: AgentEvent[] = [];
    host.bus.subscribe((e) => feed.push(e));

    const result = await host.run();

    expect(result.status).toBe("complete");
    expect(result.completed).toEqual(["n1"]);
    expect(feed.some((e) => e.kind === "file_change" && e.path === "feature.txt")).toBe(true);
    expect(feed.some((e) => e.kind === "done")).toBe(true);
    expect(host.ledger.total()).toBeCloseTo(0.03);

    // integration tip carries the change
    const show = await git.run(["show", "agentteam/integration:feature.txt"], repo);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("the feature");

    // worktree context dir invariant: no .agent-context tracked anywhere
    const tracked = await git.run(["ls-files", "agentteam/integration", "--", ".agent-context"], repo);
    expect(tracked.stdout.trim()).toBe("");
  });
});
