import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextProvider } from "../context-provider.js";
import type { ContextEnvelope, ContextModality } from "../context-envelope.js";
import type { TaskNode } from "../task-graph.js";
import type { Role } from "../events.js";
import type { Embedder } from "../embedder.js";

const CTX_DIR = ".agent-team";

/** One captured agent conclusion. `createdAt` is host-supplied (ISO-8601). */
export interface RecordedDecision {
  id: string;
  role: Role;
  goal: string;
  summary: string;
  createdAt: string;
}

/** Write side of shared memory. Kept separate from ContextProvider so the read
 *  seam (hydrate) stays clean and Noop/Text providers need no no-op write. */
export interface DecisionRecorder {
  record(decision: RecordedDecision): Promise<void>;
}

export interface SqliteVecOptions {
  dbPath: string;
  embedder: Embedder;
  k?: number;
}

interface Hit {
  node_id: string;
  role: string;
  goal: string;
  summary: string;
}

/**
 * sqlite-vec-backed shared memory. Implements BOTH ports over one db file:
 *  - record(): embed goal+summary, INSERT a decisions row + its vec0 embedding.
 *  - hydrate(): embed the node's goal, KNN top-k, write each hit as a gitignored
 *    `.agent-team/memory-<node_id>.md` into the worktree (never git add).
 * WAL mode lets parallel worktree readers coexist with the single writer.
 * Native (better-sqlite3) ⇒ lives under src/node/, exported via @agent-team/core/node only.
 */
export class SqliteVecContextProvider implements ContextProvider, DecisionRecorder {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;
  private readonly k: number;

  constructor(opts: SqliteVecOptions) {
    this.embedder = opts.embedder;
    this.k = opts.k ?? 5;
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db); // throws fast if the extension can't load
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        rowid      INTEGER PRIMARY KEY,
        node_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        goal       TEXT NOT NULL,
        summary    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_decisions USING vec0(embedding float[${this.embedder.dim}]);`,
    );
  }

  async record(d: RecordedDecision): Promise<void> {
    try {
      const vec = await this.embedder.embed(`${d.goal}\n${d.summary}`);
      // sqlite-vec v0.1.9 rejects explicit rowid binding, so vec_decisions uses
      // auto-rowid. The transaction makes the decisions + vec_decisions inserts
      // atomic, keeping their rowids in 1:1 lockstep (the hydrate JOIN relies on
      // decisions.rowid == vec_decisions.rowid).
      this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO decisions(node_id, role, goal, summary, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(d.id, d.role, d.goal, d.summary, d.createdAt);
        this.db.prepare("INSERT INTO vec_decisions(embedding) VALUES (?)").run(vec);
      })();
    } catch {
      // persisting one memory must never crash a completed run; warn so a failed
      // insert (which would otherwise silently desync the store) is visible.
      console.warn(`[shared-memory] failed to record decision ${d.id}`);
    }
  }

  async hydrate(
    node: TaskNode,
    worktreePath: string,
    _envelope?: ContextEnvelope,
    _modality?: ContextModality,
  ): Promise<void> {
    let hits: Hit[] = [];
    try {
      const q = await this.embedder.embed(node.goal);
      hits = this.db
        .prepare(
          `SELECT d.node_id, d.role, d.goal, d.summary
             FROM (
               SELECT rowid, distance FROM vec_decisions
               WHERE embedding MATCH ? ORDER BY distance LIMIT ?
             ) v
             JOIN decisions d ON d.rowid = v.rowid
             ORDER BY v.distance`,
        )
        .all(Buffer.from(q.buffer), this.k) as Hit[];
    } catch {
      return; // no memory is non-fatal to the agent run
    }
    if (hits.length === 0) return;
    const dir = join(worktreePath, CTX_DIR);
    await mkdir(dir, { recursive: true });
    for (const h of hits) {
      const md = `# Prior decision (${h.role} · ${h.node_id})\n\n**Goal:** ${h.goal}\n\n**Outcome:** ${h.summary}\n`;
      await writeFile(join(dir, `memory-${h.node_id}.md`), md, "utf8");
    }
  }

  /** Release the db handle (Windows locks the file otherwise). */
  close(): void {
    this.db.close();
  }
}
