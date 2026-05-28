import type { AgentAdapter, TaskContext, Emit, GitRunner, AgentEvent } from "@agent-team/core";
import { mapStreamMessage, interpretResult } from "./event-mapper.js";
import { makePermissionBridge } from "./permission-bridge.js";
import type { PendingPermissions } from "./pending-permissions.js";
import type { CostLedger } from "./cost-ledger.js";
import type { QueryFn } from "./query-types.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeAdapterDeps {
  query: QueryFn;
  git: GitRunner;
  pending: PendingPermissions;
  ledger: CostLedger;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly backend = "claude";
  private abort?: AbortController;
  private interrupted = false;

  constructor(private readonly deps: ClaudeAdapterDeps) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    const agentId = ctx.agentId;
    const cwd = ctx.cwd;
    if (!cwd) {
      emit({ kind: "error", from: agentId, message: "ClaudeAdapter requires ctx.cwd (worktree path)" });
      return;
    }
    this.abort = new AbortController();
    const canUseTool = makePermissionBridge({
      agentId,
      emit,
      pending: this.deps.pending,
      timeoutMs: this.deps.permTimeoutMs,
    });

    let resultMsg: SDKMessage | undefined;
    try {
      const stream = this.deps.query({
        prompt: ctx.goal,
        options: {
          cwd,
          model: this.deps.model,
          maxTurns: this.deps.maxTurns,
          permissionMode: "default",
          allowedTools: ["Read", "Glob", "Grep"],
          disallowedTools: ["Bash(git*)"],
          canUseTool,
          abortController: this.abort,
        },
      });
      for await (const msg of stream) {
        for (const ev of mapStreamMessage(msg, agentId)) emit(ev);
        if ((msg as { type?: string }).type === "result") resultMsg = msg;
      }
    } catch (err) {
      emit({ kind: "error", from: agentId, message: `query failed: ${String(err)}` });
      return;
    }

    if (this.interrupted) return;
    if (!resultMsg) {
      emit({ kind: "error", from: agentId, message: "query produced no result message" });
      return;
    }

    const decision = interpretResult(resultMsg);
    if (!decision.ok) {
      emit({ kind: "error", from: agentId, message: decision.message });
      return;
    }

    this.deps.ledger.add(agentId, decision.costUsd);
    await this.commitAndEmit(ctx, agentId, decision.summary, emit);
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
    await git.run(["commit", "-m", `${agentId}: ${summary}`], cwd);
    emit({ kind: "done", from: agentId, summary });
  }

  interrupt(): void {
    this.interrupted = true;
    this.abort?.abort();
  }
}

// re-export so consumers can build event arrays in tests without deep imports
export type { AgentEvent };
