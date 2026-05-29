import type { AgentId } from "@agent-team/core";
import type { Emit } from "@agent-team/core";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { classifyTool } from "./tool-category.js";
import type { PendingPermissions } from "./pending-permissions.js";

export interface BridgeOptions {
  agentId: AgentId;
  emit: Emit;
  pending: PendingPermissions;
  timeoutMs: number;
}

/**
 * Build the SDK canUseTool callback. Per gated tool call: classify -> register a
 * pending resolver (BEFORE emit, so a synchronous host resolution lands) -> emit an
 * action_request on the bus -> await the resolution (or timeout->deny).
 */
export function makePermissionBridge(opts: BridgeOptions): CanUseTool {
  let counter = 0;
  return async (toolName, input) => {
    const category = classifyTool(toolName, input);
    const requestId = `${opts.agentId}-perm-${counter++}`;
    const decision = opts.pending.register(requestId, opts.timeoutMs);
    opts.emit({
      kind: "action_request",
      from: opts.agentId,
      requestId,
      category,
      summary: `${toolName}`,
      payload: { toolName, input },
      timeoutMs: opts.timeoutMs,
    });
    const result = await decision;
    // The SDK's runtime schema requires updatedInput on allow (echo the input unchanged
    // unless the host already supplied a modified one). Deny passes through untouched.
    return result.behavior === "allow"
      ? { ...result, updatedInput: result.updatedInput ?? input }
      : result;
  };
}
