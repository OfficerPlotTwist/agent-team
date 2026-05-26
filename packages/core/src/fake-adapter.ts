import type { AgentAdapter, TaskContext, Emit } from "./adapter.js";
import type { AgentEvent } from "./events.js";

export class FakeAdapter implements AgentAdapter {
  readonly backend = "fake";
  private interrupted = false;

  constructor(private readonly script: Array<Omit<AgentEvent, "from">>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    for (const partial of this.script) {
      if (this.interrupted) return;
      emit({ ...partial, from: ctx.agentId } as AgentEvent);
      // Yield to the microtask queue so interrupt() set inside emit() takes effect.
      await Promise.resolve();
    }
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
