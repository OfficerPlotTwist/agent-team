import type { AgentEvent, Role, AgentId } from "./events.js";

export interface TaskContext {
  goal: string;
  role: Role;
  agentId: AgentId;
}

export type Emit = (event: AgentEvent) => void;

export interface AgentAdapter {
  /** Backend identifier, e.g. "fake" | "claude" | "codewhale". */
  readonly backend: string;
  /** Run one task to completion; resolves after the adapter emits a terminal event or is interrupted. */
  startTask(ctx: TaskContext, emit: Emit): Promise<void>;
  /** Cancel the in-flight task. */
  interrupt(): void;
}
