/**
 * Overview: the six numbers worth seeing before any drill-down, plus the
 * before/after-the-plan split that answers "where did the budget go".
 */

import type { SessionMetrics } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { bar, empty, plain, section, stat, tokensHuman } from './fmt.js';

export function renderOverview(m: SessionMetrics): string {
  const t = m.tokens;
  const q = m.quality;

  const tokens = section(
    'tokens',
    stat('fresh input + output', t.headline, 'tokens') +
      stat('fresh input', t.freshInput, 'tokens') +
      stat('output', t.output, 'tokens') +
      stat('cache reads (context re-sent)', t.cacheRead, 'tokens') +
      stat('peak context', t.contextPeak, 'tokens') +
      stat('requests', t.requests) +
      `<div class="dnote">Cache reads are the same context sent again; they are reported but never added to fresh input.</div>` +
      stat('operation context cost', t.contextCost, 'tokens') +
      (t.subagentContextCost.value
        ? `<div class="dnote">of which ~${tokensHuman(t.subagentContextCost.value)} in subagents</div>`
        : ''),
  );

  const clocks = section(
    'time',
    stat('wall clock', m.time.wall, 'ms') +
      stat('active (idle removed)', m.time.active, 'ms') +
      stat('busy (operations)', m.time.busy, 'ms') +
      stat('median think time', m.time.thinkMs, 'ms') +
      `<div class="dnote">Busy is the union of operation intervals: parallel calls count once.</div>`,
  );

  const cats = m.ops.byCategory.length
    ? `<div class="cats">${m.ops.byCategory
        .map(
          (r) =>
            `<button class="cat" data-focus="${r.key}" title="${escapeHtml(`${r.calls} ${r.key} operations`)}">` +
            `<b>${r.calls}</b><span>${escapeHtml(r.key)}</span></button>`,
        )
        .join('')}</div>`
    : empty('no operations were recorded');

  const ops = section(
    'operations',
    cats +
      plain('calls', m.ops.totals.calls.toLocaleString()) +
      plain('failed or interrupted', m.ops.totals.failed.toLocaleString()) +
      (m.ops.totals.subagentCalls ? plain('in subagents', m.ops.totals.subagentCalls.toLocaleString()) : ''),
  );

  const phases = m.plan.detected
    ? section(
        'before and after the plan',
        bar([
          { label: 'fresh input before', value: m.phases.beforePlan.freshInput, cls: 'b1' },
          { label: 'output before', value: m.phases.beforePlan.output, cls: 'b2' },
          { label: 'fresh input after', value: m.phases.afterPlan.freshInput, cls: 'b3' },
          { label: 'output after', value: m.phases.afterPlan.output, cls: 'b4' },
        ]) +
          plain(
            'planning',
            m.phases.planningStart && m.phases.planCreated
              ? `${Math.max(0, Math.round((m.phases.planCreated.ts - m.phases.planningStart.ts) / 1000))}s`
              : '—',
          ),
        m.phases.tokensProvenance === 'estimated' ? 'estimated' : '',
      )
    : section('before and after the plan', empty('No plan was detected in this conversation.'));

  const plan = m.plan.detected
    ? section(
        'plan',
        plain('detected via', m.plan.reason) +
          stat('revisions', m.plan.planRevisions) +
          stat('edits to the plan', m.plan.planEdits) +
          stat('edits after work started', m.plan.planEditsAfterImplStart) +
          (m.plan.checklistLike
            ? `<div class="dnote">Almost every revision only ticked a box: this was used as a checklist, not a plan.</div>`
            : ''),
      )
    : '';

  const improvements = m.improvements.available
    ? section(
        'after implementation',
        stat('improvement rounds', m.improvements.iterations) +
          stat('questions (no edits)', m.improvements.questions) +
          stat('unplanned edits', m.improvements.unplannedEdits) +
          stat('unplanned share', m.improvements.unplannedShare, 'pct'),
      )
    : '';

  const warnings = q.notes.length;
  const quality = section(
    'data quality',
    `<div class="qbadge ${warnings ? 'warn' : 'ok'}">${
      warnings ? `${warnings} caveat${warnings > 1 ? 's' : ''}` : 'nothing to flag'
    }</div>` +
      plain('vendor', `${q.vendor} (${Math.round(q.confidence * 100)}% confident)`) +
      plain('timestamp coverage', `${Math.round(q.coverage.timestamps * 100)}%`) +
      plain('duration coverage', `${Math.round(q.coverage.durations * 100)}%`),
  );

  return tokens + clocks + ops + phases + plan + improvements + quality;
}
