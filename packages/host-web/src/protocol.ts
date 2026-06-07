import type {
  BusEvent,
  AmbientProposal,
  AcceptOutcome,
  RequestCategory,
} from "@agent-team/core";

/** Broadcast envelopes: seq-stamped by the ring buffer, buffered for resume-replay. */
export type BroadcastEnvelope =
  | { seq: number; type: "event"; payload: BusEvent }
  | { seq: number; type: "gate"; requestId: string; category: RequestCategory; summary: string }
  | { seq: number; type: "gate_resolved"; requestId: string; allowed: boolean }
  | { seq: number; type: "proposals"; items: AmbientProposal[] }
  | {
      seq: number;
      type: "proposal_outcome";
      branch: string;
      outcome: AcceptOutcome | { status: "rejected"; branch: string };
    };

/** Direct envelopes: connection-scoped replies, never buffered; seq is always 0. */
export type DirectEnvelope =
  | { seq: 0; type: "hello"; latestSeq: number; runState: "running" | "settled"; gapped?: true }
  | { seq: 0; type: "proposal_diff"; branch: string; diff: string };

export type ServerEnvelope = BroadcastEnvelope | DirectEnvelope;

export type ClientCommand =
  | { type: "allow"; requestId: string }
  | { type: "deny"; requestId: string }
  | { type: "proposal_show"; branch: string }
  | { type: "proposal_accept"; branch: string; onto?: string }
  | { type: "proposal_reject"; branch: string }
  | { type: "proposal_refresh" }
  | { type: "resume"; afterSeq: number };

/** Strict shape-check of an untrusted client message. Anything off ⇒ null. */
export function parseClientCommand(raw: unknown): ClientCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "allow":
    case "deny":
      return typeof m.requestId === "string" ? { type: m.type, requestId: m.requestId } : null;
    case "proposal_show":
    case "proposal_reject":
      return typeof m.branch === "string" ? { type: m.type, branch: m.branch } : null;
    case "proposal_accept":
      if (typeof m.branch !== "string") return null;
      if (m.onto !== undefined && typeof m.onto !== "string") return null;
      return { type: "proposal_accept", branch: m.branch, onto: m.onto as string | undefined };
    case "proposal_refresh":
      return { type: "proposal_refresh" };
    case "resume":
      return typeof m.afterSeq === "number" && Number.isFinite(m.afterSeq)
        ? { type: "resume", afterSeq: m.afterSeq }
        : null;
    default:
      return null;
  }
}
