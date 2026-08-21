/**
 * The plan panel: how many times the plan changed, whether it changed *after*
 * work started, and what happened once implementation was done.
 *
 * Every count is clickable through to the revision that produced it, because
 * "3 edits after work started" is only useful if you can see which three.
 */

import type { ImprovementStats, PlanStats } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { msHuman, tokensHuman } from '../rows.js';
import { empty, plain, section, stat } from './fmt.js';

const CHANGE_LABEL: Record<string, string> = {
  added: '+',
  removed: '−',
  reworded: '≠',
  reordered: '↕',
  status: '✓',
};

export function renderPlan(plan: PlanStats, imp: ImprovementStats): string {
  if (!plan.detected) {
    return empty(`No plan was detected — ${plan.reason}.`);
  }

  const drift =
    (plan.planEditsAfterImplStart.value ?? 0) > 0
      ? `<div class="verdict drift">scope drift: yes — ${plan.planEditsAfterImplStart.value} edit(s) after work started</div>`
      : `<div class="verdict ok">no edits to the plan after work started</div>`;

  const counts = section(
    'plan edits',
    drift +
      stat('revisions emitted', plan.planRevisions) +
      stat('edits (steps changed)', plan.planEdits) +
      stat('progress ticks (status only)', plan.progressTicks) +
      stat('during planning', plan.planEditsDuringPlanning) +
      stat('after work started', plan.planEditsAfterImplStart) +
      stat('steps added', plan.stepsAdded) +
      stat('steps removed', plan.stepsRemoved) +
      stat('steps reworded', plan.stepsReworded) +
      stat('steps reordered', plan.stepsReordered) +
      stat('steps now', plan.stepsTotal) +
      stat('steps done', plan.stepsDone) +
      plain('detected via', plan.reason) +
      (plan.checklistLike
        ? `<div class="dnote">≥80% of revisions only changed a status: used as a checklist rather than a plan.</div>`
        : ''),
  );

  const revs = section(
    'revisions',
    `<ol class="revs">` +
      plan.revisions
        .map((r, i) => {
          const diff = plan.diffs.find((d) => d.rev === i);
          const changes = diff?.changes.length
            ? `<div class="chg">${diff.changes
                .slice(0, 12)
                .map(
                  (c) =>
                    `<span class="c c-${c.kind}" title="${escapeHtml(c.from ? `was: ${c.from}` : c.kind)}">` +
                    `${CHANGE_LABEL[c.kind] ?? '·'} ${escapeHtml((c.to ?? c.from ?? '').slice(0, 70))}</span>`,
                )
                .join('')}${diff.changes.length > 12 ? `<span class="c">…${diff.changes.length - 12} more</span>` : ''}</div>`
            : i === 0
              ? `<div class="chg"><span class="c c-added">first version · ${r.steps.length} steps</span></div>`
              : `<div class="chg"><span class="c">no change</span></div>`;
          const tag = diff ? (diff.structural ? 'edit' : 'tick') : 'created';
          return (
            `<li class="rev" data-ev="${r.idx}">` +
            `<div class="rh"><span class="tag t-${tag}">${tag}</span>` +
            `<span class="when">${r.ts ? new Date(r.ts).toLocaleTimeString() : ''}</span>` +
            `<span class="src">${escapeHtml(r.path ?? r.source)}${r.approved ? '' : ' · not approved'}</span></div>` +
            changes +
            `</li>`
          );
        })
        .join('') +
      `</ol>`,
  );

  return counts + revs + renderImprovements(imp);
}

export function renderImprovements(imp: ImprovementStats): string {
  if (!imp.available) {
    return section('after implementation', empty('Needs a detected plan to know what "after" means.'));
  }

  const rows = imp.rows.length
    ? `<table class="itab"><thead><tr><th>prompt</th><th class="n">ops</th><th class="n">edits</th>` +
      `<th class="n">±lines</th><th class="n">tokens</th><th class="n">took</th></tr></thead><tbody>` +
      imp.rows
        .map(
          (r) =>
            `<tr data-ev="${r.idx}"><td class="nm" title="${escapeHtml(r.files.join('\n'))}">${escapeHtml(r.title)}</td>` +
            `<td class="n">${r.ops}</td><td class="n">${r.edits}</td>` +
            `<td class="n">+${r.linesAdded}/−${r.linesRemoved}</td>` +
            `<td class="n">${tokensHuman(r.freshInput + r.output) || '—'}</td>` +
            `<td class="n">${msHuman(r.durationMs)}</td></tr>`,
        )
        .join('') +
      `</tbody></table>`
    : empty('No improvement rounds after implementation ended.');

  const unplanned = imp.unplannedFiles.length
    ? `<ul class="files">${imp.unplannedFiles
        .slice(0, 30)
        .map((f) => `<li><b>${f.edits}×</b> ${escapeHtml(f.path)}</li>`)
        .join('')}</ul>`
    : empty('Every file edited after the plan is named in it.');

  return (
    section(
      'improvement rounds',
      stat('rounds (prompts that changed code)', imp.iterations) +
        stat('questions (no edits)', imp.questions) +
        rows,
    ) +
    section(
      'unplanned work',
      stat('edits after the plan', imp.postPlanEdits) +
        stat('unplanned edits', imp.unplannedEdits) +
        stat('unplanned share', imp.unplannedShare, 'pct') +
        unplanned +
        `<div class="dnote">A file counts as planned when any revision mentions its path, its tail, or its ` +
        `basename — including inside code spans. Check the list before concluding the plan missed the work.</div>`,
    ) +
    section(
      'churn after the plan',
      imp.churn.length
        ? `<ul class="files">${imp.churn
            .slice(0, 30)
            .map((f) => `<li><b>${f.edits}×</b> ${escapeHtml(f.path)}</li>`)
            .join('')}</ul>`
        : empty('No files were edited after the plan.'),
    )
  );
}
