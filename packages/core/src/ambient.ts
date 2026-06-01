import type { IntegrationLike, IntegrationOutcome } from "./integration.js";
import type { AgentId } from "./events.js";

/**
 * Stage-only IntegrationLike for ambient (background) reactions. Unlike
 * IntegrationCoordinator it creates NO integration branch/worktree and NEVER
 * merges: `tip()` returns the reviewed commit SHA so the agent's worktree is
 * cut straight from the human's commit, and `integrate()` reports `merged`
 * WITHOUT merging so the one-node Scheduler run completes (the Scheduler
 * completes a node iff integrate reports `merged`). The agent's proposal branch
 * persists, unmerged, for a later human promotion step.
 */
export class AmbientIntegration implements IntegrationLike {
  private base = "";

  async init(baseRef: string): Promise<void> {
    this.base = baseRef;
  }

  tip(): string {
    return this.base;
  }

  async integrate(_authorId: AgentId, _branch: string): Promise<IntegrationOutcome> {
    return { status: "merged" }; // report-complete; deliberately does not merge
  }
}
