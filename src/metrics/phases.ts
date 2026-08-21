/**
 * Phase segmentation (SPEC §6.4).
 *
 *   PRE_PLAN ──▶ PLANNING ──▶ IMPLEMENTATION ──▶ POST_PLAN
 *
 * Only `planCreated` is usually observable. The others fall back through a
 * documented chain of rules, and every boundary carries the rule that produced
 * it and whether it was observed or inferred — because a post-plan metric is
 * only as trustworthy as the boundary it is measured from.
 */

import type { CanonEvent, OpCategory, Segment } from '../model/canon.js';
import type { Boundary, MetricOptions, PhaseId, PhaseModel, PhaseStats, PlanStats } from '../model/metrics.js';
import { planMatcher } from './plan.js';
import { idleGaps, opIntervals, unionLength } from './time.js';
import { accumulate, emptySums } from './tokens.js';

const ORDER: PhaseId[] = ['PRE_PLAN', 'PLANNING', 'IMPLEMENTATION', 'POST_PLAN'];

function emptyPhase(id: PhaseId, from: number, to: number): PhaseStats {
  return {
    id,
    from,
    to,
    firstIdx: -1,
    lastIdx: -1,
    wallMs: 0,
    activeMs: 0,
    busyMs: 0,
    freshInput: 0,
    output: 0,
    cacheRead: 0,
    contextCost: 0,
    requests: 0,
    prompts: 0,
    ops: 0,
    opsByCategory: {},
    files: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };
}

/** Which phase an event falls in, from the boundary timestamps. */
function phaseOf(ts: number, planningStart: number, planCreated: number, implEnd: number): PhaseId {
  if (planningStart && ts < planningStart) return 'PRE_PLAN';
  if (planCreated && ts < planCreated) return 'PLANNING';
  if (!implEnd || ts <= implEnd) return 'IMPLEMENTATION';
  return 'POST_PLAN';
}

export function computePhases(
  events: readonly CanonEvent[],
  segments: readonly Segment[],
  plan: PlanStats,
  opts: MetricOptions,
): PhaseModel {
  const endTs = lastTs(events);
  const end: Boundary = { ts: endTs, rule: 'last event', confidence: 'observed' };

  if (!plan.detected || !plan.revisions.length) {
    const phase = emptyPhase('NO_PLAN', firstTs(events), endTs);
    fill(phase, events, opts);
    return {
      planningStart: null,
      planCreated: null,
      implEnd: null,
      end,
      phases: [phase],
      episode: 0,
      episodeCount: 0,
      beforePlan: { freshInput: 0, output: 0, contextCost: 0, requests: 0 },
      afterPlan: { freshInput: 0, output: 0, contextCost: 0, requests: 0 },
      tokensProvenance: 'unavailable',
    };
  }

  const episodeIdx = Math.min(Math.max(0, opts.episode ?? 0), plan.episodes.length - 1);
  const episode = plan.episodes[episodeIdx];
  const created = plan.revisions[episode.rev];
  const nextEpisode = plan.episodes[episodeIdx + 1];
  const episodeEnd = nextEpisode ? nextEpisode.ts : Infinity;

  let planCreated: Boundary = {
    ts: created.ts,
    rule: created.approved ? 'first approved plan revision' : 'first plan revision (no approval signal)',
    confidence: created.approved ? 'observed' : 'inferred',
  };

  let planningStart = findPlanningStart(events, segments, created.idx);
  let implEnd = findImplEnd(events, plan, created.ts, episodeEnd, endTs, opts);

  // A dragged marker beats every rule.
  const ov = opts.overrides ?? {};
  if (ov.planningStart) planningStart = { ts: ov.planningStart, rule: 'set by hand', confidence: 'observed', manual: true };
  if (ov.planCreated) planCreated = { ts: ov.planCreated, rule: 'set by hand', confidence: 'observed', manual: true };
  if (ov.implEnd) implEnd = { ts: ov.implEnd, rule: 'set by hand', confidence: 'observed', manual: true };
  if (planningStart.ts > planCreated.ts) planningStart = { ...planCreated, rule: 'clamped to plan creation' };
  if (implEnd.ts < planCreated.ts) implEnd = { ...planCreated, rule: 'clamped to plan creation' };

  // Phases must tile the session exactly, so the boundaries are clamped into
  // order and into the session's own span before anything is measured from them.
  const start = firstTs(events);
  const clamp = (v: number, lo: number) => Math.min(Math.max(v, lo), endTs);
  const bounds = { start, planningStart: 0, planCreated: 0, implEnd: 0, end: endTs };
  bounds.planningStart = clamp(planningStart.ts, start);
  bounds.planCreated = clamp(planCreated.ts, bounds.planningStart);
  bounds.implEnd = clamp(implEnd.ts, bounds.planCreated);
  const buckets = new Map<PhaseId, CanonEvent[]>();
  for (const id of ORDER) buckets.set(id, []);
  let lastPhase: PhaseId = 'PRE_PLAN';
  for (const ev of events) {
    const id: PhaseId = ev.ts ? phaseOf(ev.ts, bounds.planningStart, bounds.planCreated, bounds.implEnd) : lastPhase;
    lastPhase = id;
    buckets.get(id)!.push(ev);
  }

  const spans: Record<PhaseId, [number, number]> = {
    PRE_PLAN: [bounds.start, bounds.planningStart],
    PLANNING: [bounds.planningStart, bounds.planCreated],
    IMPLEMENTATION: [bounds.planCreated, bounds.implEnd],
    POST_PLAN: [bounds.implEnd, bounds.end],
    NO_PLAN: [bounds.start, bounds.end],
  };

  const phases: PhaseStats[] = [];
  for (const id of ORDER) {
    const evs = buckets.get(id)!;
    const [from, to] = spans[id];
    const p = emptyPhase(id, from, Math.max(from, to));
    fill(p, evs, opts);
    phases.push(p);
  }

  const before = emptySums();
  const after = emptySums();
  for (const ev of events) {
    if (!ev.ts) continue;
    accumulate(ev.ts < bounds.planCreated ? before : after, ev);
  }
  const reported = before.requests + after.requests > 0;

  return {
    planningStart,
    planCreated,
    implEnd,
    end,
    phases,
    episode: episodeIdx,
    episodeCount: plan.episodes.length,
    beforePlan: {
      freshInput: before.freshInput,
      output: before.output,
      contextCost: before.contextCost,
      requests: before.requests,
    },
    afterPlan: {
      freshInput: after.freshInput,
      output: after.output,
      contextCost: after.contextCost,
      requests: after.requests,
    },
    tokensProvenance: reported ? 'reported' : 'estimated',
  };
}

/** Entering plan mode, or failing that the turn that produced the first plan. */
function findPlanningStart(events: readonly CanonEvent[], segments: readonly Segment[], createdIdx: number): Boundary {
  for (let i = createdIdx; i >= 0; i--) {
    const ev = events[i];
    if (ev?.plan?.role === 'start') {
      return { ts: ev.ts, rule: 'entered plan mode', confidence: 'observed' };
    }
  }
  const seg = segments[events[createdIdx]?.seg ?? 0];
  if (seg) {
    return { ts: seg.ts || events[createdIdx].ts, rule: 'start of the turn that produced the plan', confidence: 'inferred' };
  }
  return { ts: events[createdIdx]?.ts ?? 0, rule: 'first plan revision', confidence: 'inferred' };
}

/**
 * When implementation finished. Observed only when the plan tracks step status;
 * otherwise the documented fallbacks, each marked inferred.
 */
function findImplEnd(
  events: readonly CanonEvent[],
  plan: PlanStats,
  createdTs: number,
  episodeEnd: number,
  endTs: number,
  opts: MetricOptions,
): Boundary {
  // ① the last plan step flips to done
  for (const rev of plan.revisions) {
    if (rev.ts < createdTs || rev.ts > episodeEnd) continue;
    const tracked = rev.steps.filter((s) => s.status !== 'unknown');
    if (tracked.length && tracked.every((s) => s.status === 'done')) {
      return { ts: rev.ts, rule: 'every plan step marked done', confidence: 'observed' };
    }
  }

  // ② the last edit to a file the plan names
  const named = planMatcher(plan.revisions.map((r) => r.text).join('\n'));
  let lastPlanned = 0;
  let lastEdit = 0;
  for (const ev of events) {
    if (ev.kind !== 'op' || ev.op?.category !== 'edit' || !ev.ts) continue;
    if (ev.ts < createdTs || ev.ts > episodeEnd) continue;
    lastEdit = Math.max(lastEdit, ev.endTs ?? ev.ts);
    if (ev.op.target && named(ev.op.target)) {
      lastPlanned = Math.max(lastPlanned, ev.endTs ?? ev.ts);
    }
  }
  if (lastPlanned) {
    return { ts: lastPlanned, rule: 'last edit to a file the plan names', confidence: 'inferred' };
  }

  // ③ the last edit before the first long idle gap after the plan
  const gaps = idleGaps(events, opts.idleThresholdMs).filter((g) => g.from > createdTs);
  if (gaps.length && lastEdit) {
    const cut = gaps[0].from;
    let before = 0;
    for (const ev of events) {
      if (ev.kind !== 'op' || ev.op?.category !== 'edit' || !ev.ts) continue;
      if (ev.ts <= cut) before = Math.max(before, ev.endTs ?? ev.ts);
    }
    if (before) {
      return { ts: before, rule: 'last edit before the first long pause after the plan', confidence: 'inferred' };
    }
  }

  // ④ nothing to go on
  return { ts: endTs, rule: 'end of the conversation', confidence: 'inferred' };
}

function fill(p: PhaseStats, events: readonly CanonEvent[], opts: MetricOptions): void {
  const sums = emptySums();
  const files = new Set<string>();
  const byCat: Partial<Record<OpCategory, number>> = {};
  for (const ev of events) {
    if (p.firstIdx < 0) p.firstIdx = ev.idx;
    p.lastIdx = ev.idx;
    accumulate(sums, ev);
    if (ev.kind === 'prompt') p.prompts++;
    if (ev.kind === 'op' && ev.op) {
      p.ops++;
      byCat[ev.op.category] = (byCat[ev.op.category] ?? 0) + 1;
      if (ev.op.category === 'edit') {
        if (ev.op.target) files.add(ev.op.target);
        p.linesAdded += ev.op.linesAdded ?? 0;
        p.linesRemoved += ev.op.linesRemoved ?? 0;
      }
    }
  }
  p.freshInput = sums.freshInput;
  p.output = sums.output;
  p.cacheRead = sums.cacheRead;
  p.contextCost = sums.contextCost;
  p.requests = sums.requests;
  p.opsByCategory = byCat;
  p.files = files.size;
  p.wallMs = Math.max(0, p.to - p.from);
  const idle = idleGaps(events, opts.idleThresholdMs).reduce((n, g) => n + g.ms, 0);
  p.activeMs = Math.max(0, p.wallMs - idle);
  p.busyMs = unionLength(opIntervals(events));
}

function firstTs(events: readonly CanonEvent[]): number {
  for (const ev of events) if (ev.ts) return ev.ts;
  return 0;
}

function lastTs(events: readonly CanonEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].ts) return events[i].ts;
  return 0;
}
