/**
 * Real Codex rollouts, when they are lying about.
 *
 * The scenario fixtures prove each rule in isolation; this proves the adapter
 * survives what OpenAI actually writes — two formats nine days apart, one of
 * which routes every operation through a single `exec` tool. Nothing is read
 * into a model's context: the file is streamed and only aggregates are asserted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../src/vendor/codex.ts';
import { detectFromText } from '../src/vendor/detect.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { decodeAsk } from '../src/view/ask.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rollouts = readdirSync(ROOT)
  .filter((f) => /^rollout-.*\.jsonl$/.test(f))
  .sort();

async function parse(name) {
  const adapter = new CodexAdapter(name, name, 0, 1, {});
  const rl = createInterface({ input: createReadStream(ROOT + name), crlfDelay: Infinity });
  let at = 0;
  let items = 0;
  for await (const line of rl) {
    const bytes = Buffer.byteLength(line);
    if (line.trim()) {
      try {
        const rec = JSON.parse(line);
        if (rec?.payload?.type === 'item_completed') items++;
        adapter.push(rec, at, at + bytes);
      } catch {
        adapter.b.info.badLines++;
      }
    }
    at += bytes + 1;
  }
  const session = adapter.finish(1);
  const metrics = computeMetrics({
    session,
    raw: adapter.b.quality,
    samples: [],
    options: DEFAULT_OPTIONS,
  });
  return { session, metrics, adapter, items };
}

for (const name of rollouts) {
  test(`${name} parses, and every number it produces is a number`, async (t) => {
    const { session, metrics, adapter } = await parse(name);

    assert.equal(detectFromText(readFileSync(ROOT + name, 'utf8').slice(0, 64 * 1024)).vendor, 'codex');
    assert.equal(adapter.b.info.badLines, 0, 'every line is JSON');
    assert.ok(session.events.length > 50);
    // A thread that reviews another agent runs nothing of its own; every other
    // rollout that ran nothing is a rollout that failed to parse.
    if (session.info.thread?.role === 'review') {
      assert.ok(metrics.review.detected, 'a review thread is read for its decisions instead');
    } else {
      assert.ok(metrics.ops.totals.calls > 0, 'a session that ran nothing is not a session');
    }

    const walk = (v, path = '') => {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is ${v}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(metrics);

    const { busy, active, wall } = metrics.time;
    assert.ok(busy.value <= active.value + 1, `busy ${busy.value} <= active ${active.value}`);
    assert.ok(active.value <= wall.value, `active ${active.value} <= wall ${wall.value}`);

    // Nothing quoted out of another session's log may leak into this one's
    // events: what it says happened is evidence, not something we observed.
    for (const ev of session.events) {
      if (ev.kind === 'op') assert.ok(!/^>>> (TRANSCRIPT|APPROVAL)/m.test(ev.body));
      if (ev.kind !== 'op') continue;
      assert.ok(ev.op.name, 'an operation without a name is not one');
      assert.ok(ev.op.status !== undefined);
    }
    t.diagnostic(
      `${session.events.length} events, ${metrics.ops.totals.calls} ops: ` +
        metrics.ops.byName.map((r) => `${r.key}×${r.calls}`).join(' '),
    );
  });
}

test('the item stream turns a single-tool rollout into real operations', async (t) => {
  const name = rollouts.find((f) => f.includes('2026-09-03'));
  if (!name) return t.skip('the v2 rollout is not present');
  const { session, metrics, items } = await parse(name);
  assert.ok(items > 100, 'this is the format that reports completed items');

  // Everything below is invisible without reading the item stream: the calls
  // themselves are all one tool, `exec`, wrapping a script.
  const byName = new Map(metrics.ops.byName.map((r) => [r.key, r]));
  assert.ok(byName.get('exec_command').calls > 20, 'commands are operations, not script text');
  assert.ok(byName.get('apply_patch').calls > 5, 'edits exist at all');
  assert.ok(byName.get('request_user_input').calls > 5, 'so do the questions put to the human');

  const cats = new Map(metrics.ops.byCategory.map((r) => [r.key, r.calls]));
  for (const c of ['read', 'search', 'execute', 'edit', 'ask', 'plan', 'web']) {
    assert.ok((cats.get(c) ?? 0) > 0, `${c} operations are recognized`);
  }

  // Plans live only in the item stream in this format; without them the plan
  // tab, the phase boundaries and every plan metric stay empty.
  assert.equal(metrics.plan.detected, true);
  assert.ok(metrics.plan.planRevisions.value >= 2);
  assert.ok(metrics.plan.stepsTotal.value > 0);

  // Edits carry real diffs, so the phases can measure work rather than guess.
  const edits = session.events.filter((e) => e.op?.category === 'edit');
  assert.ok(edits.every((e) => e.op.target), 'every edit names its file');
  assert.ok(edits.reduce((n, e) => n + (e.op.linesAdded ?? 0), 0) > 100);

  // Questions keep what they offered, not just what was chosen.
  for (const ev of session.events.filter((e) => e.op?.category === 'ask' && e.format === 'ask')) {
    for (const q of decodeAsk(ev.body)) {
      assert.ok(q.question.length > 0);
      assert.ok(q.options.length >= 2, 'the alternatives are the point of showing a decision');
      assert.ok(
        q.options.some((o) => o.picked),
        'and an answered question says which way it went',
      );
    }
  }

  assert.equal(metrics.time.thinkMs.provenance, 'reported', 'Codex timed its own turns');

  // The `visualize` skill writes HTML into its own directory and points at it
  // from the message text with private-use sentinels. Both halves are handled:
  // no sentinel reaches a body, the page is rebuilt from the transcript, and
  // writing it is an operation rather than a change to the project.
  for (const ev of session.events) {
    assert.ok(!/[\ue200-\ue20f]/.test(ev.body), `a directive leaked into ${ev.title}`);
  }
  const shown = session.events.filter((e) => e.widgets?.length);
  assert.ok(shown.length >= 3, 'the visualizations are shown where the agent showed them');
  assert.ok(
    shown.every((e) => e.widgets.every((w) => w.html.includes('<') && w.title)),
    'each one is a real document with a title',
  );
  const viz = metrics.ops.byName.find((r) => r.key === 'visualize');
  assert.ok(viz && viz.calls >= 3);
  assert.equal(viz.category, 'other', 'a page written for the conversation is not a code edit');
  assert.ok(
    session.events.filter((e) => e.op?.category === 'edit').every((e) => !/\.codex\/visualizations\//.test(e.op.target)),
    'and no edit row points inside the scratch directory',
  );
  t.diagnostic(`plan revisions ${metrics.plan.planRevisions.value}, edits ${edits.length}`);
});

test('a guardian rollout reads as the review it is', async (t) => {
  const name = rollouts.find((f) => f.includes('2026-09-10'));
  if (!name) return t.skip('the guardian rollout is not present');
  const { session, metrics } = await parse(name);

  // The file says so itself, and it is the reason nothing else here adds up:
  // `session_id` is the *parent's* id, and the prompts came from the runtime.
  assert.equal(session.info.thread.role, 'review');
  assert.equal(session.info.thread.label, 'guardian review');
  assert.ok(session.info.thread.parentId);
  assert.notEqual(session.info.thread.parentId, session.info.sessionId);

  assert.equal(metrics.ops.totals.calls, 0, 'a reviewer runs no tools');
  assert.equal(metrics.review.detected, true);
  assert.equal(metrics.review.assessments.value, metrics.prompts, 'every request was answered');
  assert.equal(metrics.review.unanswered.value, 0);
  assert.ok(metrics.review.medianMs.value > 0);
  assert.ok(metrics.review.byRisk.length > 0);

  for (const v of metrics.review.verdicts) {
    assert.ok(v.outcome, 'a verdict says what it decided');
    assert.ok(v.rationale.length > 20, 'and why');
    assert.ok(v.subject, 'and what it was deciding about');
    assert.ok(['allow', 'block', 'ask', 'other'].includes(v.decision));
  }

  // The action is the row; the quoted parent transcript is a separate,
  // collapsed row that never becomes events of our own.
  const requests = session.events.filter((e) => e.kind === 'prompt');
  assert.ok(requests.every((e) => e.title === 'review request' && e.subtitle));
  const quotes = session.events.filter((e) => e.title === 'quoted from the reviewed session');
  assert.equal(quotes.length, requests.length);
  assert.ok(quotes.every((e) => e.collapsed && /^entries \d+–\d+ of session /.test(e.subtitle)));
  assert.ok(
    !session.events.some((e) => e.kind === 'prompt' && /TRANSCRIPT (DELTA )?START/.test(e.body)),
    'no row is the raw machine prompt again',
  );
  t.diagnostic(
    `${metrics.review.assessments.value} assessments, ` +
      `${metrics.review.allowed.value} allowed, median ${metrics.review.medianMs.value}ms`,
  );
});
