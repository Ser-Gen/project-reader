/**
 * Phases: the strip, the per-phase table, and the controls that let a human
 * correct a boundary the heuristics got wrong.
 *
 * Every boundary shows the rule that produced it and whether it was observed or
 * inferred, because the post-plan metrics are only as good as `implEnd`.
 */

import type { Boundary, PhaseModel, PhaseStats } from '../../model/metrics.js';
import { PHASE_LABEL } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { msHuman, tokensHuman } from '../rows.js';
import { empty, section } from './fmt.js';

const KEYS = ['planningStart', 'planCreated', 'implEnd'] as const;
const KEY_LABEL: Record<(typeof KEYS)[number], string> = {
  planningStart: 'planning started',
  planCreated: 'plan created',
  implEnd: 'implementation ended',
};

function boundaryRow(key: (typeof KEYS)[number], b: Boundary | null): string {
  if (!b) return '';
  const when = b.ts ? new Date(b.ts).toLocaleTimeString() : '—';
  return (
    `<div class="brow">` +
    `<span class="l">${escapeHtml(KEY_LABEL[key])}</span>` +
    `<span class="t">${escapeHtml(when)}</span>` +
    `<span class="cf ${b.confidence}${b.manual ? ' manual' : ''}">${b.manual ? 'set by hand' : b.confidence}</span>` +
    `<span class="rule">${escapeHtml(b.rule)}</span>` +
    `<button class="ghost sm" data-bound="${key}" title="move this boundary to the event at the top of the timeline">move here</button>` +
    (b.manual ? `<button class="ghost sm" data-bound-reset="${key}">reset</button>` : '') +
    `</div>`
  );
}

function phaseRow(p: PhaseStats, total: number): string {
  const cats = Object.entries(p.opsByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  return (
    `<tr data-phase="${p.id}" data-first="${p.firstIdx}">` +
    `<td class="nm"><span class="ph ph-${p.id}"></span>${escapeHtml(PHASE_LABEL[p.id])}</td>` +
    `<td class="n">${p.wallMs ? msHuman(p.wallMs) : '—'}</td>` +
    `<td class="n" title="idle removed">${p.activeMs ? msHuman(p.activeMs) : '—'}</td>` +
    `<td class="n" title="union of operation intervals">${p.busyMs ? msHuman(p.busyMs) : '—'}</td>` +
    `<td class="n">${p.freshInput ? tokensHuman(p.freshInput) : '—'}</td>` +
    `<td class="n">${p.output ? tokensHuman(p.output) : '—'}</td>` +
    `<td class="n">${p.ops}</td>` +
    `<td class="n">${p.prompts}</td>` +
    `<td class="sub">${escapeHtml(cats)}${p.files ? ` · ${p.files} files` : ''}${
      p.linesAdded || p.linesRemoved ? ` · +${p.linesAdded}/−${p.linesRemoved}` : ''
    }</td>` +
    `<td class="n">${total ? Math.round((p.wallMs / total) * 100) : 0}%</td>` +
    `</tr>`
  );
}

export function renderPhases(model: PhaseModel): string {
  if (!model.planCreated) {
    return (
      empty('No plan was detected, so this conversation has no phases.') +
      section(
        'what would count as a plan',
        `<div class="dnote">Plan mode (ExitPlanMode), a structured plan or todo tool, or a written ` +
          `PLAN/SPEC/DESIGN/TODO/ROADMAP markdown file. If the plan lived somewhere else — in your head, or in a ` +
          `document you wrote — set the boundaries by hand from the timeline.</div>`,
      )
    );
  }

  const total = model.phases.reduce((n, p) => n + p.wallMs, 0);
  const strip = `<div class="strip">${model.phases
    .filter((p) => p.wallMs > 0)
    .map(
      (p) =>
        `<i class="ph-${p.id}" style="width:${((p.wallMs / (total || 1)) * 100).toFixed(2)}%" ` +
        `title="${escapeHtml(`${PHASE_LABEL[p.id]} — ${msHuman(p.wallMs)}`)}"></i>`,
    )
    .join('')}</div>`;

  const episodes =
    model.episodeCount > 1
      ? `<div class="dnote">This conversation planned ${model.episodeCount} times. ` +
        `Showing episode ${model.episode + 1}: ` +
        Array.from({ length: model.episodeCount }, (_, i) =>
          `<button class="ghost sm${i === model.episode ? ' on' : ''}" data-episode="${i}">${i + 1}</button>`,
        ).join('') +
        `</div>`
      : '';

  const table =
    `<table class="ptab"><thead><tr>` +
    `<th>phase</th><th class="n">wall</th><th class="n">active</th><th class="n">busy</th>` +
    `<th class="n">fresh in</th><th class="n">out</th><th class="n">ops</th><th class="n">prompts</th>` +
    `<th>work</th><th class="n">%</th>` +
    `</tr></thead><tbody>${model.phases.map((p) => phaseRow(p, total)).join('')}</tbody></table>`;

  const bounds = KEYS.map((k) => boundaryRow(k, model[k])).join('');

  return (
    section('shape of the session', strip + episodes) +
    section('phases', table) +
    section(
      'boundaries',
      bounds +
        `<div class="dnote">"Move here" sets a boundary to the event currently at the top of the timeline and ` +
        `recomputes every phase metric. Inferred boundaries are the tool's best guess, not a measurement.</div>`,
    )
  );
}
