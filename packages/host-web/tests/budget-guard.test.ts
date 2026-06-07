import { describe, it, expect } from "vitest";
import { BudgetExceededAdapter } from "../src/budget-guard.js";
import type { AgentEvent, TaskContext } from "@agent-team/core";

describe("BudgetExceededAdapter (host-web copy)", () => {
  it("emits a single error naming ceiling and spend, never calls the SDK", async () => {
    const adapter = new BudgetExceededAdapter(1.5, 1.6201);
    const events: AgentEvent[] = [];
    await adapter.startTask({ agentId: "coder#n2" } as TaskContext, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", from: "coder#n2" });
    expect((events[0] as { message: string }).message).toContain("$1.5000");
    expect((events[0] as { message: string }).message).toContain("$1.6201");
  });
});
