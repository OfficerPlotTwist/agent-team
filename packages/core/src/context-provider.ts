import type { TaskNode } from "./task-graph.js";
import type { ContextEnvelope, ContextModality } from "./context-envelope.js";

/** Thrown by providers for a modality they do not (yet) materialize. */
export class NotImplementedError extends Error {
  constructor(modality: ContextModality) {
    super(`context modality not implemented: ${modality}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Seam for hydrating per-agent context into a fresh worktree (S2). S3 widens
 * hydrate to be modality-aware: an optional envelope + the richest modality the
 * adapter supports. Implementations must write gitignored files (never `git add`).
 */
export interface ContextProvider {
  hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality?: ContextModality,
  ): Promise<void>;
}

export class NoopContextProvider implements ContextProvider {
  async hydrate(
    _node: TaskNode,
    _worktreePath: string,
    _envelope?: ContextEnvelope,
    _modality?: ContextModality,
  ): Promise<void> {
    // intentionally empty
  }
}
