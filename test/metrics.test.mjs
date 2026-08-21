import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeAdapter } from '../src/vendor/claude.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { unionLength, idleGaps } from '../src/metrics/time.ts';
import { extractSteps, dice, matchSteps, normalizeStep } from '../src/metrics/steps.ts';
import { planMentionsFile } from '../src/metrics/plan.ts';
import { CLASSES, DIVISORS, estTokens, fitCalibration, medianError } from '../src/metrics/estimate.ts';
import { compareSessions } from '../src/metrics/compare.ts';
import { sessionReport } from '../src/view/report.ts';
import { scenarioRecords, scenarioTruth } from '../tools/scenario.mjs';

function analyze(records, options = {}) {
  const a = new ClaudeAdapter('f1', 'scenario.jsonl', 0, 1, {});
  let at = 0;
  for (const r of records) {
    const text = JSON.stringify(r);
    a.push(r, at, at + Buffer.byteLength(text));
    at += Buffer.byteLength(text) + 1;
  }
  const session = a.finish(1);
  const metrics = computeMetrics({
    session,
    raw: a.b.quality,
    samples: a.b.samples,
    options: { ...DEFAULT_OPTIONS, ...options },
  });
  return { session, metrics, adapter: a };
}

const truth = scenarioTruth();
const { session, metrics } = analyze(scenarioRecords());

/* ---------- tokens ---------- */

test('fresh input excludes cache reads, and every token total matches the transcript', () => {
  const t = metrics.tokens;
  assert.equal(t.freshInput.value, truth.freshInput);
  assert.equal(t.cacheRead.value, truth.cacheRead);
  assert.equal(t.output.value, truth.output);
  assert.equal(t.requests.value, truth.requests);
  assert.equal(t.contextPeak.value, truth.contextPeak);
  assert.equal(t.headline.value, truth.freshInput + truth.output);
  assert.equal(t.billedInput.value, truth.freshInput + truth.cacheRead);
  // the bug this replaces: cache reads dwarf real input, so conflating them lies
  assert.ok(t.cacheRead.value > t.freshInput.value * 5);
  assert.equal(t.freshInput.provenance, 'reported');
  assert.equal(t.contextCost.provenance, 'estimated');
});

test('operation context cost is estimated, non-zero, and separate from billed usage', () => {
  assert.ok(metrics.tokens.contextCost.value > 0);
  assert.equal(metrics.tokens.contextCost.value, metrics.tokens.opIn.value + metrics.tokens.opOut.value);
  assert.notEqual(metrics.tokens.contextCost.value, metrics.tokens.freshInput.value);
});

/* ---------- operations ---------- */

test('operations are counted, paired and grouped as the transcript says', () => {
  const byName = Object.fromEntries(metrics.ops.byName.map((r) => [r.label, r]));
  for (const [name, calls] of Object.entries(truth.calls)) {
    assert.equal(byName[name]?.calls, calls, `${name} call count`);
  }
  assert.equal(metrics.quality.unpairedCalls, truth.unpaired);
  assert.equal(metrics.quality.orphanResults, truth.orphanResults);
  assert.equal(metrics.ops.totals.subagentCalls, truth.subagentCalls);
  assert.equal(byName.Bash.unpaired, 1);
  assert.equal(byName.Bash.timedCalls, 0, 'a call with no result has no duration');
});

test('parallel calls are timed as an upper bound, not as measurements', () => {
  const edits = session.events.filter((e) => e.op?.name === 'Edit' && truth.parallelPair.includes(e.op.target));
  assert.equal(edits.length, 2);
  for (const e of edits) assert.equal(e.durationSource, 'shared');
  assert.ok(metrics.ops.byName.find((r) => r.label === 'Edit').shared);
});

test('the category view and the tool view agree on totals', () => {
  const byName = metrics.ops.byName.reduce((n, r) => n + r.calls, 0);
  const byCat = metrics.ops.byCategory.reduce((n, r) => n + r.calls, 0);
  assert.equal(byName, byCat);
  assert.equal(byName, metrics.ops.totals.calls);
});

test('drill-down groups edits by extension and then by path', () => {
  const edit = metrics.ops.byName.find((r) => r.label === 'Edit');
  const ext = edit.subgroups.find((s) => s.label === '.ts');
  assert.ok(ext, 'edits should group by extension');
  assert.equal(ext.calls, 3);
  assert.ok(ext.subgroups.some((p) => p.label === 'a.ts'));
});

/* ---------- time ---------- */

test('the three clocks are ordered busy <= active <= wall', () => {
  const { wall, active, busy } = metrics.time;
  assert.ok(busy.value <= active.value, `${busy.value} <= ${active.value}`);
  assert.ok(active.value <= wall.value, `${active.value} <= ${wall.value}`);
});

test('overlapping operation intervals are counted once', () => {
  assert.equal(unionLength([{ from: 0, to: 10 }, { from: 5, to: 20 }]), 20);
  assert.equal(unionLength([{ from: 0, to: 10 }, { from: 20, to: 30 }]), 20);
  assert.equal(unionLength([]), 0);
});

test('idle gaps are found, listed and subtracted', () => {
  const gaps = idleGaps(session.events, 20_000);
  assert.ok(gaps.length >= 1, 'the 30s pause before the follow-up prompt is idle at a 20s threshold');
  const idle = gaps.reduce((n, g) => n + g.ms, 0);
  assert.equal(metrics.time.wall.value - idle >= metrics.time.active.value - idle, true);
});

/* ---------- plan ---------- */

test('plan edits count structural changes only; ticking a box is not an edit', () => {
  const p = metrics.plan;
  assert.equal(p.detected, true);
  assert.equal(p.source, 'plan-tool');
  assert.equal(p.planRevisions.value, truth.planRevisions);
  assert.equal(p.planEdits.value, truth.planEdits);
  assert.equal(p.progressTicks.value, truth.progressTicks);
  assert.equal(p.stepsAdded.value, truth.stepsAdded);
  assert.equal(p.stepsTotal.value, truth.stepsTotal);
  assert.equal(p.stepsDone.value, truth.stepsDone);
  assert.ok(p.planEdits.value + p.progressTicks.value <= p.planRevisions.value);
});

test('an edit after work started is reported as scope drift', () => {
  assert.equal(metrics.plan.planEditsAfterImplStart.value, truth.planEditsAfterImplStart);
  assert.equal(metrics.plan.planEditsDuringPlanning.value, 0);
});

test('steps are extracted from lists or headings, whichever the plan used', () => {
  const list = extractSteps('# Plan\n\n1. First thing\n2. Second thing\n3. Third thing\n');
  assert.deepEqual(list.map((s) => s.text), ['First thing', 'Second thing', 'Third thing']);

  const heads = extractSteps('## Alpha\ntext\n## Beta\ntext\n## Gamma\ntext');
  assert.deepEqual(heads.map((s) => s.text), ['Alpha', 'Beta', 'Gamma']);

  const boxes = extractSteps('- [x] done thing\n- [ ] pending thing\n- [~] in flight');
  assert.deepEqual(boxes.map((s) => s.status), ['done', 'pending', 'active']);

  // nested items belong to their parent, not to the step list
  const nested = extractSteps('- one\n  - detail\n- two\n- three');
  assert.equal(nested.length, 3);

  // a fenced block that happens to contain list markers is not the plan
  assert.equal(extractSteps('```\n- not a step\n- nor this\n- nor that\n```\n- real one').length, 1);
});

test('step matching tolerates rewording but not replacement', () => {
  assert.equal(dice('add the streaming parser', 'add the streaming parser'), 1);
  assert.ok(dice(normalizeStep('Add the streaming parser'), normalizeStep('add the streaming parser.')) >= 0.85);
  assert.ok(dice(normalizeStep('add a parser'), normalizeStep('delete the docs')) < 0.85);

  // a light rewording stays the same step, and a new step is an addition
  const prev = extractSteps('- alpha one two three\n- beta two\n- gamma three');
  const next = extractSteps('- alpha one two three four\n- beta two\n- gamma three\n- delta four');
  const m = matchSteps(prev, next);
  assert.equal(m.filter((x) => x.prev === -1).length, 1, 'one added');
  assert.equal(m.filter((x) => x.next === -1).length, 0, 'nothing removed');
  assert.ok(m.some((x) => x.similarity >= 0.85 && x.similarity < 1), 'the reworded step still matched');

  // a step rewritten past the threshold is a removal plus an addition, on purpose
  const swapped = matchSteps(extractSteps('- alpha\n- beta\n- gamma'), extractSteps('- alpha\n- entirely different work\n- gamma'));
  assert.equal(swapped.filter((x) => x.prev === -1).length, 1);
  assert.equal(swapped.filter((x) => x.next === -1).length, 1);
});

test('a plan mentions a file by path, by tail, or by basename', () => {
  const plan = 'Update `src/a.ts` and the docs\n- Refactor b.ts';
  assert.equal(planMentionsFile(plan, '/repo/src/a.ts'), true);
  assert.equal(planMentionsFile(plan, '/repo/src/b.ts'), true);
  assert.equal(planMentionsFile(plan, '/repo/src/c.ts'), false);
  assert.equal(planMentionsFile('', '/repo/src/a.ts'), false);
});

/* ---------- phases ---------- */

test('phases tile the session exactly and every event lands in one', () => {
  const ph = metrics.phases;
  assert.equal(ph.planCreated.ts, truth.planCreatedTs);
  assert.equal(ph.implEnd.ts, truth.implEndTs);
  assert.equal(ph.implEnd.confidence, 'observed');

  const sum = ph.phases.reduce((n, p) => n + p.wallMs, 0);
  assert.equal(sum, metrics.time.wall.value, 'phase durations must add up to the wall clock');

  const ops = ph.phases.reduce((n, p) => n + p.ops, 0);
  assert.equal(ops, metrics.ops.totals.calls, 'every operation is in exactly one phase');

  const fresh = ph.phases.reduce((n, p) => n + p.freshInput, 0);
  assert.equal(fresh, metrics.tokens.freshInput.value, 'per-phase tokens must add up to the session');
});

test('tokens before and after the plan split the session without overlap', () => {
  const { beforePlan, afterPlan } = metrics.phases;
  assert.equal(beforePlan.freshInput + afterPlan.freshInput, metrics.tokens.freshInput.value);
  assert.equal(beforePlan.output + afterPlan.output, metrics.tokens.output.value);
  assert.ok(beforePlan.requests >= 1 && afterPlan.requests >= 1);
});

test('a boundary set by hand overrides the heuristic and recomputes', () => {
  const moved = truth.planCreatedTs + 25_000;
  const { metrics: m2 } = analyze(scenarioRecords(), { overrides: { planCreated: moved } });
  assert.equal(m2.phases.planCreated.ts, moved);
  assert.equal(m2.phases.planCreated.manual, true);
  assert.notEqual(m2.phases.beforePlan.freshInput, metrics.phases.beforePlan.freshInput);
});

test('a session with no plan reports phases as unavailable, never as zero', () => {
  const { metrics: m2 } = analyze(scenarioRecords(), { planSource: 'none' });
  assert.equal(m2.plan.detected, false);
  assert.equal(m2.plan.planEdits.value, null);
  assert.equal(m2.plan.planEdits.provenance, 'unavailable');
  assert.equal(m2.phases.planCreated, null);
  assert.equal(m2.improvements.iterations.value, null);
  assert.equal(m2.phases.phases.length, 1);
  assert.equal(m2.phases.phases[0].id, 'NO_PLAN');
});

/* ---------- improvements ---------- */

test('improvements separate rounds that changed code from questions', () => {
  const i = metrics.improvements;
  assert.equal(i.available, true);
  assert.equal(i.iterations.value, truth.iterations);
  assert.equal(i.questions.value, truth.questions);
  assert.equal(i.rows.length, truth.iterations);
  assert.ok(i.rows[0].edits >= 1);
});

test('unplanned work is the post-plan edits the plan never names', () => {
  const i = metrics.improvements;
  assert.equal(i.postPlanEdits.value, truth.postPlanEdits);
  assert.equal(i.unplannedEdits.value, truth.unplannedEdits);
  assert.deepEqual(i.unplannedFiles.map((f) => f.path), [truth.unplannedFile]);
  assert.ok(Math.abs(i.unplannedShare.value - truth.unplannedEdits / truth.postPlanEdits) < 1e-9);
  assert.ok(i.plannedFiles.length === 2, 'a.ts and b.ts are named by the plan');
});

/* ---------- quality ---------- */

test('quality reports what could not be trusted', () => {
  const q = metrics.quality;
  assert.equal(q.clockAnomalies.length, truth.clockAnomalies);
  assert.equal(q.unpairedCalls, truth.unpaired);
  assert.equal(q.orphanResults, truth.orphanResults);
  assert.ok(q.coverage.timestamps > 0.99);
  assert.ok(q.notes.some((n) => /chronological order/.test(n)));
  assert.equal(session.events.filter((e) => e.kind === 'compaction').length, truth.compactions);
});

test('no metric is NaN, and null never becomes zero', () => {
  const walk = (node, path = '') => {
    if (node === null || typeof node !== 'object') return;
    if ('provenance' in node && 'value' in node) {
      assert.ok(node.value === null || Number.isFinite(node.value), `${path} is not a number`);
      if (node.value === null) assert.equal(node.provenance, 'unavailable', `${path} is null but claims to be known`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(metrics);
});

/* ---------- estimation ---------- */

test('the estimator is monotonic and per-class', () => {
  assert.equal(estTokens('', 'prose'), 0);
  assert.ok(estTokens('x'.repeat(400), 'json') > estTokens('x'.repeat(400), 'prose'));
  assert.ok(estTokens('x'.repeat(800), 'prose') > estTokens('x'.repeat(400), 'prose'));
});

test('calibration fits the divisors and stays inside its bounds', () => {
  // A synthetic vendor whose real tokenizer is 20% denser than the defaults.
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const chars = CLASSES.map(() => 200 + ((i * 37) % 900));
    const tokens = chars.reduce((n, c, k) => n + c / (DIVISORS[CLASSES[k]] * 0.8), 0);
    samples.push({ chars, tokens: Math.round(tokens), kind: 'out' });
  }
  const fit = fitCalibration(samples);
  for (const c of CLASSES) {
    const f = fit.factors[c] ?? 1;
    assert.ok(f >= 0.7 && f <= 1.4, `${c} factor ${f} escaped its bounds`);
  }
  assert.ok(fit.medianError !== null);
  assert.ok(fit.medianError < 0.1, `median error ${fit.medianError} should be under 10% after fitting`);
  // and the uncalibrated estimate really was worse
  assert.ok(medianError(samples, {}) > fit.medianError);
  // and a vendor whose real tokenizer is far outside the bounded range is refused
  const wild = samples.map((s) => ({ ...s, tokens: s.tokens * 3 }));
  const refused = fitCalibration(wild);
  assert.deepEqual(refused.factors, {});
  assert.match(refused.note, /not calibrated/);
});

test('too few samples leaves the defaults alone', () => {
  const fit = fitCalibration([{ chars: CLASSES.map(() => 100), tokens: 500, kind: 'out' }]);
  assert.deepEqual(fit.factors, {});
});

/* ---------- comparison & export ---------- */

test('comparison pairs metrics and marks what cannot be compared', () => {
  const { metrics: other } = analyze(scenarioRecords().slice(0, 2));
  const groups = compareSessions(metrics, other);
  assert.ok(groups.length >= 6);
  const tokens = groups.find((g) => g.title === 'tokens');
  const headline = tokens.rows.find((r) => r.label === 'fresh input + output');
  assert.equal(headline.delta, other.tokens.headline.value - metrics.tokens.headline.value);

  const plan = groups.find((g) => g.title === 'plan');
  const edits = plan.rows.find((r) => r.label === 'plan edits');
  assert.equal(edits.a.value, truth.planEdits);
  // the shortened session has no plan at all, so its side is unavailable
  assert.equal(edits.b.provenance, 'unavailable');
  assert.equal(edits.delta, null);
});

test('the markdown report carries provenance instead of bare numbers', () => {
  const md = sessionReport(metrics, { redact: false });
  assert.match(md, /# /);
  assert.match(md, /fresh input/);
  assert.match(md, /Scope drift/);
  assert.match(md, /~/, 'estimates are marked');
  assert.match(md, /Data quality/);
  const redacted = sessionReport(metrics, { redact: true });
  assert.ok(!redacted.includes('/repo/src/c.ts'), 'redaction strips paths');
});
