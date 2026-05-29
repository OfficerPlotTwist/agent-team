import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@agent-team/core";
import { BudgetExceededAdapter } from "../src/budget-guard.js";

describe("BudgetExceededAdapter", () => {
  it("emits exactly one budget error naming the agent, no other events", async () => {
    const adapter = new BudgetExceededAdapter(0.5, 0.6);
    const events: AgentEvent[] = [];
    await adapter.startTask(
      { goal: "x", role: "coder", agentId: "coder#a", cwd: "/tmp/x", branch: "b" },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
    expect(events[0].kind === "error" && events[0].message).toContain("team cost ceiling");
    expect(events[0].kind === "error" && events[0].message).toContain("coder#a");
  });

  it("backend is budget-guard and interrupt() is a no-op", () => {
    const adapter = new BudgetExceededAdapter(1, 2);
    expect(adapter.backend).toBe("budget-guard");
    expect(() => adapter.interrupt()).not.toThrow();
  });
});
