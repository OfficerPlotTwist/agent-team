import type { RequestCategory } from "@agent-team/core";
import type { UnstampedBroadcast } from "./ring-buffer.js";

export interface GateBridgeOptions {
  broadcast: (env: UnstampedBroadcast) => void;
  /** How long pending gates survive with zero connected clients before denying. */
  graceMs?: number;
}

/**
 * Browser counterpart of ControlRoomPanel's gate semantics: requestId-keyed
 * pending map, first allow/deny wins, FAIL CLOSED when nobody is connected
 * to answer (panel dispose ⇒ deny becomes zero-clients + grace ⇒ deny).
 */
export class GateBridge {
  readonly #broadcast: (env: UnstampedBroadcast) => void;
  readonly #graceMs: number;
  readonly #pending = new Map<string, (allow: boolean) => void>();
  #clients = 0;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GateBridgeOptions) {
    this.#broadcast = opts.broadcast;
    this.#graceMs = opts.graceMs ?? 5_000;
  }

  askGate(req: { requestId: string; category: RequestCategory; summary: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pending.set(req.requestId, resolve);
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
    const resolve = this.#pending.get(cmd.requestId);
    if (!resolve) return;
    this.#pending.delete(cmd.requestId);
    resolve(cmd.type === "allow");
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

  /** Fail closed: pending gates with no one to answer deny after the grace window. */
  #armGraceIfOrphaned(): void {
    if (this.#clients > 0 || this.#pending.size === 0 || this.#graceTimer !== null) return;
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = null;
      for (const [id, resolve] of this.#pending) {
        resolve(false);
        this.#broadcast({ type: "gate_resolved", requestId: id, allowed: false });
      }
      this.#pending.clear();
    }, this.#graceMs);
  }
}
