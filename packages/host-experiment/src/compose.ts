import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  AmbientIntegration,
  Scheduler,
  pickModality,
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
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner, TextContextProvider } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import type { ExpandedExperiment } from "./expand.js";

export interface ComposeExperimentOptions {
  repoRoot: string;
  experiment: ExpandedExperiment;
  query: QueryFn;
  defaultMaxTurns: number;
  defaultPermTimeoutMs: number;
  git?: GitRunner;
}

export interface ComposedExperiment {
  bus: MessageBus;
  ledger: CostLedger;
  /** Frozen base sha all variants forked from (committed HEAD at compose time). */
  base: string;
  run(): Promise<ScheduleResult>;
}

/**
 * Wires the existing Scheduler to run the expanded variant graph against a frozen
 * base with stage-only AmbientIntegration (no variant merges) and a per-variant
 * adapter. Deliberately wires NO memory recorder (validity). Non-interactive:
 * gates default-deny, but autopilot only GATEs credential/destructive, so file
 * Writes auto-allow uniformly across variants.
 */
export async function composeExperiment(
  opts: ComposeExperimentOptions,
): Promise<ComposedExperiment> {
  const git = opts.git ?? new NodeGitRunner();
  const { graph, variantByNodeId } = opts.experiment;

  const base = (await git.run(["rev-parse", "HEAD"], opts.repoRoot)).stdout.trim();

  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    // Non-interactive experiment: a real GATE (credential/destructive) default-denies.
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      pending.resolve(req.requestId, { behavior: "deny", message: "experiment: gate auto-denied" });
    },
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);

  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") {
      pending.resolve(e.requestId, { behavior: "allow" });
    }
  });

  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(
    git,
    opts.repoRoot,
    new TextContextProvider(), // hydrate-only TEXT context; NO memory recorder (validity)
    () => ({ envelope: undefined, modality: pickModality(contextModalities) }),
  );

  const integration = new AmbientIntegration(); // stage-only: tip()=base, integrate() no-merge

  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: opts.defaultMaxTurns },
    graph,
    worktrees,
    integration,
    baseRef: base, // AmbientIntegration.init(base) freezes it; every worktree cuts from base
  });

  const adapterFor = (node: TaskNode): AgentAdapter => {
    const variant = variantByNodeId.get(node.id);
    if (!variant) throw new Error(`no variant for node ${node.id}`);
    return new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: variant.model,
      maxTurns: variant.maxTurns ?? opts.defaultMaxTurns,
      permTimeoutMs: variant.permTimeoutMs ?? opts.defaultPermTimeoutMs,
    });
  };

  return { bus, ledger, base, run: () => scheduler.run(adapterFor) };
}
