import { randomUUID } from "node:crypto";
import type { FileChangeEvent, AgentId } from "@agent-team/core";

export function makeFileChangeEvent(
  agentId: AgentId,
  filePath: string,
  content: string,
): FileChangeEvent {
  return {
    kind: "file_change",
    from: agentId,
    proposalId: randomUUID(),
    path: filePath,
    diff: content,
  };
}
