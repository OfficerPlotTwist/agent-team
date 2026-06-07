import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";

/**
 * Returned by the host when the team cost ceiling has been reached. Refuses the
 * node WITHOUT calling the SDK (no spend), emitting a single error so the
 * Scheduler treats the node as failed. interrupt() is a no-op (nothing runs).
 *
 * VERBATIM COPY of host-headless/src/budget-guard.ts — host-web must not
 * import host-headless (spec §2.1); ~25 lines of leaf glue is cheaper than a
 * shared util package. Keep the two copies in sync if the semantics change.
 */
export class BudgetExceededAdapter implements AgentAdapter {
  readonly backend = "budget-guard";

  readonly contextModalities = ["text"] as const;
  constructor(
    private readonly ceilingUsd: number,
    private readonly spentUsd: number,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    emit({
      kind: "error",
      from: ctx.agentId,
      message: `team cost ceiling $${this.ceilingUsd.toFixed(4)} reached (spent $${this.spentUsd.toFixed(4)}); skipping ${ctx.agentId}`,
    });
  }

  interrupt(): void {}
}
