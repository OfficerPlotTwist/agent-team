import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  NoopContextProvider,
  AmbientIntegration,
  Scheduler,
  TaskGraph,
} from "@agent-team/core";
import type {
  TaskNode,
  GitRunner,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  AmbientTrigger,
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";

export interface AmbientOptions {
  repoRoot: string;
  query: QueryFn;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
  git?: GitRunner;
}

export interface AmbientHost {
  bus: MessageBus;
  ledger: CostLedger;
  /** Run one ambient reaction for a trigger; resolves after the report is posted. */
  fire(trigger: AmbientTrigger): Promise<ScheduleResult>;
}

function reviewGoal(trigger: AmbientTrigger): string {
  const files = trigger.scope.map((f) => `- ${f}`).join("\n");
  return [
    `Review the changes in commit ${trigger.commitSha.slice(0, 7)} touching:`,
    files,
    "Propose concrete improvements by editing these files. If nothing needs changing, make no edits.",
  ].join("\n");
}

export function composeAmbient(opts: AmbientOptions): AmbientHost {
  const git = opts.git ?? new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    gate: (_req: ActionRequestEvent, _from: AgentId) => {},
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);
  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") pending.resolve(e.requestId, { behavior: "allow" });
  });

  const adapterFor = (_node: TaskNode): AgentAdapter =>
    new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });

  async function fire(trigger: AmbientTrigger): Promise<ScheduleResult> {
    const sha7 = trigger.commitSha.slice(0, 7);
    const agentId = `reviewer#${sha7}`;
    const branch = `agentteam/reviewer-${sha7}`;

    let sawFileChange = false;
    let doneSummary = "";
    const off = bus.subscribe((e: BusEvent) => {
      if (e.from !== agentId) return;
      if (e.kind === "file_change") sawFileChange = true;
      if (e.kind === "done") doneSummary = e.summary;
    });

    const graph = new TaskGraph([
      { id: sha7, role: "reviewer", goal: reviewGoal(trigger), dependsOn: [] },
    ]);
    const worktrees = new WorktreeManager(git, opts.repoRoot, new NoopContextProvider());
    const integration = new AmbientIntegration();
    const scheduler = new Scheduler({
      bus,
      budget: { maxTurns: opts.maxTurns },
      graph,
      worktrees,
      integration,
      baseRef: trigger.commitSha,
    });

    const result = await scheduler.run(adapterFor);
    off();

    bus.publish({
      kind: "ambient_report",
      from: agentId,
      trigger,
      summary: doneSummary || `reaction ${result.status}`,
      branch: sawFileChange ? branch : undefined,
    });

    return result;
  }

  return { bus, ledger, fire };
}
