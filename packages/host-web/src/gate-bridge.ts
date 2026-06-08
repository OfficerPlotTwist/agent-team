import type { RequestCategory } from "@agent-team/core";
import type { UnstampedBroadcast } from "./ring-buffer.js";

export interface GateBridgeOptions {
  broadcast: (env: UnstampedBroadcast) => void;
  /** How long pending gates survive with zero connected clients before denying. */
  graceMs?: number;
}

interface PendingGate {
  resolve: (allow: boolean) => void;
  /** Per-gate expiry mirroring the adapter's permTimeoutMs (null ⇒ none). */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Stop a timer from holding the event loop open; the http server owns liveness. */
function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * Browser counterpart of ControlRoomPanel's gate semantics: requestId-keyed
 * pending map, first allow/deny wins, FAIL CLOSED two ways — (1) zero clients +
 * grace ⇒ deny; (2) a per-gate timeout mirroring the adapter's permTimeoutMs ⇒
 * deny AND broadcast gate_resolved. Without (2), the adapter times the request
 * out silently while this gate stays pending, so a late click would resolve an
 * orphaned gate the adapter already denied — UI/decision divergence. (2) makes
 * this bridge the authoritative source of the gate's resolution for the UI.
 */
export class GateBridge {
  readonly #broadcast: (env: UnstampedBroadcast) => void;
  readonly #graceMs: number;
  readonly #pending = new Map<string, PendingGate>();
  #clients = 0;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GateBridgeOptions) {
    this.#broadcast = opts.broadcast;
    this.#graceMs = opts.graceMs ?? 5_000;
  }

  askGate(req: {
    requestId: string;
    category: RequestCategory;
    summary: string;
    /** Adapter permission timeout; on lapse this bridge denies + broadcasts. */
    timeoutMs?: number;
  }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer =
        req.timeoutMs != null && req.timeoutMs > 0
          ? unref(setTimeout(() => this.#expire(req.requestId), req.timeoutMs))
          : null;
      this.#pending.set(req.requestId, { resolve, timer });
      this.#broadcast({
        type: "gate",
        requestId: req.requestId,
        category: req.category,
        summary: req.summary,
      });
      this.#armGraceIfOrphaned();
    });
  }

  /** First allow/deny wins; later commands for the same id are ignored. */
  command(cmd: { type: "allow" | "deny"; requestId: string }): void {
    const entry = this.#pending.get(cmd.requestId);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.#pending.delete(cmd.requestId);
    entry.resolve(cmd.type === "allow");
    this.#broadcast({ type: "gate_resolved", requestId: cmd.requestId, allowed: cmd.type === "allow" });
  }

  clientConnected(): void {
    this.#clients++;
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  clientDisconnected(): void {
    this.#clients = Math.max(0, this.#clients - 1);
    this.#armGraceIfOrphaned();
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  /** Per-gate timeout fired: nobody answered in time → deny and tell the UI. */
  #expire(requestId: string): void {
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    this.#pending.delete(requestId); // timer already fired; nothing to clear
    entry.resolve(false);
    this.#broadcast({ type: "gate_resolved", requestId, allowed: false });
  }

  /** Fail closed: pending gates with no one to answer deny after the grace window. */
  #armGraceIfOrphaned(): void {
    if (this.#clients > 0 || this.#pending.size === 0 || this.#graceTimer !== null) return;
    this.#graceTimer = unref(
      setTimeout(() => {
        this.#graceTimer = null;
        for (const [id, entry] of this.#pending) {
          if (entry.timer !== null) clearTimeout(entry.timer);
          entry.resolve(false);
          this.#broadcast({ type: "gate_resolved", requestId: id, allowed: false });
        }
        this.#pending.clear();
      }, this.#graceMs),
    );
  }
}
