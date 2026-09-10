import type { AgentAdapter, TaskContext, Emit, GitRunner } from "@agent-team/core";
import { mapLine, type CodewhaleMeta } from "./event-mapper.js";
import type { LineRunner, LineProcess } from "./runner.js";

/** Cost/usage sink — structurally compatible with adapters-claude's CostLedger. */
export interface UsageSink {
  add(agentId: string, usd: number): void;
  addUsage(agentId: string, usage: { tokensIn: number; tokensOut: number }): void;
}

export interface CodewhaleAdapterDeps {
  run: LineRunner;
  git: GitRunner;
  ledger: UsageSink;
  model?: string;
}

export class CodewhaleAdapter implements AgentAdapter {
  readonly backend = "codewhale";
  readonly contextModalities = ["text"] as const;
  private proc?: LineProcess;
  private interrupted = false;

  constructor(private readonly deps: CodewhaleAdapterDeps) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    const agentId = ctx.agentId;
    const cwd = ctx.cwd;
    this.interrupted = false; // reset per task so an adapter instance is safely reusable
    if (!cwd) {
      emit({ kind: "error", from: agentId, message: "CodewhaleAdapter requires ctx.cwd (worktree path)" });
      return;
    }

    const args = [
      "-C", cwd,
      ...(this.deps.model ? ["--model", this.deps.model] : []),
      "exec", "--auto", "--output-format", "stream-json",
      ctx.goal,
    ];

    let meta: CodewhaleMeta | undefined;
    this.proc = this.deps.run(args, cwd, (line) => {
      const mapped = mapLine(line, agentId);
      if (mapped.kind === "tool_call") emit(mapped.event);
      else if (mapped.kind === "metadata") meta = mapped.meta;
    });
    const code = await this.proc.wait;
    this.proc = undefined;

    if (this.interrupted) return; // deliberate interrupt: no error, no done
    if (code !== 0) {
      emit({ kind: "error", from: agentId, message: `codewhale exited ${code}` });
      return;
    }
    if (!meta || meta.status !== "completed") {
      const status = meta ? `status "${meta.status}"` : "no metadata";
      emit({ kind: "error", from: agentId, message: `codewhale did not complete (${status})` });
      return;
    }

    this.deps.ledger.add(agentId, 0);
    this.deps.ledger.addUsage(agentId, {
      tokensIn: meta.input_tokens ?? 0,
      tokensOut: meta.output_tokens ?? 0,
    });
    await this.commitAndEmit(ctx, agentId, "codewhale exec completed", emit);
  }

  private async commitAndEmit(ctx: TaskContext, agentId: string, summary: string, emit: Emit): Promise<void> {
    const cwd = ctx.cwd as string;
    const git = this.deps.git;
    await git.run(["add", "-A"], cwd);
    const names = (await git.run(["diff", "--cached", "--name-only"], cwd)).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length === 0) {
      emit({ kind: "done", from: agentId, summary: `${summary} (no changes)` });
      return;
    }

    let i = 0;
    for (const file of names) {
      const d = await git.run(["diff", "--cached", "--", file], cwd);
      emit({ kind: "file_change", from: agentId, proposalId: `${agentId}-${i++}`, path: file, diff: d.stdout });
    }
    const committed = await git.run(["commit", "-m", `${agentId}: ${summary}`], cwd);
    if (committed.code !== 0) {
      emit({ kind: "error", from: agentId, message: `git commit failed: ${committed.stderr.trim()}` });
      return;
    }
    emit({ kind: "done", from: agentId, summary });
  }

  interrupt(): void {
    this.interrupted = true;
    this.proc?.kill();
  }
}
