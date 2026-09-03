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
    assert.ok(metrics.ops.totals.calls > 0, 'a session that ran nothing is not a session');

    const walk = (v, path = '') => {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is ${v}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(metrics);

    const { busy, active, wall } = metrics.time;
    assert.ok(busy.value <= active.value + 1, `busy ${busy.value} <= active ${active.value}`);
    assert.ok(active.value <= wall.value, `active ${active.value} <= wall ${wall.value}`);

    for (const ev of session.events) {
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
  t.diagnostic(`plan revisions ${metrics.plan.planRevisions.value}, edits ${edits.length}`);
});
