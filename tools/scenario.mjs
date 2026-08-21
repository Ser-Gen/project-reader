/**
 * A small transcript with *known* answers.
 *
 * The 5.7 MB example proves the parser survives real data; it cannot prove a
 * metric is right, because nobody knows what the right value is. This builds a
 * deliberately awkward session — parallel calls, a subagent, a compaction, clock
 * skew, an unanswered call, an orphan result, a plan that gets edited after work
 * starts — together with the ground truth every metric must reproduce.
 */

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();

let uuid = 0;
const nextUuid = () => `u${String(++uuid).padStart(4, '0')}`;

const base = (s, extra) => ({
  uuid: nextUuid(),
  sessionId: 'scenario-1',
  timestamp: at(s),
  cwd: '/repo',
  gitBranch: 'main',
  version: '2.1.0',
  ...extra,
});

const human = (s, text) =>
  base(s, {
    type: 'user',
    promptId: `p${s}`,
    origin: { kind: 'human' },
    message: { role: 'user', content: [{ type: 'text', text }] },
  });

const assistant = (s, content, usage, extra) =>
  base(s, {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      id: `msg_${s}`,
      content,
      ...(usage ? { usage } : {}),
    },
    ...extra,
  });

const result = (s, id, toolUseResult, content = 'ok', extra) =>
  base(s, {
    type: 'user',
    toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ...extra,
  });

const todos = (items) => items.map((t) => ({ content: t[0], status: t[1], activeForm: t[0] }));
const patch = (adds, dels) => ({
  structuredPatch: [
    {
      oldStart: 1,
      oldLines: dels + 1,
      newStart: 1,
      newLines: adds + 1,
      lines: [' keep', ...Array.from({ length: dels }, (_, i) => `-old ${i}`), ...Array.from({ length: adds }, (_, i) => `+new ${i}`)],
    },
  ],
});

const PLAN_STEPS = [
  'Update src/a.ts to stream input',
  'Refactor src/b.ts',
  'Add tests',
];

/** The transcript, in file order. */
export function scenarioRecords() {
  const r = [];

  // ---- before the plan ----
  r.push(human(0, 'Please plan the streaming refactor.'));
  r.push(
    assistant(
      5,
      [{ type: 'thinking', thinking: 'Considering the shape of the refactor.' }],
      { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 1000, output_tokens: 20 },
    ),
  );

  // ---- the plan is created (revision 1, 3 steps, all pending) ----
  r.push(
    assistant(
      10,
      [{ type: 'tool_use', id: 't_todo1', name: 'TodoWrite', input: { todos: todos(PLAN_STEPS.map((s) => [s, 'pending'])) } }],
      { input_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200, output_tokens: 300 },
    ),
  );
  r.push(result(11, 't_todo1', { newTodos: todos(PLAN_STEPS.map((s) => [s, 'pending'])) }));

  // ---- implementation: two edits issued in parallel in one request ----
  r.push(
    assistant(
      20,
      [
        { type: 'tool_use', id: 't_e1', name: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', id: 't_e2', name: 'Edit', input: { file_path: '/repo/src/b.ts', old_string: 'x', new_string: 'y' } },
      ],
      { input_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1500, output_tokens: 120 },
    ),
  );
  r.push(result(24, 't_e1', patch(2, 1)));
  r.push(result(26, 't_e2', patch(1, 0)));

  // progress tick: one step in flight, nothing structural changed
  r.push(assistant(30, [
    { type: 'tool_use', id: 't_todo2', name: 'TodoWrite', input: { todos: todos([[PLAN_STEPS[0], 'completed'], [PLAN_STEPS[1], 'in_progress'], [PLAN_STEPS[2], 'pending']]) } },
  ]));
  r.push(result(31, 't_todo2', { newTodos: todos([[PLAN_STEPS[0], 'completed'], [PLAN_STEPS[1], 'in_progress'], [PLAN_STEPS[2], 'pending']]) }));

  // a shell command that is never answered
  r.push(assistant(35, [{ type: 'tool_use', id: 't_hang', name: 'Bash', input: { command: 'npm run watch' } }]));

  // a subagent: the Task call, then sidechain work attributed back to it
  r.push(assistant(40, [{ type: 'tool_use', id: 't_task', name: 'Task', input: { subagent_type: 'Explore', description: 'find callers' } }]));
  r.push(assistant(41, [{ type: 'tool_use', id: 't_sub1', name: 'Grep', input: { pattern: 'stream(' } }], null, { isSidechain: true }));
  r.push(result(42, 't_sub1', { mode: 'content', numFiles: 3 }, 'three matches', { isSidechain: true }));
  r.push(result(45, 't_task', { content: 'found 3 callers' }));

  // clock skew: a record that arrives out of order
  r.push(assistant(44, [{ type: 'text', text: 'A late record with an earlier timestamp.' }]));

  // context compaction
  r.push(base(50, { type: 'user', isCompactSummary: true, leafUuid: 'u0001', message: { role: 'user', content: 'Summary of the session so far.' } }));

  // ---- the plan is edited after work started: a fourth step appears ----
  const plusStep = [...PLAN_STEPS, 'Update the docs'];
  r.push(assistant(60, [
    { type: 'tool_use', id: 't_todo3', name: 'TodoWrite', input: { todos: todos([[plusStep[0], 'completed'], [plusStep[1], 'completed'], [plusStep[2], 'pending'], [plusStep[3], 'pending']]) } },
  ]));
  r.push(result(61, 't_todo3', { newTodos: todos([[plusStep[0], 'completed'], [plusStep[1], 'completed'], [plusStep[2], 'pending'], [plusStep[3], 'pending']]) }));

  // an orphan result: no call with this id exists in the file
  r.push(result(65, 't_missing', { stdout: 'stray' }, 'stray output'));

  // ---- implementation ends: every step is done ----
  r.push(assistant(70, [
    { type: 'tool_use', id: 't_todo4', name: 'TodoWrite', input: { todos: todos(plusStep.map((s) => [s, 'completed'])) } },
  ]));
  r.push(result(71, 't_todo4', { newTodos: todos(plusStep.map((s) => [s, 'completed'])) }));

  // ---- after implementation: one improvement round, one question ----
  r.push(human(100, 'Also tidy up the error handling.'));
  r.push(
    assistant(
      105,
      [{ type: 'tool_use', id: 't_e3', name: 'Edit', input: { file_path: '/repo/src/c.ts', old_string: 'a', new_string: 'b' } }],
      { input_tokens: 40, cache_creation_input_tokens: 5, cache_read_input_tokens: 2000, output_tokens: 60 },
    ),
  );
  r.push(result(108, 't_e3', patch(3, 2)));

  r.push(human(200, 'Why did you use a Fenwick tree?'));
  r.push(
    assistant(
      205,
      [{ type: 'text', text: 'Because it maps offsets to indices in O(log n).' }],
      { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 2100, output_tokens: 40 },
    ),
  );

  return r;
}

/** What every metric must reproduce from the records above. */
export function scenarioTruth() {
  return {
    // token accounting: fresh input never includes cache reads
    freshInput: 100 + 50 + 200 + 0 + 50 + 10 + 40 + 5 + 30 + 0,
    cacheRead: 1000 + 1200 + 1500 + 2000 + 2100,
    output: 20 + 300 + 120 + 60 + 40,
    requests: 5,
    contextPeak: 30 + 0 + 2100,

    // operations
    calls: { TodoWrite: 4, Edit: 3, Bash: 1, Task: 1, Grep: 1 },
    unpaired: 1, // the Bash that never answered
    orphanResults: 1,
    subagentCalls: 1,
    parallelPair: ['/repo/src/a.ts', '/repo/src/b.ts'], // one request, two calls

    // plan
    planRevisions: 4,
    planEdits: 1, // only revision 3 changed the steps
    progressTicks: 2, // revisions 2 and 4 only moved statuses
    planEditsAfterImplStart: 1,
    stepsAdded: 1,
    stepsTotal: 4,
    stepsDone: 4,

    // phases
    planCreatedTs: T0 + 10_000,
    implEndTs: T0 + 70_000,

    // improvements
    iterations: 1,
    questions: 1,
    postPlanEdits: 3,
    unplannedEdits: 1,
    unplannedFile: '/repo/src/c.ts',

    // quality
    compactions: 1,
    clockAnomalies: 1,
  };
}

export function scenarioJsonl() {
  return scenarioRecords().map((r) => JSON.stringify(r)).join('\n') + '\n';
}
