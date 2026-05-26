import type { AgentId, FileChangeEvent } from "./events.js";

/** Port implemented by the host (Plan B wires this to VS Code's edit API). */
export interface DiffApplier {
  apply(path: string, diff: string): Promise<void>;
}

export type ProposalStatus = "pending" | "applied" | "rejected";

export interface Proposal {
  proposalId: string;
  path: string;
  diff: string;
  from: AgentId;
  status: ProposalStatus;
}

export class DiffStore {
  private proposals = new Map<string, Proposal>();

  constructor(private applier: DiffApplier) {}

  stage(e: FileChangeEvent): Proposal {
    const p: Proposal = {
      proposalId: e.proposalId,
      path: e.path,
      diff: e.diff,
      from: e.from,
      status: "pending",
    };
    this.proposals.set(p.proposalId, p);
    return p;
  }

  list(status?: ProposalStatus): Proposal[] {
    const all = [...this.proposals.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  async approve(proposalId: string): Promise<Proposal> {
    const p = this.mustGet(proposalId);
    await this.applier.apply(p.path, p.diff);
    p.status = "applied";
    return p;
  }

  reject(proposalId: string): Proposal {
    const p = this.mustGet(proposalId);
    p.status = "rejected";
    return p;
  }

  private mustGet(proposalId: string): Proposal {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`No proposal with id ${proposalId}`);
    return p;
  }
}
