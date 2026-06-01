import type { ContextProvider } from "./context-provider.js";
import type { TaskNode } from "./task-graph.js";
import type { ContextEnvelope, ContextModality } from "./context-envelope.js";

/**
 * Fans a single hydrate call out to several providers in sequence, so an agent
 * can receive editor-context AND shared-memory files in the same worktree.
 * Pure — depends only on the ContextProvider interface.
 */
export class CompositeContextProvider implements ContextProvider {
  constructor(private readonly providers: ContextProvider[]) {}

  async hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality?: ContextModality,
  ): Promise<void> {
    for (const p of this.providers) {
      await p.hydrate(node, worktreePath, envelope, modality);
    }
  }
}
