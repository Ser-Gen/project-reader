/**
 * Token accounting (SPEC §5).
 *
 * Two measures live here and are never added together:
 *
 *   billed usage  — what the vendor recorded per API request. `freshInput` is
 *                   the honest "input" figure; cache reads are the same context
 *                   sent again, so folding them in (as the old reader did)
 *                   inflates a long session by an order of magnitude.
 *   context cost  — the estimated tokens an operation pushed into the
 *                   conversation. This is what "tokens spent on an operation"
 *                   means here, because no vendor bills per tool call.
 */

import type { CanonEvent } from '../model/canon.js';
import { metric, unavailable, type TokenTotals } from '../model/metrics.js';

export interface TokenSums {
  freshInput: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  requests: number;
  contextPeak: number;
  contextCost: number;
  opIn: number;
  opOut: number;
}

export function emptySums(): TokenSums {
  return {
    freshInput: 0,
    cacheRead: 0,
    output: 0,
    reasoning: 0,
    requests: 0,
    contextPeak: 0,
    contextCost: 0,
    opIn: 0,
    opOut: 0,
  };
}

/** Fold one event into a running total. Used for the session and per phase. */
export function accumulate(sums: TokenSums, ev: CanonEvent): void {
  const r = ev.tokens.reported;
  if (r) {
    sums.freshInput += r.input + r.cacheWrite;
    sums.cacheRead += r.cacheRead;
    sums.output += r.output;
    sums.reasoning += r.reasoning ?? 0;
    sums.requests++;
    const context = r.input + r.cacheWrite + r.cacheRead;
    if (context > sums.contextPeak) sums.contextPeak = context;
  }
  if (ev.kind === 'op') {
    sums.opIn += ev.tokens.payloadIn ?? 0;
    sums.opOut += ev.tokens.payloadOut ?? 0;
    sums.contextCost += (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);
  }
}

export function computeTokens(events: readonly CanonEvent[]): TokenTotals {
  const all = emptySums();
  const sub = emptySums();
  for (const ev of events) {
    accumulate(all, ev);
    if (ev.sidechain > 0) accumulate(sub, ev);
  }

  const reported = all.requests > 0;
  const billed = (v: number) =>
    reported ? metric(v, 'reported') : unavailable('this vendor records no per-request usage');

  return {
    headline:
      reported ?
        metric(all.freshInput + all.output, 'reported', undefined, 'fresh input + output')
      : unavailable('this vendor records no per-request usage'),
    freshInput: billed(all.freshInput),
    output: billed(all.output),
    cacheRead: billed(all.cacheRead),
    billedInput: reported
      ? metric(all.freshInput + all.cacheRead, 'reported', undefined, 'includes re-sent context')
      : unavailable('this vendor records no per-request usage'),
    contextPeak: billed(all.contextPeak),
    requests: reported ? metric(all.requests, 'reported') : metric(0, 'unavailable'),
    reasoning: all.reasoning > 0 ? metric(all.reasoning, 'reported') : unavailable('not reported separately'),
    contextCost: metric(all.contextCost, 'estimated'),
    opIn: metric(all.opIn, 'estimated'),
    opOut: metric(all.opOut, 'estimated'),
    subagentOutput: reported ? metric(sub.output, 'reported') : unavailable(),
    subagentContextCost: metric(sub.contextCost, 'estimated'),
  };
}
