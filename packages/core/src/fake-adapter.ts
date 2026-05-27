import type { AgentAdapter, TaskContext, Emit } from "./adapter.js";
import type { AgentEvent } from "./events.js";

export class FakeAdapter implements AgentAdapter {
  readonly backend = "fake";
  private interrupted = false;
  /** The most recent context passed to startTask (for test assertions). */
  lastContext?: TaskContext;

  constructor(private readonly script: Array<Omit<AgentEvent, "from">>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.lastContext = ctx;
    this.interrupted = false;
    for (const partial of this.script) {
      if (this.interrupted) return;
      emit({ ...partial, from: ctx.agentId } as AgentEvent);
      await Promise.resolve();
    }
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
