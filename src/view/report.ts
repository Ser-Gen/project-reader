/**
 * The Markdown report (SPEC D19, §9.4).
 *
 * Provenance is carried into the text — `~` for estimates, explicit
 * "not recorded" rows — so a pasted report cannot be mistaken for exact
 * measurement. Paths and prompt excerpts can be redacted before sharing.
 */

import type { Metric, SessionMetrics } from '../model/metrics.js';
import { PHASE_LABEL } from '../model/metrics.js';
import { compareSessions } from '../metrics/compare.js';
import { msHuman, tokensHuman } from './rows.js';

export interface ReportOptions {
  redact: boolean;
}

function val(m: Metric, kind: 'count' | 'tokens' | 'ms' | 'pct' = 'count'): string {
  if (m.value === null || m.provenance === 'unavailable') return `— not recorded${m.note ? ` (${m.note})` : ''}`;
  const pre = m.provenance === 'estimated' ? '~' : '';
  const v =
    kind === 'tokens' ? tokensHuman(m.value)
    : kind === 'ms' ? msHuman(m.value)
    : kind === 'pct' ? `${Math.round(m.value * 100)}%`
    : m.value.toLocaleString();
  return pre + v;
}

const redactPath = (p: string, on: boolean) => (on ? p.replace(/^.*\//, '…/') : p);

export function sessionReport(m: SessionMetrics, opts: ReportOptions = { redact: false }): string {
  const L: string[] = [];
  const when = m.startTs ? new Date(m.startTs).toLocaleString() : 'unknown date';

  L.push(`# ${m.title}`, '');
  L.push(
    `**${m.vendor}**${m.model ? ` · ${m.model}` : ''} · ${when} · ${m.prompts} prompts · ${m.events} events`,
    '',
  );
  if (m.cwd && !opts.redact) L.push(`\`${m.cwd}\``, '');

  L.push('## Tokens', '');
  L.push('| measure | value |', '| --- | --- |');
  L.push(`| fresh input + output | ${val(m.tokens.headline, 'tokens')} |`);
  L.push(`| fresh input | ${val(m.tokens.freshInput, 'tokens')} |`);
  L.push(`| output | ${val(m.tokens.output, 'tokens')} |`);
  L.push(`| cache reads (context re-sent) | ${val(m.tokens.cacheRead, 'tokens')} |`);
  L.push(`| billed input (includes re-sent) | ${val(m.tokens.billedInput, 'tokens')} |`);
  L.push(`| peak context | ${val(m.tokens.contextPeak, 'tokens')} |`);
  L.push(`| requests | ${val(m.tokens.requests)} |`);
  L.push(`| operation context cost | ${val(m.tokens.contextCost, 'tokens')} |`);
  L.push('');
  L.push('*Cache reads are context sent again; they are never added into fresh input.*', '');

  L.push('## Time', '');
  L.push('| clock | value |', '| --- | --- |');
  L.push(`| wall | ${val(m.time.wall, 'ms')} |`);
  L.push(`| active (idle removed) | ${val(m.time.active, 'ms')} |`);
  L.push(`| busy (union of operations) | ${val(m.time.busy, 'ms')} |`);
  L.push('');

  if (m.plan.detected) {
    L.push('## Phases', '');
    L.push('| phase | wall | active | busy | fresh in | out | ops | prompts |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const p of m.phases.phases) {
      L.push(
        `| ${PHASE_LABEL[p.id]} | ${msHuman(p.wallMs)} | ${msHuman(p.activeMs)} | ${msHuman(p.busyMs)} | ` +
          `${tokensHuman(p.freshInput)} | ${tokensHuman(p.output)} | ${p.ops} | ${p.prompts} |`,
      );
    }
    L.push('');
    const before = m.phases.beforePlan;
    const after = m.phases.afterPlan;
    const mark = m.phases.tokensProvenance === 'estimated' ? '~' : '';
    L.push(
      `**Before the plan:** ${mark}${tokensHuman(before.freshInput)} fresh in · ${mark}${tokensHuman(before.output)} out ` +
        `· ${before.requests} requests`,
      '',
      `**After the plan:** ${mark}${tokensHuman(after.freshInput)} fresh in · ${mark}${tokensHuman(after.output)} out ` +
        `· ${after.requests} requests`,
      '',
    );
    for (const key of ['planningStart', 'planCreated', 'implEnd'] as const) {
      const b = m.phases[key];
      if (b) L.push(`- \`${key}\`: ${new Date(b.ts).toLocaleString()} — ${b.rule} (${b.confidence})`);
    }
    L.push('');

    L.push('## Plan', '');
    L.push(`Detected via ${m.plan.reason}.`, '');
    L.push('| measure | value |', '| --- | --- |');
    L.push(`| revisions | ${val(m.plan.planRevisions)} |`);
    L.push(`| edits (steps changed) | ${val(m.plan.planEdits)} |`);
    L.push(`| progress ticks | ${val(m.plan.progressTicks)} |`);
    L.push(`| edits during planning | ${val(m.plan.planEditsDuringPlanning)} |`);
    L.push(`| edits after work started | ${val(m.plan.planEditsAfterImplStart)} |`);
    L.push(`| steps added / removed | ${val(m.plan.stepsAdded)} / ${val(m.plan.stepsRemoved)} |`);
    L.push(`| steps reworded / reordered | ${val(m.plan.stepsReworded)} / ${val(m.plan.stepsReordered)} |`);
    L.push('');
    if ((m.plan.planEditsAfterImplStart.value ?? 0) > 0) {
      L.push(`> Scope drift: the plan was edited ${m.plan.planEditsAfterImplStart.value} time(s) after work started.`, '');
    }

    L.push('## After implementation', '');
    L.push('| measure | value |', '| --- | --- |');
    L.push(`| improvement rounds | ${val(m.improvements.iterations)} |`);
    L.push(`| questions (no edits) | ${val(m.improvements.questions)} |`);
    L.push(`| edits after the plan | ${val(m.improvements.postPlanEdits)} |`);
    L.push(`| unplanned edits | ${val(m.improvements.unplannedEdits)} |`);
    L.push(`| unplanned share | ${val(m.improvements.unplannedShare, 'pct')} |`);
    L.push('');
    if (m.improvements.unplannedFiles.length) {
      L.push('Files edited after the plan that it never mentions:', '');
      for (const f of m.improvements.unplannedFiles.slice(0, 20)) {
        L.push(`- ${f.edits}× \`${redactPath(f.path, opts.redact)}\``);
      }
      L.push('');
    }
    if (m.improvements.rows.length && !opts.redact) {
      L.push('Improvement rounds:', '');
      for (const r of m.improvements.rows.slice(0, 20)) {
        L.push(`- ${r.title} — ${r.ops} ops, ${r.edits} edits, +${r.linesAdded}/−${r.linesRemoved}, ${msHuman(r.durationMs)}`);
      }
      L.push('');
    }
  } else {
    L.push('## Plan', '', `No plan was detected — ${m.plan.reason}.`, '');
  }

  L.push('## Operations', '');
  L.push('| operation | calls | not ok | total | median | ~tokens |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of m.ops.byName.slice(0, 20)) {
    const bad = r.error + r.interrupted + r.unpaired;
    L.push(
      `| ${r.label} | ${r.calls} | ${bad} | ${r.timedCalls ? msHuman(r.totalMs) : '—'} | ` +
        `${r.timedCalls ? msHuman(r.medianMs) : '—'} | ~${tokensHuman(r.tokensIn + r.tokensOut)} |`,
    );
  }
  L.push('');

  L.push('## Data quality', '');
  const q = m.quality;
  L.push(
    `Detected as **${q.vendor}** (${Math.round(q.confidence * 100)}% confident). ` +
      `${q.lines.toLocaleString()} records, ${q.badLines} unparsable. ` +
      `Timestamp coverage ${Math.round(q.coverage.timestamps * 100)}%, duration coverage ${Math.round(
        q.coverage.durations * 100,
      )}%.`,
    '',
  );
  for (const n of q.notes) L.push(`- ${n}`);
  if (q.calibration) {
    L.push(
      `- Token estimator: ${q.calibration.samples} samples, ` +
        (q.calibration.medianError === null
          ? 'error not measurable on this session'
          : `${(q.calibration.medianError * 100).toFixed(1)}% median error against reported usage`),
    );
  }
  L.push('', '*Generated by Project Reader. `~` marks an estimate; "not recorded" means the transcript does not contain it.*');
  return L.join('\n');
}

export function compareReport(a: SessionMetrics, b: SessionMetrics, opts: ReportOptions = { redact: false }): string {
  const L: string[] = [];
  L.push(`# ${a.title} vs ${b.title}`, '');
  L.push(`Absolute values, no normalization. A = ${a.vendor}, B = ${b.vendor}.`, '');
  for (const g of compareSessions(a, b)) {
    L.push(`## ${g.title}`, '');
    L.push('| metric | A | B | difference |', '| --- | --- | --- | --- |');
    for (const r of g.rows) {
      const diff =
        r.delta === null ? '—'
        : r.mixed ? 'not comparable'
        : `${r.delta > 0 ? '+' : ''}${
            r.fmt === 'tokens' ? tokensHuman(r.delta)
            : r.fmt === 'ms' ? msHuman(r.delta)
            : r.fmt === 'pct' ? `${Math.round(r.delta * 100)}%`
            : r.delta.toLocaleString()
          }`;
      L.push(`| ${r.label.trim()} | ${val(r.a, r.fmt)} | ${val(r.b, r.fmt)} | ${diff} |`);
    }
    L.push('');
  }
  if (!opts.redact && a.cwd && b.cwd) L.push(`A: \`${a.cwd}\``, '', `B: \`${b.cwd}\``, '');
  return L.join('\n');
}
