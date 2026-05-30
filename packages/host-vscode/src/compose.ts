import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  NoopContextProvider,
  TaskGraph,
} from "@agent-team/core";
import type {
  TaskNode,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import type { ControlRoomPanel } from "./control-room/panel.js";

const BASE_REF = "agentteam/integration";

async function ensureIntegrationBranch(repoRoot: string): Promise<void> {
  const git = new NodeGitRunner();
  const result = await git.run(["rev-parse", "--verify", BASE_REF], repoRoot);
  if (result.code !== 0) {
    await git.run(["branch", BASE_REF], repoRoot);
  }
}

export async function composeVscode(
  graphPath: string,
  panel: ControlRoomPanel,
): Promise<ScheduleResult> {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) throw new Error("No workspace folder open — open a git repo first.");

  await ensureIntegrationBranch(repoRoot);

  const graph = new TaskGraph(
    JSON.parse(readFileSync(graphPath, "utf8")) as TaskNode[],
  );

  const git = new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      void panel.askGate(req).then((allow) =>
        pending.resolve(
          req.requestId,
          allow
            ? { behavior: "allow" }
            : { behavior: "deny", message: "denied at gate" },
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

  // Forward every bus event to the live feed
  bus.subscribe((e: BusEvent) => panel.pushEvent(e));

  const worktrees = new WorktreeManager(git, repoRoot, new NoopContextProvider());
  const integration = new IntegrationCoordinator(git, worktrees, bus, repoRoot);
  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: 50 },
    graph,
    worktrees,
    integration,
    baseRef: BASE_REF,
  });

  const adapterFor = (_node: TaskNode): AgentAdapter =>
    new ClaudeAdapter({
      query: query as unknown as QueryFn,
      git,
      pending,
      ledger,
      model: "claude-opus-4-8",
      maxTurns: 50,
      permTimeoutMs: 60_000,
    });

  return scheduler.run(adapterFor);
}
