/**
 * Rendering a number the tool is not equally sure about.
 *
 * A vendor-reported figure, a derived one and a guess must never look alike, and
 * a metric that is unavailable must render as "—" and never as 0 — a zero is a
 * measurement, and claiming one we do not have is the whole failure mode this
 * project is trying to avoid.
 */

import type { Metric, Provenance } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { msHuman, tokensHuman } from '../rows.js';

export type ValueKind = 'count' | 'tokens' | 'ms' | 'pct' | 'bytes';

export function rawValue(m: Metric, kind: ValueKind): string {
  if (m.value === null || m.provenance === 'unavailable') return '—';
  switch (kind) {
    case 'tokens':
      return tokensHuman(m.value);
    case 'ms':
      return msHuman(m.value);
    case 'pct':
      return `${Math.round(m.value * 100)}%`;
    case 'bytes':
      return `${(m.value / 1024 / 1024).toFixed(1)} MB`;
    default:
      return m.value.toLocaleString();
  }
}

const PROV_TITLE: Record<Provenance, string> = {
  reported: 'recorded by the agent itself',
  derived: 'computed from recorded timestamps and events',
  estimated: 'estimated — this vendor does not record it',
  unavailable: 'not recorded in this transcript',
};

/** A metric as a span: prefix, provenance class, coverage warning, tooltip. */
export function value(m: Metric, kind: ValueKind = 'count'): string {
  const text = rawValue(m, kind);
  const est = m.provenance === 'estimated' && m.value !== null;
  const low = m.coverage !== undefined && m.coverage < 0.9;
  const title = [PROV_TITLE[m.provenance], m.note, low ? `only ${Math.round((m.coverage ?? 0) * 100)}% of events could contribute` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    `<span class="v p-${m.provenance}" title="${escapeHtml(title)}">${est ? '~' : ''}${text}` +
    (low ? '<i class="warn">!</i>' : '') +
    `</span>`
  );
}

/** One label/value line. */
export function stat(label: string, m: Metric, kind: ValueKind = 'count'): string {
  return `<div class="stat"><span class="l">${escapeHtml(label)}</span>${value(m, kind)}</div>`;
}

export function plain(label: string, text: string, title = ''): string {
  return (
    `<div class="stat"${title ? ` title="${escapeHtml(title)}"` : ''}>` +
    `<span class="l">${escapeHtml(label)}</span><span class="v">${escapeHtml(text)}</span></div>`
  );
}

export function section(title: string, body: string, note = ''): string {
  return (
    `<section class="dsec"><h3>${escapeHtml(title)}${note ? `<em>${escapeHtml(note)}</em>` : ''}</h3>${body}</section>`
  );
}

export function empty(text: string): string {
  return `<p class="dempty">${escapeHtml(text)}</p>`;
}

/** A proportional bar made of labelled slices. */
export function bar(parts: { label: string; value: number; cls: string }[]): string {
  const total = parts.reduce((n, p) => n + Math.max(0, p.value), 0);
  if (!total) return '';
  const slices = parts
    .filter((p) => p.value > 0)
    .map(
      (p) =>
        `<i class="${p.cls}" style="width:${((p.value / total) * 100).toFixed(2)}%" ` +
        `title="${escapeHtml(`${p.label}: ${tokensHuman(p.value)} (${Math.round((p.value / total) * 100)}%)`)}"></i>`,
    )
    .join('');
  const legend = parts
    .filter((p) => p.value > 0)
    .map((p) => `<span class="lg"><i class="${p.cls}"></i>${escapeHtml(p.label)} ${tokensHuman(p.value)}</span>`)
    .join('');
  return `<div class="barwrap"><div class="bar">${slices}</div><div class="legend">${legend}</div></div>`;
}

export { tokensHuman, msHuman };
