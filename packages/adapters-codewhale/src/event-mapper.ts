import type { AgentId, ToolCallEvent } from "@agent-team/core";

/** Run metadata reported by codewhale's final `metadata` JSONL line. */
export interface CodewhaleMeta {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  status?: string;
}

export type MappedLine =
  | { kind: "tool_call"; event: ToolCallEvent }
  | { kind: "metadata"; meta: CodewhaleMeta }
  | { kind: "ignore" };

const IGNORE: MappedLine = { kind: "ignore" };

/**
 * Maps one codewhale stream-json stdout line to an adapter action.
 * Pure: unparseable and unknown lines map to "ignore".
 */
export function mapLine(line: string, agentId: AgentId): MappedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return IGNORE;
  }
  if (typeof parsed !== "object" || parsed === null) return IGNORE;
  const obj = parsed as { type?: string; name?: string; input?: unknown; meta?: CodewhaleMeta };

  if (obj.type === "tool_use" && typeof obj.name === "string") {
    return {
      kind: "tool_call",
      event: { kind: "tool_call", from: agentId, name: obj.name, args: obj.input },
    };
  }
  if (obj.type === "metadata" && typeof obj.meta === "object" && obj.meta !== null) {
    return { kind: "metadata", meta: obj.meta };
  }
  // tool_result, content, session_capture, done, and anything future-shaped.
  return IGNORE;
}
