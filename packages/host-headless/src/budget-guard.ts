import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";

/**
 * Returned by the host when the team cost ceiling has been reached. Refuses the
 * node WITHOUT calling the SDK (no spend), emitting a single error so the
 * Scheduler treats the node as failed. interrupt() is a no-op (nothing runs).
 */
export class BudgetExceededAdapter implements AgentAdapter {
  readonly backend = "budget-guard";

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
