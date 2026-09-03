/**
 * Event -> row HTML. Pure string building, memoized: producing a row must stay
 * cheap enough to run inside a scroll frame.
 */

import type { CanonEvent } from '../model/canon.js';
import { icon } from './icons.js';
import { iconOf } from './kinds.js';
import { renderAsk } from './ask.js';
import { escapeHtml, renderDiff, renderMarkdown, renderPlain } from './markdown.js';

/** Bodies longer than this render collapsed with a "show more" affordance. */
const CLAMP_CHARS = 1200;

/**
 * Questions get a longer leash: a decision is only readable whole, and the
 * measured shape of a real `AskUserQuestion` — three questions, three options
 * each, a paragraph per option — is ~2.6 KB, every byte of it the point.
 */
const ASK_CLAMP_CHARS = 8000;

const clampOf = (ev: CanonEvent): number => (ev.format === 'ask' ? ASK_CLAMP_CHARS : CLAMP_CHARS);

/** Session-wide thresholds above which a row is marked expensive. */
export interface RowScale {
  costP90: number;
  msP90: number;
}

export function timeOf(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

export function relTime(ts: number, base: number): string {
  if (!ts || !base) return '';
  const s = Math.max(0, Math.round((ts - base) / 1000));
  if (s < 60) return `+${s}s`;
  if (s < 3600) return `+${Math.floor(s / 60)}m`;
  return `+${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function tokensHuman(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function msHuman(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(ms / 3_600_000)}h${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, '0')}m`;
}

/**
 * A page the agent wrote and asked its host to display.
 *
 * It is rendered, because a visualization *is* the answer the human was given
 * — the same reason a screenshot row opens by default. It is rendered inside a
 * fully restricted `sandbox`, so the agent's markup and styling appear and its
 * scripts, forms and navigation do not run: this is a transcript reader, and
 * nothing in a transcript gets to execute here. The small preamble makes the
 * page inherit the reader's dark scheme, which is what `light-dark()` in these
 * documents is written against.
 */
const FRAME_HEAD =
  '<meta charset="utf-8"><style>:root{color-scheme:dark}' +
  'body{margin:0;padding:12px;background:#0f1115;color:#dfe4ee;' +
  'font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>';

function widget(w: { kind: string; title: string; path: string; html: string }): string {
  const file = w.path.split('/').pop() ?? w.path;
  return (
    `<figure class="viz">` +
    `<figcaption><span class="vk">${escapeHtml(w.kind)}</span>` +
    `<span class="vt">${escapeHtml(w.title)}</span>` +
    `<span class="vf">${escapeHtml(file)}</span></figcaption>` +
    `<iframe sandbox="" loading="lazy" referrerpolicy="no-referrer" title="${escapeHtml(w.title)}"` +
    ` srcdoc="${escapeHtml(FRAME_HEAD + w.html)}"></iframe>` +
    `<figcaption class="vn">scripts are not run here</figcaption>` +
    `</figure>`
  );
}

function body(ev: CanonEvent, full: boolean): string {
  const clamp = clampOf(ev);
  const clamped = !full && ev.body.length > clamp;
  const text = clamped ? ev.body.slice(0, clamp) : ev.body;
  if (!text && !ev.images?.length) return '';

  let html = '';
  if (text) {
    switch (ev.format) {
      case 'md':
        html = renderMarkdown(text);
        break;
      case 'diff':
        html = renderDiff(text);
        break;
      case 'ask':
        html = renderAsk(text);
        break;
      default:
        html = renderPlain(text);
    }
  }

  if (ev.widgets?.length) {
    html += ev.widgets.map(widget).join('');
  }

  if (ev.images?.length) {
    html += `<div class="shots">${ev.images
      .map(
        (im) =>
          `<img class="shot" src="${im.url}" loading="lazy" decoding="async"${
            im.w ? ` width="${im.w}" height="${im.h}"` : ''
          } alt="screenshot ${bytesHuman(im.bytes)}">`,
      )
      .join('')}</div>`;
  }

  const hidden = (clamped ? ev.body.length - clamp : 0) + (ev.more ? ev.fullLen - ev.body.length : 0);
  if (hidden > 0) {
    html += `<button class="more" data-act="expand">▾ ${hidden.toLocaleString()} more characters</button>`;
  } else if (full && ev.fullLen > clamp) {
    html += `<button class="more" data-act="collapse">▴ collapse</button>`;
  }
  return html;
}

/**
 * The analytics chips: what this operation cost and how long it took. Suppressed
 * rather than shown as 0 when the value is not available, and marked with `≤`
 * when several calls shared one request timestamp so only their envelope is known.
 */
function metricChips(ev: CanonEvent, scale?: RowScale): string {
  if (ev.kind !== 'op') return '';
  let out = '';
  const cost = (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);
  if (cost > 0) {
    const heavy = scale && scale.costP90 > 0 && cost >= scale.costP90 ? ' heavy' : '';
    out += `<span class="chip tok${heavy}" title="estimated tokens this call put into the conversation">~${tokensHuman(cost)}</span>`;
  }
  if (ev.durationMs !== undefined && ev.durationSource !== 'unknown') {
    const heavy = scale && scale.msP90 > 0 && ev.durationMs >= scale.msP90 ? ' heavy' : '';
    const bound = ev.durationSource === 'shared' ? '≤' : '';
    const title =
      ev.durationSource === 'shared'
        ? 'issued in parallel with other calls — this is the upper bound'
        : ev.durationSource === 'reported'
          ? 'reported by the tool'
          : 'call to result';
    out += `<span class="chip ms${heavy}" title="${title}">${bound}${msHuman(ev.durationMs)}</span>`;
  }
  return out;
}

export function renderRow(ev: CanonEvent, open: boolean, full: boolean, scale?: RowScale): string {
  const cat = iconOf(ev);
  const status = ev.op?.status;
  const cls = ['ev', `k-${ev.kind}`, `c-${cat}`];
  if (status && status !== 'unpaired') cls.push(`s-${status}`);
  if (status === 'unpaired') cls.push('s-pending');
  if (ev.sidechain > 0) cls.push('side');
  if (open) cls.push('open');

  const chips = ev.chips?.length ? ev.chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('') : '';
  const imgChip = ev.images?.length ? `<span class="chip img">${ev.images.length} img</span>` : '';
  const planChip = ev.plan?.role === 'revision' ? `<span class="chip plan">plan</span>` : '';
  const sub = ev.subtitle ? `<span class="sub">${escapeHtml(ev.subtitle)}</span>` : '';
  const foldable =
    ev.kind === 'reasoning' || ev.kind === 'op' || ev.kind === 'notice' || ev.kind === 'error' || ev.kind === 'compaction';

  return (
    `<article class="${cls.join(' ')}" data-idx="${ev.idx}">` +
    `<header class="head" data-act="fold">` +
    icon(cat) +
    `<time>${timeOf(ev.ts)}</time>` +
    `<span class="badge">${escapeHtml(ev.op?.name ?? ev.title)}</span>` +
    sub +
    `<span class="grow"></span>` +
    planChip +
    chips +
    imgChip +
    metricChips(ev, scale) +
    (foldable ? `<span class="caret">${open ? '▾' : '▸'}</span>` : '') +
    `</header>` +
    (open ? `<div class="body">${body(ev, full)}</div>` : '') +
    `</article>`
  );
}
