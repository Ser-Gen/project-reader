import test from 'node:test';
import assert from 'node:assert/strict';

import { QwenAdapter, fullBody, categoryOf } from '../src/vendor/qwen.ts';
import { detectFromText } from '../src/vendor/detect.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { decodeAsk } from '../src/view/ask.ts';
import { Registry } from '../src/intake.ts';
import { peekIdentity } from '../src/worker/peek.ts';
import { extractImages } from '../src/worker/images.ts';

const T0 = Date.parse('2026-11-01T10:00:00.000Z');
let seq = 0;
const rec = (type, at, extra = {}) => ({
  uuid: `u${++seq}`,
  parentUuid: null,
  sessionId: 'sess-qwen',
  timestamp: new Date(T0 + at * 1000).toISOString(),
  type,
  provenance:
    type === 'user' ? 'real_user'
    : type === 'assistant' ? 'assistant_output'
    : type === 'tool_result' ? 'tool_result'
    : 'system',
  cwd: '/work/project',
  version: '0.28.4',
  gitBranch: 'main',
  ...extra,
});
const sys = (subtype, at, payload = {}) => rec('system', at, { subtype, systemPayload: payload });
const prompt = (text, at = 0, extra = {}) =>
  rec('user', at, { message: { role: 'user', parts: [{ text }] }, executionContext: { modelId: 'qwen4-max', approvalMode: 'auto' }, ...extra });
const assistant = (parts, at = 1, um) =>
  rec('assistant', at, { model: 'qwen4-max', message: { role: 'model', parts }, ...(um ? { usageMetadata: um } : {}) });
const call = (id, name, args, at = 1) => assistant([{ functionCall: { id, name, args } }], at);
const result = (id, output, at = 2, rd, tcrExtra = {}) =>
  rec('tool_result', at, {
    message: { role: 'user', parts: [{ functionResponse: { id, name: 'tool', response: { output } } }] },
    toolCallResult: { callId: id, status: 'success', executionStatus: 'success', ...(rd ? { resultDisplay: rd } : {}), ...tcrExtra },
  });
const usage = (prompt_, candidates, thoughts, cached) => ({
  promptTokenCount: prompt_,
  candidatesTokenCount: candidates,
  thoughtsTokenCount: thoughts,
  totalTokenCount: prompt_ + candidates,
  cachedContentTokenCount: cached,
});

function run(records) {
  const adapter = new QwenAdapter('f1', 'sess.jsonl', 0, 1, {});
  let at = 0;
  for (const record of records) {
    const text = JSON.stringify(record);
    adapter.push(record, at, at + Buffer.byteLength(text));
    at += Buffer.byteLength(text) + 1;
  }
  const session = adapter.finish(1);
  const metrics = computeMetrics({ session, raw: adapter.b.quality, samples: [], options: DEFAULT_OPTIONS });
  return { adapter, session, metrics };
}

test('qwen detection uses its own wire marks, and claude still detects as claude', () => {
  const head = [
    sys('session_source', 0, { sourceType: 'default' }),
    sys('session_model', 0, { modelId: 'qwen4-max' }),
    prompt('hello', 1),
    assistant([{ text: 'hi' }], 2, usage(100, 10, 0, 50)),
    result('c1', 'ok', 3),
  ].map(JSON.stringify).join('\n');
  const detected = detectFromText(head);
  assert.equal(detected.vendor, 'qwen');
  assert.match(detected.reason, /qwen code/);

  // A system-only head (the runtime writes a lot of preamble) is still qwen.
  const sysHead = [
    sys('session_source', 0, { sourceType: 'default' }),
    sys('ui_telemetry', 0, { uiEvent: 'x' }),
    sys('session_approval_mode', 0, { mode: 'auto' }),
  ].map(JSON.stringify).join('\n');
  assert.equal(detectFromText(sysHead).vendor, 'qwen');

  const claudeHead = [
    { type: 'user', uuid: 'a', sessionId: 's', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', uuid: 'b', sessionId: 's', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 1, output_tokens: 2 } } },
  ].map(JSON.stringify).join('\n');
  assert.equal(detectFromText(claudeHead).vendor, 'claude');
});

test('the parts stream becomes one timeline; only real_user opens a segment', () => {
  const { session, metrics } = run([
    sys('session_model', 0, { modelId: 'qwen4-max' }),
    sys('ui_telemetry', 0, { uiEvent: 'shown' }),
    prompt('inspect the project', 1),
    assistant([{ text: 'checking', thought: true }, { text: 'I will run a command.' }, { functionCall: { id: 'c1', name: 'run_shell_command', args: { command: 'npm test' } } }], 2, usage(1000, 80, 30, 900)),
    result('c1', 'all passed', 3, { type: 'shell_result', exitCode: 0, output: 'all passed', text: 'all passed', truncated: false, outcome: 'completed', notices: [] }),
    rec('user', 4, { provenance: 'synthetic', message: { role: 'user', parts: [{ text: 'runtime reminder' }] } }),
  ]);

  assert.deepEqual(session.events.map((ev) => ev.kind), ['system', 'system', 'prompt', 'reasoning', 'text', 'op', 'notice']);
  assert.equal(session.events[3].collapsed, true);
  assert.equal(session.info.title, 'inspect the project');
  assert.equal(session.info.model, 'qwen4-max');
  assert.equal(session.info.version, '0.28.4');
  assert.equal(session.info.cwd, '/work/project');
  assert.equal(session.info.sessionId, 'sess-qwen');
  assert.equal(session.segments.filter((s) => s.promptIdx >= 0).length, 1);

  const op = session.events[5];
  assert.equal(op.op.status, 'ok');
  assert.equal(op.op.command, 'npm test');
  assert.equal(op.op.subgroup, 'npm test');
  assert.equal(op.op.exitCode, 0);
  assert.equal(op.durationMs, 1000);
  assert.equal(op.durationSource, 'derived');
  // Usage attaches to the first event of its request, as in every adapter.
  assert.deepEqual(session.events[3].tokens.reported, { input: 100, cacheWrite: 0, cacheRead: 900, output: 80, reasoning: 30 });

  assert.equal(metrics.tokens.freshInput.value, 100);
  assert.equal(metrics.tokens.cacheRead.value, 900);
  assert.equal(metrics.tokens.output.value, 80);
  assert.equal(metrics.tokens.headline.value, 180);
  assert.equal(metrics.tokens.requests.value, 1);
  assert.equal(metrics.ops.totals.calls, 1);
});

test('each assistant record is one request: usage is attached once, never summed', () => {
  const { session, metrics } = run([
    prompt('q', 0),
    assistant([{ text: 'a' }], 1, usage(1000, 80, 30, 900)),
    assistant([{ text: 'b' }], 2, usage(1200, 40, 0, 1000)),
  ]);
  assert.equal(metrics.tokens.requests.value, 2);
  assert.equal(metrics.tokens.output.value, 120);
  assert.equal(metrics.tokens.freshInput.value, 300);
  assert.equal(metrics.tokens.cacheRead.value, 1900);
  const reported = session.events.filter((ev) => ev.tokens.reported);
  assert.equal(reported.length, 2);
  assert.deepEqual(reported[1].tokens.reported, { input: 200, cacheWrite: 0, cacheRead: 1000, output: 40, reasoning: 0 });
});

test('reasoning billed but not persisted refuses the calibration sample', () => {
  const { adapter } = run([
    prompt('q', 0),
    assistant([{ text: 'answer' }], 1, usage(1000, 80, 30, 900)),
    assistant([{ text: 'checking', thought: true }, { text: 'answer 2' }], 2, usage(1100, 90, 40, 950)),
  ]);
  const out = adapter.b.samples.filter((s) => s.kind === 'out');
  assert.equal(out.length, 1);
  assert.equal(out[0].tokens, 90);
});

test('a shell result is charged at the wrapper the model received, not the display', () => {
  const wrapper = 'Command: npm test\nDirectory: /work/project\nOutput:\nall passed\nExit Code: 0';
  const { session } = run([
    call('c1', 'run_shell_command', { command: 'npm test' }, 0),
    result('c1', wrapper, 1, { type: 'shell_result', exitCode: 0, output: 'all passed', text: 'all passed', truncated: false, outcome: 'completed', notices: [] }),
  ]);
  const op = session.events[0];
  assert.equal(op.body, 'all passed');
  assert.equal(op.tokens.payloadOut, Math.ceil(wrapper.length / 3.1));
});

test('an edit renders its diff with the reported line counts', () => {
  const fileDiff = 'Index: a.ts\n===================================================================\n--- a.ts\tCurrent\n+++ a.ts\tProposed\n@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3';
  const confirmation = 'The file /work/project/a.ts has been updated.';
  const { session } = run([
    call('e1', 'edit', { file_path: '/work/project/a.ts', old_string: 'old', new_string: 'new' }, 0),
    result('e1', confirmation, 1, { fileDiff, filePath: '/work/project/a.ts', diffStat: { model_added_lines: 1, model_removed_lines: 1, user_added_lines: 0, user_removed_lines: 0 } }),
  ]);
  const op = session.events[0];
  assert.equal(op.format, 'diff');
  assert.equal(op.op.linesAdded, 1);
  assert.equal(op.op.linesRemoved, 1);
  assert.equal(op.op.category, 'edit');
  assert.equal(op.op.subgroup, '.ts');
  assert.match(op.body, /-old/);
  assert.match(op.body, /\+new/);
  assert.equal(op.tokens.payloadOut, Math.ceil(confirmation.length / 3.1));
});

test('questions keep every option and mark the answer qwen returned', () => {
  const question = 'Which approach?';
  const questions = [
    {
      header: 'Approach',
      question,
      options: [
        { label: 'Adapter', description: 'Normalize the wire format' },
        { label: 'Rewrite', description: 'Replace the reader' },
      ],
    },
  ];
  const { session } = run([
    call('a1', 'ask_user_question', { questions }, 0),
    result('a1', 'User has provided the following answers:', 1, {
      type: 'ask_user_question_answers',
      text: 'User has provided the following answers:',
      answers: [{ question, answer: 'Adapter' }],
    }),
  ]);
  const row = session.events[0];
  assert.equal(row.format, 'ask');
  const [decoded] = decodeAsk(row.body);
  assert.equal(decoded.question, question);
  assert.equal(decoded.options.length, 2);
  assert.equal(decoded.options[0].picked, true);
  assert.equal(decoded.options[1].picked, false);
});

test('plan mode start, approval and rejection; a plan file counts as a plan', () => {
  const approved = run([
    call('p1', 'enter_plan_mode', { userRequested: true }, 0),
    result('p1', 'Entered plan mode.', 1),
    call('p2', 'exit_plan_mode', { plan: '# Plan\n1. one\n2. two' }, 2),
    result('p2', 'User approved the plan.', 3),
  ]);
  const start = approved.session.events[0];
  assert.equal(start.plan.source, 'plan-mode');
  assert.equal(start.plan.role, 'start');
  const revision = approved.session.events[1];
  assert.equal(revision.plan.role, 'revision');
  assert.equal(revision.plan.approved, true);
  assert.equal(revision.plan.steps.length, 2);
  assert.equal(approved.metrics.plan.detected, true);

  const rejected = run([
    call('p3', 'exit_plan_mode', { plan: '# Plan\n1. one' }, 0),
    result('p3', 'The user rejected the plan. Keep planning.', 1),
  ]);
  assert.equal(rejected.session.events[0].plan.approved, false);

  const filePlan = run([
    call('w1', 'write_file', { file_path: '/work/project/PLAN.md', content: '# Plan\n- step' }, 0),
    result('w1', 'File created.', 1),
  ]);
  assert.equal(filePlan.session.events[0].plan.source, 'file');
  assert.equal(filePlan.session.events[0].plan.path, '/work/project/PLAN.md');
});

test('tool_call is categorized by the deferred tool it wraps', () => {
  const { session } = run([
    call('t1', 'tool_call', { name: 'web_fetch', arguments: { url: 'https://example.com/page' } }, 0),
    result('t1', 'page content', 1),
  ]);
  const op = session.events[0];
  assert.equal(op.op.name, 'tool_call');
  assert.equal(op.op.category, 'web');
  assert.equal(op.op.subgroup, 'example.com');
  assert.deepEqual(op.chips, ['web_fetch']);
});

test('unpaired calls, orphan results and unknown records stay visible to quality', () => {
  const { adapter, session } = run([
    call('open', 'read_file', { file_path: '/a.ts' }, 0),
    result('missing', 'orphan output', 1),
    rec('future_record', 2),
    sys('never_seen_subtype', 3, {}),
  ]);
  assert.equal(session.events.find((ev) => ev.op)?.op.status, 'unpaired');
  assert.equal(session.events.find((ev) => ev.title === 'orphan result')?.body, 'orphan output');
  assert.equal(adapter.b.quality.orphanResults, 1);
  assert.equal(adapter.b.quality.unknownTypes.get('future_record'), 1);
  assert.equal(adapter.b.quality.unknownTypes.get('system:never_seen_subtype'), 1);
});

test('turn_result is bookkeeping, not a second copy of the conversation', () => {
  const { session } = run([
    prompt('the real prompt', 0),
    assistant([{ text: 'the real answer' }], 1),
    sys('turn_result', 2, { state: 'completed', stopReason: 'end_turn', startedAt: T0, endedAt: T0 + 5000, promptText: 'the real prompt', resultText: 'the real answer' }),
  ]);
  assert.equal(session.events.filter((ev) => ev.kind === 'prompt').length, 1);
  assert.equal(session.events.filter((ev) => ev.kind === 'text').length, 1);
  const turn = session.events[2];
  assert.equal(turn.kind, 'system');
  assert.match(turn.subtitle, /completed · end_turn · 5\.0s/);

  const failed = run([sys('turn_result', 0, { state: 'aborted', stopReason: 'cancelled' })]);
  assert.equal(failed.session.events[0].kind, 'error');
});

test('an oversized result is rebuilt from its original wire record', () => {
  const big = 'x'.repeat(40_000);
  const output = result('c-big', big, 1);
  const { session } = run([call('c-big', 'run_shell_command', { command: 'generate' }, 0), output]);
  const row = session.events[0];
  assert.equal(row.more, true);
  assert.ok(row.body.length < big.length);
  assert.equal(fullBody(output, { start: 0, end: 0, block: 0 }), big);

  const textRec = assistant([{ text: 'y'.repeat(40_000) }], 0);
  assert.equal(fullBody(textRec, { start: 0, end: 0, block: 0 }), 'y'.repeat(40_000));
});

test('tool categories use the same canonical groups as the other adapters', () => {
  assert.equal(categoryOf('read_file'), 'read');
  assert.equal(categoryOf('grep_search'), 'search');
  assert.equal(categoryOf('edit'), 'edit');
  assert.equal(categoryOf('run_shell_command'), 'execute');
  assert.equal(categoryOf('web_fetch'), 'web');
  assert.equal(categoryOf('exit_plan_mode'), 'plan');
  assert.equal(categoryOf('ask_user_question'), 'ask');
  assert.equal(categoryOf('agent'), 'agent');
  assert.equal(categoryOf('something_new'), 'other');
});

test('inlineData parts become blob URLs inside the worker walk', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const record = prompt('look at this', 0);
  record.message.parts.push({ inlineData: { mimeType: 'image/png', data: png } });
  const n = await extractImages(record);
  assert.equal(n, 1);
  assert.ok(record.message.parts[1].__img.url.startsWith('blob:'));
  assert.equal(record.message.parts[1].inlineData.data, '');
  const { session } = run([record]);
  assert.equal(session.events[0].images.length, 1);
});

test('peek names a qwen transcript from its first human prompt', async () => {
  const records = [sys('session_model', 0, { modelId: 'qwen4-max' }), prompt('read my qwen session', 1)];
  const head = records.map(JSON.stringify).join('\n');
  const file = new File([head], 'sess.jsonl');
  const identity = await peekIdentity(file, detectFromText(head));
  assert.equal(identity.title, 'read my qwen session');
  assert.equal(identity.model, 'qwen4-max');
  assert.equal(identity.startTs, T0);
  assert.equal(identity.complete, true);
});

test('qwen title/ledger/cursor-key are sidecars, and the title is part of the cache identity', async () => {
  const registry = new Registry();
  const transcript = registry.add(new File(['{}\n'], 'sess.jsonl', { lastModified: 10 }), 'root/projects/-work/chats/sess.jsonl');
  const title = registry.add(
    new File([JSON.stringify({ version: 1, displayName: 'A custom title', source: 'prompt' })], 'sess.title.json', { lastModified: 11 }),
    'root/projects/-work/chats/sess.title.json',
  );
  assert.equal(title, null);
  const ledger = registry.add(new File(['{}\n'], 'sess.ledger.jsonl'), 'root/projects/-work/chats/sess.ledger.jsonl');
  assert.equal(ledger, null);
  const cursorKey = registry.add(new File(['opaque'], 'session-transcript-cursor-key'), 'root/projects/-work/session-transcript-cursor-key');
  assert.equal(cursorKey, null);
  assert.equal(registry.entries.size, 1);

  await registry.hydrateQwenMetadata();
  registry.identify(transcript, { title: 'first prompt', startTs: T0 + 1000, complete: true });
  assert.equal(transcript.identity.title, 'A custom title');
  assert.equal(transcript.identity.startTs, T0 + 1000);
  assert.notEqual(registry.mergedKey(transcript), transcript.key);
});
