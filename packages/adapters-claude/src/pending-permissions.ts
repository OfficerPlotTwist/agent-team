import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

interface Entry {
  resolve: (r: PermissionResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Host-scoped registry mapping a globally-unique requestId to the resolver of a
 * blocked canUseTool call. Keyed (not single-slot) so concurrent adapters resolve
 * independently — the multi-agent seam, exercised at N=1 in B1.
 */
export class PendingPermissions {
  private readonly map = new Map<string, Entry>();

  /** Register a pending request. Resolves to deny if not resolved within timeoutMs. */
  register(requestId: string, timeoutMs: number): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.map.delete(requestId);
        resolve({ behavior: "deny", message: `Permission request ${requestId} timed out` });
      }, timeoutMs);
      this.map.set(requestId, { resolve, timer });
    });
  }

  has(requestId: string): boolean {
    return this.map.has(requestId);
  }

  /** Resolve a pending request. No-op if the id is unknown (e.g. merge_conflict). */
  resolve(requestId: string, result: PermissionResult): void {
    const entry = this.map.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.map.delete(requestId);
    entry.resolve(result);
  }
}
