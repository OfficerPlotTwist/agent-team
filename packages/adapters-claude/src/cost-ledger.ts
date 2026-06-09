import type { AgentId } from "@agent-team/core";

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/** Per-agent USD + token accumulator. B1 reports cost; B2 enforces a team ceiling
 *  against `total()`. Token tracking is additive — the cost methods are unchanged. */
export class CostLedger {
  private readonly perAgentMap = new Map<AgentId, number>();
  private readonly usageMap = new Map<AgentId, TokenUsage>();

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

  /** Accumulate input/output token usage for an agent (separate from cost). */
  addUsage(agentId: AgentId, usage: TokenUsage): void {
    const cur = this.usageMap.get(agentId) ?? { tokensIn: 0, tokensOut: 0 };
    this.usageMap.set(agentId, {
      tokensIn: cur.tokensIn + usage.tokensIn,
      tokensOut: cur.tokensOut + usage.tokensOut,
    });
  }

  usagePerAgent(): Map<AgentId, TokenUsage> {
    return new Map([...this.usageMap].map(([k, v]) => [k, { ...v }]));
  }
}
