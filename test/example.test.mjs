/**
 * The real-data test: a genuine 5.7 MB Claude Code transcript.
 *
 * The scenario fixture proves the metrics are *right*; this proves they survive
 * real input — and it is the only place the token estimator can be checked
 * against usage a vendor actually reported.
 *
 * The file is never read into a model's context: this reads it, aggregates, and
 * asserts on the aggregates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ClaudeAdapter } from '../src/vendor/claude.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { fitCalibration, medianError } from '../src/metrics/estimate.ts';
import { decodeAsk, renderAsk } from '../src/view/ask.ts';

const PATH = fileURLToPath(new URL('../example.jsonl', import.meta.url));

function parseExample() {
  const adapter = new ClaudeAdapter('example', 'example.jsonl', 0, 1, {});
  const text = readFileSync(PATH, 'utf8');
  let at = 0;
  for (const line of text.split('\n')) {
    const len = Buffer.byteLength(line);
    if (line.trim()) {
      try {
        adapter.push(JSON.parse(line), at, at + len);
      } catch {
        adapter.b.info.badLines++;
      }
    }
    at += len + 1;
  }
  const session = adapter.finish(1);
  const metrics = computeMetrics({
    session,
    raw: adapter.b.quality,
    samples: adapter.b.samples,
    options: DEFAULT_OPTIONS,
  });
  return { session, metrics, adapter };
}

test('a real transcript parses and satisfies every metric invariant', (t) => {
  if (!existsSync(PATH)) return t.skip('example.jsonl is not present');
  const { session, metrics } = parseExample();

  assert.ok(session.events.length > 100, 'the transcript should produce events');
  assert.ok(metrics.ops.totals.calls > 0, 'and operations');

  const { wall, active, busy } = metrics.time;
  assert.ok(busy.value <= active.value + 1, `busy ${busy.value} <= active ${active.value}`);
  assert.ok(active.value <= wall.value, `active ${active.value} <= wall ${wall.value}`);

  const t2 = metrics.tokens;
  assert.equal(t2.billedInput.value, t2.freshInput.value + t2.cacheRead.value);
  assert.equal(t2.headline.value, t2.freshInput.value + t2.output.value);
  assert.ok(t2.contextPeak.value >= 0);
  // the old reader added cache reads into "input"; on a long session that is a
  // multiple of the truth, which is exactly why they are reported apart
  assert.ok(t2.cacheRead.value > t2.freshInput.value, 'cache reads dominate a long session');

  const phaseWall = metrics.phases.phases.reduce((n, p) => n + p.wallMs, 0);
  assert.equal(phaseWall, wall.value, 'phase durations must tile the session');
  const phaseOps = metrics.phases.phases.reduce((n, p) => n + p.ops, 0);
  assert.equal(phaseOps, metrics.ops.totals.calls, 'every operation belongs to exactly one phase');
  const phaseFresh = metrics.phases.phases.reduce((n, p) => n + p.freshInput, 0);
  assert.equal(phaseFresh, t2.freshInput.value, 'per-phase tokens must tile the session');

  const plan = metrics.plan;
  if (plan.detected) {
    assert.ok(plan.planEdits.value + plan.progressTicks.value <= plan.planRevisions.value);
  } else {
    assert.equal(plan.planEdits.value, null);
  }

  // nothing anywhere is NaN, and nothing null pretends to be known
  const walk = (node, path = '') => {
    if (node === null || typeof node !== 'object') return;
    if ('provenance' in node && 'value' in node) {
      assert.ok(node.value === null || Number.isFinite(node.value), `${path} is not finite`);
      if (node.value === null) assert.equal(node.provenance, 'unavailable', `${path}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(metrics);
});

/**
 * The 10% accuracy target (SPEC §5.4) is asserted against synthetic data in
 * metrics.test.mjs, where the sample text really is everything the tokenizer
 * saw. On a real Claude transcript it is *not* reachable and must not be faked:
 * reported output includes reasoning the agent generated but did not write down,
 * so no divisor over the visible text can reproduce it. What must hold is that
 * the tool notices this, refuses the fit, and says so.
 */
test('calibration against a real transcript either fits within bounds or refuses', (t) => {
  if (!existsSync(PATH)) return t.skip('example.jsonl is not present');
  const { adapter, metrics } = parseExample();
  const samples = adapter.b.samples;
  assert.ok(samples.length >= 50, `needs samples to calibrate, got ${samples.length}`);

  const fit = fitCalibration(samples);
  assert.ok(fit.medianError !== null, 'the residual error is always reported');

  if (Object.keys(fit.factors).length) {
    for (const [cls, f] of Object.entries(fit.factors)) {
      assert.ok(f >= 0.7 && f <= 1.4, `${cls} factor ${f} escaped its bounds`);
    }
    // calibration has to earn its place: it must beat the uncalibrated divisors
    assert.ok(fit.medianError <= medianError(samples.filter((s) => s.kind === 'out'), {}) + 1e-9);
    assert.ok(fit.medianError <= 0.1, `fitted error ${(fit.medianError * 100).toFixed(1)}% should meet the target`);
  } else {
    assert.ok(fit.note, 'a refused fit must explain itself');
    assert.ok(
      metrics.quality.notes.some((n) => /estimator/i.test(n)),
      'and the refusal must reach the quality panel',
    );
  }
});

test('real question rows keep every option, its description and the pick', (t) => {
  if (!existsSync(PATH)) return t.skip('example.jsonl is not present');
  const { session } = parseExample();
  const asks = session.events.filter((e) => e.op?.name === 'AskUserQuestion' && e.format === 'ask');
  assert.ok(asks.length >= 2, 'the transcript contains answered questions');

  for (const ev of asks) {
    const questions = decodeAsk(ev.body);
    assert.ok(questions.length > 0);
    for (const q of questions) {
      assert.ok(q.question.length > 0, 'the question text survives');
      assert.ok(q.options.length >= 2, 'every option that was offered is kept');
      assert.ok(
        q.options.every((o) => o.label.length > 0),
        'and each one keeps its label',
      );
      assert.ok(
        q.options.some((o) => o.description.length > 0),
        'descriptions are what make the options mean anything',
      );
      assert.equal(q.options.filter((o) => o.picked).length >= 1, true, 'the answer marks a pick');
    }
    // The body must fit the clamp, or the row would open on half a decision.
    assert.ok(ev.body.length < 8000, `ask body ${ev.body.length} fits the row clamp`);
    const html = renderAsk(ev.body);
    assert.ok(!html.includes('undefined') && !html.includes('NaN'));
  }
});
