import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeAdapter, toolBody, fullBody, categoryOf, subgroupOf } from '../src/vendor/claude.ts';
import { CodexAdapter, fullBody as codexFullBody, scriptCommands } from '../src/vendor/codex.ts';
import { CursorAdapter, parseExportedChat, readCursorDb } from '../src/vendor/cursor.ts';
import { SqliteDb } from '../src/vendor/sqlite.ts';
import { detectFromText } from '../src/vendor/detect.ts';
import { decodeAsk } from '../src/view/ask.ts';
import { computeMetrics } from '../src/metrics/index.ts';
import { DEFAULT_OPTIONS } from '../src/model/metrics.ts';

export function run(Adapter, records) {
  const a = new Adapter('f1', 'test.jsonl', 0, 1, {});
  let at = 0;
  for (const r of records) {
    const text = JSON.stringify(r);
    a.push(r, at, at + Buffer.byteLength(text));
    at += Buffer.byteLength(text) + 1;
  }
  return { session: a.finish(1), adapter: a };
}

const rec = (o) => ({ timestamp: '2026-01-01T10:00:00.000Z', sessionId: 's1', uuid: `u${Math.random()}`, ...o });

/* ---------- claude ---------- */

test('human prompts open segments; a tool_result folds into its call', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'queue-operation', operation: 'enqueue' }),
    rec({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'first ask' }] } }),
    rec({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        id: 'm1',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }],
      },
    }),
    rec({
      timestamp: '2026-01-01T10:00:02.000Z',
      type: 'user',
      toolUseResult: { stdout: 'a.txt\nb.txt', stderr: '', interrupted: false },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt' }] },
    }),
    rec({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'second ask' }] } }),
  ]);

  assert.deepEqual(session.events.map((e) => e.kind), ['system', 'prompt', 'op', 'prompt']);
  const tool = session.events[2];
  assert.equal(tool.op.name, 'Bash');
  assert.equal(tool.op.category, 'execute');
  assert.equal(tool.op.subgroup, 'ls');
  assert.equal(tool.op.status, 'ok');
  assert.equal(tool.subtitle, 'ls -la');
  assert.equal(tool.body, 'a.txt\nb.txt');
  assert.equal(tool.durationMs, 2000);
  assert.equal(tool.durationSource, 'derived');
  assert.ok(tool.tokens.payloadOut > 0, 'the result should carry an estimated payload');

  // preamble + two prompt segments
  assert.equal(session.segments.length, 3);
  assert.equal(session.segments[1].title, 'first ask');
  assert.equal(session.segments[1].toolCount, 1);
  assert.equal(session.events[2].seg, 1);
  assert.equal(session.events[3].seg, 2);
});

test('tool results are never mistaken for prompts', () => {
  const { session, adapter } = run(ClaudeAdapter, [
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'orphan' }] } }),
  ]);
  assert.equal(session.events.filter((e) => e.kind === 'prompt').length, 0);
  assert.equal(adapter.b.quality.orphanResults, 1);
});

test('an unanswered call is unpaired, not successful', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'sleep 100' } }] } }),
  ]);
  assert.equal(session.events[0].op.status, 'unpaired');
  assert.equal(session.events[0].durationMs, undefined);
});

test('reasoning is kept but collapsed, and empty reasoning becomes a system note', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
  ]);
  assert.equal(session.events[0].kind, 'reasoning');
  assert.equal(session.events[0].collapsed, true);
  assert.equal(session.events[1].kind, 'system');
});

test('bad timestamps and missing fields do not throw', () => {
  const { session } = run(ClaudeAdapter, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    { type: 'wat' },
  ]);
  assert.equal(session.events[0].ts, 0);
  assert.equal(session.events[0].tsSource, 'missing');
  assert.equal(session.events[1].kind, 'system');
});

test('usage is attached once per request and cache reads stay separate', () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 9000, output_tokens: 7 };
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'a' }], usage } }),
    // the same message id arriving again must not be counted twice
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'b' }], usage } }),
  ]);
  const reported = session.events.filter((e) => e.tokens.reported);
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0].tokens.reported, { input: 10, cacheWrite: 5, cacheRead: 9000, output: 7 });
});

test('parallel calls in one request are marked as sharing their timing', () => {
  const { session } = run(ClaudeAdapter, [
    rec({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'm1',
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/a.ts' } },
          { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/x/b.ts' } },
        ],
      },
    }),
    rec({ timestamp: '2026-01-01T10:00:03.000Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } }),
    rec({ timestamp: '2026-01-01T10:00:05.000Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'y' }] } }),
  ]);
  const ops = session.events.filter((e) => e.kind === 'op');
  assert.equal(ops.length, 2);
  for (const o of ops) assert.equal(o.durationSource, 'shared');
});

test('subagent work is attributed to the call that spawned it', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'task', name: 'Task', input: { subagent_type: 'Explore' } }] } }),
    rec({ isSidechain: true, type: 'assistant', message: { role: 'assistant', id: 'm2', content: [{ type: 'tool_use', id: 'g', name: 'Grep', input: { pattern: 'x' } }] } }),
  ]);
  const [task, grep] = session.events;
  assert.equal(task.op.category, 'agent');
  assert.equal(grep.sidechain, 1);
  assert.equal(grep.spawnedBy, task.idx);
});

test('plan mode wins over a todo list when both are present', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'e', name: 'ExitPlanMode', input: { plan: '- one\n- two\n- three' } }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'User approved' }] } }),
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm2', content: [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'one', status: 'pending' }] } }] } }),
  ]);
  const plans = session.events.filter((e) => e.plan);
  assert.equal(plans[0].plan.source, 'plan-mode');
  assert.equal(plans[0].plan.approved, true);
  assert.equal(plans[0].plan.steps.length, 3);
  assert.equal(plans[1].plan.source, 'plan-tool');
});

test('a rejected plan is not recorded as approved', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'e', name: 'ExitPlanMode', input: { plan: '- one\n- two\n- three' } }] } }),
    rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e', content: 'The user rejected the plan.' }] } }),
  ]);
  assert.equal(session.events[0].plan.approved, false);
});

test('a plan written to a file counts as a plan', () => {
  const { session } = run(ClaudeAdapter, [
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/repo/PLAN.md', content: '# Plan\n\n- a\n- b\n- c' } }] } }),
    rec({ type: 'assistant', message: { role: 'assistant', id: 'm2', content: [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/repo/notes.md', content: '- a\n- b\n- c' } }] } }),
  ]);
  assert.equal(session.events[0].plan.source, 'file');
  assert.equal(session.events[0].plan.path, '/repo/PLAN.md');
  assert.equal(session.events[1].plan, undefined);
});

test('categories and drill-down keys', () => {
  assert.equal(categoryOf('Read'), 'read');
  assert.equal(categoryOf('Grep'), 'search');
  assert.equal(categoryOf('MysteryTool'), 'other');
  assert.equal(subgroupOf('Bash', 'execute', 'npm test -- --watch'), 'npm test');
  assert.equal(subgroupOf('Edit', 'edit', '/repo/src/main.ts'), '.ts');
  assert.equal(subgroupOf('WebFetch', 'web', 'https://www.docs.example.com/x'), 'docs.example.com');
});

/* ---------- tool bodies ---------- */

test('Edit results render as a unified diff with counts', () => {
  const b = toolBody('Edit', null, {
    structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-gone', '+new', '+extra'] }],
  }, '');
  assert.equal(b.format, 'diff');
  assert.deepEqual(b.chips, ['+2', '−1']);
  assert.equal(b.adds, 2);
  assert.equal(b.dels, 1);
});

test('WebSearch results become a markdown link list', () => {
  const b = toolBody('WebSearch', null, { query: 'q', durationSeconds: 2.05, results: [{ content: [{ title: 'T', url: 'https://x.dev' }] }] }, '');
  assert.equal(b.format, 'md');
  assert.equal(b.text, '- [T](https://x.dev)');
  assert.deepEqual(b.chips, ['1 results', '2.0s']);
});

test('TodoWrite renders a checklist with progress', () => {
  const b = toolBody('TodoWrite', null, { newTodos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, '');
  assert.equal(b.text, '[x] a\n[ ] b');
  assert.deepEqual(b.chips, ['1/2 done']);
});

test('interrupted bash is reported as interrupted, not ok', () => {
  assert.equal(toolBody('Bash', null, { stdout: '', stderr: '', interrupted: true }, '').status, 'interrupted');
});

test('fullBody rebuilds an over-sized body from the raw record', () => {
  const big = 'x'.repeat(40_000);
  const record = rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'short' }, { type: 'text', text: big }] } });
  const { session } = run(ClaudeAdapter, [record]);
  assert.equal(session.events[1].more, true);
  assert.ok(session.events[1].body.length < big.length);
  assert.equal(fullBody(record, { start: 0, end: 0, block: 1 }), big);
});

/* ---------- codex ---------- */

const cx = (s, type, payload) => ({ timestamp: new Date(Date.parse('2026-02-01T10:00:00Z') + s * 1000).toISOString(), type, payload });

test('codex rollouts produce prompts, calls and results', () => {
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 'sess', cwd: '/repo', model: 'gpt-5' }),
    cx(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] }),
    cx(2, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about it' }] }),
    cx(3, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) }),
    cx(6, 'response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0, duration_seconds: 2.5 } }) }),
    cx(7, 'response_item', { type: 'function_call', name: 'update_plan', call_id: 'c2', arguments: JSON.stringify({ plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'pending' }] }) }),
    cx(8, 'response_item', { type: 'function_call_output', call_id: 'c2', output: 'updated' }),
  ]);
  const kinds = session.events.map((e) => e.kind);
  assert.ok(kinds.includes('prompt'));
  assert.ok(kinds.includes('reasoning'));
  const shell = session.events.find((e) => e.op?.name === 'shell');
  assert.equal(shell.op.category, 'execute');
  assert.equal(shell.op.status, 'ok');
  assert.equal(shell.op.exitCode, 0);
  assert.equal(shell.durationMs, 2500);
  assert.equal(shell.durationSource, 'reported');
  assert.equal(session.info.cwd, '/repo');
  const plan = session.events.find((e) => e.plan);
  assert.equal(plan.plan.source, 'plan-tool');
  assert.deepEqual(plan.plan.steps.map((s) => s.status), ['done', 'pending']);
});

test('codex cumulative token counters are differenced, and a reset is clamped', () => {
  const { session, adapter } = run(CodexAdapter, [
    cx(1, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one' }] }),
    cx(2, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 } } }),
    cx(3, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] }),
    cx(4, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 2500, cached_input_tokens: 900, output_tokens: 250 } } }),
    // the context was reset: totals go backwards
    cx(5, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'three' }] }),
    cx(6, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 20 } } }),
  ]);
  const reported = session.events.filter((e) => e.tokens.reported).map((e) => e.tokens.reported);
  assert.deepEqual(reported[0], { input: 600, cacheWrite: 0, cacheRead: 400, output: 100, reasoning: 0 });
  assert.deepEqual(reported[1], { input: 1000, cacheWrite: 0, cacheRead: 500, output: 150, reasoning: 0 });
  // The reset contributes nothing rather than a negative — the usage before it
  // is unrecoverable, so the total is low rather than wrong, and says so.
  assert.equal(reported.length, 2);
  assert.ok(adapter.b.quality.notes.some((n) => /reset/.test(n)));
});

test('a codex exec script is shown as code, and the commands inside it are lifted out', () => {
  const script =
    'const r = await tools.exec_command({cmd:"rg -n \\"Tip|Top\\" src --glob \'!vendor/**\'"});\ntext(r.output);\n';
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 's', cwd: 'e:\\work\\repo' }),
    cx(1, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: script }),
    cx(4, 'response_item', {
      type: 'custom_tool_call_output',
      call_id: 'c1',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time 1.4 seconds\nOutput:\n' },
        { type: 'input_text', text: 'src/a.ts:12: TipTop\n' },
      ],
    }),
  ]);
  const call = session.events.find((e) => e.op?.name === 'exec');
  // The row leads with the command, not with `{"_raw":"const r = await…`.
  assert.equal(call.subtitle, 'rg -n "Tip|Top" src --glob \'!vendor/**\'');
  // The script is a plain wrapper around one command that the head already
  // shows, so the body is just the output.
  assert.equal(call.body, 'src/a.ts:12: TipTop\n');
  assert.equal(call.op.subgroup, 'rg', 'the ops table groups by command, not by the one tool');
  assert.equal(call.op.category, 'execute');
  // The wall time is reported by the tool, not inferred from record stamps.
  assert.equal(call.durationMs, 1400);
  assert.equal(call.durationSource, 'reported');
  assert.equal(call.body.includes('Script completed'), false);
  assert.equal(call.op.status, 'ok');
});

test('a script with no shell command still groups, and a failed one is an error', () => {
  const { session } = run(CodexAdapter, [
    cx(1, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'text(ALL_TOOLS.map(x=>x.name));\n' }),
    cx(2, 'response_item', {
      type: 'custom_tool_call_output',
      call_id: 'c1',
      output: [{ type: 'input_text', text: 'Script failed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: 'boom' }],
    }),
  ]);
  const call = session.events.find((e) => e.op?.name === 'exec');
  assert.equal(call.op.subgroup, 'script');
  assert.equal(call.op.status, 'error');
  // Nothing in the head can stand for a program, so it is shown above what it
  // printed, the way a terminal would.
  assert.ok(call.body.startsWith('text(ALL_TOOLS.map(x=>x.name));'), call.body);
  assert.ok(call.body.endsWith('boom'));
  assert.ok(/─+ output/.test(call.body));
});

test('a truncated codex result is flagged, and still costed at what the model was sent', () => {
  const full = 'Script completed\nWall time 0.5 seconds\nOutput:\nWarning: truncated output (original token count: 27376)\nthe rest\n';
  const { session } = run(CodexAdapter, [
    cx(1, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'tools.exec_command({cmd:"ls"})' }),
    cx(2, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: full }] }),
  ]);
  const call = session.events.find((e) => e.op?.name === 'exec');
  assert.equal(call.body, 'the rest\n');
  assert.ok(call.chips.some((c) => /truncated/.test(c)));
  // The warning and the header were in the context even though the row drops
  // them, so the estimate must not shrink with the display.
  assert.ok(call.tokens.payloadOut > Math.round('the rest\n'.length / 4));
});

test('codex patch events become per-file edits with real diffs', () => {
  const diff = '@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n';
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 's', cwd: 'e:\\work\\repo' }),
    cx(1, 'event_msg', {
      type: 'patch_apply_end',
      call_id: 'exec-1',
      success: true,
      stdout: 'Success. Updated the following files:\nM E:\\work\\repo\\src\\a.php',
      changes: {
        'E:\\work\\repo\\src\\a.php': { type: 'update', unified_diff: diff, move_path: null },
        'E:\\work\\repo\\src\\b.css': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y\n', move_path: null },
      },
    }),
  ]);
  const edits = session.events.filter((e) => e.op?.category === 'edit');
  assert.equal(edits.length, 2, 'one row per file, not one row per patch');
  // The drive letter disagrees with the session cwd about its case, which is
  // exactly what the real rollouts do.
  assert.deepEqual(edits.map((e) => e.op.target), ['src/a.php', 'src/b.css']);
  assert.equal(edits[0].format, 'diff');
  assert.equal(edits[0].op.linesAdded, 2);
  assert.equal(edits[0].op.linesRemoved, 1);
  assert.equal(edits[0].op.subgroup, '.php');
  // The diff never reached the model; the script call is where the cost was paid.
  assert.equal(edits[0].tokens.payloadIn, 0);
});

test('codex reasoning that is stored encrypted is reported, not silently dropped', () => {
  const { session, adapter } = run(CodexAdapter, [
    cx(1, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' }),
    cx(2, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' }),
  ]);
  assert.equal(session.events.filter((e) => e.kind === 'reasoning').length, 0);
  assert.ok(adapter.b.quality.notes.some((n) => /encrypted/.test(n)));
});

test('a codex result body survives the expand path unchanged', () => {
  const record = cx(2, 'response_item', {
    type: 'custom_tool_call_output',
    call_id: 'c1',
    output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'line one\nline two' }],
  });
  assert.equal(codexFullBody(record, { start: 0, end: 0, block: 1 }), 'line one\nline two');
});

/* ---------- codex: the item stream ---------- */

const item = (sec, it, ms = 0) =>
  cx(sec, 'event_msg', { type: 'item_completed', item: it, started_at_ms: 1000, completed_at_ms: 1000 + ms });

const execCall = (sec, id, input) => cx(sec, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input });
const execOut = (sec, id, text) =>
  cx(sec, 'response_item', { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text }] });

const command = (over = {}) => ({
  type: 'CommandExecution',
  id: 'exec-1',
  command: ['/bin/zsh', '-lc', 'rg -n Tip src'],
  parsed_cmd: [{ type: 'search', cmd: 'rg -n Tip src' }],
  status: 'completed',
  stdout: 'src/a.ts:1: Tip\nsrc/b.ts:2: Tip\n',
  stderr: '',
  exit_code: 0,
  duration: { secs: 0, nanos: 51_000_000 },
  formatted_output: 'src/a.ts:1: Tip\n',
  ...over,
});

test('a command item becomes the call it was launched by, with its own facts', () => {
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 's', cwd: '/repo' }),
    execCall(1, 'c1', 'const r = await tools.exec_command({cmd:"rg -n Tip src"});\ntext(r.output);\n'),
    item(2, command(), 51),
    execOut(3, 'c1', 'Script completed\nWall time 0.3 seconds\nOutput:\n{"exit_code":0}'),
  ]);
  const ops = session.events.filter((e) => e.kind === 'op');
  assert.equal(ops.length, 1, 'one call and one item are one operation, as under Claude');
  const op = ops[0];
  assert.equal(op.op.name, 'exec_command');
  // Codex classified the command itself; trusting it is what gives the ops
  // table a read/search/execute split instead of one `exec` bucket.
  assert.equal(op.op.category, 'search');
  assert.equal(op.op.subgroup, 'rg');
  assert.equal(op.subtitle, 'rg -n Tip src');
  assert.equal(op.op.exitCode, 0);
  assert.equal(op.durationMs, 51);
  assert.equal(op.durationSource, 'reported');
  // The row shows what the model was handed; the rest is one expand away.
  assert.equal(op.body, 'src/a.ts:1: Tip\n');
  assert.ok(op.more, 'and the fuller output is reachable');
  assert.equal(op.fullLen, 'src/a.ts:1: Tip\nsrc/b.ts:2: Tip\n'.length);
  assert.ok(op.chips.includes('full output on expand'));
});

test('a failing command is an error, and a sub-millisecond duration is not a measurement', () => {
  const { session } = run(CodexAdapter, [
    execCall(1, 'c1', 'tools.exec_command({cmd:"false"})'),
    item(2, command({ exit_code: 1, duration: { secs: 0, nanos: 5958 }, formatted_output: 'boom', stdout: 'boom' })),
    execOut(3, 'c1', 'Script completed\nWall time 0.4 seconds\nOutput:\n'),
  ]);
  const op = session.events.find((e) => e.kind === 'op');
  assert.equal(op.op.status, 'error');
  assert.equal(op.op.exitCode, 1);
  // Codex reports 0 for commands that plainly took longer, so the call's own
  // wall time stands in rather than a measurement nobody can believe.
  assert.equal(op.durationMs, 400);
});

test('one call that did several things becomes several rows, and shows the program once', () => {
  const script = 'const r = await Promise.all([\n  tools.view_image({path:"/repo/a.png"}),\n  tools.exec_command({cmd:"rg -n Tip src"}),\n]);\n';
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 's', cwd: '/repo' }),
    execCall(1, 'c1', script),
    item(2, { type: 'ImageView', id: 'exec-a', path: 'file:///repo/a%20b.png' }),
    item(3, command(), 51),
    execOut(4, 'c1', 'Script completed\nWall time 1.0 seconds\nOutput:\nlots of text here'),
  ]);
  const ops = session.events.filter((e) => e.kind === 'op');
  assert.deepEqual(ops.map((e) => e.op.name), ['view_image', 'exec_command']);
  assert.deepEqual(ops.map((e) => e.op.category), ['read', 'search']);
  assert.ok(ops[0].body.startsWith('const r = await Promise.all(['), 'the program is shown once, on the first row');
  assert.ok(!ops[1].body.includes('Promise.all'), 'and not repeated on the rest');
  assert.equal(ops[0].op.target, 'a b.png', 'the file:// path is decoded and shortened');
  assert.ok(ops[0].chips.some((c) => /not stored/.test(c)), 'an image Codex only pointed at cannot be shown');
  // One envelope carried both results back, so its cost is shared, not doubled.
  const cost = ops.reduce((n, e) => n + (e.tokens.payloadOut ?? 0), 0);
  assert.ok(cost > 0 && cost <= Math.ceil('Script completed\nWall time 1.0 seconds\nOutput:\nlots of text here'.length / 3));
});

test('a patch item becomes one edit row per file, and an added file reads as one', () => {
  const { session } = run(CodexAdapter, [
    cx(0, 'session_meta', { id: 's', cwd: '/repo' }),
    execCall(1, 'c1', 'tools.apply_patch({patch})'),
    item(2, {
      type: 'FileChange',
      id: 'exec-2',
      status: 'completed',
      changes: {
        '/repo/src/a.ts': { type: 'update', unified_diff: '@@ -1,2 +1,2 @@\n-old\n+new\n' },
        '/repo/src/new.css': { type: 'add', content: 'a {}\nb {}' },
      },
    }),
    execOut(3, 'c1', 'Script completed\nWall time 0.2 seconds\nOutput:\nSuccess.'),
  ]);
  const edits = session.events.filter((e) => e.op?.category === 'edit');
  assert.equal(edits.length, 2);
  assert.deepEqual(edits.map((e) => e.op.target), ['src/a.ts', 'src/new.css']);
  assert.equal(edits[0].format, 'diff');
  assert.equal(edits[0].op.linesAdded, 1);
  assert.equal(edits[1].op.linesAdded, 2, 'an added file counts as wholly added');
  assert.ok(edits[1].body.startsWith('@@ -0,0 +1,2 @@'), 'written as a hunk so it reads like every other edit');
  assert.ok(!edits[0].body.includes('apply_patch'), 'the envelope is not repeated above its own diff');
});

test('questions keyed by id, answered with lists, render as the decision they were', () => {
  const questions = [
    {
      id: 'source',
      header: 'Источник',
      question: 'Which is authoritative?',
      options: [
        { label: 'Prod (Recommended)', description: 'The screenshots are the live interface.' },
        { label: 'The other one', description: 'Keep going with what is started.' },
      ],
    },
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which parts?',
      options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }],
    },
    { id: 'free', header: 'Notes', question: 'Anything else?', options: [{ label: 'No' }] },
  ];
  const { session } = run(CodexAdapter, [
    cx(1, 'response_item', {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'q1',
      arguments: JSON.stringify({ questions }),
    }),
    cx(9, 'response_item', {
      type: 'function_call_output',
      call_id: 'q1',
      output: JSON.stringify({
        answers: {
          source: { answers: ['Prod (Recommended)'] },
          scope: { answers: ['Alpha', 'Gamma'] },
          free: { answers: ['none of these, do it the other way'] },
        },
      }),
    }),
  ]);
  const ask = session.events.find((e) => e.op?.name === 'request_user_input');
  assert.equal(ask.op.category, 'ask');
  assert.equal(ask.format, 'ask');
  assert.equal(ask.op.status, 'ok');
  assert.equal(ask.durationMs, 8000, 'a question is timed by how long the human took');

  const back = decodeAsk(ask.body);
  assert.equal(back.length, 3);
  assert.deepEqual(back[0].options.map((o) => o.picked), [true, false]);
  assert.equal(back[0].options[0].description, 'The screenshots are the live interface.');
  // Two answers to one question is the only evidence that it took several.
  assert.equal(back[1].multi, true);
  assert.deepEqual(back[1].options.filter((o) => o.picked).map((o) => o.label), ['Alpha', 'Gamma']);
  assert.equal(back[0].multi, false);
  const typed = back[2].options.find((o) => o.own);
  assert.equal(typed.label, 'none of these, do it the other way');
});

test('an unanswered question still shows what was on offer', () => {
  const { session } = run(CodexAdapter, [
    cx(1, 'response_item', {
      type: 'function_call',
      name: 'request_user_input',
      call_id: 'q1',
      arguments: JSON.stringify({ questions: [{ id: 'a', question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }] }),
    }),
  ]);
  const ask = session.events.find((e) => e.op?.name === 'request_user_input');
  assert.equal(ask.format, 'ask');
  assert.equal(ask.op.status, 'unpaired');
  assert.equal(decodeAsk(ask.body)[0].options.filter((o) => !o.none).length, 2);
});

test('plans, searches and stray items all become rows of their own', () => {
  const { session, adapter } = run(CodexAdapter, [
    item(1, { type: 'Plan', id: 'p1', text: '# Plan\n\n- one\n- two\n' }),
    item(2, {
      type: 'Extension',
      kind: 'web.search',
      id: 'exec-3',
      query: 'codex skills',
      results: [{ type: 'text_result', title: 'Skills', url: 'https://developers.openai.com/x', snippet: 'about skills' }],
    }, 3000),
    // an operation item that no call is waiting for
    item(3, command()),
    cx(4, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
      rate_limits: { primary: { used_percent: 37, window_minutes: 300 }, secondary: { used_percent: 14, window_minutes: 10080 }, plan_type: 'plus' } }),
  ]);
  const plan = session.events.find((e) => e.plan);
  assert.equal(plan.op.category, 'plan');
  assert.deepEqual(plan.plan.steps.map((s) => s.text), ['one', 'two']);

  const web = session.events.find((e) => e.op?.category === 'web');
  assert.equal(web.op.name, 'web.search');
  assert.equal(web.subtitle, 'codex skills');
  assert.ok(web.body.includes('[Skills](https://developers.openai.com/x)'));
  assert.equal(web.durationMs, 3000);

  assert.ok(session.events.some((e) => e.op?.name === 'exec_command'), 'a stray item is still an operation');
  assert.ok(adapter.b.quality.notes.some((n) => /rate limits at 37% of the 5-hour/.test(n)));
});

test('a turn that reported its own time to first token is not guessed at', () => {
  const { session, adapter } = run(CodexAdapter, [
    cx(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }),
    cx(2, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }),
    cx(3, 'event_msg', { type: 'task_complete', duration_ms: 12_000, time_to_first_token_ms: 4613 }),
  ]);
  const metrics = computeMetrics({ session, raw: adapter.b.quality, samples: [], options: DEFAULT_OPTIONS });
  assert.equal(metrics.time.thinkMs.value, 4613);
  assert.equal(metrics.time.thinkMs.provenance, 'reported');
});

/* ---------- cursor ---------- */

test('an exported cursor chat in markdown becomes a session', () => {
  const chat = parseExportedChat('**User**\n\nfix the bug\n\n**Cursor**\n\nI changed src/x.ts\n');
  assert.ok(chat);
  assert.equal(chat.bubbles.length, 2);
  assert.equal(chat.bubbles[0].role, 'user');
  const adapter = new CursorAdapter('f', 'export.md', 0, 0.5, {});
  const session = adapter.build(chat, [], [], 1);
  assert.deepEqual(session.events.map((e) => e.kind), ['prompt', 'text']);
  assert.ok(adapter.b.quality.notes.some((n) => /estimated/.test(n)));
});

test('the sqlite reader walks a real database', (t) => {
  let dir;
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('sqlite3 is not installed');
  }
  dir = mkdtempSync(join(tmpdir(), 'pr-sqlite-'));
  const dbPath = join(dir, 'state.vscdb');
  try {
    const bubble = (id, type, text) =>
      `INSERT INTO cursorDiskKV VALUES('bubbleId:c1:${id}', '${JSON.stringify({ type, text }).replace(/'/g, "''")}');`;
    const composer = {
      composerId: 'c1',
      name: 'Refactor the parser',
      createdAt: 1_700_000_000_000,
      fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }],
    };
    // a payload long enough to spill onto an overflow page
    const long = 'x'.repeat(9000);
    const sql = [
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);',
      'CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);',
      `INSERT INTO cursorDiskKV VALUES('composerData:c1', '${JSON.stringify(composer).replace(/'/g, "''")}');`,
      bubble('b1', 1, 'please refactor ' + long),
      bubble('b2', 2, 'done'),
      '',
    ].join('\n');
    execFileSync('sqlite3', [dbPath], { input: sql });

    const bytes = new Uint8Array(readFileSync(dbPath));
    const db = new SqliteDb(bytes);
    assert.deepEqual(db.tables.map((x) => x.name).sort(), ['ItemTable', 'cursorDiskKV']);

    const { chats } = readCursorDb(bytes);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].title, 'Refactor the parser');
    assert.equal(chats[0].bubbles.length, 2);
    assert.ok(chats[0].bubbles[0].text.endsWith(long), 'overflow pages must be reassembled');
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- detection ---------- */

test('vendors are told apart by content, never by extension', () => {
  const claude = detectFromText(
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n',
  );
  assert.equal(claude.vendor, 'claude');

  const codex = detectFromText(JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'message' } }) + '\n');
  assert.equal(codex.vendor, 'codex');

  const cursor = detectFromText(JSON.stringify({ composerId: 'c1', bubbles: [] }) + '\n');
  assert.equal(cursor.vendor, 'cursor');

  const sqlite = detectFromText('SQLite format 3\0rest of the file');
  assert.equal(sqlite.vendor, 'cursor');

  const nothing = detectFromText('just some prose\nwith no json in it\n');
  assert.equal(nothing.vendor, 'unknown');
  assert.ok(nothing.sample, 'an unrecognized file shows what it looked like');
});
