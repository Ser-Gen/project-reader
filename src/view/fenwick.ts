/**
 * Fenwick (binary indexed) tree over row heights.
 *
 * Gives O(log n) `offsetOf(index)` and `indexAt(pixel)` with O(log n) updates,
 * so measuring a row mid-scroll never costs a full prefix-sum rebuild and
 * jumping to row 400_000 is as cheap as jumping to row 3.
 */
export class Fenwick {
  private n = 0;
  private tree = new Float64Array(1);
  private raw = new Float64Array(1);

  constructor(heights?: ArrayLike<number>) {
    if (heights) this.reset(heights);
  }

  get size(): number {
    return this.n;
  }

  reset(heights: ArrayLike<number>): void {
    const n = heights.length;
    this.n = n;
    this.raw = new Float64Array(n);
    const tree = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      this.raw[i] = heights[i];
      tree[i + 1] += heights[i];
      const parent = i + 1 + ((i + 1) & -(i + 1));
      if (parent <= n) tree[parent] += tree[i + 1];
    }
    this.tree = tree;
  }

  height(i: number): number {
    return this.raw[i];
  }

  set(i: number, value: number): void {
    const delta = value - this.raw[i];
    if (delta === 0) return;
    this.raw[i] = value;
    for (let k = i + 1; k <= this.n; k += k & -k) this.tree[k] += delta;
  }

  /** Sum of heights of rows [0, i). */
  offsetOf(i: number): number {
    let s = 0;
    for (let k = Math.min(i, this.n); k > 0; k -= k & -k) s += this.tree[k];
    return s;
  }

  get total(): number {
    return this.offsetOf(this.n);
  }

  /** Largest index whose offset is <= px (i.e. the row containing that pixel). */
  indexAt(px: number): number {
    if (px <= 0) return 0;
    let idx = 0;
    let remaining = px;
    let step = 1 << (31 - Math.clz32(Math.max(this.n, 1)));
    for (; step > 0; step >>= 1) {
      const next = idx + step;
      if (next <= this.n && this.tree[next] <= remaining) {
        idx = next;
        remaining -= this.tree[next];
      }
    }
    return Math.min(idx, this.n - 1);
  }
}
