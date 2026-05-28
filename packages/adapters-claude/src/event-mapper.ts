import type { AgentEvent, AgentId } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

/**
 * Pure: map ONE streaming SDK message to zero-or-more normalized events.
 * Only assistant content blocks produce streaming events (text -> message,
 * tool_use -> tool_call). Terminal handling lives in interpretResult + the adapter.
 */
export function mapStreamMessage(msg: SDKMessage, agentId: AgentId): AgentEvent[] {
  if (msg.type !== "assistant") return [];
  const content = (msg as { message?: { content?: ContentBlock[] } }).message?.content ?? [];
  const out: AgentEvent[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = (block as TextBlock).text ?? "";
      if (text.trim().length > 0) {
        out.push({ kind: "message", from: agentId, to: "all", text });
      }
    } else if (block.type === "tool_use") {
      const tu = block as ToolUseBlock;
      out.push({ kind: "tool_call", from: agentId, name: tu.name, args: tu.input });
    }
  }
  return out;
}

export type ResultDecision =
  | { ok: true; summary: string; costUsd: number }
  | { ok: false; message: string };

/** Pure: decide terminal outcome from a result message (no I/O). */
export function interpretResult(msg: SDKMessage): ResultDecision {
  const m = msg as {
    type: string;
    subtype?: string;
    result?: string;
    total_cost_usd?: number;
    errors?: string[];
  };
  if (m.subtype === "success") {
    return { ok: true, summary: m.result ?? "", costUsd: m.total_cost_usd ?? 0 };
  }
  const message = (m.errors ?? [m.subtype ?? "unknown error"]).join("; ");
  return { ok: false, message };
}
