/**
 * The analytics dock: tabs, event delegation, and the bridge back to the reader.
 *
 * It stays collapsed by default so the reader's first paint is unchanged (D4).
 * Selection is bidirectional: clicking a metric row filters and scrolls the
 * timeline, and the timeline tells the dock which phase you are looking at.
 */

import type { MetricOptions, OpRow, SessionMetrics } from '../../model/metrics.js';
import { renderCompare } from './compare.js';
import { defaultOpsView, renderOps, type OpsView, type OpSort } from './ops.js';
import { renderOverview } from './overview.js';
import { renderPhases } from './phases.js';
import { renderPlan } from './plan.js';
import { renderQuality } from './quality.js';

export type DockTab = 'overview' | 'ops' | 'phases' | 'plan' | 'quality' | 'compare';

const TABS: { key: DockTab; label: string }[] = [
  { key: 'overview', label: 'overview' },
  { key: 'ops', label: 'operations' },
  { key: 'phases', label: 'phases' },
  { key: 'plan', label: 'plan' },
  { key: 'quality', label: 'quality' },
  { key: 'compare', label: 'compare' },
];

export interface DockHooks {
  /** show only these events in the timeline; null clears the pin */
  focus: (idxs: number[] | null, label: string) => void;
  scrollTo: (idx: number) => void;
  /** timestamp of the event currently at the top of the timeline */
  topTs: () => number;
  setOptions: (patch: Partial<MetricOptions>) => void;
  chooseCompare: (id: string) => void;
  sessionChoices: () => { id: string; title: string }[];
  exportReport: () => void;
}

export class Dock {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly hooks: DockHooks;
  private metrics: SessionMetrics | null = null;
  private other: SessionMetrics | null = null;
  private tab: DockTab = 'overview';
  private opsView: OpsView = defaultOpsView();

  constructor(root: HTMLElement, hooks: DockHooks) {
    this.root = root;
    this.hooks = hooks;
    root.innerHTML =
      `<div id="dockgrip" class="dockgrip" title="drag the dock wider or narrower"></div>` +
      `<header class="dhead">` +
      `<div class="dtabbar">${TABS.map(
        (t) => `<button class="dt" data-tab="${t.key}">${t.label}</button>`,
      ).join('')}</div>` +
      `<div class="dtools">` +
      `<button class="ghost sm" data-act="export" title="copy a Markdown report to the clipboard">report</button>` +
      `<button class="ghost sm" data-act="collapse" title="hide the analytics dock">›</button>` +
      `</div></header>` +
      `<div class="dbody"></div>`;
    this.body = root.querySelector('.dbody') as HTMLElement;
    root.addEventListener('click', this.onClick);
    root.addEventListener('change', this.onChange);
    this.paintTabs();
  }

  get open(): boolean {
    return !this.root.classList.contains('collapsed');
  }

  setOpen(on: boolean): void {
    this.root.classList.toggle('collapsed', !on);
    if (on) this.render();
  }

  setTab(tab: DockTab): void {
    this.tab = tab;
    this.paintTabs();
    this.render();
  }

  setMetrics(m: SessionMetrics | null): void {
    const changedSession = m?.key !== this.metrics?.key;
    this.metrics = m;
    if (changedSession) this.opsView = defaultOpsView();
    this.render();
  }

  setCompare(m: SessionMetrics | null): void {
    this.other = m;
    if (m) this.setTab('compare');
    else this.render();
  }

  private paintTabs(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>('.dt')) {
      el.classList.toggle('on', el.dataset.tab === this.tab);
    }
  }

  render(): void {
    if (!this.open) return;
    const m = this.metrics;
    if (!m) {
      this.body.innerHTML = `<p class="dempty">Open a session to see its numbers.</p>`;
      return;
    }
    switch (this.tab) {
      case 'overview':
        this.body.innerHTML = renderOverview(m);
        break;
      case 'ops':
        this.body.innerHTML = renderOps(m.ops, this.opsView);
        break;
      case 'phases':
        this.body.innerHTML = renderPhases(m.phases);
        break;
      case 'plan':
        this.body.innerHTML = renderPlan(m.plan, m.improvements);
        break;
      case 'quality':
        this.body.innerHTML = renderQuality(m.quality);
        break;
      case 'compare':
        this.body.innerHTML = renderCompare(m, this.other, this.hooks.sessionChoices());
        break;
    }
  }

  /** Find a row anywhere in the current grouping, including its drill-downs. */
  private findRow(key: string): OpRow | undefined {
    const walk = (rows: OpRow[]): OpRow | undefined => {
      for (const r of rows) {
        if (r.key === key) return r;
        const hit = r.subgroups && walk(r.subgroups);
        if (hit) return hit;
      }
      return undefined;
    };
    const m = this.metrics;
    if (!m) return undefined;
    return walk(m.ops.byName) ?? walk(m.ops.byCategory);
  }

  private onClick = (e: MouseEvent): void => {
    const el = e.target as HTMLElement;
    const tab = el.closest<HTMLElement>('.dt')?.dataset.tab as DockTab | undefined;
    if (tab) {
      this.setTab(tab);
      return;
    }
    const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'collapse') {
      this.setOpen(false);
      return;
    }
    if (act === 'export') {
      this.hooks.exportReport();
      return;
    }

    const focusKey = el.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey;
    if (focusKey) {
      const row = this.findRow(focusKey);
      if (row) this.hooks.focus(row.idxs, `${row.label} · ${row.calls} calls`);
      return;
    }
    const focusCat = el.closest<HTMLElement>('[data-focus]')?.dataset.focus;
    if (focusCat) {
      const row = this.metrics?.ops.byCategory.find((r) => r.key === focusCat);
      if (row) this.hooks.focus(row.idxs, `${row.label} · ${row.calls} calls`);
      return;
    }

    const sort = el.closest<HTMLElement>('[data-sort]')?.dataset.sort as OpSort | undefined;
    if (sort) {
      this.opsView.sort = sort;
      this.render();
      return;
    }
    const group = el.closest<HTMLElement>('[data-group]')?.dataset.group;
    if (group === 'name' || group === 'category') {
      this.opsView.grouping = group;
      this.render();
      return;
    }
    const orow = el.closest<HTMLElement>('.orow');
    if (orow?.dataset.key) {
      const key = orow.dataset.key;
      if (this.opsView.expanded.has(key)) this.opsView.expanded.delete(key);
      else this.opsView.expanded.add(key);
      this.render();
      return;
    }

    const bound = el.closest<HTMLElement>('[data-bound]')?.dataset.bound;
    if (bound) {
      const ts = this.hooks.topTs();
      if (ts) this.hooks.setOptions({ overrides: { [bound]: ts } });
      return;
    }
    const reset = el.closest<HTMLElement>('[data-bound-reset]')?.dataset.boundReset;
    if (reset) {
      this.hooks.setOptions({ overrides: { [reset]: undefined } });
      return;
    }
    const episode = el.closest<HTMLElement>('[data-episode]')?.dataset.episode;
    if (episode) {
      this.hooks.setOptions({ episode: Number(episode) });
      return;
    }

    const ev = el.closest<HTMLElement>('[data-ev]')?.dataset.ev;
    if (ev) this.hooks.scrollTo(Number(ev));
  };

  private onChange = (e: Event): void => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLSelectElement && el.dataset.compare !== undefined) {
      this.hooks.chooseCompare(el.value);
      return;
    }
    if (el instanceof HTMLInputElement && el.dataset.main !== undefined) {
      this.opsView.mainThreadOnly = el.checked;
      this.hooks.setOptions({ mainThreadOnly: el.checked });
    }
  };
}
