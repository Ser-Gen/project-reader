/**
 * "How much work happened after the plan was implemented, and was any of it
 * unplanned?" (SPEC §6.5).
 *
 * Two measures, reported side by side because they answer different halves of
 * the question:
 *
 *   iterations     — human-driven rounds after implementation ended that
 *                    actually changed code. A prompt that only asked a question
 *                    is not an improvement, and is counted separately.
 *   unplanned work — post-plan edits to files no plan revision ever mentions.
 */

import type { CanonEvent, Segment } from '../model/canon.js';
import type { ImprovementStats, Iteration, PhaseModel, PlanStats } from '../model/metrics.js';
import { metric, unavailable } from '../model/metrics.js';
import { planMatcher } from './plan.js';
import { emptySums, accumulate } from './tokens.js';

export function computeImprovements(
  events: readonly CanonEvent[],
  segments: readonly Segment[],
  plan: PlanStats,
  phases: PhaseModel,
): ImprovementStats {
  const planCreated = phases.planCreated?.ts ?? 0;
  const implEnd = phases.implEnd?.ts ?? 0;

  if (!plan.detected || !planCreated) {
    const na = unavailable('no plan was detected, so there is no "after the plan"');
    return {
      available: false,
      iterations: na,
      questions: na,
      rows: [],
      postPlanEdits: na,
      postPlanLinesAdded: na,
      postPlanLinesRemoved: na,
      unplannedEdits: na,
      unplannedShare: na,
      unplannedFiles: [],
      plannedFiles: [],
      churn: [],
    };
  }

  const named = planMatcher(plan.revisions.map((r) => r.text).join('\n'));

  /* ---- unplanned work: post-plan edits to files the plan never names ---- */
  const planned = new Map<string, number>();
  const unplanned = new Map<string, number>();
  const churn = new Map<string, number>();
  let postPlanEdits = 0;
  let adds = 0;
  let dels = 0;

  for (const ev of events) {
    if (ev.kind !== 'op' || ev.op?.category !== 'edit' || !ev.ts || ev.ts < planCreated) continue;
    postPlanEdits++;
    adds += ev.op.linesAdded ?? 0;
    dels += ev.op.linesRemoved ?? 0;
    const path = ev.op.target;
    if (!path) continue;
    churn.set(path, (churn.get(path) ?? 0) + 1);
    const bucket = named(path) ? planned : unplanned;
    bucket.set(path, (bucket.get(path) ?? 0) + 1);
  }
  const unplannedEdits = [...unplanned.values()].reduce((n, v) => n + v, 0);

  /* ---- iterations: human rounds after implementation that changed code ---- */
  const rows: Iteration[] = [];
  let questions = 0;

  for (const seg of segments) {
    if (seg.promptIdx < 0) continue;
    const prompt = events[seg.promptIdx];
    if (!prompt?.ts || prompt.ts <= implEnd) continue;

    const sums = emptySums();
    const files = new Set<string>();
    let ops = 0;
    let edits = 0;
    let segAdds = 0;
    let segDels = 0;
    let lastTs = prompt.ts;
    for (let i = seg.firstEvent; i <= seg.lastEvent && i < events.length; i++) {
      const ev = events[i];
      accumulate(sums, ev);
      if (ev.ts) lastTs = Math.max(lastTs, ev.endTs ?? ev.ts);
      if (ev.kind !== 'op' || !ev.op) continue;
      ops++;
      if (ev.op.category === 'edit') {
        edits++;
        segAdds += ev.op.linesAdded ?? 0;
        segDels += ev.op.linesRemoved ?? 0;
        if (ev.op.target) files.add(ev.op.target);
      }
    }
    if (!edits) {
      questions++;
      continue;
    }
    rows.push({
      seg: seg.idx,
      idx: seg.promptIdx,
      ts: prompt.ts,
      title: seg.title,
      ops,
      edits,
      files: [...files],
      linesAdded: segAdds,
      linesRemoved: segDels,
      freshInput: sums.freshInput,
      output: sums.output,
      contextCost: sums.contextCost,
      durationMs: Math.max(0, lastTs - prompt.ts),
    });
  }

  const sortDesc = (m: Map<string, number>) =>
    [...m.entries()].map(([path, edits]) => ({ path, edits })).sort((a, b) => b.edits - a.edits);

  const inferred = phases.implEnd?.confidence === 'inferred';
  const note = inferred ? 'the end of implementation was inferred, not observed' : undefined;

  return {
    available: true,
    iterations: metric(rows.length, 'derived', undefined, note),
    questions: metric(questions, 'derived', undefined, note),
    rows,
    postPlanEdits: metric(postPlanEdits, 'derived'),
    postPlanLinesAdded: metric(adds, 'derived'),
    postPlanLinesRemoved: metric(dels, 'derived'),
    unplannedEdits: metric(unplannedEdits, 'derived'),
    unplannedShare: postPlanEdits
      ? metric(unplannedEdits / postPlanEdits, 'derived', undefined, 'of all edits made after the plan')
      : unavailable('no edits after the plan'),
    unplannedFiles: sortDesc(unplanned),
    plannedFiles: sortDesc(planned),
    churn: sortDesc(churn),
  };
}
