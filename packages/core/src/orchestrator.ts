import type { AgentAdapter } from "./adapter.js";
import type { Role } from "./events.js";
import { makeAgentId, roleOf } from "./events.js";
import { MessageBus } from "./bus.js";
import type { TaskGraph, TaskNode } from "./task-graph.js";
import type { WorktreeManager } from "./worktree.js";
import type { IntegrationCoordinator } from "./integration.js";

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

export type RunStatus = "done" | "budget" | "stopped" | "drained";

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
      } else if (e.kind === "done" && roleOf(e.from) === "lead") {
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
    // All agents finished their work without a lead `done`, budget, or stop.
    // This is distinct from `done` — the lead never declared the goal met.
    return terminal ?? { status: "drained", summary: "all agents completed" };
  }
}

export interface SchedulerDeps {
  bus: MessageBus;
  budget: Budget;
  graph: TaskGraph;
  worktrees: WorktreeManager;
  integration: IntegrationCoordinator;
  /** Ref the integration branch + first worktrees are cut from (workspace HEAD). */
  baseRef: string;
}

export type ScheduleStatus = "complete" | "budget" | "stopped" | "blocked";

export interface ScheduleResult {
  status: ScheduleStatus;
  completed: string[];
  blocked: string[];
}

/**
 * Executes a TaskGraph: creates a worktree per ready node, runs ready nodes
 * concurrently, merges each branch into integration on `done`, unlocks dependents.
 * Terminates on graph-complete, budget exhaustion, stop(), or a blocked graph
 * (no in-flight work and nothing ready — e.g. a node failed or hit a conflict).
 */
export class Scheduler {
  private stopped = false;
  private wakeRef: (() => void) | null = null;

  constructor(private deps: SchedulerDeps) {}

  stop(): void {
    this.stopped = true;
    // Unblock the run loop so a stop is acted on promptly even when every node
    // is mid-flight; the loop re-checks `stopped` at the top. A spurious wake is
    // harmless. Without this, `await tick` only resumes when a node settles.
    this.wakeRef?.();
  }

  async run(adapterFor: (node: TaskNode) => AgentAdapter): Promise<ScheduleResult> {
    const { bus, budget, graph, worktrees, integration, baseRef } = this.deps;
    this.stopped = false;
    await integration.init(baseRef);

    // Per-agent turn budget + done tracking. Turns are counted per agentId so an
    // over-budget node is interrupted alone (Fix 1); only a node that emitted a
    // `done` event may merge + complete (Fix 2).
    const doneAgents = new Set<string>();
    const turnsByAgent = new Map<string, number>();
    const adapterByAgent = new Map<string, AgentAdapter>();
    let budgetHit = false;
    const inflight = new Map<string, Promise<void>>();
    const adapters = new Map<string, AgentAdapter>();
    const failed = new Set<string>();

    const off = bus.subscribe((e) => {
      if (e.kind === "done") doneAgents.add(e.from);
      const n = (turnsByAgent.get(e.from) ?? 0) + 1;
      turnsByAgent.set(e.from, n);
      if (n >= budget.maxTurns) {
        const a = adapterByAgent.get(e.from);
        if (a) { budgetHit = true; a.interrupt(); }
      }
    });

    // A "tick" promise that resolves whenever any node settles, so the loop wakes.
    let resolveTick!: () => void;
    let tick = new Promise<void>((r) => { resolveTick = r; });
    const wake = (): void => {
      const r = resolveTick;
      tick = new Promise<void>((res) => { resolveTick = res; });
      r();
    };
    this.wakeRef = wake;

    const runNode = async (node: TaskNode): Promise<void> => {
      let created = false;
      try {
        const wt = await worktrees.create(node, integration.tip());
        created = true;
        const agentId = `${node.role}#${node.id}`;
        const adapter = adapterFor(node);
        adapters.set(node.id, adapter);
        await adapter.startTask(
          { goal: node.goal, role: node.role, agentId, cwd: wt.path, branch: wt.branch },
          (event) => bus.publish(event),
        );
        const outcome = await integration.integrate(agentId, wt.branch);
        if (outcome.status === "merged") graph.complete(node.id);
        else failed.add(node.id);
      } catch (err) {
        failed.add(node.id);
        bus.publish({ kind: "error", from: `${node.role}#${node.id}`, message: String(err) });
      } finally {
        // Always reclaim the worktree, even if startTask/integrate threw.
        if (created) await worktrees.remove(node);
        inflight.delete(node.id);
        adapters.delete(node.id);
        wake();
      }
    };

    while (!graph.isDone()) {
      if (this.stopped) break;
      for (const node of graph.ready()) {
        if (inflight.has(node.id) || failed.has(node.id)) continue;
        graph.start(node.id);
        inflight.set(node.id, runNode(node));
      }
      if (inflight.size === 0) break; // graph not done and nothing in flight => blocked
      await tick;
    }

    if (this.stopped) {
      for (const a of adapters.values()) a.interrupt();
    }
    off();
    this.wakeRef = null;
    await Promise.allSettled([...inflight.values()]);
    await worktrees.pruneAll();

    const completed = graph.completedIds();
    const completedSet = new Set(completed);
    const blocked = graph.ids().filter((id) => !completedSet.has(id));
    const status: ScheduleStatus = graph.isDone()
      ? "complete"
      : this.stopped
        ? "stopped"
        : budgetHit
          ? "budget"
          : "blocked";
    return { status, completed, blocked };
  }
}
