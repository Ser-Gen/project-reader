/**
 * The chronological pane: filtering, fold/expand state, phase markers, the token
 * gutter, and the bridge between the virtualizer and the row renderer.
 */

import type { CanonEvent, CanonSession } from '../model/canon.js';
import { matchesFilter, type Category } from './kinds.js';
import { renderRow, type RowScale } from './rows.js';
import { Virtualizer } from './virtualizer.js';
import { escapeHtml } from './markdown.js';

const HEADER_H = 34; // a folded row is just its header

export interface Marker {
  label: string;
  kind: 'phase' | 'plan' | 'compaction';
}

export interface TimelineHooks {
  /** fetch the untruncated body of an event whose inline copy was clipped */
  fetchBody: (idx: number) => Promise<string>;
  onImage: (src: string) => void;
  /** the event currently at the top of the viewport changed */
  onTop: (topEventIdx: number) => void;
}

export class Timeline {
  private readonly virt: Virtualizer;
  private readonly hooks: TimelineHooks;
  private readonly gutter?: HTMLCanvasElement;

  private events: CanonEvent[] = [];
  /** row position -> event index (filtering lives here, never in the DOM) */
  private view: number[] = [];
  private rowOf = new Map<number, number>();
  private folded = new Set<number>();
  private full = new Set<number>();
  private cache = new Map<string, string>();
  private pendingBody = new Set<number>();
  private markers = new Map<number, Marker[]>();
  private scale: RowScale = { costP90: 0, msP90: 0 };

  showSystem = false;
  /** empty = no type filter; otherwise keep events matching any selected category */
  private filter: ReadonlySet<Category> = new Set();
  private flashIdx = -1;

  private lastTop = -1;
  private topFrame = 0;

  constructor(scroller: HTMLElement, content: HTMLElement, hooks: TimelineHooks, gutter?: HTMLCanvasElement) {
    this.hooks = hooks;
    this.gutter = gutter;
    this.virt = new Virtualizer({
      scroller,
      content,
      estimate: (row) => this.estimate(row),
      render: (row, el) => this.renderInto(row, el),
    });
    content.addEventListener('click', this.onClick);
    // Sidebar highlighting is derived from the virtualizer's index, so tracking
    // it costs one O(log n) lookup per frame instead of an observer per row.
    scroller.addEventListener('scroll', this.trackTop, { passive: true });
  }

  private trackTop = (): void => {
    if (this.topFrame) return;
    this.topFrame = requestAnimationFrame(() => {
      this.topFrame = 0;
      const ev = this.topEvent();
      if (ev !== this.lastTop) {
        this.lastTop = ev;
        this.hooks.onTop(ev);
      }
    });
  };

  setSession(session: CanonSession): void {
    this.events = session.events;
    this.folded = new Set(session.events.filter((e) => e.collapsed).map((e) => e.idx));
    this.full.clear();
    this.cache.clear();
    this.markers.clear();
    this.scale = computeScale(session.events);
    this.rebuild();
  }

  /** Phase boundaries, plan revisions and compactions, keyed by event index. */
  setMarkers(markers: Map<number, Marker[]>): void {
    this.markers = markers;
    this.cache.clear();
    this.rebuildKeepingPlace();
  }

  setShowSystem(on: boolean): void {
    if (this.showSystem === on) return;
    this.showSystem = on;
    this.rebuildKeepingPlace();
  }

  /** Show only the given categories; an empty set means "everything". */
  setFilter(filter: ReadonlySet<Category>): void {
    this.filter = new Set(filter);
    this.rebuildKeepingPlace();
  }

  /** Restrict the view to an explicit set of events (a metric drill-down). */
  private pinned: ReadonlySet<number> | null = null;

  setPinned(idxs: ReadonlySet<number> | null): void {
    this.pinned = idxs;
    this.rebuildKeepingPlace();
  }

  get pinnedCount(): number {
    return this.pinned?.size ?? 0;
  }

  /** How many rows the current filter leaves visible. */
  get visibleCount(): number {
    return this.view.length;
  }

  /** Rebuild the view, then land back on whatever was at the top of the viewport. */
  private rebuildKeepingPlace(): void {
    const anchor = this.topEvent();
    this.rebuild();
    this.scrollToEvent(anchor, false);
  }

  private rebuild(): void {
    this.view = [];
    this.rowOf.clear();
    for (const e of this.events) {
      if (this.pinned) {
        if (!this.pinned.has(e.idx)) continue;
      } else {
        if (!this.showSystem && e.kind === 'system') continue;
        if (!matchesFilter(e, this.filter)) continue;
      }
      this.rowOf.set(e.idx, this.view.length);
      this.view.push(e.idx);
    }
    this.virt.setCount(this.view.length);
    this.lastTop = -1;
    this.trackTop();
    this.paintGutter();
  }

  /** Event index currently at the top of the viewport. */
  topEvent(): number {
    return this.view[this.virt.topIndex()] ?? 0;
  }

  scrollToEvent(evIdx: number, flash = true): void {
    let row = this.rowOf.get(evIdx);
    if (row === undefined) {
      // Hidden by the current filter: land on the nearest visible neighbour,
      // looking forward first and then back, so a filter that removes the tail
      // of the timeline still leaves us somewhere sensible.
      for (let i = evIdx + 1; i < this.events.length && row === undefined; i++) row = this.rowOf.get(i);
      for (let i = evIdx - 1; i >= 0 && row === undefined; i--) row = this.rowOf.get(i);
    }
    if (row === undefined) return;
    this.virt.scrollToIndex(row);
    this.trackTop();
    if (flash) {
      this.flashIdx = this.view[row];
      this.virt.invalidate(row);
      setTimeout(() => {
        const was = this.flashIdx;
        this.flashIdx = -1;
        const r = this.rowOf.get(was);
        if (r !== undefined) this.virt.invalidate(r);
      }, 1200);
    }
  }

  private estimate(row: number): number {
    const ev = this.events[this.view[row]];
    if (!ev) return HEADER_H;
    const extra = this.markers.has(ev.idx) ? 30 : 0;
    if (this.folded.has(ev.idx)) return HEADER_H + extra;
    if (!this.full.has(ev.idx)) return Math.min(ev.est, 420) + extra;
    return ev.est + extra;
  }

  private renderInto(row: number, el: HTMLElement): void {
    const evIdx = this.view[row];
    const ev = this.events[evIdx];
    if (!ev) return;
    const open = !this.folded.has(evIdx);
    const isFull = this.full.has(evIdx);
    const key = `${evIdx}:${open ? 1 : 0}:${isFull ? 1 : 0}:${ev.body.length}`;
    let html = this.cache.get(key);
    if (html === undefined) {
      html = markerHtml(this.markers.get(evIdx)) + renderRow(ev, open, isFull, this.scale);
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, html);
    }
    el.innerHTML = html;
    el.classList.toggle('flash', this.flashIdx === evIdx);
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const img = target.closest('img.shot') as HTMLImageElement | null;
    if (img) {
      this.hooks.onImage(img.src);
      return;
    }
    const art = target.closest('article.ev') as HTMLElement | null;
    if (!art) return;
    const idx = Number(art.dataset.idx);
    const act = (target.closest('[data-act]') as HTMLElement | null)?.dataset.act;

    if (act === 'expand') {
      this.full.add(idx);
      const ev = this.events[idx];
      if (ev.more && !this.pendingBody.has(idx)) {
        this.pendingBody.add(idx);
        void this.hooks.fetchBody(idx).then((text) => {
          this.pendingBody.delete(idx);
          if (text) {
            ev.body = text;
            ev.more = false;
            ev.est = Math.round(56 + Math.min((text.length / 90) * 21, 40000));
          }
          this.refresh(idx);
        });
      }
      this.refresh(idx);
      return;
    }
    if (act === 'collapse') {
      this.full.delete(idx);
      this.refresh(idx);
      return;
    }
    if (act === 'fold') {
      if (this.folded.has(idx)) this.folded.delete(idx);
      else {
        this.folded.add(idx);
        this.full.delete(idx);
      }
      this.refresh(idx);
    }
  };

  private refresh(evIdx: number): void {
    const row = this.rowOf.get(evIdx);
    if (row !== undefined) this.virt.invalidate(row);
  }

  /** Anything foldable open/closed in bulk — used by the "expand all" control. */
  setAllFolded(folded: boolean): void {
    if (folded) {
      this.folded = new Set(
        this.events
          .filter(
            (e) =>
              e.kind === 'reasoning' ||
              e.kind === 'op' ||
              e.kind === 'notice' ||
              e.kind === 'error' ||
              e.kind === 'compaction',
          )
          .map((e) => e.idx),
      );
      this.full.clear();
    } else {
      this.folded.clear();
    }
    this.cache.clear();
    const anchor = this.topEvent();
    this.virt.setCount(this.view.length);
    this.scrollToEvent(anchor, false);
  }

  /**
   * The token gutter: cumulative operation cost down the session, painted once
   * per rebuild so an expensive stretch is visible as a shape before you scroll
   * to it.
   */
  paintGutter(): void {
    const c = this.gutter;
    if (!c) return;
    const w = c.clientWidth || 8;
    const h = c.clientHeight || 0;
    if (!h) return;
    const dpr = Math.min(2, self.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.view.length) return;

    const total = this.virt.totalHeight || 1;
    const bins = new Float64Array(h);
    for (let row = 0; row < this.view.length; row++) {
      const ev = this.events[this.view[row]];
      if (!ev || ev.kind !== 'op') continue;
      const cost = (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);
      if (!cost) continue;
      const y = Math.min(h - 1, Math.max(0, Math.floor((this.virt.offsetOf(row) / total) * h)));
      bins[y] += cost;
    }
    let max = 0;
    for (const v of bins) if (v > max) max = v;
    if (!max) return;
    ctx.fillStyle = getComputedStyle(c).color || '#6ea8fe';
    for (let y = 0; y < h; y++) {
      if (!bins[y]) continue;
      ctx.globalAlpha = 0.35 + 0.65 * (bins[y] / max);
      ctx.fillRect(w - Math.max(1, (bins[y] / max) * w), y, Math.max(1, (bins[y] / max) * w), 1);
    }
    ctx.globalAlpha = 1;
  }
}

function markerHtml(markers: Marker[] | undefined): string {
  if (!markers?.length) return '';
  return markers
    .map((m) => `<div class="mk mk-${m.kind}"><span>${escapeHtml(m.label)}</span></div>`)
    .join('');
}

/** p90 of operation cost and duration — the threshold for "expensive". */
function computeScale(events: readonly CanonEvent[]): RowScale {
  const costs: number[] = [];
  const times: number[] = [];
  for (const ev of events) {
    if (ev.kind !== 'op') continue;
    const cost = (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);
    if (cost) costs.push(cost);
    if (ev.durationMs !== undefined && ev.durationSource !== 'unknown') times.push(ev.durationMs);
  }
  const p90 = (arr: number[]) => {
    if (arr.length < 10) return 0;
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.9)];
  };
  return { costP90: p90(costs), msP90: p90(times) };
}
