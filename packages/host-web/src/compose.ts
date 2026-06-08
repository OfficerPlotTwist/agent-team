import { fileURLToPath } from "node:url";
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  pickModality,
  CompositeContextProvider,
  HashEmbedder,
  ProposalCoordinator,
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
  AgentAdapter,
  ScheduleResult,
  ContextProvider,
  Embedder,
} from "@agent-team/core";
import { NodeGitRunner, TextContextProvider, SqliteVecContextProvider } from "@agent-team/core/node";
import type { DecisionRecorder } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import { BudgetExceededAdapter } from "./budget-guard.js";
import { GateBridge } from "./gate-bridge.js";
import { ProposalsService } from "./proposals-service.js";
import { createControlServer } from "./server.js";
import type { ControlServer } from "./server.js";
import type { ClientCommand, DirectEnvelope } from "./protocol.js";

export interface ComposeWebOptions {
  repoRoot: string;
  graph: TaskGraph;
  query: QueryFn;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
  costCeilingUsd?: number;
  git?: GitRunner;
  /** Shared-memory sqlite-vec db; semantics identical to composeHeadless. */
  memoryDb?: string;
  embedder?: Embedder;
  /** 0 = ephemeral (tests). Default 7340. */
  port?: number;
  /** Default: <package>/ui/dist. */
  uiDist?: string;
  ringCapacity?: number;
  heartbeatMs?: number;
  graceMs?: number;
}

export interface ComposedWebHost {
  bus: MessageBus;
  ledger: CostLedger;
  server: ControlServer;
  port(): number;
  run(): Promise<ScheduleResult>;
  close(): Promise<void>;
}

const BASE_REF = "agentteam/integration";

export async function composeWeb(opts: ComposeWebOptions): Promise<ComposedWebHost> {
  const git = opts.git ?? new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  let runState: "running" | "settled" = "running";
  let serverRef: ControlServer | undefined; // late-bound: GateBridge needs broadcast before the server exists

  const gates = new GateBridge({
    broadcast: (env) => serverRef?.broadcast(env),
    graceMs: opts.graceMs,
  });
  const proposals = new ProposalsService(new ProposalCoordinator({ git, repoRoot: opts.repoRoot }));

  async function handleCommand(cmd: ClientCommand, reply: (env: DirectEnvelope) => void): Promise<void> {
    switch (cmd.type) {
      case "allow":
      case "deny":
        gates.command(cmd);
        return;
      case "proposal_show":
        reply({ seq: 0, type: "proposal_diff", branch: cmd.branch, diff: await proposals.diff(cmd.branch) });
        return;
      case "proposal_accept": {
        const outcome = await proposals.accept(cmd.branch, cmd.onto);
        // Clean up the branch after a successful merge so list() returns 0 open proposals.
        if (outcome.status === "merged") {
          await proposals.reject(cmd.branch);
        }
        serverRef?.broadcast({ type: "proposal_outcome", branch: cmd.branch, outcome });
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      }
      case "proposal_reject":
        await proposals.reject(cmd.branch);
        serverRef?.broadcast({
          type: "proposal_outcome",
          branch: cmd.branch,
          outcome: { status: "rejected", branch: cmd.branch },
        });
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      case "proposal_refresh":
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      case "resume":
        return; // handled inside the server
    }
  }

  const server = await createControlServer({
    uiDist: opts.uiDist ?? fileURLToPath(new URL("../ui/dist", import.meta.url)),
    port: opts.port ?? 7340,
    ringCapacity: opts.ringCapacity,
    heartbeatMs: opts.heartbeatMs,
    runState: () => runState,
    onClientConnected: () => {
      gates.clientConnected();
      void proposals
        .list()
        .then((items) => serverRef?.broadcast({ type: "proposals", items }))
        .catch((err) => console.warn("[host-web] proposals list failed:", err));
    },
    onClientDisconnected: () => gates.clientDisconnected(),
    onCommand: (cmd, reply) => {
      void handleCommand(cmd, reply).catch((err) => console.warn("[host-web] command failed:", err));
    },
  });
  serverRef = server;

  // GATE: route to the browser inbox; resolution feeds adapters-claude's pending map.
  const handlers: BrokerHandlers = {
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      void gates
        .askGate({
          requestId: req.requestId,
          category: req.category,
          summary: req.summary,
          timeoutMs: req.timeoutMs,
        })
        .then((allow) =>
          pending.resolve(
            req.requestId,
            allow ? { behavior: "allow" } : { behavior: "deny", message: "denied at gate" },
          ),
        );
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

  // Every bus event goes to the browser feed.
  bus.subscribe((e: BusEvent) => serverRef?.broadcast({ type: "event", payload: e }));

  // Shared memory (identical to composeHeadless).
  let memory: SqliteVecContextProvider | undefined;
  let recorder: DecisionRecorder | undefined;
  let contextProvider: ContextProvider = new TextContextProvider();
  if (opts.memoryDb) {
    memory = new SqliteVecContextProvider({
      dbPath: opts.memoryDb,
      embedder: opts.embedder ?? new HashEmbedder(),
    });
    recorder = memory;
    contextProvider = new CompositeContextProvider([new TextContextProvider(), memory]);
  }
  if (recorder) {
    const rec = recorder;
    bus.subscribe((e: BusEvent) => {
      if (e.kind !== "done") return;
      const id = e.from.slice(e.from.indexOf("#") + 1);
      const node = opts.graph.get(id);
      if (!node) return;
      void rec.record({
        id: node.id,
        role: node.role,
        goal: node.goal,
        summary: e.summary,
        createdAt: new Date().toISOString(),
      });
    });
  }

  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(git, opts.repoRoot, contextProvider, () => ({
    envelope: undefined,
    modality: pickModality(contextModalities),
  }));
  const integration = new IntegrationCoordinator(git, worktrees, bus, opts.repoRoot);
  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: opts.maxTurns },
    graph: opts.graph,
    worktrees,
    integration,
    baseRef: BASE_REF,
  });

  const adapterFor = (_node: TaskNode): AgentAdapter => {
    if (opts.costCeilingUsd != null && ledger.total() >= opts.costCeilingUsd) {
      return new BudgetExceededAdapter(opts.costCeilingUsd, ledger.total());
    }
    return new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });
  };

  return {
    bus,
    ledger,
    server,
    port: () => server.port(),
    run: async () => {
      try {
        return await scheduler.run(adapterFor);
      } finally {
        runState = "settled";
      }
    },
    close: async () => {
      memory?.close();
      await server.close();
    },
  };
}
