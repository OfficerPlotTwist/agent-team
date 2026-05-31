import type OpenAI from "openai";
import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";
import { runLoop } from "./loop.js";

export class DeepSeekAdapter implements AgentAdapter {
  readonly backend = "deepseek";
  readonly contextModalities = ["text"] as const;
  #interrupted = false;

  constructor(
    private readonly client: OpenAI,
    private readonly model = "deepseek-coder",
    private readonly maxTurns = 40,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.#interrupted = false;
    await runLoop(ctx, emit, this.client, this.model, this.maxTurns, () => this.#interrupted);
  }

  interrupt(): void {
    this.#interrupted = true;
  }
}
