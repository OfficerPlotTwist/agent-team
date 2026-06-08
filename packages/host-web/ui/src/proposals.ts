import type { AmbientProposal } from "@agent-team/core";
import type { ClientCommand } from "../../src/protocol.js";

export class ProposalsPane {
  readonly #list: HTMLElement;
  readonly #diff: HTMLPreElement;
  readonly #send: (cmd: ClientCommand) => void;
  readonly #outcomes = new Map<string, { text: string; ok: boolean }>();

  constructor(root: HTMLElement, send: (cmd: ClientCommand) => void) {
    this.#list = root.querySelector("#proposal-list") as HTMLElement;
    this.#diff = root.querySelector("#proposal-diff") as HTMLPreElement;
    this.#send = send;
    (root.querySelector("#proposals-refresh") as HTMLButtonElement).onclick = () =>
      this.#send({ type: "proposal_refresh" });
  }

  render(items: AmbientProposal[]): void {
    this.#list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "proposal";
      empty.textContent = "no pending proposals";
      this.#list.appendChild(empty);
      return;
    }
    for (const p of items) {
      const row = document.createElement("div");
      row.className = "proposal";
      const branch = document.createElement("div");
      branch.className = "branch";
      branch.textContent = `${p.branch} (${p.commitCount} commit${p.commitCount === 1 ? "" : "s"})`;
      branch.onclick = () => this.#send({ type: "proposal_show", branch: p.branch });
      const finding = document.createElement("div");
      finding.className = "finding";
      finding.textContent = p.finding || "(no finding trailer)";
      const actions = document.createElement("div");
      actions.className = "actions";
      const accept = document.createElement("button");
      accept.textContent = "Accept";
      accept.onclick = () => this.#send({ type: "proposal_accept", branch: p.branch });
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      reject.onclick = () => this.#send({ type: "proposal_reject", branch: p.branch });
      actions.append(accept, reject);
      row.append(branch, finding, actions);
      const prior = this.#outcomes.get(p.branch);
      if (prior) row.appendChild(this.#outcomeEl(prior));
      this.#list.appendChild(row);
    }
  }

  showDiff(branch: string, diff: string): void {
    this.#diff.hidden = false;
    this.#diff.textContent = `# ${branch}\n${diff}`;
  }

  outcome(branch: string, outcome: { status: string; files?: string[] }): void {
    const ok = outcome.status === "merged" || outcome.status === "rejected";
    const text =
      outcome.status === "conflict"
        ? `conflict: ${(outcome.files ?? []).join(", ")} — branch left intact`
        : outcome.status;
    this.#outcomes.set(branch, { text, ok });
    const note = document.createElement("div");
    note.append(this.#outcomeEl({ text, ok }));
    this.#list.prepend(note); // visible even after the row disappears from a refreshed list
  }

  #outcomeEl(o: { text: string; ok: boolean }): HTMLElement {
    const el = document.createElement("div");
    el.className = `outcome ${o.ok ? "ok" : "bad"}`;
    el.textContent = o.text;
    return el;
  }
}
