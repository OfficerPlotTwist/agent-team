import { describe, it, expect } from "vitest";
import type { AgentAdapter } from "../src/adapter.js";
import type { AgentEvent } from "../src/events.js";

/**
 * Runs the shared adapter contract. `makeAdapter` must return an adapter that,
 * given the goal "emit one message then finish", emits exactly a `message`
 * followed by a `done`.
 */
export function runAdapterConformance(name: string, makeAdapter: () => AgentAdapter): void {
  describe(`AgentAdapter conformance: ${name}`, () => {
    it("exposes a non-empty backend id", () => {
      expect(makeAdapter().backend.length).toBeGreaterThan(0);
    });

    it("stamps every event's `from` with the context agentId", async () => {
      const out: AgentEvent[] = [];
      await makeAdapter().startTask(
        { goal: "emit one message then finish", role: "coder", agentId: "coder#7" },
        (e) => out.push(e),
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((e) => e.from === "coder#7")).toBe(true);
    });

    it("terminates with a `done` (or `error`) event", async () => {
      const out: AgentEvent[] = [];
      await makeAdapter().startTask(
        { goal: "emit one message then finish", role: "coder", agentId: "coder#7" },
        (e) => out.push(e),
      );
      const last = out[out.length - 1];
      expect(["done", "error"]).toContain(last.kind);
    });
  });
}
