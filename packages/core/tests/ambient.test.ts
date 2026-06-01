import { describe, it, expect } from "vitest";
import { AmbientIntegration } from "../src/ambient.js";
import { MessageBus } from "../src/bus.js";
import type { AmbientReportEvent, AmbientTrigger, BusEvent } from "../src/events.js";

describe("AmbientIntegration (stage-only)", () => {
  it("init stores the base; tip returns the reviewed SHA verbatim", async () => {
    const ai = new AmbientIntegration();
    await ai.init("abc123");
    expect(ai.tip()).toBe("abc123");
  });

  it("integrate reports merged WITHOUT merging", async () => {
    const ai = new AmbientIntegration();
    await ai.init("abc123");
    const outcome = await ai.integrate("reviewer#abc1234", "agentteam/reviewer-abc1234");
    expect(outcome).toEqual({ status: "merged" });
  });
});

describe("ambient_report event", () => {
  it("publishes through the bus and is seq-stamped", () => {
    const bus = new MessageBus();
    const seen: BusEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const trigger: AmbientTrigger = { reason: "commit", commitSha: "deadbee", scope: ["a.ts"] };
    const ev: AmbientReportEvent = {
      kind: "ambient_report",
      from: "reviewer#deadbee",
      trigger,
      summary: "looks risky",
      branch: "agentteam/reviewer-deadbee",
    };
    const stamped = bus.publish(ev);
    expect(stamped.kind).toBe("ambient_report");
    expect(typeof stamped.seq).toBe("number");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "ambient_report", summary: "looks risky" });
  });
});
