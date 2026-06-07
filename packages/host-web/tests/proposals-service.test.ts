import { describe, it, expect } from "vitest";
import { ProposalsService } from "../src/proposals-service.js";
import type { AcceptOutcome, AmbientProposal } from "@agent-team/core";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ProposalsService", () => {
  it("delegates list and diff straight through", async () => {
    const svc = new ProposalsService({
      list: async () => [{ branch: "b" } as AmbientProposal],
      diff: async (b) => `diff-of-${b}`,
      accept: async () => ({ status: "nothing", branch: "b" }) as AcceptOutcome,
      reject: async () => {},
    });
    expect((await svc.list())[0]?.branch).toBe("b");
    expect(await svc.diff("b")).toBe("diff-of-b");
  });

  it("serializes accept/reject: the second mutation starts only after the first settles", async () => {
    const order: string[] = [];
    const first = deferred<AcceptOutcome>();
    const svc = new ProposalsService({
      list: async () => [],
      diff: async () => "",
      accept: async (b) => {
        order.push(`accept-start-${b}`);
        if (b === "b1") return first.promise;
        return { status: "merged", branch: b, onto: "main" };
      },
      reject: async (b) => {
        order.push(`reject-start-${b}`);
      },
    });

    const p1 = svc.accept("b1");
    const p2 = svc.reject("b2"); // queued behind b1
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["accept-start-b1"]); // b2 not started yet
    first.resolve({ status: "merged", branch: "b1", onto: "main" });
    await p1;
    await p2;
    expect(order).toEqual(["accept-start-b1", "reject-start-b2"]);
  });

  it("a rejected mutation does not poison the queue", async () => {
    const svc = new ProposalsService({
      list: async () => [],
      diff: async () => "",
      accept: async () => {
        throw new Error("boom");
      },
      reject: async () => {},
    });
    await expect(svc.accept("bad")).rejects.toThrow("boom");
    await expect(svc.reject("ok")).resolves.toBeUndefined(); // queue still alive
  });
});
