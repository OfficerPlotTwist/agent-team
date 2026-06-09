import type { MessageBus, BusEvent, GitRunner, Role } from "@agent-team/core";
import type { CostLedger } from "@agent-team/adapters-claude";
import type { Variant } from "./variant.js";
import type { VariantMetrics } from "./report.js";

interface Tally {
  firstTs: number | null;
  doneTs: number | null;
  turns: number;
  done: boolean;
  error?: string;
}

export interface MetricsCollectorDeps {
  bus: MessageBus;
  ledger: CostLedger;
  git: GitRunner;
  repoRoot: string;
  /** Frozen base sha all variants forked from. */
  base: string;
  variantByNodeId: Map<string, Variant>;
  role: Role;
}

/**
 * Subscribes to the bus and tallies per-agentId turns/wall-clock/done/error.
 * After the run, reads per-variant cost from ledger.perAgent() and diff-shape
 * from git (each staged branch vs the frozen base). agentId = `${role}#${nodeId}`;
 * wall-clock comes from the bus-stamped event.ts (first event -> done).
 */
export class MetricsCollector {
  readonly #deps: MetricsCollectorDeps;
  readonly #tally = new Map<string, Tally>(); // keyed by nodeId

  constructor(deps: MetricsCollectorDeps) {
    this.#deps = deps;
    deps.bus.subscribe((e) => this.#onEvent(e));
  }

  #onEvent(e: BusEvent): void {
    const nodeId = e.from.slice(e.from.indexOf("#") + 1);
    if (!this.#deps.variantByNodeId.has(nodeId)) return;
    const t =
      this.#tally.get(nodeId) ?? { firstTs: null, doneTs: null, turns: 0, done: false };
    if (t.firstTs === null) t.firstTs = e.ts;
    t.turns += 1;
    if (e.kind === "done") {
      t.done = true;
      t.doneTs = e.ts;
    } else if (e.kind === "error") {
      t.error = e.message;
    }
    this.#tally.set(nodeId, t);
  }

  async collect(): Promise<VariantMetrics[]> {
    const { ledger, git, repoRoot, base, variantByNodeId, role } = this.#deps;
    const perAgent = ledger.perAgent();
    const out: VariantMetrics[] = [];

    for (const [nodeId, variant] of variantByNodeId) {
      const agentId = `${role}#${nodeId}`;
      const branch = `agentteam/${role}-${nodeId}`;
      const t = this.#tally.get(nodeId) ?? { firstTs: null, doneTs: null, turns: 0, done: false };
      const shape = await this.#diffShape(git, repoRoot, base, branch);
      out.push({
        variant: variant.name,
        nodeId,
        status: t.done ? "completed" : "failed",
        costUsd: perAgent.get(agentId) ?? 0,
        turns: t.turns,
        wallMs: t.firstTs !== null && t.doneTs !== null ? t.doneTs - t.firstTs : 0,
        ...shape,
        branch,
        ...(t.done ? {} : { error: t.error ?? "no done event" }),
      });
    }
    return out;
  }

  async #diffShape(
    git: GitRunner,
    repoRoot: string,
    base: string,
    branch: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; commits: number }> {
    const stat = (await git.run(["diff", "--shortstat", `${base}..${branch}`], repoRoot)).stdout;
    const num = (re: RegExp): number => {
      const m = stat.match(re);
      return m ? Number(m[1]) : 0;
    };
    const commitsOut = (await git.run(["rev-list", "--count", `${base}..${branch}`], repoRoot)).stdout;
    return {
      filesChanged: num(/(\d+) files? changed/),
      insertions: num(/(\d+) insertions?\(\+\)/),
      deletions: num(/(\d+) deletions?\(-\)/),
      commits: Number(commitsOut.trim()) || 0,
    };
  }
}
