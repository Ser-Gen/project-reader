/**
 * The operations table (SPEC §6.1): calls, failures, time and context cost per
 * tool, with drill-down into command heads, file extensions, paths and domains.
 *
 * Two tabs: by tool name (what you ran) and by canonical category (the only
 * grouping that compares fairly across agents).
 */

import type { OpRow, OpStats } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { msHuman, tokensHuman } from '../rows.js';
import { empty } from './fmt.js';

export type OpSort = 'calls' | 'time' | 'tokens' | 'fail' | 'name';

export interface OpsView {
  grouping: 'name' | 'category';
  sort: OpSort;
  expanded: Set<string>;
  mainThreadOnly: boolean;
}

export const defaultOpsView = (): OpsView => ({
  grouping: 'name',
  sort: 'calls',
  expanded: new Set(),
  mainThreadOnly: false,
});

function sortRows(rows: OpRow[], sort: OpSort): OpRow[] {
  const copy = [...rows];
  switch (sort) {
    case 'time':
      return copy.sort((a, b) => b.totalMs - a.totalMs);
    case 'tokens':
      return copy.sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
    case 'fail':
      return copy.sort((a, b) => failRate(b) - failRate(a) || b.calls - a.calls);
    case 'name':
      return copy.sort((a, b) => a.label.localeCompare(b.label));
    default:
      return copy.sort((a, b) => b.calls - a.calls);
  }
}

function failRate(r: OpRow): number {
  return r.calls ? (r.error + r.interrupted + r.unpaired) / r.calls : 0;
}

function rowHtml(r: OpRow, view: OpsView, depth: number): string {
  const open = view.expanded.has(r.key);
  const failed = r.error + r.interrupted + r.unpaired;
  const bad = failed ? `<span class="bad" title="${r.error} errors, ${r.interrupted} interrupted, ${r.unpaired} never answered">${failed}</span>` : '';
  const dur = r.timedCalls
    ? `${r.shared ? '≤' : ''}${msHuman(r.totalMs)}`
    : '<span class="na" title="no call had a usable duration">—</span>';
  const med = r.timedCalls ? msHuman(r.medianMs) : '—';
  const p95 = r.timedCalls ? msHuman(r.p95Ms) : '—';
  const cost = r.tokensIn + r.tokensOut;

  const head =
    `<tr class="orow d${depth}${open ? ' open' : ''}" data-key="${escapeHtml(r.key)}" data-first="${r.firstIdx}">` +
    `<td class="nm">${r.subgroups?.length ? `<span class="tw">${open ? '▾' : '▸'}</span>` : '<span class="tw"></span>'}` +
    `<button class="lnk" data-focus-key="${escapeHtml(r.key)}" title="show only these in the timeline">${escapeHtml(r.label)}</button></td>` +
    `<td class="n">${r.calls}${bad}</td>` +
    `<td class="n" title="${r.timedCalls} of ${r.calls} calls timed">${dur}</td>` +
    `<td class="n">${med}</td>` +
    `<td class="n">${p95}</td>` +
    `<td class="n" title="estimated tokens this row put into the conversation">~${tokensHuman(cost)}</td>` +
    `<td class="n"><span class="sh" style="--w:${(r.share * 100).toFixed(1)}%">${Math.round(r.share * 100)}%</span></td>` +
    `</tr>`;

  if (!open || !r.subgroups?.length) return head;
  return head + sortRows(r.subgroups, view.sort).map((c) => rowHtml(c, view, depth + 1)).join('');
}

export function renderOps(ops: OpStats, view: OpsView): string {
  const rows = view.grouping === 'name' ? ops.byName : ops.byCategory;
  if (!rows.length) return empty('This session ran no operations.');

  const tabs =
    `<div class="dtabs">` +
    `<button class="dtab${view.grouping === 'name' ? ' on' : ''}" data-group="name">by tool</button>` +
    `<button class="dtab${view.grouping === 'category' ? ' on' : ''}" data-group="category">by category</button>` +
    `<label class="dchk"><input type="checkbox" data-main ${view.mainThreadOnly ? 'checked' : ''}> main thread only</label>` +
    `</div>`;

  const header =
    `<thead><tr>` +
    `<th data-sort="name">operation</th>` +
    `<th data-sort="calls" class="n">calls</th>` +
    `<th data-sort="time" class="n">total</th>` +
    `<th class="n">median</th>` +
    `<th class="n">p95</th>` +
    `<th data-sort="tokens" class="n">tokens</th>` +
    `<th class="n">share</th>` +
    `</tr></thead>`;

  const body = sortRows(rows, view.sort).map((r) => rowHtml(r, view, 0)).join('');

  const totals =
    `<div class="dnote">${ops.totals.calls.toLocaleString()} calls · ` +
    `${ops.totals.failed.toLocaleString()} not ok · ` +
    `${ops.totals.timedCalls.toLocaleString()} timed · ` +
    `~${tokensHuman(ops.totals.tokensIn + ops.totals.tokensOut)} context cost` +
    (ops.totals.subagentCalls ? ` · ${ops.totals.subagentCalls} in subagents` : '') +
    `</div>`;

  return tabs + `<table class="otab">${header}<tbody>${body}</tbody></table>` + totals;
}
