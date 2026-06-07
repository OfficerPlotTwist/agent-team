import type { BroadcastEnvelope } from "./protocol.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A broadcast envelope before the ring buffer assigns its seq. */
export type UnstampedBroadcast = DistributiveOmit<BroadcastEnvelope, "seq">;

/** Fixed-capacity buffer of seq-stamped broadcasts; the resume-replay source. */
export class RingBuffer {
  readonly #capacity: number;
  readonly #items: BroadcastEnvelope[] = [];
  #nextSeq = 1;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be >= 1");
    this.#capacity = capacity;
  }

  /** Assign the next seq, store, return the stamped envelope. */
  stamp(partial: UnstampedBroadcast): BroadcastEnvelope {
    const env = { ...partial, seq: this.#nextSeq++ } as BroadcastEnvelope;
    this.#items.push(env);
    if (this.#items.length > this.#capacity) this.#items.shift();
    return env;
  }

  latestSeq(): number {
    return this.#nextSeq - 1;
  }

  /** Envelopes with seq > afterSeq, plus whether part of that range was dropped. */
  after(afterSeq: number): { items: BroadcastEnvelope[]; gapped: boolean } {
    const oldest = this.#items[0]?.seq ?? this.#nextSeq;
    const gapped = afterSeq + 1 < oldest && this.latestSeq() > afterSeq;
    return { items: this.#items.filter((e) => e.seq > afterSeq), gapped };
  }
}
