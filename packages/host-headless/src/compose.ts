import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  NoopContextProvider,
} from "@agent-team/core";
import type {
  TaskGraph,
  TaskNode,
  GitRunner,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
} from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";

export interface ComposeOptions {
  repoRoot: string;
  graph: TaskGraph;
  query: QueryFn;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
  /** Resolve a GATE interactively. Defaults to deny (non-interactive safety). */
  onGate?: (req: ActionRequestEvent) => Promise<boolean>;
  git?: GitRunner;
}

export interface ComposedHost {
  scheduler: Scheduler;
  bus: MessageBus;
  ledger: CostLedger;
  pending: PendingPermissions;
  baseRef: string;
  run(): Promise<import("@agent-team/core").ScheduleResult>;
}

const BASE_REF = "agentteam/integration";

export function composeHeadless(opts: ComposeOptions): ComposedHost {
  const git = opts.git ?? new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    // GATE: only credential/destructive under Autopilot. Resolve via onGate (default deny).
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      const ask = opts.onGate ?? (async () => false);
      void ask(req).then((allow) =>
        pending.resolve(
          req.requestId,
          allow ? { behavior: "allow" } : { behavior: "deny", message: "denied at gate" },
        ),
      );
    },
    // ROUTE has no real peers in B1 — log only; the subscriber auto-allows (mode !== GATE).
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);

  // Wire bus -> broker -> pending. Only permission requests (registered in `pending`)
  // are brokered; merge_conflict action_requests are not registered, so they bypass.
  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") {
      pending.resolve(e.requestId, { behavior: "allow" });
    }
  });

  const worktrees = new WorktreeManager(git, opts.repoRoot, new NoopContextProvider());
  const integration = new IntegrationCoordinator(git, worktrees, bus, opts.repoRoot);
  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: opts.maxTurns },
    graph: opts.graph,
    worktrees,
    integration,
    baseRef: BASE_REF,
  });

  const adapterFor = (_node: TaskNode): ClaudeAdapter =>
    new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });

  return {
    scheduler,
    bus,
    ledger,
    pending,
    baseRef: BASE_REF,
    run: () => scheduler.run(adapterFor),
  };
}
