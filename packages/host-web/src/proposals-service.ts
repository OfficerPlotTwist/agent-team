import type { AmbientProposal, AcceptOutcome } from "@agent-team/core";

/** The slice of ProposalCoordinator the service needs (structural, fake-friendly). */
export interface ProposalOps {
  list(): Promise<AmbientProposal[]>;
  diff(branch: string): Promise<string>;
  accept(branch: string, onto?: string): Promise<AcceptOutcome>;
  reject(branch: string): Promise<void>;
}

/**
 * Serializes repo-MUTATING proposal commands through one in-process queue:
 * two tabs accepting concurrently must not interleave git state (S6's
 * acceptSeq protects worktree paths, not repo state). Reads pass through.
 */
export class ProposalsService {
  readonly #ops: ProposalOps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ops: ProposalOps) {
    this.#ops = ops;
  }

  list(): Promise<AmbientProposal[]> {
    return this.#ops.list();
  }

  diff(branch: string): Promise<string> {
    return this.#ops.diff(branch);
  }

  accept(branch: string, onto?: string): Promise<AcceptOutcome> {
    return this.#serialize(() => this.#ops.accept(branch, onto));
  }

  reject(branch: string): Promise<void> {
    return this.#serialize(() => this.#ops.reject(branch));
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => undefined); // failures don't poison the queue
    return next;
  }
}
