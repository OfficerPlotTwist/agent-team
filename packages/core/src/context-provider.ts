import type { TaskNode } from "./task-graph.js";

/**
 * Seam for hydrating per-agent context into a fresh worktree (S2). The KG-backed
 * implementation lands in the future S5 sub-project; S2 ships only the port + a
 * no-op default. Implementations must write gitignored files (never `git add`).
 */
export interface ContextProvider {
  hydrate(node: TaskNode, worktreePath: string): Promise<void>;
}

export class NoopContextProvider implements ContextProvider {
  async hydrate(_node: TaskNode, _worktreePath: string): Promise<void> {
    // intentionally empty
  }
}
