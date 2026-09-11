/**
 * One session out of several files.
 *
 * A Codex guardian review is a separate rollout that only makes sense next to
 * the session it judges, so the reader merges the two. What has to hold: every
 * event keeps its place in time, nothing is lost or duplicated, the borrowed
 * events say which thread they came from, the segments still cover the whole
 * timeline, and the summed figures add up to the sum of the parts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { ClaudeAdapter } from '../src/vendor/claude.ts';
import { CodexAdapter } from '../src/vendor/codex.ts';
import { mergeThreads } from '../src/vendor/merge.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUARDIAN = readdirSync(ROOT).find((f) => /^rollout-.*01a08b80.*\.jsonl$/.test(f));

/** The id the guardian rollout says it is reviewing. */
const PARENT_ID = '01a08b78-3af5-7621-a984-eb90012586c1';

function build(name, records) {
  const adapter = new CodexAdapter(name, name, 0, 1, {});
  let at = 0;
  for (const rec of records) {
    const bytes = Buffer.byteLength(JSON.stringify(rec));
    adapter.push(rec, at, at + bytes);
    at += bytes + 1;
  }
  return { session: adapter.finish(1), sources: adapter.b.sources, builder: adapter.b };
}

async function parseFile(name) {
  const adapter = new CodexAdapter(name, name, 0, 1, {});
  const rl = createInterface({ input: createReadStream(ROOT + name), crlfDelay: Infinity });
  let at = 0;
  for await (const line of rl) {
    const bytes = Buffer.byteLength(line);
    if (line.trim()) {
      try {
        adapter.push(JSON.parse(line), at, at + bytes);
      } catch {
        adapter.b.info.badLines++;
      }
    }
    at += bytes + 1;
  }
  return { session: adapter.finish(1), sources: adapter.b.sources, builder: adapter.b };
}

const iso = (ms) => new Date(ms).toISOString();

/** A small ordinary session, built to straddle the guardian's timestamps. */
function parentRecords(startMs, spanMs) {
  const at = (f) => iso(startMs + Math.round(spanMs * f));
  return [
    {
      timestamp: at(0),
      type: 'session_meta',
      payload: { id: PARENT_ID, session_id: PARENT_ID, cwd: '/work/servant', originator: 'Codex Desktop', thread_source: 'user' },
    },
    {
      timestamp: at(0.05),
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fetch the release notes' }] },
    },
    {
      timestamp: at(0.1),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'c1',
        arguments: JSON.stringify({ command: ['/bin/zsh', '-lc', 'curl -s https://example.test/notes'] }),
      },
    },
    {
      timestamp: at(0.9),
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    },
    {
      timestamp: at(1),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    },
  ];
}

test('a review thread is merged into the session it judges, in the order things happened', async () => {
  if (!GUARDIAN) return;
  const child = await parseFile(GUARDIAN);
  const span = child.session.info.endTs - child.session.info.startTs;
  const parent = build('parent.jsonl', parentRecords(child.session.info.startTs - 60_000, span + 120_000));

  const merged = mergeThreads(parent, [{ ...child, file: { name: GUARDIAN } }]);
  const { session, sources } = merged;

  assert.equal(session.events.length, parent.session.events.length + child.session.events.length, 'nothing lost');
  assert.equal(sources.length, session.events.length, 'every event keeps the bytes it came from');

  // Time only ever moves forward, and indices were renumbered to match.
  let last = 0;
  session.events.forEach((ev, i) => {
    assert.equal(ev.idx, i);
    if (ev.ts) {
      assert.ok(ev.ts >= last, `event ${i} goes back in time`);
      last = ev.ts;
    }
  });

  const lanes = session.lanes ?? [];
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].role, 'review');
  assert.equal(lanes[0].detached, false, 'the clocks overlap, so it is interleaved');
  assert.equal(lanes[0].file, GUARDIAN);

  const borrowed = session.events.filter((ev) => ev.lane === lanes[0].id);
  assert.equal(borrowed.length, child.session.events.length);
  for (const ev of borrowed) {
    assert.ok(ev.sidechain >= 1, 'a borrowed event is not on the main thread');
    assert.equal(sources[ev.idx].file.name, GUARDIAN, 'and is re-read from its own file');
  }
  // The session's own events are untouched.
  for (const ev of session.events) {
    if (!ev.lane) assert.equal(ev.sidechain, 0);
  }

  // Interleaved, not appended: the reviewer cuts in before the session ends.
  const firstBorrowed = session.events.findIndex((ev) => ev.lane);
  assert.ok(firstBorrowed > 0 && firstBorrowed < session.events.length - 1, 'the lane sits inside the session');

  // Segments still cover everything exactly once.
  assert.ok(session.segments.length > 0);
  for (const ev of session.events) {
    const seg = session.segments[ev.seg];
    assert.ok(seg, `event ${ev.idx} has no segment`);
    assert.ok(ev.idx >= seg.firstEvent && ev.idx <= seg.lastEvent, `event ${ev.idx} outside its segment`);
  }
});

test('a merged session counts both threads, and can still say which was which', async () => {
  if (!GUARDIAN) return;
  const child = await parseFile(GUARDIAN);
  const span = child.session.info.endTs - child.session.info.startTs;
  const parent = build('parent.jsonl', parentRecords(child.session.info.startTs - 60_000, span + 120_000));
  const { session } = mergeThreads(parent, [{ ...child, file: { name: GUARDIAN } }]);

  const alone = computeMetrics({ session: parent.session, raw: parent.builder.quality, samples: [], options: DEFAULT_OPTIONS });
  const both = computeMetrics({ session, raw: parent.builder.quality, samples: [], options: DEFAULT_OPTIONS });

  assert.equal(alone.threads.merged, false, 'an ordinary session has no threads to divide');
  assert.equal(both.threads.merged, true);
  assert.equal(both.threads.shares.length, 2);

  const [main, review] = both.threads.shares;
  assert.equal(main.role, 'main');
  assert.equal(review.role, 'review');
  assert.equal(main.events + review.events, session.events.length, 'the split accounts for every event');
  assert.equal(main.ops + review.ops, both.ops.totals.calls, 'and for every operation');
  assert.ok(review.ops === 0, 'a reviewer runs nothing');

  // The decisions came with the thread; they were not there before.
  assert.equal(alone.review.detected, false);
  assert.ok(both.review.detected);
  assert.ok(both.review.assessments.value > 0);

  // Summed, never silently: the parent alone cannot cost more than the pair.
  assert.ok(both.events > alone.events);
  assert.ok((both.tokens.contextCost.value ?? 0) >= (alone.tokens.contextCost.value ?? 0));
});

test('a thread whose clock does not overlap is parked at the end and says so', async () => {
  if (!GUARDIAN) return;
  const child = await parseFile(GUARDIAN);
  // The same review, a year later: nothing in it can be placed inside the session.
  const parent = build('parent.jsonl', parentRecords(child.session.info.startTs - 365 * 86_400_000, 60_000));
  const { session } = mergeThreads(parent, [{ ...child, file: { name: GUARDIAN } }]);

  assert.equal(session.lanes[0].detached, true);
  const firstBorrowed = session.events.findIndex((ev) => ev.lane);
  assert.equal(firstBorrowed, parent.session.events.length, 'it starts after everything the session did');

  const tail = session.segments[session.segments.length - 1];
  assert.match(tail.title, /clock does not overlap/);
  assert.equal(tail.firstEvent, firstBorrowed);
  assert.equal(tail.lastEvent, session.events.length - 1);
  // A detached lane must not stretch the session's own span.
  assert.equal(session.info.endTs, parent.session.info.endTs);
});

test('a merged session explains where its decisions came from, without claiming to be the reviewer', async () => {
  if (!GUARDIAN) return;
  const { renderReview } = await import('../src/view/dock/review.ts');
  const child = await parseFile(GUARDIAN);
  const span = child.session.info.endTs - child.session.info.startTs;
  const parent = build('parent.jsonl', parentRecords(child.session.info.startTs - 60_000, span + 120_000));
  const { session } = mergeThreads(parent, [{ ...child, file: { name: GUARDIAN } }]);
  const m = computeMetrics({ session, raw: parent.builder.quality, samples: [], options: DEFAULT_OPTIONS });

  assert.equal(m.thread, undefined, 'the session itself is not a review thread');
  const html = renderReview(m);
  assert.match(html, /where these decisions came from/);
  assert.doesNotMatch(html, /Every prompt here was written by the runtime/);
  assert.match(html, /guardian review/);
  assert.ok(!/undefined|NaN/.test(html));

  // And the standalone thread still explains itself the old way.
  const alone = computeMetrics({ session: child.session, raw: child.builder.quality, samples: [], options: DEFAULT_OPTIONS });
  assert.match(renderReview(alone), /what this thread is/);
});

test('with no threads to merge, the session is returned untouched', async () => {
  const parent = build('parent.jsonl', parentRecords(Date.parse('2026-09-10T10:00:00Z'), 60_000));
  const merged = mergeThreads(parent, []);
  assert.equal(merged.session, parent.session);
  assert.equal(merged.sources, parent.sources);
  assert.equal(merged.session.lanes, undefined);
});

test('the guardian rollout still knows which session it belongs to', async (t) => {
  if (!GUARDIAN) {
    t.skip('no guardian rollout here');
    return;
  }
  const child = await parseFile(GUARDIAN);
  assert.equal(child.session.info.thread.parentId, PARENT_ID);
  assert.notEqual(child.session.info.sessionId, PARENT_ID, 'its own id is not its parent’s');
  assert.ok(existsSync(ROOT + GUARDIAN));
});


/* ---------- a Claude subagent, written to a file of its own ---------- */

/**
 * Newer Claude Code does not inline a subagent: it writes
 * `<session>/subagents/agent-<id>.jsonl`, and every record in that file carries
 * the *parent's* `sessionId` while its own identity is `agentId`. Taking the
 * field at face value files the thread as the session it came out of — which is
 * what made five explorations look like five sessions in a folder view.
 */
function claude(name, records) {
  const a = new ClaudeAdapter(name, name, 0, 1, {});
  let at = 0;
  for (const rec of records) {
    const bytes = Buffer.byteLength(JSON.stringify(rec));
    a.push(rec, at, at + bytes);
    at += bytes + 1;
  }
  return { session: a.finish(1), sources: a.b.sources, builder: a.b };
}

const SESSION = '5a229ad7-c85c-4f0b-b21c-330552c555e6';
const AGENT = 'ac8494b20788f2e91';
const T = (s) => new Date(Date.parse('2026-05-07T16:07:00Z') + s * 1000).toISOString();

/** The session: a human ask, the call that spawns a thread, and its result. */
const hostRecords = () => [
  {
    type: 'user',
    timestamp: T(0),
    sessionId: SESSION,
    uuid: 'p1',
    isSidechain: false,
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text: 'does it take a gamepad?' }] },
  },
  {
    type: 'assistant',
    timestamp: T(1),
    sessionId: SESSION,
    uuid: 'a1',
    isSidechain: false,
    message: {
      role: 'assistant',
      id: 'mh1',
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'Agent',
          input: { description: 'Investigate gamepad/joystick support', subagent_type: 'Explore', prompt: 'go and look' },
        },
      ],
      usage: { input_tokens: 5, cache_creation_input_tokens: 50, output_tokens: 15 },
    },
  },
  {
    // The call names the job; only the result names the thread that did it.
    type: 'user',
    timestamp: T(40),
    sessionId: SESSION,
    uuid: 'r1',
    isSidechain: false,
    toolUseResult: { status: 'completed', agentId: AGENT, agentType: 'Explore', totalToolUseCount: 1 },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'no joystick init' }] },
  },
  {
    type: 'assistant',
    timestamp: T(45),
    sessionId: SESSION,
    uuid: 'a2',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text: 'SDL_Joystick is stubbed out.' }] },
  },
];

/** The thread's own file: the parent's id throughout, its own only in `agentId`. */
const threadRecords = () => [
  {
    type: 'user',
    timestamp: T(2),
    sessionId: SESSION,
    agentId: AGENT,
    isSidechain: true,
    uuid: 's1',
    parentUuid: null,
    cwd: '/work/engine',
    message: { role: 'user', content: 'Investigate whether the engine has gamepad support.' },
  },
  {
    type: 'assistant',
    timestamp: T(5),
    sessionId: SESSION,
    agentId: AGENT,
    isSidechain: true,
    uuid: 's2',
    message: {
      role: 'assistant',
      id: 'ms1',
      content: [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'SDL_Joystick' } }],
      usage: { input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 20 },
    },
  },
  {
    type: 'user',
    timestamp: T(30),
    sessionId: SESSION,
    agentId: AGENT,
    isSidechain: true,
    uuid: 's3',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Input.cpp:  #ifdef EMSCRIPTEN' }] },
  },
];

test('a subagent transcript is its own thread, not the session it came out of', () => {
  const { session } = claude('agent-ac8494b20788f2e91.jsonl', threadRecords());
  assert.equal(session.info.sessionId, AGENT, 'its own id is the agent id');
  assert.equal(session.info.thread.role, 'subagent');
  assert.equal(session.info.thread.parentId, SESSION, 'and the recorded sessionId is what it serves');
  assert.notEqual(session.info.thread.parentId, session.info.sessionId);
  // Every event in it is the thread, so none of them is marked as a departure
  // from a main thread that this file does not have.
  assert.equal(session.lanes, undefined);
  assert.ok(session.events.every((e) => e.lane === undefined));
});

test('a session whose subagents are inline is not mistaken for one of them', () => {
  const { session } = claude('session.jsonl', [
    ...hostRecords(),
    // The old shape: the thread's records sit in the session's own file.
    { type: 'assistant', timestamp: T(50), sessionId: SESSION, agentId: AGENT, isSidechain: true, uuid: 'x1', message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }] } },
  ]);
  assert.equal(session.info.sessionId, SESSION);
  assert.equal(session.info.thread, undefined, 'the session is not a thread');
  assert.equal(session.lanes.length, 1, 'the inline stretch is still a lane');
  assert.match(session.lanes[0].label, /gamepad/, 'named after the job, not the agent type');
});

test('a thread in its own file is merged in at the call that asked for it', () => {
  const host = claude('session.jsonl', hostRecords());
  const thread = claude('agent-ac8494b20788f2e91.jsonl', threadRecords());
  const { session, sources } = mergeThreads(host, [{ ...thread, file: { name: 'agent-ac8494b20788f2e91.jsonl' } }]);

  assert.equal(session.events.length, host.session.events.length + thread.session.events.length);
  assert.equal(session.lanes.length, 1);
  const lane = session.lanes[0];
  assert.equal(lane.id, AGENT);
  assert.equal(lane.label, 'subagent · Investigate gamepad/joystick support');
  assert.equal(lane.detached, false, 'its clock runs inside the session it belongs to');

  const spawn = session.events.findIndex((e) => e.op?.name === 'Agent');
  const borrowed = session.events.filter((e) => e.lane === lane.id);
  assert.equal(borrowed.length, thread.session.events.length);
  for (const ev of borrowed) {
    assert.equal(ev.spawnedBy, spawn, 'every borrowed event points at the call that asked for it');
    assert.ok(ev.sidechain >= 1, 'and reads as work off the main thread');
  }
  // Placed by its own clock, which here puts it directly after the call.
  assert.equal(session.events[spawn + 1].lane, lane.id);
  assert.ok(session.events.every((e, i) => e.idx === i));
  // A borrowed event is re-read from the file it came out of, not the session's.
  assert.equal(sources[spawn].file, undefined);
  assert.equal(sources[spawn + 1].file.name, 'agent-ac8494b20788f2e91.jsonl');
});

test('a merged subagent is summed into the session and still divisible', () => {
  const host = claude('session.jsonl', hostRecords());
  const thread = claude('agent-ac8494b20788f2e91.jsonl', threadRecords());
  const { session } = mergeThreads(host, [thread]);
  const m = computeMetrics({ session, raw: host.builder.quality, samples: [], options: DEFAULT_OPTIONS });

  assert.equal(m.threads.merged, true);
  assert.deepEqual(m.threads.shares.map((s) => s.role), ['main', 'subagent']);
  const sub = m.threads.shares[1];
  assert.equal(sub.label, 'subagent · Investigate gamepad/joystick support');
  assert.equal(sub.events, thread.session.events.length);
  assert.equal(sub.billed.value, 130, 'the thread is billed what the thread reported');
  assert.equal(m.threads.shares[0].billed.value, 70, 'and the session what it did');
  assert.equal(m.tokens.headline.value, 200, 'the headline is the sum of both');
  assert.equal(m.tokens.headline.value, m.threads.shares.reduce((n, sh) => n + sh.freshInput + sh.output, 0));
});
