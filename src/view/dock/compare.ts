/**
 * A/B comparison (SPEC §7.4).
 *
 * Absolute values, no normalization — so the scale rows come first, and any row
 * where one side was measured and the other estimated is marked as not directly
 * comparable rather than quietly subtracted.
 */

import type { SessionMetrics } from '../../model/metrics.js';
import { compareSessions, type CompareRow } from '../../metrics/compare.js';
import { escapeHtml } from '../markdown.js';
import { msHuman, tokensHuman } from '../rows.js';
import { empty } from './fmt.js';

function cell(row: CompareRow, side: 'a' | 'b'): string {
  const m = row[side];
  if (m.value === null || m.provenance === 'unavailable') {
    return `<td class="n na" title="${escapeHtml(m.note ?? 'not recorded')}">— not recorded</td>`;
  }
  const est = m.provenance === 'estimated' ? '~' : '';
  const v =
    row.fmt === 'tokens' ? tokensHuman(m.value)
    : row.fmt === 'ms' ? msHuman(m.value)
    : row.fmt === 'pct' ? `${Math.round(m.value * 100)}%`
    : m.value.toLocaleString();
  return `<td class="n">${est}${v}</td>`;
}

function deltaCell(row: CompareRow): string {
  if (row.delta === null) return `<td class="n na">—</td>`;
  if (row.mixed) {
    return `<td class="n na" title="one side is reported and the other estimated">not comparable</td>`;
  }
  const d = row.delta;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const abs = Math.abs(d);
  const v =
    row.fmt === 'tokens' ? tokensHuman(abs)
    : row.fmt === 'ms' ? msHuman(abs)
    : row.fmt === 'pct' ? `${Math.round(abs * 100)}%`
    : abs.toLocaleString();
  return `<td class="n dl ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${sign}${v}</td>`;
}

export function renderCompare(
  a: SessionMetrics | null,
  b: SessionMetrics | null,
  choices: { id: string; title: string }[],
): string {
  const picker =
    `<div class="dtabs"><label class="dchk">compare with ` +
    `<select data-compare><option value="">…</option>` +
    choices
      .map((c) => `<option value="${escapeHtml(c.id)}"${b && c.id === b.key ? ' selected' : ''}>${escapeHtml(c.title)}</option>`)
      .join('') +
    `</select></label></div>`;

  if (!a) return picker + empty('Open a session first.');
  if (!b) return picker + empty('Pick a second session to compare against. Open more than one file to have a choice.');

  const groups = compareSessions(a, b);
  const table =
    `<table class="ctab"><thead><tr><th>metric</th>` +
    `<th class="n">${escapeHtml(shortTitle(a))}</th>` +
    `<th class="n">${escapeHtml(shortTitle(b))}</th>` +
    `<th class="n">difference</th></tr></thead><tbody>` +
    groups
      .map(
        (g) =>
          `<tr class="grp"><td colspan="4">${escapeHtml(g.title)}</td></tr>` +
          g.rows
            .map(
              (r) =>
                `<tr><td class="nm">${escapeHtml(r.label)}</td>${cell(r, 'a')}${cell(r, 'b')}${deltaCell(r)}</tr>`,
            )
            .join(''),
      )
      .join('') +
    `</tbody></table>`;

  const warn =
    a.vendor !== b.vendor
      ? `<div class="dnote">These sessions come from different agents (${a.vendor} vs ${b.vendor}). ` +
        `Only the by-category operation counts are directly comparable; tool names and token reporting differ.</div>`
      : '';

  return picker + warn + table;
}

function shortTitle(m: SessionMetrics): string {
  return m.title.length > 24 ? m.title.slice(0, 24) + '…' : m.title;
}
