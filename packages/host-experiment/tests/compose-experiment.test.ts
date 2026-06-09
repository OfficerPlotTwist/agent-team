import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { expandTask } from "../src/expand.js";
import { composeExperiment } from "../src/compose.js";
import { MetricsCollector } from "../src/metrics.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("composeExperiment offline integration", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "hx-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // Fake query: behavior varies by the variant's model. cheap writes 1 file at
  // cost 0.01; thorough writes 2 files at cost 0.05. Both Write through canUseTool
  // (approval -> auto-allow under autopilot), then yield a result.
  const query: QueryFn = async function* ({ options }) {
    const o = options as {
      model?: string;
      cwd?: string;
      canUseTool?: (n: string, i: Record<string, unknown>, x: never) => Promise<{ behavior: string }>;
    };
    const cheap = o.model === "fake-cheap";
    const files = cheap ? ["a.txt"] : ["a.txt", "b.txt"];
    for (const f of files) {
      const d = await o.canUseTool!("Write", { file_path: f }, {} as never);
      if (d.behavior === "allow") writeFileSync(join(o.cwd as string, f), `${o.model}:${f}\n`);
    }
    yield asMsg({
      type: "result", subtype: "success", is_error: false,
      result: `wrote ${files.length}`, total_cost_usd: cheap ? 0.01 : 0.05,
      usage: cheap
        ? { input_tokens: 500, output_tokens: 100 }
        : { input_tokens: 1500, output_tokens: 300 },
    });
  };

  it("runs K variants in parallel from a frozen base, stages all, merges none, and measures each", async () => {
    const exp = expandTask({ taskId: "t", role: "coder", goal: "write files" }, [
      { name: "cheap", model: "fake-cheap" },
      { name: "thorough", model: "fake-thorough" },
    ]);
    const host = await composeExperiment({
      repoRoot: repo, experiment: exp, query,
      defaultMaxTurns: 50, defaultPermTimeoutMs: 2000, git,
    });
    const collector = new MetricsCollector({
      bus: host.bus, ledger: host.ledger, git, repoRoot: repo,
      base: host.base, variantByNodeId: exp.variantByNodeId, role: "coder",
    });

    const result = await host.run();
    expect(result.status).toBe("complete");

    // staging invariant: both branches exist, none merged anywhere, base unmoved.
    const base = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    expect(base).toBe(host.base); // main never advanced
    const noIntegration = await git.run(["rev-parse", "--verify", "agentteam/integration"], repo);
    expect(noIntegration.code).not.toBe(0); // AmbientIntegration creates NO integration branch
    for (const b of ["agentteam/coder-t__cheap", "agentteam/coder-t__thorough"]) {
      expect((await git.run(["rev-parse", "--verify", b], repo)).code).toBe(0);
    }

    const rows = await collector.collect();
    const cheap = rows.find((r) => r.variant === "cheap")!;
    const thorough = rows.find((r) => r.variant === "thorough")!;
    expect(cheap.status).toBe("completed");
    expect(cheap.costUsd).toBeCloseTo(0.01);
    expect(cheap.filesChanged).toBe(1);
    expect(thorough.costUsd).toBeCloseTo(0.05);
    expect(thorough.filesChanged).toBe(2);
    // model + token usage flow end-to-end through the real ClaudeAdapter
    expect(cheap.model).toBe("fake-cheap");
    expect(cheap.tokensIn).toBe(500);
    expect(cheap.tokensOut).toBe(100);
    expect(thorough.model).toBe("fake-thorough");
    expect(thorough.tokensIn).toBe(1500);
    expect(thorough.tokensOut).toBe(300);

    // ISOLATION (spec §10.4): each variant forked from the same frozen base and
    // never saw the other's work. cheap wrote only a.txt; thorough also wrote
    // b.txt. cheap's branch must NOT contain thorough's unique file, and BOTH
    // must contain the shared base file — proving no cross-variant contamination.
    expect((await git.run(["show", "agentteam/coder-t__cheap:b.txt"], repo)).code).not.toBe(0);
    expect((await git.run(["show", "agentteam/coder-t__cheap:seed.txt"], repo)).code).toBe(0);
    expect((await git.run(["show", "agentteam/coder-t__thorough:seed.txt"], repo)).code).toBe(0);
  });
});
