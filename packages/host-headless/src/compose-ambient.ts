import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  NoopContextProvider,
  AmbientIntegration,
  Scheduler,
  TaskGraph,
  HashEmbedder,
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
  ContextProvider,
  Embedder,
} from "@agent-team/core";
import { NodeGitRunner, SqliteVecContextProvider } from "@agent-team/core/node";
import type { DecisionRecorder } from "@agent-team/core/node";
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
  /** Path to the shared-memory sqlite-vec db. Absent ⇒ no shared memory (today's behavior). */
  memoryDb?: string;
  /** Embedder for shared memory. Defaults to HashEmbedder (offline). */
  embedder?: Embedder;
}

export interface AmbientHost {
  bus: MessageBus;
  ledger: CostLedger;
  /** Run one ambient reaction for a trigger; resolves after the report is posted. */
  fire(trigger: AmbientTrigger): Promise<ScheduleResult>;
  /** Release the shared-memory db handle (no-op when --memory is off). */
  close(): void;
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

  // Shared memory: one provider serves both ports — hydrate (the reviewer reads
  // prior findings about the same files at worktree creation) and record (each
  // ambient_report finding is persisted for future reactions). Absent ⇒ Noop.
  let memory: SqliteVecContextProvider | undefined;
  let recorder: DecisionRecorder | undefined;
  let contextProvider: ContextProvider = new NoopContextProvider();
  if (opts.memoryDb) {
    memory = new SqliteVecContextProvider({
      dbPath: opts.memoryDb,
      embedder: opts.embedder ?? new HashEmbedder(),
    });
    recorder = memory;
    contextProvider = memory;
  }

  if (recorder) {
    const rec = recorder;
    bus.subscribe((e: BusEvent) => {
      if (e.kind !== "ambient_report") return;
      void rec.record({
        id: e.trigger.commitSha.slice(0, 7),
        role: "reviewer",
        goal: reviewGoal(e.trigger),
        summary: e.summary,
        createdAt: new Date().toISOString(),
      });
    });
  }

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
    const worktrees = new WorktreeManager(git, opts.repoRoot, contextProvider);
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

    // Persist the reviewer's finding onto the proposal commit as a trailer so the
    // proposals CLI can read it from git alone. The agent's worktree is already
    // removed, so amend through a throwaway worktree. Single-line the summary
    // (trailers are one line). Best-effort: a failed amend must not fail the run.
    const finding = doneSummary.replace(/\s+/g, " ").trim();
    if (sawFileChange && finding) {
      const tmp = `${opts.repoRoot}/.worktrees/proposal-finding-${sha7}`;
      const added = await git.run(["worktree", "add", "--force", tmp, branch], opts.repoRoot);
      if (added.code === 0) {
        const amended = await git.run(["commit", "--amend", "--no-edit", "--trailer", `Ambient-Finding: ${finding}`], tmp);
        if (amended.code !== 0) {
          console.warn(`[composeAmbient] finding-trailer amend failed (${amended.code}): ${amended.stderr.trim()}`);
        }
        await git.run(["worktree", "remove", "--force", tmp], opts.repoRoot);
      }
    }

    bus.publish({
      kind: "ambient_report",
      from: agentId,
      trigger,
      summary: doneSummary || `reaction ${result.status}`,
      branch: sawFileChange ? branch : undefined,
    });

    return result;
  }

  return { bus, ledger, fire, close: () => memory?.close() };
}
