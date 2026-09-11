/**
 * Assessments made by a reviewing thread.
 *
 * A thread whose job is to judge another agent runs no tools of its own, so
 * every operations metric is empty for it and the dock has nothing to say. What
 * it does produce is decisions — how many, which way they went, how much risk
 * they carried, and how long each took. That is the analysis this kind of
 * transcript supports, and it is computed here from `CanonEvent.review` alone:
 * no vendor's vocabulary reaches this file, only the normalized decision.
 */

import type { CanonEvent, ReviewFact } from '../model/canon.js';
import { metric, unavailable, type ReviewStats, type ReviewVerdict } from '../model/metrics.js';

export function computeReview(events: readonly CanonEvent[]): ReviewStats {
  const verdicts: ReviewVerdict[] = [];
  /** requests per thread, so only the threads that judge are counted */
  const askedOf = new Map<string, number>();
  const judging = new Set<string>();
  /**
   * ts of the request each thread is waiting on. Kept per lane because a review
   * thread merged into the session it watches sits among that session's own
   * prompts, and pairing a verdict with the human's last message would measure
   * something nobody asked about.
   */
  const pendingOf = new Map<string, number>();
  const MAIN = '';

  for (const ev of events) {
    const lane = ev.lane ?? MAIN;
    // A request is whatever opened the turn; for a review thread that is the
    // machine-composed prompt carrying the planned action.
    if (ev.kind === 'prompt') {
      askedOf.set(lane, (askedOf.get(lane) ?? 0) + 1);
      pendingOf.set(lane, ev.ts);
      continue;
    }
    const fact: ReviewFact | undefined = ev.review;
    if (!fact) continue;
    judging.add(lane);
    const pending = pendingOf.get(lane) ?? 0;
    verdicts.push({
      idx: ev.idx,
      ts: ev.ts,
      decision: fact.decision,
      outcome: fact.outcome,
      risk: fact.risk,
      authorization: fact.authorization,
      rationale: fact.rationale ?? '',
      subject: fact.subject,
      ms: pending && ev.ts >= pending ? ev.ts - pending : null,
    });
    pendingOf.set(lane, 0);
  }

  if (!verdicts.length) {
    return {
      detected: false,
      verdicts: [],
      assessments: unavailable('this session made no reviewed decisions'),
      allowed: unavailable(),
      blocked: unavailable(),
      escalated: unavailable(),
      unanswered: unavailable(),
      medianMs: unavailable(),
      byRisk: [],
    };
  }

  // Only the threads that actually decided things: in a merged session the
  // human's own prompts are not requests anyone reviewed.
  let asked = 0;
  for (const lane of judging) asked += askedOf.get(lane) ?? 0;

  const count = (d: ReviewVerdict['decision']): number => verdicts.filter((v) => v.decision === d).length;
  const timed = verdicts.map((v) => v.ms).filter((n): n is number => n !== null);
  const risk = new Map<string, number>();
  for (const v of verdicts) {
    const key = v.risk ?? 'unstated';
    risk.set(key, (risk.get(key) ?? 0) + 1);
  }

  return {
    detected: true,
    verdicts,
    assessments: metric(verdicts.length, 'reported'),
    allowed: metric(count('allow'), 'reported'),
    blocked: metric(count('block'), 'reported'),
    escalated: metric(count('ask'), 'reported'),
    // A request the reviewer never answered is the interesting failure here.
    unanswered: metric(Math.max(0, asked - verdicts.length), 'derived'),
    medianMs: timed.length
      ? metric(median(timed), 'derived', timed.length / verdicts.length)
      : unavailable('no request could be paired with its verdict'),
    byRisk: [...risk].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
