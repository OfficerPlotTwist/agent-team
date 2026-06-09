import { describe, it, expect } from "vitest";
import { MessageBus } from "@agent-team/core";
import { CostLedger } from "@agent-team/adapters-claude";
import type { GitRunner } from "@agent-team/core";
import { MetricsCollector } from "../src/metrics.js";
import type { Variant } from "../src/variant.js";

// A fake GitRunner returning canned diff-shape / commit-count per branch.
function fakeGit(byBranch: Record<string, { shortstat: string; commits: string }>): GitRunner {
  return {
    run: async (args: string[]) => {
      const branch = args[args.length - 1] ?? "";
      const key = branch.includes("..") ? (branch.split("..")[1] ?? "") : branch;
      const data = byBranch[key];
      if (args[0] === "diff") return { code: 0, stdout: data?.shortstat ?? "", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: data?.commits ?? "0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as GitRunner;
}

describe("MetricsCollector", () => {
  it("tallies per-agent turns + wall-clock + status from the bus, cost from the ledger, diff from git", async () => {
    const bus = new MessageBus();
    const ledger = new CostLedger();
    const variantByNodeId = new Map<string, Variant>([
      ["t__cheap", { name: "cheap", model: "m1" }],
      ["t__slow", { name: "slow", model: "m2" }],
    ]);
    const git = fakeGit({
      "agentteam/coder-t__cheap": { shortstat: " 1 file changed, 10 insertions(+)", commits: "1" },
      "agentteam/coder-t__slow": { shortstat: " 2 files changed, 40 insertions(+), 3 deletions(-)", commits: "2" },
    });

    const collector = new MetricsCollector({
      bus, ledger, git, repoRoot: "/r", base: "BASE", variantByNodeId, role: "coder",
    });

    // cheap: 2 events (msg, done) -> turns 2; ledger 0.01; status completed
    bus.publish({ kind: "message", from: "coder#t__cheap", to: "all", text: "hi" });
    bus.publish({ kind: "done", from: "coder#t__cheap", summary: "ok" });
    ledger.add("coder#t__cheap", 0.01);
    ledger.addUsage("coder#t__cheap", { tokensIn: 1200, tokensOut: 300 });
    // slow: error, no done -> failed
    bus.publish({ kind: "tool_call", from: "coder#t__slow", name: "Bash", args: {} });
    bus.publish({ kind: "error", from: "coder#t__slow", message: "boom" });
    ledger.add("coder#t__slow", 0.02);

    const rows = await collector.collect();
    const cheap = rows.find((r) => r.variant === "cheap")!;
    const slow = rows.find((r) => r.variant === "slow")!;

    expect(cheap.status).toBe("completed");
    expect(cheap.model).toBe("m1");
    expect(cheap.costUsd).toBeCloseTo(0.01);
    expect(cheap.tokensIn).toBe(1200);
    expect(cheap.tokensOut).toBe(300);
    expect(cheap.turns).toBe(2);
    expect(cheap.wallMs).toBeGreaterThanOrEqual(0);
    expect(cheap.filesChanged).toBe(1);
    expect(cheap.insertions).toBe(10);
    expect(cheap.deletions).toBe(0);
    expect(cheap.commits).toBe(1);
    expect(cheap.branch).toBe("agentteam/coder-t__cheap");

    expect(slow.status).toBe("failed");
    expect(slow.error).toBe("boom");
    expect(slow.filesChanged).toBe(2);
    expect(slow.deletions).toBe(3);
    expect(slow.commits).toBe(2);
  });
});
