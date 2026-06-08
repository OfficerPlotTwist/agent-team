import type { RequestCategory } from "@agent-team/core";

export class GatesPane {
  readonly #el: HTMLElement;
  readonly #send: (cmd: { type: "allow" | "deny"; requestId: string }) => void;
  readonly #rows = new Map<string, HTMLElement>();

  constructor(el: HTMLElement, send: (cmd: { type: "allow" | "deny"; requestId: string }) => void) {
    this.#el = el;
    this.#send = send;
  }

  add(gate: { requestId: string; category: RequestCategory; summary: string }): void {
    if (this.#rows.has(gate.requestId)) return;
    const row = document.createElement("div");
    row.className = "gate";
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = gate.category;
    const summary = document.createElement("span");
    summary.className = "summary";
    summary.textContent = gate.summary;
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    allow.onclick = () => this.#send({ type: "allow", requestId: gate.requestId });
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.onclick = () => this.#send({ type: "deny", requestId: gate.requestId });
    row.append(cat, summary, allow, deny);
    this.#el.appendChild(row);
    this.#rows.set(gate.requestId, row);
  }

  /** gate_resolved covers multi-tab races: whoever resolves, every tab clears. */
  resolve(requestId: string): void {
    this.#rows.get(requestId)?.remove();
    this.#rows.delete(requestId);
  }
}
