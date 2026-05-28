import type { AgentId } from "@agent-team/core";

/** Per-agent USD accumulator. B1 reports; B2 enforces a team ceiling against it. */
export class CostLedger {
  private readonly perAgentMap = new Map<AgentId, number>();

  add(agentId: AgentId, usd: number): void {
    this.perAgentMap.set(agentId, (this.perAgentMap.get(agentId) ?? 0) + usd);
  }

  total(): number {
    let t = 0;
    for (const v of this.perAgentMap.values()) t += v;
    return t;
  }

  perAgent(): Map<AgentId, number> {
    return new Map(this.perAgentMap);
  }
}
