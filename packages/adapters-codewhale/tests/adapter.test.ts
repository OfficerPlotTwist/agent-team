import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AgentEvent, TaskContext } from "@agent-team/core";
import { CodewhaleAdapter } from "../src/adapter.js";
import type { UsageSink } from "../src/adapter.js";
import type { LineRunner, LineProcess } from "../src/runner.js";

// Exact live transcript replayed by the fake runner.
const transcript = [
  `{"type":"tool_use","name":"write_file","id":"call_00_qQ...","input":{"path":"hello.txt","content":"hi"}}`,
  `{"type":"tool_result","id":"call_00_qQ...","output":"...diff text...","status":"success"}`,
  `{"type":"tool_use","name":"read_file","id":"call_00_P4...","input":{"path":"hello.txt"}}`,
  `{"type":"tool_result","id":"call_00_P4...","output":"hi","status":"success"}`,
  `{"type":"content","content":"Done"}`,
  `{"type":"content","content":"."}`,
  `{"type":"session_capture","content":"1720752c-..."}`,
  `{"type":"metadata","meta":{"model":"deepseek-v4-pro","input_tokens":186029,"output_tokens":167,"session_id":"...","status":"completed"}}`,
  `{"type":"done"}`,
];

function makeLedger(): UsageSink & { adds: [string, number][]; usages: [string, { tokensIn: number; tokensOut: number }][] } {
  const adds: [string, number][] = [];
  const usages: [string, { tokensIn: number; tokensOut: number }][] = [];
  return {
    adds,
    usages,
    add: (agentId, usd) => adds.push([agentId, usd]),
    addUsage: (agentId, usage) => usages.push([agentId, usage]),
  };
}

/** Fake runner: invokes onLine with each canned line, optionally performs a side
 * effect in cwd first (simulating the CLI writing files), then resolves wait. */
function fakeRunner(
  lines: string[],
  opts: { exitCode?: number; sideEffect?: (cwd: string) => void } = {},
): LineRunner & { calls: { args: string[]; cwd: string }[] } {
  const calls: { args: string[]; cwd: string }[] = [];
  const runner = ((args: string[], cwd: string, onLine: (line: string) => void): LineProcess => {
    calls.push({ args, cwd });
    opts.sideEffect?.(cwd);
    for (const l of lines) onLine(l);
    return { wait: Promise.resolve(opts.exitCode ?? 0), kill: () => {} };
  }) as LineRunner & { calls: { args: string[]; cwd: string }[] };
  runner.calls = calls;
  return runner;
}

describe("CodewhaleAdapter", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "cw-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const ctxFor = (cwd?: string): TaskContext => ({ goal: "write hello", role: "coder", agentId: "coder#1", cwd });

  it("happy path: tool_call events, usage recorded, file committed, last event is done", async () => {
    const run = fakeRunner(transcript, {
      sideEffect: (cwd) => writeFileSync(join(cwd, "hello.txt"), "hi"),
    });
    const ledger = makeLedger();
    const adapter = new CodewhaleAdapter({ run, git, ledger });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(repo), (e) => events.push(e));

    const toolCalls = events.filter((e) => e.kind === "tool_call");
    expect(toolCalls).toEqual([
      { kind: "tool_call", from: "coder#1", name: "write_file", args: { path: "hello.txt", content: "hi" } },
      { kind: "tool_call", from: "coder#1", name: "read_file", args: { path: "hello.txt" } },
    ]);

    expect(ledger.adds).toEqual([["coder#1", 0]]);
    expect(ledger.usages).toEqual([["coder#1", { tokensIn: 186029, tokensOut: 167 }]]);

    const fileChanges = events.filter((e) => e.kind === "file_change");
    expect(fileChanges).toHaveLength(1);
    expect(fileChanges[0]).toMatchObject({ from: "coder#1", proposalId: "coder#1-0", path: "hello.txt" });

    const last = events[events.length - 1];
    expect(last.kind).toBe("done");

    // Committed on the current branch.
    const status = await git.run(["status", "--porcelain"], repo);
    expect(status.stdout.trim()).toBe("");
    const log = await git.run(["log", "-1", "--format=%s"], repo);
    expect(log.stdout.trim()).toBe("coder#1: codewhale exec completed");
    const show = await git.run(["show", "HEAD:hello.txt"], repo);
    expect(show.stdout).toBe("hi");
  });

  it("no-changes path: done with '(no changes)' suffix", async () => {
    const run = fakeRunner(transcript); // no side effect — nothing written
    const ledger = makeLedger();
    const adapter = new CodewhaleAdapter({ run, git, ledger });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(repo), (e) => events.push(e));

    const last = events[events.length - 1];
    expect(last.kind).toBe("done");
    if (last.kind !== "done") return;
    expect(last.summary).toMatch(/\(no changes\)$/);
    expect(events.filter((e) => e.kind === "file_change")).toHaveLength(0);
  });

  it("nonzero exit: error event, no done, ledger untouched", async () => {
    const run = fakeRunner(transcript, { exitCode: 3 });
    const ledger = makeLedger();
    const adapter = new CodewhaleAdapter({ run, git, ledger });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(repo), (e) => events.push(e));

    const errors = events.filter((e) => e.kind === "error");
    expect(errors).toHaveLength(1);
    if (errors[0].kind === "error") expect(errors[0].message).toContain("codewhale exited 3");
    expect(events.filter((e) => e.kind === "done")).toHaveLength(0);
    expect(ledger.adds).toHaveLength(0);
    expect(ledger.usages).toHaveLength(0);
  });

  it("metadata status 'failed': error, no done", async () => {
    const failed = transcript.map((l) =>
      l.startsWith(`{"type":"metadata"`)
        ? `{"type":"metadata","meta":{"model":"deepseek-v4-pro","input_tokens":10,"output_tokens":2,"status":"failed"}}`
        : l,
    );
    const run = fakeRunner(failed);
    const ledger = makeLedger();
    const adapter = new CodewhaleAdapter({ run, git, ledger });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(repo), (e) => events.push(e));

    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "done")).toHaveLength(0);
    expect(ledger.usages).toHaveLength(0);
  });

  it("missing metadata: error, no done", async () => {
    const noMeta = transcript.filter((l) => !l.startsWith(`{"type":"metadata"`));
    const run = fakeRunner(noMeta);
    const ledger = makeLedger();
    const adapter = new CodewhaleAdapter({ run, git, ledger });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(repo), (e) => events.push(e));

    expect(events.filter((e) => e.kind === "error")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "done")).toHaveLength(0);
  });

  it("missing ctx.cwd: error, runner never invoked", async () => {
    const run = fakeRunner(transcript);
    const adapter = new CodewhaleAdapter({ run, git, ledger: makeLedger() });
    const events: AgentEvent[] = [];
    await adapter.startTask(ctxFor(undefined), (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "error",
      from: "coder#1",
      message: "CodewhaleAdapter requires ctx.cwd (worktree path)",
    });
    expect(run.calls).toHaveLength(0);
  });

  it("interrupt: startTask resolves with no done and no error", async () => {
    let resolveWait!: (code: number) => void;
    const run: LineRunner = vi.fn(() => ({
      wait: new Promise<number>((res) => (resolveWait = res)),
      kill: () => resolveWait(1),
    }));
    const adapter = new CodewhaleAdapter({ run, git, ledger: makeLedger() });
    const events: AgentEvent[] = [];
    const task = adapter.startTask(ctxFor(repo), (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 0)); // let startTask reach the wait
    adapter.interrupt();
    await task;

    expect(events.filter((e) => e.kind === "done")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
  });

  it("passes exact args to the runner (model included, executable excluded)", async () => {
    const run = fakeRunner(transcript, {
      sideEffect: (cwd) => writeFileSync(join(cwd, "hello.txt"), "hi"),
    });
    const adapter = new CodewhaleAdapter({ run, git, ledger: makeLedger(), model: "m" });
    await adapter.startTask(ctxFor(repo), () => {});
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0].args).toEqual([
      "-C", repo, "--model", "m", "exec", "--auto", "--output-format", "stream-json", "write hello",
    ]);
    expect(run.calls[0].cwd).toBe(repo);
  });

  it("omits --model when not configured", async () => {
    const run = fakeRunner(transcript);
    const adapter = new CodewhaleAdapter({ run, git, ledger: makeLedger() });
    await adapter.startTask(ctxFor(repo), () => {});
    expect(run.calls[0].args).toEqual([
      "-C", repo, "exec", "--auto", "--output-format", "stream-json", "write hello",
    ]);
  });
});
