/**
 * Plan detection and revision diffing (SPEC §6.3).
 *
 * The hard part is not finding a plan, it is deciding what counts as *editing*
 * one. A TodoWrite-heavy session emits dozens of revisions that only tick a box;
 * counting those as "40 edits to the plan" would make the metric useless. So a
 * revision is only an edit when its *steps* changed — added, removed, reworded
 * past the similarity threshold, or reordered. Everything else is a progress tick.
 */

import type { CanonEvent, PlanArtifact, PlanRevision, PlanStep } from '../model/canon.js';
import type { MetricOptions, PlanDiff, PlanStats, PlanStepChange } from '../model/metrics.js';
import { metric, unavailable } from '../model/metrics.js';
import { matchSteps, normalizeStep } from './steps.js';
import { oneLine } from '../vendor/text.js';

const PRIORITY: PlanRevision['source'][] = ['plan-mode', 'plan-tool', 'file'];

interface Artifact {
  idx: number;
  ts: number;
  plan: PlanArtifact;
}

function emptyStats(reason: string): PlanStats {
  const na = () => unavailable('no plan was detected in this conversation');
  return {
    detected: false,
    source: null,
    reason,
    revisions: [],
    diffs: [],
    planRevisions: metric(0, 'derived'),
    planEdits: na(),
    progressTicks: na(),
    planEditsDuringPlanning: na(),
    planEditsAfterImplStart: na(),
    stepsAdded: na(),
    stepsRemoved: na(),
    stepsReworded: na(),
    stepsReordered: na(),
    planTextGrowth: na(),
    stepsTotal: na(),
    stepsDone: na(),
    checklistLike: false,
    episodes: [],
  };
}

/** Compare two revisions and say what actually changed. */
export function diffRevisions(prev: PlanRevision, next: PlanRevision, partial: boolean): PlanStepChange[] {
  if (partial) {
    // An edit to a plan *file* only carries the fragment it replaced, so the
    // honest reading is "the document changed", not a step-level diff.
    return [{ kind: 'reworded', to: oneLine(next.text, 80) }];
  }
  const matches = matchSteps(prev.steps, next.steps);
  const changes: PlanStepChange[] = [];
  const order: number[] = [];

  for (const m of matches) {
    if (m.prev === -1 && m.next >= 0) {
      changes.push({ kind: 'added', to: next.steps[m.next].text });
    } else if (m.next === -1 && m.prev >= 0) {
      changes.push({ kind: 'removed', from: prev.steps[m.prev].text });
    } else if (m.prev >= 0 && m.next >= 0) {
      const a = prev.steps[m.prev];
      const b = next.steps[m.next];
      order.push(m.prev);
      if (normalizeStep(a.text) !== normalizeStep(b.text)) {
        changes.push({ kind: 'reworded', from: a.text, to: b.text });
      } else if (a.status !== b.status) {
        changes.push({ kind: 'status', to: b.text, status: b.status });
      }
    }
  }

  // Matched steps that moved relative to each other.
  for (let i = 1; i < order.length; i++) {
    if (order[i] < order[i - 1]) {
      changes.push({ kind: 'reordered', to: next.steps[i]?.text });
      break;
    }
  }
  return changes;
}

export function computePlan(events: readonly CanonEvent[], opts: MetricOptions): PlanStats {
  const artifacts: Artifact[] = [];
  for (const ev of events) {
    if (ev.plan) artifacts.push({ idx: ev.idx, ts: ev.ts, plan: ev.plan });
  }
  if (!artifacts.length) return emptyStats('no plan tool, plan mode or plan file was used');
  if (opts.planSource === 'none') return emptyStats('plan detection was switched off for this conversation');

  const present = new Set(artifacts.filter((a) => a.plan.role === 'revision').map((a) => a.plan.source));
  const forced = opts.planSource;
  const chosen = forced && present.has(forced) ? forced : PRIORITY.find((s) => present.has(s));
  if (!chosen) {
    return emptyStats('planning was entered but no plan was ever produced');
  }

  // Plan mode wins, but edits to a plan *document* are still edits to the plan.
  const accept = new Set<PlanRevision['source']>(chosen === 'plan-mode' ? ['plan-mode', 'file'] : [chosen]);
  const partials = new Set<number>();
  const revisions: PlanRevision[] = [];
  for (const a of artifacts) {
    if (a.plan.role !== 'revision' || !accept.has(a.plan.source)) continue;
    if (a.plan.partial) partials.add(revisions.length);
    revisions.push({
      idx: a.idx,
      ts: a.ts,
      source: a.plan.source,
      approved: a.plan.approved,
      path: a.plan.path,
      text: a.plan.text,
      steps: a.plan.steps,
    });
  }
  if (!revisions.length) return emptyStats('planning was entered but no plan was ever produced');

  const reason =
    chosen === 'plan-mode' ? 'plan mode payload'
    : chosen === 'plan-tool' ? 'structured plan/todo tool'
    : `plan file (${revisions[0].path ?? 'markdown'})`;

  const created = revisions.find((r) => r.approved) ?? revisions[0];
  const diffs: PlanDiff[] = [];
  let edits = 0;
  let ticks = 0;
  let added = 0;
  let removed = 0;
  let reworded = 0;
  let reordered = 0;
  let duringPlanning = 0;
  let afterImplStart = 0;

  for (let i = 1; i < revisions.length; i++) {
    const changes = diffRevisions(revisions[i - 1], revisions[i], partials.has(i));
    const structural = changes.some((c) => c.kind !== 'status');
    const after = revisions[i].ts > created.ts;
    if (structural) {
      edits++;
      if (after) afterImplStart++;
      else duringPlanning++;
      for (const c of changes) {
        if (c.kind === 'added') added++;
        else if (c.kind === 'removed') removed++;
        else if (c.kind === 'reworded') reworded++;
        else if (c.kind === 'reordered') reordered++;
      }
    } else if (changes.length) {
      ticks++;
    }
    diffs.push({ rev: i, idx: revisions[i].idx, ts: revisions[i].ts, structural, changes, afterImplStart: after });
  }

  // A new plan episode is a *re-plan*: work happened, and then the plan was
  // largely replaced. Adding one step to a todo list is an edit, not a new plan,
  // which is the difference between "planned twice" and "planned once, loudly".
  const episodes: PlanStats['episodes'] = [];
  let lastEpisodeIdx = -1;
  for (let i = 0; i < revisions.length; i++) {
    const r = revisions[i];
    if (episodes.length === 0) {
      episodes.push({ rev: i, idx: r.idx, ts: r.ts });
      lastEpisodeIdx = r.idx;
      continue;
    }
    if (!r.approved) continue;
    const diff = diffs.find((d) => d.rev === i);
    if (!diff?.structural) continue;
    const replaced = diff.changes.filter((c) => c.kind === 'added' || c.kind === 'removed').length;
    const scale = Math.max(1, r.steps.length);
    const rePlan = r.source === 'plan-mode' || replaced / scale >= 0.6;
    if (!rePlan) continue;
    const worked = events.some(
      (e) => e.idx > lastEpisodeIdx && e.idx < r.idx && e.kind === 'op' && e.op?.category === 'edit',
    );
    if (worked) {
      episodes.push({ rev: i, idx: r.idx, ts: r.ts });
      lastEpisodeIdx = r.idx;
    }
  }

  const last = revisions[revisions.length - 1];
  const stepsDone = last.steps.filter((s: PlanStep) => s.status === 'done').length;
  const changed = diffs.length;
  const checklistLike = changed >= 5 && ticks / changed >= 0.8;

  return {
    detected: true,
    source: chosen,
    reason,
    revisions,
    diffs,
    planRevisions: metric(revisions.length, 'derived'),
    planEdits: metric(edits, 'derived'),
    progressTicks: metric(ticks, 'derived'),
    planEditsDuringPlanning: metric(duringPlanning, 'derived'),
    planEditsAfterImplStart: metric(afterImplStart, 'derived'),
    stepsAdded: metric(added, 'derived'),
    stepsRemoved: metric(removed, 'derived'),
    stepsReworded: metric(reworded, 'derived'),
    stepsReordered: metric(reordered, 'derived'),
    planTextGrowth: metric(last.text.length - revisions[0].text.length, 'derived'),
    stepsTotal: metric(last.steps.length, 'derived'),
    stepsDone: last.steps.some((s: PlanStep) => s.status !== 'unknown')
      ? metric(stepsDone, 'derived')
      : unavailable('this plan carries no step status'),
    checklistLike,
    episodes,
  };
}

/**
 * Does a plan name this file?
 *
 * Tried in order: exact path, path suffix, basename, basename without its
 * extension. Backticks and fences are flattened first so a path mentioned inside
 * a code span still counts — false negatives here are the difference between
 * "the plan missed half the work" and "the plan didn't spell out a filename".
 *
 * Returned as a closure because the plan text is asked about once per edit and
 * flattening it each time is the difference between a millisecond and ten.
 */
export function planMatcher(planText: string): (path: string) => boolean {
  const hay = planText ? planText.toLowerCase().replace(/[`*_]/g, '') : '';
  const memo = new Map<string, boolean>();
  return (path: string) => {
    if (!hay || !path) return false;
    const hit = memo.get(path);
    if (hit !== undefined) return hit;
    const answer = mentions(hay, path.toLowerCase());
    memo.set(path, answer);
    return answer;
  };
}

/** One-shot form, for callers with a single question to ask. */
export function planMentionsFile(planText: string, path: string): boolean {
  return planMatcher(planText)(path);
}

function mentions(hay: string, p: string): boolean {
  if (hay.includes(p)) return true;
  const parts = p.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const suffix = parts.slice(i).join('/');
    if (suffix.length > 3 && hay.includes(suffix)) return true;
  }
  const base = parts[parts.length - 1] ?? '';
  if (base.length > 3 && hay.includes(base)) return true;
  const stem = base.replace(/\.[^.]+$/, '');
  return stem.length > 3 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay);
}

/** The first planning signal, used as the PLANNING boundary. */
export function planningStartIdx(events: readonly CanonEvent[]): CanonEvent | undefined {
  return events.find((e) => e.plan?.role === 'start');
}
