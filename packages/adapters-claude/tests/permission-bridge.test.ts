import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@agent-team/core";
import { PendingPermissions } from "../src/pending-permissions.js";
import { makePermissionBridge } from "../src/permission-bridge.js";

describe("makePermissionBridge", () => {
  it("emits an action_request with the classified category and resolves synchronously in-emit", async () => {
    const pending = new PendingPermissions();
    const events: AgentEvent[] = [];
    // Host resolves the request synchronously INSIDE the emit callback. This only
    // works if the bridge registered the resolver BEFORE emitting — it regression-
    // guards the register-before-emit ordering invariant.
    const bridge = makePermissionBridge({
      agentId: "coder#a",
      emit: (e) => {
        events.push(e);
        if (e.kind === "action_request") {
          expect(e.category).toBe("approval");
          expect(e.from).toBe("coder#a");
          pending.resolve(e.requestId, { behavior: "allow" });
        }
      },
      pending,
      timeoutMs: 1000,
    });

    const result = await bridge("Write", { file_path: "a.ts" }, {} as never);
    expect(result).toEqual({ behavior: "allow", updatedInput: { file_path: "a.ts" } });
    expect(events.some((e) => e.kind === "action_request")).toBe(true);
  });

  it("echoes the tool input as updatedInput on allow (SDK requires it)", async () => {
    const pending = new PendingPermissions();
    const events: AgentEvent[] = [];
    const bridge = makePermissionBridge({
      agentId: "coder#a",
      emit: (e) => {
        events.push(e);
        if (e.kind === "action_request") pending.resolve(e.requestId, { behavior: "allow" });
      },
      pending,
      timeoutMs: 1000,
    });
    const input = { file_path: "a.ts", content: "x" };
    const result = await bridge("Write", input, {} as never);
    expect(result).toEqual({ behavior: "allow", updatedInput: input });
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
