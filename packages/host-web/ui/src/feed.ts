import { prepare, layout } from "@chenglou/pretext";
import type { PreparedText } from "@chenglou/pretext";
import type { BusEvent } from "@agent-team/core";
import {
  makeGeometry, appendRows, resetRows, totalHeight, windowFor, isAtBottom,
} from "./virtualizer.js";

const FONT = '14px "Segoe UI"';
const LINE_HEIGHT = 20;
const ROW_PAD = 4;

function eventText(e: BusEvent): string {
  switch (e.kind) {
    case "message": return `${e.from}: ${e.text}`;
    case "tool_call": return `${e.from} → ${e.name}`;
    case "file_change": return `~ ${e.path}  (${e.from})`;
    case "action_request": return `? ${e.from} [${e.category}] ${e.summary}`;
    case "done": return `✓ ${e.from}: ${e.summary}`;
    case "error": return `✗ ${e.from}: ${e.message}`;
    default: return JSON.stringify(e);
  }
}

export class FeedPane {
  readonly #el: HTMLElement;
  readonly #spacer: HTMLElement;
  readonly #texts: string[] = [];
  readonly #kinds: string[] = [];
  readonly #prepared: PreparedText[] = [];
  readonly #geometry = makeGeometry(ROW_PAD);
  readonly #live = new Map<number, HTMLElement>();
  #stick = true;
  #dividerAt: number | null = null; // row index after which a "missed events" divider renders

  constructor(el: HTMLElement) {
    this.#el = el;
    this.#spacer = el.querySelector("#spacer") as HTMLElement;
    el.addEventListener("scroll", () => {
      this.#stick = isAtBottom(this.#geometry, el.scrollTop, el.clientHeight);
      this.#render();
    });
    new ResizeObserver(() => this.#relayout()).observe(el);
  }

  append(event: BusEvent): void {
    const text = eventText(event);
    const prepared = prepare(text, FONT); // prepare once per event; layout is the cheap call
    this.#texts.push(text);
    this.#kinds.push(event.kind);
    this.#prepared.push(prepared);
    appendRows(this.#geometry, [layout(prepared, this.#width(), LINE_HEIGHT).height]);
    this.#spacer.style.height = `${totalHeight(this.#geometry)}px`;
    if (this.#stick) this.#el.scrollTop = totalHeight(this.#geometry);
    this.#render();
  }

  /** Resume gap fell out of the ring buffer — mark the seam in the feed. */
  markGap(): void {
    this.#dividerAt = this.#texts.length - 1;
    this.#render();
  }

  #width(): number {
    return Math.max(50, this.#el.clientWidth - 32);
  }

  #relayout(): void {
    const w = this.#width();
    resetRows(this.#geometry, this.#prepared.map((p) => layout(p, w, LINE_HEIGHT).height));
    this.#spacer.style.height = `${totalHeight(this.#geometry)}px`;
    for (const [, el] of this.#live) el.remove();
    this.#live.clear();
    if (this.#stick) this.#el.scrollTop = totalHeight(this.#geometry);
    this.#render();
  }

  #render(): void {
    const { i0, i1 } = windowFor(this.#geometry, this.#el.scrollTop, this.#el.clientHeight);
    for (const [i, el] of this.#live) {
      if (i < i0 || i > i1) {
        el.remove();
        this.#live.delete(i);
      }
    }
    for (let i = i0; i <= i1; i++) {
      const existing = this.#live.get(i);
      if (existing) {
        existing.style.top = `${this.#geometry.offsets[i]}px`;
        continue;
      }
      const row = document.createElement("div");
      row.className = `row kind-${this.#kinds[i]}${i % 2 ? " alt" : ""}`;
      row.style.top = `${this.#geometry.offsets[i]}px`;
      row.style.height = `${this.#geometry.heights[i]}px`;
      row.textContent = this.#texts[i]!;
      if (this.#dividerAt === i) {
        const div = document.createElement("div");
        div.className = "divider";
        div.textContent = "⚠ missed events (ring buffer overflow)";
        div.style.top = `${this.#geometry.offsets[i]}px`;
        this.#spacer.after(div);
      }
      this.#spacer.after(row);
      this.#live.set(i, row);
    }
  }
}
