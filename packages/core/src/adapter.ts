import type { AgentEvent, Role, AgentId } from "./events.js";
import type { ContextModality } from "./context-envelope.js";

export interface TaskContext {
  goal: string;
  role: Role;
  agentId: AgentId;
  /** Worktree path the agent should work in (S2). Undefined for non-worktree runs. */
  cwd?: string;
  /** The agent's branch (S2). Undefined for non-worktree runs. */
  branch?: string;
}

export type Emit = (event: AgentEvent) => void;

export interface AgentAdapter {
  /** Backend identifier, e.g. "fake" | "claude" | "codewhale". */
  readonly backend: string;
  /** Context modalities this adapter can consume, richest first. */
  readonly contextModalities: readonly ContextModality[];
  /** Run one task to completion; resolves after the adapter emits a terminal event or is interrupted. */
  startTask(ctx: TaskContext, emit: Emit): Promise<void>;
  /** Cancel the in-flight task. */
  interrupt(): void;
}
