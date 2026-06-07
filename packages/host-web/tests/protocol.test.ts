import { describe, it, expect } from "vitest";
import { parseClientCommand } from "../src/protocol.js";

describe("parseClientCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseClientCommand({ type: "allow", requestId: "r1" })).toEqual({ type: "allow", requestId: "r1" });
    expect(parseClientCommand({ type: "resume", afterSeq: 7 })).toEqual({ type: "resume", afterSeq: 7 });
    expect(parseClientCommand({ type: "proposal_accept", branch: "b", onto: "main" }))
      .toEqual({ type: "proposal_accept", branch: "b", onto: "main" });
    expect(parseClientCommand({ type: "proposal_refresh" })).toEqual({ type: "proposal_refresh" });
  });

  it("rejects malformed or unknown messages", () => {
    expect(parseClientCommand(null)).toBeNull();
    expect(parseClientCommand("allow")).toBeNull();
    expect(parseClientCommand({ type: "allow" })).toBeNull();
    expect(parseClientCommand({ type: "resume", afterSeq: "7" })).toBeNull();
    expect(parseClientCommand({ type: "resume", afterSeq: -1 })).toBeNull();
    expect(parseClientCommand({ type: "resume", afterSeq: 1.5 })).toBeNull();
    expect(parseClientCommand({ type: "proposal_accept", branch: "b", onto: 3 })).toBeNull();
    expect(parseClientCommand({ type: "launch_missiles" })).toBeNull();
  });
});
