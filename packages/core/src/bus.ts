import type { AgentEvent, BusEvent, MessageEvent } from "./events.js";
import { roleOf } from "./events.js";

export interface BusOptions {
  /** Max times one role may recur in a single causal chain before a cycle is flagged. */
  maxChainRepeats?: number;
}

export interface CycleInfo {
  event: BusEvent;
  role: string;
  count: number;
}

type Subscriber = (e: BusEvent) => void;
type CycleListener = (info: CycleInfo) => void;

export class MessageBus {
  private seq = 0;
  private subscribers = new Set<Subscriber>();
  private cycleListeners = new Set<CycleListener>();
  private bySeq = new Map<number, BusEvent>();
  private readonly maxChainRepeats: number;

  constructor(opts: BusOptions = {}) {
    this.maxChainRepeats = opts.maxChainRepeats ?? 4;
  }

  publish(event: AgentEvent): BusEvent {
    const stamped: BusEvent = { ...event, seq: this.seq++, ts: Date.now() };
    this.bySeq.set(stamped.seq, stamped);
    if (stamped.kind === "message") {
      this.checkCycle(stamped);
    }
    for (const sub of this.subscribers) sub(stamped);
    return stamped;
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  onCycle(listener: CycleListener): () => void {
    this.cycleListeners.add(listener);
    return () => this.cycleListeners.delete(listener);
  }

  private checkCycle(event: BusEvent & MessageEvent): void {
    const counts = new Map<string, number>();
    let cursor: (BusEvent & MessageEvent) | undefined = event;
    while (cursor) {
      const role = roleOf(cursor.from);
      const next = (counts.get(role) ?? 0) + 1;
      counts.set(role, next);
      if (next > this.maxChainRepeats) {
        for (const l of this.cycleListeners) l({ event, role, count: next });
        return;
      }
      const parentSeq = cursor.causedBy;
      const parent = parentSeq !== undefined ? this.bySeq.get(parentSeq) : undefined;
      cursor = parent && parent.kind === "message" ? (parent as BusEvent & MessageEvent) : undefined;
    }
  }
}
