import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, GitRunner } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/claude-adapter.js";
import { PendingPermissions } from "../src/pending-permissions.js";
import { CostLedger } from "../src/cost-ledger.js";
import type { QueryFn } from "../src/query-types.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("ClaudeAdapter", () => {
  let repo: string;
  let git: GitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "seed"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function run(query: QueryFn) {
    const pending = new PendingPermissions();
    const ledger = new CostLedger();
    const adapter = new ClaudeAdapter({
      query,
      git,
      pending,
      ledger,
      model: "claude-test",
      maxTurns: 5,
      permTimeoutMs: 1000,
    });
    const events: AgentEvent[] = [];
    return { adapter, events, ledger, emit: (e: AgentEvent) => events.push(e) };
  }

  it("emits message, file_change, done and commits on a successful run with changes", async () => {
    const query: QueryFn = async function* ({ options }) {
      yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: "making greeting" }] } });
      writeFileSync(join(options.cwd as string, "greeting.txt"), "hello\n"); // simulate Write tool effect
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "made greeting.txt", total_cost_usd: 0.02 });
    };
    const { adapter, events, ledger, emit } = run(query);
    await adapter.startTask({ goal: "make greeting", role: "coder", agentId: "coder#a", cwd: repo, branch: "b" }, emit);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("message");
    expect(kinds).toContain("file_change");
    expect(kinds[kinds.length - 1]).toBe("done");
    const fc = events.find((e) => e.kind === "file_change");
    expect(fc && fc.kind === "file_change" && fc.path).toBe("greeting.txt");
    expect(ledger.total()).toBeCloseTo(0.02);
    // committed: a new commit exists and working tree is clean
    const log = await git.run(["log", "--oneline"], repo);
    expect(log.stdout.split("\n").filter(Boolean).length).toBe(2);
  });

  it("emits done with a no-changes note and does NOT commit when the agent changed nothing", async () => {
    const query: QueryFn = async function* () {
      yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: "just reading" }] } });
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "read only", total_cost_usd: 0.01 });
    };
    const { adapter, events, emit } = run(query);
    await adapter.startTask({ goal: "read", role: "coder", agentId: "coder#a", cwd: repo, branch: "b" }, emit);
    expect(events.map((e) => e.kind)).not.toContain("file_change");
    expect(events[events.length - 1].kind).toBe("done");
    const log = await git.run(["log", "--oneline"], repo);
    expect(log.stdout.split("\n").filter(Boolean).length).toBe(1); // only seed
  });

  it("emits error and does NOT commit on a result error subtype", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "partial.txt"), "x\n");
      yield asMsg({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit max turns"] });
    };
    const { adapter, events, emit } = run(query);
    await adapter.startTask({ goal: "x", role: "coder", agentId: "coder#a", cwd: repo, branch: "b" }, emit);
    const last = events[events.length - 1];
    expect(last.kind).toBe("error");
    expect(last.kind === "error" && last.message).toContain("hit max turns");
    const log = await git.run(["log", "--oneline"], repo);
    expect(log.stdout.split("\n").filter(Boolean).length).toBe(1); // no commit
  });

  it("emits error and does NOT commit when git commit fails (exit code guard)", async () => {
    const real = new NodeGitRunner();
    // Stub: force only `git commit` to fail; delegate everything else to real git.
    const failingGit: GitRunner = {
      run: (args, cwd) =>
        args[0] === "commit"
          ? Promise.resolve({ stdout: "", stderr: "pre-commit hook rejected", code: 1 })
          : real.run(args, cwd),
    };
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "x.txt"), "x\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "made x", total_cost_usd: 0.01 });
    };
    const pending = new PendingPermissions();
    const ledger = new CostLedger();
    const adapter = new ClaudeAdapter({
      query, git: failingGit, pending, ledger,
      model: "claude-test", maxTurns: 5, permTimeoutMs: 1000,
    });
    const events: AgentEvent[] = [];
    await adapter.startTask({ goal: "x", role: "coder", agentId: "coder#a", cwd: repo, branch: "b" }, (e) => events.push(e));

    const last = events[events.length - 1];
    expect(last.kind).toBe("error");
    expect(last.kind === "error" && last.message).toContain("commit failed");
    // file_change events were still emitted before the failed commit
    expect(events.some((e) => e.kind === "file_change")).toBe(true);
    // real repo has only the seed commit — nothing was committed
    const log = await real.run(["log", "--oneline"], repo);
    expect(log.stdout.split("\n").filter(Boolean).length).toBe(1);
  });
});
