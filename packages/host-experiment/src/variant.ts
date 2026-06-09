import type { Role } from "@agent-team/core";

export interface Variant {
  /** git-safe: [A-Za-z0-9_-]+ (validated via assertGitSafe). */
  name: string;
  /** e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001". */
  model: string;
  /** Adapter knob; defaults to the experiment default when omitted. */
  maxTurns?: number;
  /** Adapter knob; defaults to the experiment default when omitted. */
  permTimeoutMs?: number;
}

/**
 * Variant node id. Double-underscore, NOT ":", because these ids become git
 * branch names (`agentteam/${role}-${nodeId}`, WorktreeManager.branchFor) and
 * git ref names forbid ":".
 */
export function variantNodeId(taskId: string, variantName: string): string {
  return `${taskId}__${variantName}`;
}

/** Throw if `name` would produce an invalid git ref component. Requires a
 *  leading alphanumeric so a name can never start with '-' (which could be
 *  mis-parsed as a flag) or '_'. */
export function assertGitSafe(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(
      `variant/task name "${name}" must match [A-Za-z0-9][A-Za-z0-9_-]* (git ref names forbid ':', spaces, '..', leading '-', etc.)`,
    );
  }
}

/** Re-export Role for callers building ExperimentTask. */
export type { Role };
