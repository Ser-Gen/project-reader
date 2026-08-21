/**
 * A/B comparison (SPEC §7.4, D12).
 *
 * Absolute values only — no normalization, no cohort baselines. The tool cannot
 * stop you comparing a two-hour session with a ten-minute one, so it puts both
 * sides' scale indicators at the top and marks any row where one side was
 * measured and the other estimated.
 */

import type { Metric, SessionMetrics } from '../model/metrics.js';
import { metric, unavailable } from '../model/metrics.js';

export type CompareFormat = 'count' | 'tokens' | 'ms' | 'pct';

export interface CompareRow {
  label: string;
  a: Metric;
  b: Metric;
  fmt: CompareFormat;
  /** one side is vendor-reported and the other is a guess: not directly comparable */
  mixed: boolean;
  delta: number | null;
  note?: string;
}

export interface CompareGroup {
  title: string;
  rows: CompareRow[];
}

function row(label: string, a: Metric, b: Metric, fmt: CompareFormat, note?: string): CompareRow {
  const known = (m: Metric) => m.value !== null && m.provenance !== 'unavailable';
  const mixed =
    known(a) && known(b) && (a.provenance === 'estimated') !== (b.provenance === 'estimated');
  return {
    label,
    a,
    b,
    fmt,
    mixed,
    delta: known(a) && known(b) ? (b.value as number) - (a.value as number) : null,
    note,
  };
}

const count = (v: number) => metric(v, 'derived');

export function compareSessions(a: SessionMetrics, b: SessionMetrics): CompareGroup[] {
  const phase = (m: SessionMetrics, id: string, pick: (p: any) => number): Metric => {
    const p = m.phases.phases.find((x) => x.id === id);
    return p ? metric(pick(p), m.phases.tokensProvenance === 'reported' ? 'reported' : 'estimated') : unavailable('phase not present');
  };

  return [
    {
      title: 'scale',
      rows: [
        row('prompts', count(a.prompts), count(b.prompts), 'count'),
        row('events', count(a.events), count(b.events), 'count'),
        row('operations', count(a.ops.totals.calls), count(b.ops.totals.calls), 'count'),
        row('wall clock', a.time.wall, b.time.wall, 'ms'),
      ],
    },
    {
      title: 'tokens',
      rows: [
        row('fresh input + output', a.tokens.headline, b.tokens.headline, 'tokens'),
        row('fresh input', a.tokens.freshInput, b.tokens.freshInput, 'tokens'),
        row('output', a.tokens.output, b.tokens.output, 'tokens'),
        row('cache reads', a.tokens.cacheRead, b.tokens.cacheRead, 'tokens'),
        row('peak context', a.tokens.contextPeak, b.tokens.contextPeak, 'tokens'),
        row('requests', a.tokens.requests, b.tokens.requests, 'count'),
        row('operation context cost', a.tokens.contextCost, b.tokens.contextCost, 'tokens'),
      ],
    },
    {
      title: 'time',
      rows: [
        row('active', a.time.active, b.time.active, 'ms'),
        row('busy (operations)', a.time.busy, b.time.busy, 'ms'),
        row('idle removed', a.time.idleMs, b.time.idleMs, 'ms'),
        row('median think time', a.time.thinkMs, b.time.thinkMs, 'ms'),
      ],
    },
    {
      title: 'operations',
      rows: [
        row('calls', count(a.ops.totals.calls), count(b.ops.totals.calls), 'count'),
        row('failed', count(a.ops.totals.failed), count(b.ops.totals.failed), 'count'),
        row('time in operations', count(a.ops.totals.totalMs), count(b.ops.totals.totalMs), 'ms'),
        row('in subagents', count(a.ops.totals.subagentCalls), count(b.ops.totals.subagentCalls), 'count'),
        ...categoryRows(a, b),
      ],
    },
    {
      title: 'phases',
      rows: [
        row('tokens before the plan', tokensBefore(a), tokensBefore(b), 'tokens'),
        row('tokens after the plan', tokensAfter(a), tokensAfter(b), 'tokens'),
        row('planning duration', phase(a, 'PLANNING', (p) => p.wallMs), phase(b, 'PLANNING', (p) => p.wallMs), 'ms'),
        row(
          'implementation duration',
          phase(a, 'IMPLEMENTATION', (p) => p.wallMs),
          phase(b, 'IMPLEMENTATION', (p) => p.wallMs),
          'ms',
        ),
      ],
    },
    {
      title: 'plan',
      rows: [
        row('plan revisions', a.plan.planRevisions, b.plan.planRevisions, 'count'),
        row('plan edits', a.plan.planEdits, b.plan.planEdits, 'count'),
        row('edits after work started', a.plan.planEditsAfterImplStart, b.plan.planEditsAfterImplStart, 'count'),
        row('progress ticks', a.plan.progressTicks, b.plan.progressTicks, 'count'),
        row('steps added', a.plan.stepsAdded, b.plan.stepsAdded, 'count'),
        row('steps removed', a.plan.stepsRemoved, b.plan.stepsRemoved, 'count'),
      ],
    },
    {
      title: 'improvements',
      rows: [
        row('iterations after implementation', a.improvements.iterations, b.improvements.iterations, 'count'),
        row('questions (no edits)', a.improvements.questions, b.improvements.questions, 'count'),
        row('edits after the plan', a.improvements.postPlanEdits, b.improvements.postPlanEdits, 'count'),
        row('unplanned edits', a.improvements.unplannedEdits, b.improvements.unplannedEdits, 'count'),
        row('unplanned share', a.improvements.unplannedShare, b.improvements.unplannedShare, 'pct'),
      ],
    },
  ];
}

function tokensBefore(m: SessionMetrics): Metric {
  if (!m.plan.detected) return unavailable('no plan');
  const p = m.phases.beforePlan;
  return metric(p.freshInput + p.output, m.phases.tokensProvenance);
}

function tokensAfter(m: SessionMetrics): Metric {
  if (!m.plan.detected) return unavailable('no plan');
  const p = m.phases.afterPlan;
  return metric(p.freshInput + p.output, m.phases.tokensProvenance);
}

/** The only grouping that compares fairly when the two sides are different agents. */
function categoryRows(a: SessionMetrics, b: SessionMetrics): CompareRow[] {
  const keys = new Set([...a.ops.byCategory.map((r) => r.key), ...b.ops.byCategory.map((r) => r.key)]);
  const rows: CompareRow[] = [];
  for (const key of keys) {
    const ra = a.ops.byCategory.find((r) => r.key === key);
    const rb = b.ops.byCategory.find((r) => r.key === key);
    rows.push(row(`  ${key}`, count(ra?.calls ?? 0), count(rb?.calls ?? 0), 'count'));
  }
  return rows;
}
