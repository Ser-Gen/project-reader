import test from 'node:test';
import assert from 'node:assert/strict';

import { KimiAdapter, fullBody, categoryOf } from '../src/vendor/kimi.ts';
import { detectFromText } from '../src/vendor/detect.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';
import { decodeAsk } from '../src/view/ask.ts';
import { Registry } from '../src/intake.ts';
import { peekIdentity } from '../src/worker/peek.ts';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const rec = (type, at, extra = {}) => ({ type, agentId: 'main', time: T0 + at * 1000, ...extra });
const loop = (event, at) => rec('context.append_loop_event', at, { event });
const call = (id, name, args, at = 1, display) =>
  loop({ type: 'tool.call', uuid: `u-${id}`, toolCallId: id, stepUuid: 'step-1', name, args, display }, at);
const result = (id, output, at = 2, extra = {}) =>
  loop({ type: 'tool.result', parentUuid: `u-${id}`, toolCallId: id, result: { output, durationMs: 25, ...extra } }, at);
const textMessage = (text, origin = 'user', at = 0) =>
  rec('context.append_message', at, { message: { role: 'user', origin: { kind: origin }, content: [{ type: 'text', text }] } });

function run(records) {
  const adapter = new KimiAdapter('f1', 'wire.jsonl', 0, 1, {});
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

test('kimi detection uses wire records, not the file name', () => {
  const head = [
    { type: 'metadata', protocol_version: '1.5', created_at: '2026-10-01T10:00:00.000Z' },
    rec('usage.record', 0, { usageScope: 'turn', usage: { inputOther: 1, inputCacheCreation: 0, inputCacheRead: 0, output: 1 } }),
  ].map(JSON.stringify).join('\n');
  const detected = detectFromText(head);
  assert.equal(detected.vendor, 'kimi');
  assert.match(detected.reason, /kimi code/);
});

test('the loop stream becomes one timeline and turn usage is counted once', () => {
  const usage = { inputOther: 10, inputCacheCreation: 5, inputCacheRead: 900, output: 7 };
  const { session, metrics } = run([
    { type: 'metadata', protocol_version: '1.5', created_at: '2026-10-01T10:00:00.000Z' },
    rec('turn.prompt', 0, { turnId: 'turn-1' }),
    textMessage('inspect the project', 'user', 0),
    loop({ type: 'step.begin', turnId: 'turn-1', step: 1 }, 1),
    rec('usage.record', 2, { model: 'kimi-for-coding', usageScope: 'turn', usage }),
    loop({ type: 'content.part', uuid: 'think-1', part: { type: 'think', think: 'checking' } }, 3),
    loop({ type: 'content.part', uuid: 'text-1', part: { type: 'text', text: 'I will run a command.' } }, 4),
    call('bash-1', 'Bash', { command: 'npm test' }, 5),
    result('bash-1', 'all passed', 6),
    loop({ type: 'step.end', turnId: 'turn-1', step: 1, usage, llmFirstTokenLatencyMs: 320 }, 7),
    rec('usage.record', 8, { usageScope: 'session', usage: { inputOther: 9999, inputCacheCreation: 0, inputCacheRead: 0, output: 9999 } }),
    rec('agent.message.appended', 9, { message: { message: { role: 'user', content: [{ type: 'text', text: 'inspect the project' }] } } }),
    rec('llm.request', 10, { messages: [{ role: 'user', content: 'inspect the project' }] }),
  ]);

  assert.deepEqual(session.events.map((ev) => ev.kind), ['prompt', 'reasoning', 'text', 'op']);
  assert.equal(session.info.title, 'inspect the project');
  assert.equal(session.info.model, 'kimi-for-coding');
  assert.equal(session.info.version, 'wire 1.5');
  assert.equal(session.segments.find((seg) => seg.promptIdx >= 0).ttftMs, 320);

  const op = session.events[3];
  assert.equal(op.op.status, 'ok');
  assert.equal(op.op.command, 'npm test');
  assert.equal(op.op.subgroup, 'npm test');
  assert.equal(op.durationMs, 25);
  assert.equal(op.durationSource, 'reported');
  assert.deepEqual(op.tokens.reported, { input: 10, cacheWrite: 5, cacheRead: 900, output: 7 });

  assert.equal(metrics.tokens.freshInput.value, 15);
  assert.equal(metrics.tokens.cacheRead.value, 900);
  assert.equal(metrics.tokens.output.value, 7);
  assert.equal(metrics.tokens.headline.value, 22);
  assert.equal(metrics.tokens.contextPeak.value, 915);
  assert.equal(metrics.tokens.requests.value, 1);
  assert.equal(metrics.ops.totals.calls, 1);
});

test('step.end usage covers a missing usage.record and an unfinished step keeps its usage', () => {
  const usage = { inputOther: 3, inputCacheCreation: 2, inputCacheRead: 8, output: 4 };
  const first = run([
    loop({ type: 'step.begin', turnId: 'a', step: 1 }, 0),
    loop({ type: 'content.part', part: { type: 'text', text: 'answer' } }, 1),
    loop({ type: 'step.end', turnId: 'a', step: 1, usage }, 2),
  ]);
  assert.equal(first.metrics.tokens.headline.value, 9);

  const second = run([
    loop({ type: 'step.begin', turnId: 'b', step: 1 }, 0),
    rec('usage.record', 1, { usageScope: 'turn', usage }),
    loop({ type: 'content.part', part: { type: 'text', text: 'partial' } }, 2),
  ]);
  assert.equal(second.metrics.tokens.headline.value, 9);
});

test('edit and write rows carry diffs and line counts, while todo ticks stay progress', () => {
  const edit = call(
    'edit-1',
    'Edit',
    { path: '/repo/a.ts', old_string: 'const b = 2;', new_string: 'const b = 4;' },
    0,
    { path: '/repo/a.ts', before: 'const a = 1;\nconst b = 2;\nconst c = 3;', after: 'const a = 1;\nconst b = 4;\nconst c = 3;' },
  );
  const write = call('write-1', 'Write', { path: '/repo/new.ts', content: 'one\ntwo\n' }, 3);
  const todos1 = call('todo-1', 'TodoList', { todos: [{ title: 'one', status: 'pending' }, { title: 'two', status: 'pending' }] }, 5);
  const todos2 = call('todo-2', 'TodoList', { todos: [{ title: 'one', status: 'done' }, { title: 'two', status: 'pending' }] }, 7);
  const records = [edit, result('edit-1', 'ok'), write, result('write-1', 'ok'), todos1, result('todo-1', 'ok'), todos2, result('todo-2', 'ok')];
  const { session, metrics } = run(records);

  const edited = session.events.find((ev) => ev.op?.name === 'Edit');
  assert.equal(edited.format, 'diff');
  assert.equal(edited.op.linesAdded, 1);
  assert.equal(edited.op.linesRemoved, 1);
  assert.match(edited.body, /-const b = 2;/);
  assert.match(edited.body, /\+const b = 4;/);
  assert.equal(fullBody(edit, { start: 0, end: 0, block: 0 }), edited.body);

  const written = session.events.find((ev) => ev.op?.name === 'Write');
  assert.equal(written.op.linesAdded, 2);
  assert.equal(written.op.linesRemoved, undefined);
  assert.match(written.body, /\+one\n\+two/);

  const todos = session.events.filter((ev) => ev.op?.name === 'TodoList');
  assert.equal(todos.length, 2);
  assert.match(todos[1].body, /\[x\] one/);
  assert.equal(metrics.plan.detected, true);
  assert.equal(metrics.plan.planRevisions.value, 2);
  assert.equal(metrics.plan.progressTicks.value, 1);
  assert.equal(metrics.plan.planEdits.value, 0);
});

test('replace_all does not invent line totals for an unknown number of replacements', () => {
  const { session } = run([
    call('edit-all', 'Edit', { path: '/repo/a.ts', old_string: 'x', new_string: 'y\ny', replace_all: true }),
    result('edit-all', 'replaced everywhere'),
  ]);
  const edit = session.events[0];
  assert.equal(edit.op.linesAdded, undefined);
  assert.equal(edit.op.linesRemoved, undefined);
  assert.deepEqual(edit.chips, ['replace all']);
});

test('questions keep every option and mark the answer returned by kimi', () => {
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
    call('ask-1', 'AskUserQuestion', { questions }),
    result('ask-1', JSON.stringify({ answers: { [question]: 'Adapter' } })),
  ]);
  const row = session.events[0];
  assert.equal(row.format, 'ask');
  const [decoded] = decodeAsk(row.body);
  assert.equal(decoded.question, question);
  assert.equal(decoded.options.length, 2);
  assert.equal(decoded.options[0].description, 'Normalize the wire format');
  assert.equal(decoded.options[0].picked, true);
  assert.equal(decoded.options[1].picked, false);
});

test('compactions, unpaired calls, orphan results and unknown records stay visible to quality', () => {
  const { adapter, session } = run([
    rec('context.apply_compaction', 0, { summary: 'what happened before', compactedCount: 12, tokensBefore: 1000, tokensAfter: 200 }),
    call('read-open', 'Read', { path: '/repo/a.ts' }, 1),
    result('missing-call', 'orphan output', 2),
    rec('future.record', 3, { value: 1 }),
  ]);
  assert.equal(session.events[0].kind, 'compaction');
  assert.equal(session.events[0].body, 'what happened before');
  assert.deepEqual(session.events[0].chips, ['12 compacted', '1000 → 200 tokens']);
  assert.equal(session.events.find((ev) => ev.op)?.op.status, 'unpaired');
  assert.equal(session.events.find((ev) => ev.title === 'orphan result')?.body, 'orphan output');
  assert.equal(adapter.b.quality.orphanResults, 1);
  assert.equal(adapter.b.quality.unknownTypes.get('future.record'), 1);
});

test('an oversized result is rebuilt from its original wire record', () => {
  const big = 'x'.repeat(40_000);
  const output = result('bash-big', big);
  const { session } = run([call('bash-big', 'Bash', { command: 'generate' }), output]);
  const row = session.events[0];
  assert.equal(row.more, true);
  assert.ok(row.body.length < big.length);
  assert.equal(fullBody(output, { start: 0, end: 0, block: 0 }), big);
});

test('tool categories use the same canonical groups as the other adapters', () => {
  assert.equal(categoryOf('Read'), 'read');
  assert.equal(categoryOf('Grep'), 'search');
  assert.equal(categoryOf('Edit'), 'edit');
  assert.equal(categoryOf('Bash'), 'execute');
  assert.equal(categoryOf('FetchURL'), 'web');
  assert.equal(categoryOf('TodoList'), 'plan');
  assert.equal(categoryOf('AskUserQuestion'), 'ask');
  assert.equal(categoryOf('Agent'), 'agent');
});

test('peek names a standalone wire from its first human prompt', async () => {
  const records = [
    { type: 'metadata', protocol_version: '1.5', created_at: '2026-10-01T10:00:00.000Z' },
    textMessage('read my kimi session'),
  ];
  const file = new File([records.map(JSON.stringify).join('\n')], 'wire.jsonl');
  const detection = detectFromText(records.map(JSON.stringify).join('\n'));
  const identity = await peekIdentity(file, detection);
  assert.equal(identity.title, 'read my kimi session');
  assert.equal(identity.startTs, T0);
  assert.equal(identity.complete, true);
});

test('kimi state.json is a metadata sidecar and part of the cache identity', async () => {
  const registry = new Registry();
  const wire = registry.add(new File(['{}\n'], 'wire.jsonl', { lastModified: 10 }), 'root/session_abc/agents/main/wire.jsonl');
  const state = {
    id: 'session_abc',
    title: 'A custom title',
    cwd: '/work/project',
    createdAt: T0,
  };
  const sidecar = registry.add(
    new File([JSON.stringify(state)], 'state.json', { lastModified: 11 }),
    'root/session_abc/state.json',
  );
  assert.equal(sidecar, null);

  await registry.hydrateKimiMetadata();
  registry.identify(wire, { title: 'first prompt', startTs: T0 + 1000, complete: true });
  assert.equal(wire.identity.title, 'A custom title');
  assert.equal(wire.identity.cwd, '/work/project');
  assert.equal(wire.identity.sessionId, 'session_abc');
  assert.equal(wire.identity.startTs, T0 + 1000);
  assert.equal(wire.project, '/work/project');
  assert.notEqual(registry.mergedKey(wire), wire.key);
});
