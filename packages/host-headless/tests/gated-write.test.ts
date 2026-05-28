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

describe("host-headless gated-write integration (offline, real permission path)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "b1-gated-"));
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

  it("a Write tool call flows through canUseTool->broker->auto-allow, then commits", async () => {
    // The fake SDK asks permission for a Write (approval category). Under Autopilot
    // that is not credential/destructive, so the broker auto-allows (no GATE prompt).
    const query: QueryFn = async function* ({ options }) {
      const canUseTool = (options as { canUseTool?: (n: string, i: Record<string, unknown>, o: never) => Promise<{ behavior: string }> }).canUseTool;
      const decision = await canUseTool!("Write", { file_path: "gated.txt" }, {} as never);
      if (decision.behavior === "allow") {
        writeFileSync(join(options.cwd as string, "gated.txt"), "approved write\n");
      }
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "wrote gated.txt", total_cost_usd: 0.01 });
    };

    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "make a gated write", dependsOn: [] }]);
    // No onGate provided: if anything wrongly routed to GATE it would default-deny and the file would NOT be written.
    const host = composeHeadless({ repoRoot: repo, graph, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 2000 });

    const feed: AgentEvent[] = [];
    host.bus.subscribe((e) => feed.push(e));

    const result = await host.run();

    expect(result.status).toBe("complete");
    // the permission request actually flowed on the bus
    const reqs = feed.filter((e) => e.kind === "action_request");
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    expect(reqs.some((e) => e.kind === "action_request" && e.category === "approval")).toBe(true);
    // auto-allowed → the write happened, committed, merged to integration
    const show = await git.run(["show", "agentteam/integration:gated.txt"], repo);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("approved write");
  });
});
