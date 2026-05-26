export type Role = "lead" | "architect" | "coder" | "reviewer" | "ops";

/** Instance id, always formatted `${role}#${index}`, e.g. "coder#1". */
export type AgentId = string;

export type Target = Role | AgentId | "all";

export type RequestCategory =
  | "approval"
  | "credential"
  | "judgment"
  | "external_action"
  | "destructive"
  | "info";

export interface MessageEvent {
  kind: "message";
  from: AgentId;
  to: Target;
  text: string;
  /** seq of the bus event this message responds to (for cycle detection). */
  causedBy?: number;
}

export interface ToolCallEvent {
  kind: "tool_call";
  from: AgentId;
  name: string;
  args: unknown;
}

export interface FileChangeEvent {
  kind: "file_change";
  from: AgentId;
  proposalId: string;
  path: string;
  /** Unified diff text. */
  diff: string;
}

export interface ActionRequestEvent {
  kind: "action_request";
  from: AgentId;
  requestId: string;
  category: RequestCategory;
  summary: string;
  payload?: unknown;
  timeoutMs: number;
}

export interface DoneEvent {
  kind: "done";
  from: AgentId;
  summary: string;
}

export interface ErrorEvent {
  kind: "error";
  from: AgentId;
  message: string;
}

export type AgentEvent =
  | MessageEvent
  | ToolCallEvent
  | FileChangeEvent
  | ActionRequestEvent
  | DoneEvent
  | ErrorEvent;

/** Transport metadata stamped by the bus on publish. */
export interface EventMeta {
  seq: number;
  ts: number;
}

export type BusEvent = AgentEvent & EventMeta;

const ROLES: readonly Role[] = ["lead", "architect", "coder", "reviewer", "ops"];

export function makeAgentId(role: Role, index: number): AgentId {
  return `${role}#${index}`;
}

export function roleOf(id: AgentId): Role {
  const role = id.split("#")[0];
  if (!ROLES.includes(role as Role)) {
    throw new Error(`Cannot derive role from agent id: ${id}`);
  }
  return role as Role;
}

/** True if an event addressed with `to` should be delivered to `recipient`. */
export function addressedTo(to: Target, recipientId: AgentId): boolean {
  if (to === "all") return true;
  if (to === recipientId) return true;
  return to === roleOf(recipientId);
}
