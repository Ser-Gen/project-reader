/**
 * The three clocks (SPEC §6.2).
 *
 * "How long did this session take" has three defensible answers and the tool
 * refuses to pick one for you:
 *
 *   wall   — last timestamp minus first. Includes the lunch break.
 *   active — wall minus every gap longer than the idle threshold.
 *   busy   — the union of operation intervals. Parallel calls count once, which
 *            is the only sound answer to "how much time did operations take".
 */

import type { CanonEvent } from '../model/canon.js';
import { metric, unavailable, type IdleGap, type Metric, type TimeStats } from '../model/metrics.js';

export interface Interval {
  from: number;
  to: number;
}

/** Total length of a union of intervals — overlapping work is not counted twice. */
export function unionLength(intervals: Interval[]): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  let total = 0;
  let from = sorted[0].from;
  let to = sorted[0].to;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.from > to) {
      total += to - from;
      from = iv.from;
      to = iv.to;
    } else if (iv.to > to) {
      to = iv.to;
    }
  }
  return total + (to - from);
}

export function opIntervals(events: readonly CanonEvent[]): Interval[] {
  const out: Interval[] = [];
  for (const ev of events) {
    if (ev.kind !== 'op' || !ev.ts || !ev.endTs) continue;
    if (ev.endTs <= ev.ts) continue;
    out.push({ from: ev.ts, to: ev.endTs });
  }
  return out;
}

/** Gaps longer than the threshold, in order, so the subtraction stays auditable. */
export function idleGaps(events: readonly CanonEvent[], thresholdMs: number): IdleGap[] {
  const gaps: IdleGap[] = [];
  let prev = 0;
  let prevIdx = 0;
  for (const ev of events) {
    if (!ev.ts || ev.tsSource !== 'record') continue;
    if (prev && ev.ts - prev > thresholdMs) {
      gaps.push({ from: prev, to: ev.ts, ms: ev.ts - prev, idx: prevIdx });
    }
    if (ev.ts >= prev) {
      prev = ev.ts;
      prevIdx = ev.idx;
    }
  }
  return gaps;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export function computeTime(events: readonly CanonEvent[], thresholdMs: number): TimeStats {
  let first = 0;
  let last = 0;
  let stamped = 0;
  for (const ev of events) {
    if (!ev.ts || ev.tsSource !== 'record') continue;
    stamped++;
    if (!first || ev.ts < first) first = ev.ts;
    if (ev.ts > last) last = ev.ts;
  }
  const coverage = events.length ? stamped / events.length : 0;
  const wall = first && last > first ? last - first : 0;
  const gaps = idleGaps(events, thresholdMs);
  const idle = gaps.reduce((n, g) => n + g.ms, 0);

  const intervals = opIntervals(events);
  const opCount = events.reduce((n, e) => n + (e.kind === 'op' ? 1 : 0), 0);
  const busyCoverage = opCount ? intervals.length / opCount : 0;

  // Think time: from the start of an assistant turn to its first operation.
  // Human latency: from an operation's result to the next human prompt.
  const think: number[] = [];
  const human: number[] = [];
  let turnStart = 0;
  let lastResult = 0;
  for (const ev of events) {
    if (!ev.ts) continue;
    if (ev.kind === 'text' || ev.kind === 'reasoning') {
      if (!turnStart) turnStart = ev.ts;
    } else if (ev.kind === 'op') {
      if (turnStart && ev.ts >= turnStart) think.push(ev.ts - turnStart);
      turnStart = 0;
      if (ev.endTs) lastResult = ev.endTs;
    } else if (ev.kind === 'prompt') {
      if (lastResult && ev.ts > lastResult) human.push(ev.ts - lastResult);
      turnStart = 0;
      lastResult = 0;
    }
  }

  const clock = (v: number, note?: string): Metric =>
    stamped ? metric(v, 'derived', coverage, note) : unavailable('no timestamps recorded');

  const thinkMs = median(think);
  const humanMs = median(human);

  return {
    wall: clock(wall, 'first event to last'),
    active: clock(Math.max(0, wall - idle), `${gaps.length} idle gaps removed`),
    busy: intervals.length
      ? metric(unionLength(intervals), 'derived', busyCoverage, 'union of operation intervals')
      : unavailable('no operation had both a start and an end timestamp'),
    idleMs: clock(idle),
    idleGaps: gaps,
    idleThresholdMs: thresholdMs,
    thinkMs: thinkMs === null ? unavailable() : metric(thinkMs, 'derived', undefined, 'median per turn'),
    humanMs: humanMs === null ? unavailable() : metric(humanMs, 'derived', undefined, 'median per prompt'),
  };
}
