/**
 * Who did which part of the work.
 *
 * When a session is read together with its dependent threads, every total in
 * the dock covers all of them — that is what "one session" means, and it is the
 * only way to answer what a piece of work actually cost. A sum with no
 * breakdown, though, hides the thing a reader most wants to know next: how much
 * of it was the agent, and how much was the machinery around it.
 *
 * So each lane is reported on its own terms, from `CanonEvent.lane` alone. No
 * vendor's vocabulary reaches this file; a lane is a lane whether it came from
 * another rollout or from a subagent inside the same one.
 */

import type { CanonSession, LaneInfo } from '../model/canon.js';
import { metric, unavailable, type Metric, type ThreadShare, type ThreadStats } from '../model/metrics.js';

const MAIN = '';

export function computeThreads(session: CanonSession): ThreadStats {
  const lanes = session.lanes ?? [];
  if (!lanes.length) return { merged: false, shares: [] };

  const shares = new Map<string, ThreadShare>();
  const put = (id: string, seed: () => ThreadShare): ThreadShare => {
    const found = shares.get(id);
    if (found) return found;
    const made = seed();
    shares.set(id, made);
    return made;
  };

  const mainShare = (): ThreadShare => blank(MAIN, session.info.title, 'main');
  const laneShare = (lane: LaneInfo): ThreadShare => {
    const s = blank(lane.id, lane.label, lane.role);
    s.file = lane.file;
    s.detached = lane.detached;
    return s;
  };

  put(MAIN, mainShare);
  for (const lane of lanes) put(lane.id, () => laneShare(lane));

  let billed = false;
  for (const ev of session.events) {
    const share = shares.get(ev.lane ?? MAIN);
    if (!share) continue;
    share.events++;
    if (ev.kind === 'op') {
      share.ops++;
      share.contextCost += (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);
    }
    const r = ev.tokens.reported;
    if (r) {
      billed = true;
      share.freshInput += r.input + r.cacheWrite;
      share.output += r.output;
      share.requests++;
    }
    if (ev.ts) {
      if (!share.startTs || ev.ts < share.startTs) share.startTs = ev.ts;
      const end = ev.endTs && ev.endTs > ev.ts ? ev.endTs : ev.ts;
      if (end > share.endTs) share.endTs = end;
    }
  }

  return {
    merged: true,
    shares: [...shares.values()].map((s) => ({
      ...s,
      // The same rule as everywhere else: a vendor that reports no usage gets a
      // dash, not a zero that looks like a measurement.
      billed: billed ? tokenMetric(s.freshInput + s.output, s.requests) : unavailable('this vendor records no per-request usage'),
    })),
  };
}

function tokenMetric(value: number, requests: number): Metric {
  return requests ? metric(value, 'reported', undefined, 'fresh input + output') : unavailable('no request on this thread reported usage');
}

function blank(id: string, label: string, role: ThreadShare['role']): ThreadShare {
  return {
    id,
    label,
    role,
    events: 0,
    ops: 0,
    requests: 0,
    freshInput: 0,
    output: 0,
    contextCost: 0,
    startTs: 0,
    endTs: 0,
    billed: unavailable(),
  };
}
