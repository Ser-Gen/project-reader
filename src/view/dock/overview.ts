/**
 * Overview: the six numbers worth seeing before any drill-down, plus the
 * before/after-the-plan split that answers "where did the budget go".
 */

import type { SessionMetrics, ThreadShare } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { bar, empty, msHuman, plain, section, stat, tokensHuman } from './fmt.js';
import { reviewNote } from './review.js';

/**
 * Name a thread in the table. Two reviewers of the same session carry the same
 * name, so when that happens they are told apart by when they started — the one
 * thing about them that differs and that a reader can find in the timeline.
 */
function threadLabel(sh: ThreadShare, all: readonly ThreadShare[]): string {
  const twice = all.filter((o) => o.label === sh.label).length > 1;
  const when = twice && sh.startTs ? ` · ${new Date(sh.startTs).toLocaleTimeString()}` : '';
  const role = sh.role === 'main' || sh.label.includes(sh.role) ? '' : ` · ${sh.role}`;
  return `${sh.label}${role}${when}`;
}

export function renderOverview(m: SessionMetrics): string {
  const t = m.tokens;
  const q = m.quality;

  const thread = m.thread
    ? section(
        m.thread.role === 'review' ? 'review thread' : 'subagent thread',
        plain('role', m.thread.label) +
          (m.thread.parentId ? plain('serves session', m.thread.parentId) : '') +
          (m.review.detected ? plain('decisions', reviewNote(m.review)) : '') +
          `<div class="dnote">This file is one side of a conversation held in another file. Its prompts were ` +
          `composed by the runtime, so "prompts" here counts requests put to it, not things a person typed.</div>`,
      )
    : '';

  // A merged session's totals belong to more than one thread. Summing them is
  // the only way to say what the work cost; showing the split is the only way
  // to keep that sum honest.
  const threads = m.threads.merged
    ? section(
        'threads in this session',
        `<table class="rtab"><thead><tr><th>thread</th><th class="n">events</th><th class="n">ops</th>` +
          `<th class="n">billed</th><th class="n">~context</th><th class="n">span</th></tr></thead><tbody>` +
          m.threads.shares
            .map((sh) => {
              const span = sh.startTs && sh.endTs > sh.startTs ? msHuman(sh.endTs - sh.startTs) : '—';
              return (
                `<tr>` +
                `<td class="rw">${escapeHtml(threadLabel(sh, m.threads.shares))}` +
                `${sh.detached ? ' <span class="chip" title="its clock does not overlap this session">detached</span>' : ''}</td>` +
                `<td class="n">${sh.events.toLocaleString()}</td>` +
                `<td class="n">${sh.ops.toLocaleString()}</td>` +
                `<td class="n">${sh.billed.value === null ? '—' : tokensHuman(sh.billed.value)}</td>` +
                // No operations means no operation cost — a dash, not a zero
                // that looks like a measurement of something.
                `<td class="n">${sh.ops ? `~${tokensHuman(sh.contextCost)}` : '—'}</td>` +
                `<td class="n">${escapeHtml(span)}</td>` +
                `</tr>`
              );
            })
            .join('') +
          `</tbody></table>` +
          `<div class="dnote">Every other figure in this dock covers all of these threads together — that is what ` +
          `this session cost. This is how it divides.</div>`,
      )
    : '';

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

  // A thread that judges another agent runs no tools; saying why the table is
  // empty is worth more than an empty table.
  const noOps =
    m.thread?.role === 'review'
      ? empty('A review thread runs no operations of its own — it reads and decides. See the review tab.')
      : empty('no operations were recorded');

  const cats = m.ops.byCategory.length
    ? `<div class="cats">${m.ops.byCategory
        .map(
          (r) =>
            `<button class="cat" data-focus="${r.key}" title="${escapeHtml(`${r.calls} ${r.key} operations`)}">` +
            `<b>${r.calls}</b><span>${escapeHtml(r.key)}</span></button>`,
        )
        .join('')}</div>`
    : noOps;

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

  return thread + threads + tokens + clocks + ops + phases + plan + improvements + quality;
}
