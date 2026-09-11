/**
 * One session out of several files (SPEC §14 A10).
 *
 * A Codex guardian review is written to its own rollout, but it is not its own
 * session: it exists only to judge one thing the session next to it planned to
 * do, and reading the two apart means reading a decision without its subject.
 * So when both files are in the folder, the reader merges them — one timeline,
 * one set of numbers, with every borrowed event marked with the lane it came
 * from.
 *
 * Two rules make the merge honest:
 *
 *  - Events are placed by their own clock. A thread whose span does not overlap
 *    the session's is not interleaved at a guessed position; it is parked at the
 *    end and says so (`LaneInfo.detached`).
 *  - Nothing is invented and nothing is dropped: every event keeps its body, its
 *    tokens and its provenance, so the summed figures are a sum of things that
 *    were actually recorded, and `lane` is what lets them be split apart again.
 *
 * This file knows nothing about any vendor — it merges `CanonSession`s.
 */

import type { CanonEvent, CanonSession, LaneInfo, Segment } from '../model/canon.js';
import type { EventSource } from './builder.js';
import { oneLine } from './text.js';

export interface MergeInput {
  session: CanonSession;
  sources: EventSource[];
  /** the file these events were read from, when it is not the parent's */
  file?: File;
}

export interface Merged {
  session: CanonSession;
  sources: EventSource[];
}

interface Slot {
  ev: CanonEvent;
  src: EventSource;
  /** which input it came from: 0 = the session itself */
  rank: number;
  pos: number;
  sortTs: number;
  lane?: string;
}

/**
 * What to call a thread inside the session it belongs to.
 *
 * Its own title carries a disambiguator — "guardian review · 01a08b78…" — because
 * on its own it has to say which session it serves. Here that is the session we
 * are in, so the plain word is the whole of it.
 *
 * When the parent asked for the thread by name, that wins over both: the job is
 * what distinguishes five subagents from each other, and each of them knows only
 * that it is a subagent.
 */
function laneLabel(child: CanonSession, spawn?: CanonEvent): string {
  // What the parent asked for beats what the thread calls itself: "subagent ·
  // investigate gamepad support" is the job, and the thread's own name is at
  // best a restatement of it.
  // The row head, not the drill-down key: `subgroup` for an agent call is the
  // *type* of agent, so five Explores would be five lanes called "Explore".
  const asked = spawn?.subtitle ?? spawn?.op?.subgroup ?? spawn?.op?.target;
  if (asked) return jobLabel(asked);
  const t = child.info.thread;
  if (t?.label) return t.label;
  if (child.info.title && child.info.title !== child.info.name) return child.info.title;
  return child.info.name;
}

/**
 * A thread named after the job it was given. Both places that learn the job —
 * the parent's tool call here, the runtime's sidecar at intake — say it the
 * same way, so a thread does not change its name once the session is opened.
 */
export function jobLabel(job: string): string {
  return `subagent \u00b7 ${oneLine(job, 48)}`;
}

function laneOf(child: CanonSession, file?: string, spawn?: CanonEvent): LaneInfo {
  const t = child.info.thread;
  return {
    id: child.info.sessionId ?? child.info.id,
    label: laneLabel(child, spawn),
    role: t?.role ?? 'subagent',
    kind: t?.kind ?? 'thread',
    file,
    startTs: child.info.startTs,
    endTs: child.info.endTs,
    events: child.events.length,
  };
}

/**
 * Sort keys that survive a missing timestamp: an event without one inherits the
 * last one seen *in its own thread*, so a gap never throws it to the front.
 */
function slotsOf(input: MergeInput, rank: number, lane: string | undefined, at: number): Slot[] {
  const out: Slot[] = [];
  let carry = at;
  for (let i = 0; i < input.session.events.length; i++) {
    const ev = input.session.events[i];
    if (ev.ts) carry = ev.ts;
    out.push({ ev, src: input.sources[i], rank, pos: i, sortTs: ev.ts || carry, lane });
  }
  return out;
}

export function mergeThreads(parent: MergeInput, children: MergeInput[]): Merged {
  const usable = children.filter((c) => c.session.events.length);
  if (!usable.length) return { session: parent.session, sources: parent.sources };

  const info = { ...parent.session.info };
  // Lanes the session already had — its own subagents — keep their events and
  // their names; the threads merged in here are added beside them.
  const own = parent.session.lanes ?? [];
  const lanes: LaneInfo[] = [];
  const slots: Slot[] = slotsOf(parent, 0, undefined, info.startTs);

  // The call that started a thread, by the thread's id. A thread written to its
  // own file is otherwise placed by its clock alone; with this it points back at
  // the operation that asked for it, exactly as an inline sidechain does.
  const spawnOf = new Map<string, CanonEvent>();
  for (const ev of parent.session.events) {
    if (ev.op?.spawnedThread) spawnOf.set(ev.op.spawnedThread, ev);
  }
  /** lane id -> the parent event index that spawned it, before renumbering */
  const spawnedBy = new Map<string, number>();

  // A lane that cannot be interleaved is appended, one after another, past the
  // last thing that happened on the main thread.
  let tail = Math.max(info.endTs, 0) + 1;

  usable.forEach((child, i) => {
    const spawn = spawnOf.get(child.session.info.sessionId ?? '');
    const lane = laneOf(child.session, child.session.info.name, spawn);
    if (spawn) spawnedBy.set(lane.id, spawn.idx);
    const overlaps =
      lane.startTs > 0 && info.startTs > 0 && lane.startTs <= info.endTs && lane.endTs >= info.startTs;
    lane.detached = !overlaps;
    lanes.push(lane);
    const at = overlaps ? lane.startTs : tail;
    if (!overlaps) tail += Math.max(1, lane.endTs - lane.startTs) + 1;
    for (const slot of slotsOf(child, i + 1, lane.id, at)) {
      if (lane.detached) slot.sortTs = at;
      slots.push(slot);
    }
  });

  slots.sort((a, b) => a.sortTs - b.sortTs || a.rank - b.rank || a.pos - b.pos);

  // Renumber. `spawnedBy` is an index, so it has to be remapped inside the
  // thread that issued it.
  const events: CanonEvent[] = [];
  const sources: EventSource[] = [];
  const remap = new Map<string, number>();
  slots.forEach((slot, idx) => {
    remap.set(`${slot.rank}:${slot.ev.idx}`, idx);
    const ev: CanonEvent = { ...slot.ev, idx };
    if (slot.lane) {
      ev.lane = slot.lane;
      // A borrowed thread is subagent work by definition: it is not the main
      // line of the conversation, and the ops table already knows how to
      // exclude that.
      ev.sidechain = Math.max(1, ev.sidechain);
    }
    events.push(ev);
    sources.push(slot.rank === 0 ? slot.src : { ...slot.src, file: usable[slot.rank - 1].file });
  });
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const anchor = ev.lane !== undefined ? spawnedBy.get(ev.lane) : undefined;
    if (anchor !== undefined) {
      // A merged thread points at an op in the *parent*, so it is remapped from
      // rank 0 rather than from the thread's own numbering.
      ev.spawnedBy = remap.get(`0:${anchor}`);
      continue;
    }
    if (ev.spawnedBy === undefined) continue;
    const from = slots[i].rank;
    ev.spawnedBy = remap.get(`${from}:${ev.spawnedBy}`) ?? undefined;
  }

  const segments = resegment(parent.session.segments, events, remap, lanes);


  const merged: CanonSession = {
    info: {
      ...info,
      bytes: info.bytes + usable.reduce((n, c) => n + c.session.info.bytes, 0),
      lines: info.lines + usable.reduce((n, c) => n + c.session.info.lines, 0),
      badLines: info.badLines + usable.reduce((n, c) => n + c.session.info.badLines, 0),
      startTs: Math.min(info.startTs || Infinity, ...lanes.filter((l) => !l.detached).map((l) => l.startTs || Infinity)),
      endTs: Math.max(info.endTs, ...lanes.filter((l) => !l.detached).map((l) => l.endTs)),
    },
    events,
    segments,
    parts: parent.session.parts,
    lanes: [...own, ...lanes],
  };
  if (!Number.isFinite(merged.info.startTs)) merged.info.startTs = info.startTs;
  return { session: merged, sources };
}

/**
 * The session's own prompts stay the spine of the timeline: a borrowed event
 * belongs to whichever turn was under way when it happened. A detached lane has
 * no turn to belong to, so it gets a block of its own at the end — which is
 * also what makes it visible in the prompt list rather than silently trailing
 * the last one.
 */
function resegment(
  original: readonly Segment[],
  events: readonly CanonEvent[],
  remap: Map<string, number>,
  lanes: readonly LaneInfo[],
): Segment[] {
  const detached = new Set(lanes.filter((l) => l.detached).map((l) => l.id));
  const firstDetached = detached.size ? events.findIndex((ev) => ev.lane && detached.has(ev.lane)) : -1;
  const end = firstDetached >= 0 ? firstDetached - 1 : events.length - 1;

  const segments: Segment[] = original.map((seg) => ({
    ...seg,
    promptIdx: seg.promptIdx >= 0 ? (remap.get(`0:${seg.promptIdx}`) ?? -1) : -1,
    firstEvent: remap.get(`0:${seg.firstEvent}`) ?? 0,
    lastEvent: end,
    toolCount: 0,
    imageCount: 0,
    fileCount: 0,
  }));
  for (let i = 0; i < segments.length - 1; i++) {
    segments[i].lastEvent = Math.max(segments[i].firstEvent, segments[i + 1].firstEvent - 1);
  }
  if (segments.length) segments[segments.length - 1].lastEvent = Math.max(segments[segments.length - 1].firstEvent, end);

  if (firstDetached >= 0) {
    for (const lane of lanes) {
      if (!lane.detached) continue;
      const first = events.findIndex((ev) => ev.lane === lane.id);
      if (first < 0) continue;
      let last = first;
      for (let i = first; i < events.length; i++) if (events[i].lane === lane.id) last = i;
      segments.push({
        idx: segments.length,
        promptIdx: -1,
        title: `${lane.label} (its clock does not overlap this session)`,
        ts: events[first].ts,
        firstEvent: first,
        lastEvent: last,
        toolCount: 0,
        imageCount: 0,
        fileCount: 0,
      });
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    seg.idx = i;
    for (let e = seg.firstEvent; e <= seg.lastEvent && e < events.length; e++) {
      const ev = events[e];
      ev.seg = i;
      if (ev.kind === 'op') {
        seg.toolCount++;
        if (ev.op?.category === 'edit') seg.fileCount++;
      }
      if (ev.images?.length) seg.imageCount += ev.images.length;
    }
  }
  return segments;
}
