/** Pure feed-window math (offsets, window, stick-to-bottom). No DOM, node-testable. */
export interface FeedGeometry {
  heights: number[];
  /** offsets[i] = content top of row i; offsets[n] = total content height. */
  offsets: number[];
  rowPad: number;
}

export function makeGeometry(rowPad: number): FeedGeometry {
  return { heights: [], offsets: [0], rowPad };
}

export function appendRows(g: FeedGeometry, newHeights: number[]): void {
  for (const h of newHeights) {
    g.heights.push(h);
    g.offsets.push(g.offsets[g.offsets.length - 1]! + h + g.rowPad);
  }
}

/** Rebuild all rows in place (container resize re-measure). */
export function resetRows(g: FeedGeometry, heights: number[]): void {
  g.heights.length = 0;
  g.offsets.length = 1;
  appendRows(g, heights);
}

export function totalHeight(g: FeedGeometry): number {
  return g.offsets[g.offsets.length - 1]!;
}

export function firstVisible(g: FeedGeometry, scrollTop: number): number {
  let lo = 0;
  let hi = g.heights.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.offsets[mid + 1]! <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function windowFor(
  g: FeedGeometry,
  scrollTop: number,
  viewport: number,
  overscan = 5,
): { i0: number; i1: number } {
  const n = g.heights.length;
  if (n === 0) return { i0: 0, i1: -1 };
  const i0 = Math.max(0, firstVisible(g, scrollTop) - overscan);
  let i1 = i0;
  const bottom = scrollTop + viewport;
  while (i1 < n && g.offsets[i1]! < bottom) i1++;
  return { i0, i1: Math.min(n - 1, i1 + overscan) };
}

/** Sticky iff scrolled to (near) the bottom; scrolling up un-sticks. */
export function isAtBottom(g: FeedGeometry, scrollTop: number, viewport: number, slack = 4): boolean {
  return scrollTop + viewport >= totalHeight(g) - slack;
}
