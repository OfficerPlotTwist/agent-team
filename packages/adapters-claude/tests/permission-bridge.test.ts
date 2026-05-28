import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@agent-team/core";
import { PendingPermissions } from "../src/pending-permissions.js";
import { makePermissionBridge } from "../src/permission-bridge.js";

describe("makePermissionBridge", () => {
  it("emits an action_request with the classified category and awaits resolution", async () => {
    const pending = new PendingPermissions();
    const events: AgentEvent[] = [];
    const bridge = makePermissionBridge({
      agentId: "coder#a",
      emit: (e) => events.push(e),
      pending,
      timeoutMs: 1000,
    });

    // Simulate the host resolving the request as soon as it is emitted.
    const original = pending.register.bind(pending);
    // Kick off the gated call; resolve on next tick.
    const callPromise = bridge("Write", { file_path: "a.ts" }, {} as never);
    // The bridge registers then emits synchronously; grab the requestId from the event.
    const req = events.find((e) => e.kind === "action_request");
    expect(req).toBeTruthy();
    if (req && req.kind === "action_request") {
      expect(req.category).toBe("approval");
      expect(req.from).toBe("coder#a");
      pending.resolve(req.requestId, { behavior: "allow" });
    }
    void original;
    await expect(callPromise).resolves.toEqual({ behavior: "allow" });
  });

  it("returns deny when the request is denied", async () => {
    const pending = new PendingPermissions();
    const events: AgentEvent[] = [];
    const bridge = makePermissionBridge({
      agentId: "coder#a",
      emit: (e) => events.push(e),
      pending,
      timeoutMs: 1000,
    });
    const callPromise = bridge("Bash", { command: "rm -rf /" }, {} as never);
    const req = events.find((e) => e.kind === "action_request");
    if (req && req.kind === "action_request") {
      expect(req.category).toBe("destructive");
      pending.resolve(req.requestId, { behavior: "deny", message: "blocked" });
    }
    await expect(callPromise).resolves.toEqual({ behavior: "deny", message: "blocked" });
  });

  it("denies on timeout when never resolved", async () => {
    const pending = new PendingPermissions();
    const bridge = makePermissionBridge({
      agentId: "coder#a",
      emit: () => {},
      pending,
      timeoutMs: 5,
    });
    const result = await bridge("Write", { file_path: "a.ts" }, {} as never);
    expect(result.behavior).toBe("deny");
  });
});
