/**
 * The panels are pure string builders, so they can be rendered and inspected
 * without a browser. What matters here is not layout but honesty: an unavailable
 * metric must reach the page as "—", never as 0, and no panel may leak an
 * `undefined` or an unescaped angle bracket into the DOM it builds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeAdapter } from '../src/vendor/claude.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { renderOverview } from '../src/view/dock/overview.ts';
import { renderOps, defaultOpsView } from '../src/view/dock/ops.ts';
import { renderPhases } from '../src/view/dock/phases.ts';
import { renderPlan } from '../src/view/dock/plan.ts';
import { renderQuality } from '../src/view/dock/quality.ts';
import { renderCompare } from '../src/view/dock/compare.ts';
import { value } from '../src/view/dock/fmt.ts';
import { renderRow, msHuman, tokensHuman } from '../src/view/rows.ts';
import { scenarioRecords } from '../tools/scenario.mjs';

function analyze(records, options = {}) {
  const a = new ClaudeAdapter('f1', 'scenario.jsonl', 0, 1, {});
  let at = 0;
  for (const r of records) {
    const text = JSON.stringify(r);
    a.push(r, at, at + Buffer.byteLength(text));
    at += Buffer.byteLength(text) + 1;
  }
  const session = a.finish(1);
  return {
    session,
    metrics: computeMetrics({ session, raw: a.b.quality, samples: a.b.samples, options: { ...DEFAULT_OPTIONS, ...options } }),
  };
}

const { session, metrics } = analyze(scenarioRecords());
const { metrics: noPlan } = analyze(scenarioRecords(), { planSource: 'none' });

const panels = () => [
  ['overview', renderOverview(metrics)],
  ['operations', renderOps(metrics.ops, defaultOpsView())],
  ['phases', renderPhases(metrics.phases)],
  ['plan', renderPlan(metrics.plan, metrics.improvements)],
  ['quality', renderQuality(metrics.quality)],
  ['compare', renderCompare(metrics, noPlan, [{ id: 'f2', title: 'other' }])],
  ['overview (no plan)', renderOverview(noPlan)],
  ['phases (no plan)', renderPhases(noPlan.phases)],
  ['plan (no plan)', renderPlan(noPlan.plan, noPlan.improvements)],
];

test('every panel renders without leaking undefined or NaN', () => {
  for (const [name, html] of panels()) {
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes('undefined'), `${name} leaked "undefined"`);
    assert.ok(!html.includes('NaN'), `${name} leaked "NaN"`);
    assert.ok(!html.includes('[object Object]'), `${name} leaked an object`);
  }
});

test('an unavailable metric renders as a dash, never as zero', () => {
  const html = renderPlan(noPlan.plan, noPlan.improvements);
  assert.ok(html.includes('No plan was detected'), 'the empty state explains itself');

  const dash = value({ value: null, provenance: 'unavailable', note: 'nothing recorded' });
  assert.ok(dash.includes('—'));
  assert.ok(!/>0</.test(dash));

  const est = value({ value: 1200, provenance: 'estimated' }, 'tokens');
  assert.ok(est.includes('~'), 'estimates are marked');
  assert.ok(est.includes('p-estimated'));

  const rep = value({ value: 1200, provenance: 'reported' }, 'tokens');
  assert.ok(!rep.includes('~'), 'reported figures are not marked as guesses');
});

test('a low-coverage metric is flagged rather than shown plainly', () => {
  const warned = value({ value: 5, provenance: 'derived', coverage: 0.4 });
  assert.ok(warned.includes('warn'));
  const fine = value({ value: 5, provenance: 'derived', coverage: 0.99 });
  assert.ok(!fine.includes('warn'));
});

test('operation rows escape transcript text and deep-link to the timeline', () => {
  const view = defaultOpsView();
  view.expanded.add('Edit');
  const html = renderOps(metrics.ops, view);
  assert.ok(html.includes('data-focus-key="Edit"'), 'rows link to their events');
  assert.ok(html.includes('data-first='), 'rows carry an anchor event');
  assert.ok(html.includes('.ts'), 'the drill-down is expanded');
});

test('rows render operation cost and duration, and mark parallel timings', () => {
  const edit = session.events.find((e) => e.op?.name === 'Edit');
  const html = renderRow(edit, false, false, { costP90: 1, msP90: 1 });
  assert.ok(html.includes('chip tok'), 'context cost is shown');
  assert.ok(html.includes('≤'), 'a parallel call is an upper bound');
  assert.ok(html.includes('heavy'), 'an expensive row is weighted');

  const prompt = session.events.find((e) => e.kind === 'prompt');
  const promptHtml = renderRow(prompt, true, false);
  assert.ok(!promptHtml.includes('chip tok'), 'only operations carry cost chips');
});

test('untrusted transcript text cannot break out of a row', () => {
  const nasty = {
    ...session.events.find((e) => e.kind === 'prompt'),
    title: '<script>x</script>',
    subtitle: '" onmouseover="alert(1)',
    body: '<img src=x onerror=alert(1)>',
  };
  const html = renderRow(nasty, true, false);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('onmouseover="alert'));
  assert.ok(!html.includes('<img src=x'));
});

test('human-readable numbers stay readable at every scale', () => {
  assert.equal(tokensHuman(0), '0');
  assert.equal(tokensHuman(999), '999');
  assert.equal(tokensHuman(1500), '1.5k');
  assert.equal(tokensHuman(25_000), '25k');
  assert.equal(tokensHuman(2_500_000), '2.5M');
  assert.equal(msHuman(999), '999ms');
  assert.equal(msHuman(1500), '1.5s');
  assert.equal(msHuman(65_000), '1m05s');
  assert.equal(msHuman(3_700_000), '1h02m');
});
