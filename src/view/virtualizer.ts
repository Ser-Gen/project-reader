/**
 * Windowed list with measured, variable row heights.
 *
 * - heights live in a Fenwick tree -> O(log n) scroll<->index mapping
 * - only the visible window (+ overscan) exists in the DOM; rows are recycled
 * - measurement happens once per frame in a single read pass, then heights are
 *   patched and the scroll position is anchored so content above the viewport
 *   growing (images decoding, a row expanding) never yanks the view
 */

import { Fenwick } from './fenwick.js';

export interface VirtualizerOptions {
  scroller: HTMLElement;
  content: HTMLElement;
  estimate: (index: number) => number;
  render: (index: number, el: HTMLElement) => void;
  overscanPx?: number;
  onRange?: (start: number, end: number) => void;
}

export class Virtualizer {
  private readonly opts: VirtualizerOptions;
  private readonly heights = new Fenwick();
  private readonly mounted = new Map<number, HTMLElement>();
  private readonly pool: HTMLElement[] = [];
  private readonly ro: ResizeObserver;
  private readonly rowIndex = new WeakMap<Element, number>();

  private count = 0;
  private frame = 0;
  private viewport = 0;
  private start = 0;
  private end = -1;
  private adjusting = false;

  constructor(opts: VirtualizerOptions) {
    this.opts = opts;
    opts.scroller.addEventListener('scroll', this.onScroll, { passive: true });

    this.ro = new ResizeObserver((entries) => {
      // A mounted row changed size on its own (image decoded, font loaded).
      let dirty = false;
      for (const e of entries) {
        const i = this.rowIndex.get(e.target);
        if (i === undefined) continue;
        const h = (e.target as HTMLElement).offsetHeight;
        if (h > 0 && Math.abs(h - this.heights.height(i)) > 0.5) dirty = true;
      }
      if (dirty) this.schedule();
    });

    new ResizeObserver(() => {
      this.viewport = opts.scroller.clientHeight;
      this.schedule();
    }).observe(opts.scroller);
    this.viewport = opts.scroller.clientHeight;
  }

  /** (Re)build for a list of n rows, discarding all mounted DOM. */
  setCount(n: number): void {
    this.unmountAll();
    this.count = n;
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) h[i] = this.opts.estimate(i);
    this.heights.reset(h);
    this.start = 0;
    this.end = -1;
    this.opts.scroller.scrollTop = 0;
    this.sync();
  }

  /** Row i changed shape (expanded/collapsed): re-render and re-measure it. */
  invalidate(index: number): void {
    const el = this.mounted.get(index);
    if (el) {
      el.textContent = '';
      this.opts.render(index, el);
    } else {
      this.heights.set(index, this.opts.estimate(index));
    }
    this.schedule();
  }

  get range(): [number, number] {
    return [this.start, this.end];
  }

  offsetOf(index: number): number {
    return this.heights.offsetOf(index);
  }

  /** Total scrollable height, for painting anything alongside the scrollbar. */
  get totalHeight(): number {
    return this.heights.total;
  }

  scrollToIndex(index: number, padding = 12): void {
    const i = Math.max(0, Math.min(index, this.count - 1));
    this.opts.scroller.scrollTop = Math.max(0, this.heights.offsetOf(i) - padding);
    this.sync();
  }

  /** Index of the row occupying the top of the viewport. */
  topIndex(): number {
    return this.heights.indexAt(this.opts.scroller.scrollTop + 1);
  }

  destroy(): void {
    this.opts.scroller.removeEventListener('scroll', this.onScroll);
    this.ro.disconnect();
    this.unmountAll();
  }

  private onScroll = (): void => this.schedule();

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.sync();
    });
  }

  /** One frame: decide the window, mount/unmount, then measure. */
  private sync(): void {
    if (this.adjusting) return;
    const { scroller, content, overscanPx = 900 } = this.opts;
    if (this.count === 0) {
      content.style.height = '0px';
      return;
    }

    const scrollTop = scroller.scrollTop;
    const first = this.heights.indexAt(Math.max(0, scrollTop - overscanPx));
    const last = this.heights.indexAt(scrollTop + this.viewport + overscanPx);

    // Recycle rows that left the window.
    for (const [i, el] of this.mounted) {
      if (i < first || i > last) {
        this.ro.unobserve(el);
        el.remove();
        el.textContent = '';
        this.mounted.delete(i);
        if (this.pool.length < 64) this.pool.push(el);
      }
    }

    // Mount rows that entered it.
    const frag = document.createDocumentFragment();
    for (let i = first; i <= last; i++) {
      if (this.mounted.has(i)) continue;
      const el = this.pool.pop() ?? this.makeRow();
      el.style.transform = `translateY(${this.heights.offsetOf(i)}px)`;
      this.rowIndex.set(el, i);
      this.opts.render(i, el);
      this.mounted.set(i, el);
      this.ro.observe(el);
      frag.appendChild(el);
    }
    if (frag.childNodes.length) content.appendChild(frag);

    this.measure(first);

    // Reposition everything against the (possibly patched) height index.
    for (const [i, el] of this.mounted) {
      el.style.transform = `translateY(${this.heights.offsetOf(i)}px)`;
    }
    content.style.height = `${Math.round(this.heights.total)}px`;

    if (first !== this.start || last !== this.end) {
      this.start = first;
      this.end = last;
      this.opts.onRange?.(first, last);
    }
  }

  /**
   * Single batched read pass. Anchors on the first row at/after the viewport top
   * so that height corrections above it don't move the visible content.
   */
  private measure(first: number): void {
    const scroller = this.opts.scroller;
    const anchor = this.heights.indexAt(scroller.scrollTop + 1);
    const before = this.heights.offsetOf(anchor);

    let changed = false;
    for (const [i, el] of this.mounted) {
      const h = el.offsetHeight;
      if (h > 0 && Math.abs(h - this.heights.height(i)) > 0.5) {
        this.heights.set(i, h);
        changed = true;
      }
    }
    if (!changed) return;

    const after = this.heights.offsetOf(anchor);
    const delta = after - before;
    if (delta !== 0 && anchor >= first && scroller.scrollTop > 0) {
      this.adjusting = true;
      scroller.scrollTop += delta;
      this.adjusting = false;
    }
  }

  private makeRow(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'vrow';
    return el;
  }

  private unmountAll(): void {
    for (const [, el] of this.mounted) {
      this.ro.unobserve(el);
      el.remove();
    }
    this.mounted.clear();
    this.pool.length = 0;
    this.opts.content.textContent = '';
  }
}
