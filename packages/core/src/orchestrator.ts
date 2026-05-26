import type { AgentAdapter } from "./adapter.js";
import type { Role } from "./events.js";
import { makeAgentId } from "./events.js";
import { MessageBus } from "./bus.js";

export interface SpecialistSpec {
  role: Role;
  adapter: AgentAdapter;
}

export interface Budget {
  maxTurns: number;
}

export interface OrchestratorDeps {
  bus: MessageBus;
  budget: Budget;
}

export type RunStatus = "done" | "budget" | "stopped";

export interface RunResult {
  status: RunStatus;
  summary: string;
}

export class Orchestrator {
  private stopped = false;
  private turns = 0;

  constructor(private deps: OrchestratorDeps) {}

  stop(): void {
    this.stopped = true;
  }

  async run(goal: string, team: SpecialistSpec[]): Promise<RunResult> {
    this.stopped = false;
    this.turns = 0;

    const adapters = team.map((s) => s.adapter);
    let terminal: RunResult | null = null;

    // Record the first terminal condition. Budget/stop interrupt all agents to
    // halt runaway work; a lead `done` is allowed to let in-flight finite work
    // drain (so cross-agent event ordering does not race the resolution).
    const recordTerminal = (result: RunResult, interrupt: boolean) => {
      if (terminal) return;
      terminal = result;
      if (interrupt) for (const a of adapters) a.interrupt();
    };

    const off = this.deps.bus.subscribe((e) => {
      this.turns += 1;
      if (this.stopped) {
        recordTerminal({ status: "stopped", summary: "stopped by user" }, true);
      } else if (this.turns >= this.deps.budget.maxTurns) {
        recordTerminal({ status: "budget", summary: `turn budget ${this.deps.budget.maxTurns} reached` }, true);
      } else if (e.kind === "done" && e.from === makeAgentId("lead", 0)) {
        recordTerminal({ status: "done", summary: e.summary }, false);
      }
    });

    // Assign instance ids using the team array index so each specialist gets a
    // stable, unique id (lead#0, coder#1, etc.) regardless of role collisions.
    const tasks = team.map((s, index) => {
      const agentId = makeAgentId(s.role, index);
      return s.adapter.startTask({ goal, role: s.role, agentId }, (event) => {
        this.deps.bus.publish(event);
      });
    });

    await Promise.all(tasks);
    off();
    return terminal ?? { status: this.stopped ? "stopped" : "done", summary: "all agents completed" };
  }
}
