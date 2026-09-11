/**
 * The list has to be right before it is clicked.
 *
 * Everything here is about the folder view: a transcript names itself, belongs
 * to a project, started at a particular moment, and sometimes serves another
 * transcript. All four are read from the head of the file — the alternative is
 * a list that rewrites and reorders itself under the reader as each file is
 * eventually opened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { peekIdentity, PEEK_BYTES } from '../src/worker/peek.ts';
import { detectFromText } from '../src/vendor/detect.ts';
import { Registry, startOf, titleOf } from '../src/intake.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rollouts = readdirSync(ROOT).filter((f) => /^rollout-.*\.jsonl$/.test(f)).sort();

/** Only ever the head: a peek that reads the whole file is not a peek. */
function headFile(name) {
  const size = statSync(ROOT + name).size;
  const fd = readFileSync(ROOT + name);
  return { file: new File([fd], name, { lastModified: 1 }), size };
}

for (const name of rollouts) {
  test(`${name} names itself from its head alone`, async (t) => {
    const { file, size } = headFile(name);
    const det = detectFromText(readFileSync(ROOT + name, 'utf8').slice(0, 64 * 1024));
    const id = await peekIdentity(file, det);

    assert.ok(id.cwd, 'a project, from the first record');
    assert.ok(id.sessionId, 'an id of its own');
    assert.ok(id.startTs > 0, 'and a real start time to sort by');
    assert.equal(id.complete, size <= PEEK_BYTES);
    assert.ok(id.title, 'the file name is not a name');
    assert.ok(!id.title.startsWith('rollout-'), `still called after the file: ${id.title}`);
    // The runtime's own preamble is not what the human asked for.
    assert.ok(!/^<[a-z_]+>/.test(id.title), `named after a runtime block: ${id.title}`);
    t.diagnostic(`${id.title} · ${id.cwd} · ${id.thread?.label ?? 'session'}`);
  });
}

test('a dependent thread is identified as one, and points at what it serves', async () => {
  const guardian = rollouts.find((f) => /01a08b80/.test(f));
  if (!guardian) return;
  const { file } = headFile(guardian);
  const det = detectFromText(readFileSync(ROOT + guardian, 'utf8').slice(0, 64 * 1024));
  const id = await peekIdentity(file, det);

  assert.equal(id.thread?.role, 'review');
  assert.ok(id.thread.parentId);
  assert.notEqual(id.thread.parentId, id.sessionId, 'a thread does not serve itself');
  assert.match(id.title, /guardian review/);
});

/* ---------------- the tree ---------------- */

function entryFor(reg, name, identity) {
  const entry = reg.add(new File(['{}'], name, { lastModified: 10 }), `folder/${name}`);
  entry.vendor = 'codex';
  reg.identify(entry, identity);
  return entry;
}

test('a dependent thread is listed under the session it serves, not beside it', () => {
  const reg = new Registry();
  const parent = entryFor(reg, 'parent.jsonl', {
    title: 'run the launcher',
    cwd: '/work/servant',
    sessionId: 'aaa',
    startTs: 2000,
    complete: true,
  });
  const child = entryFor(reg, 'guardian.jsonl', {
    title: 'guardian review · aaa…',
    // Its own cwd differs; it still belongs to the work it was reviewing.
    cwd: '/elsewhere',
    sessionId: 'bbb',
    thread: { role: 'review', kind: 'guardian_review', label: 'guardian review', parentId: 'aaa' },
    startTs: 2500,
    complete: true,
  });
  const other = entryFor(reg, 'later.jsonl', {
    title: 'add a component',
    cwd: '/work/servant',
    sessionId: 'ccc',
    startTs: 9000,
    complete: true,
  });

  const groups = reg.projects();
  assert.equal(groups.length, 1, 'the child does not open a project of its own');
  const [group] = groups;
  assert.equal(group.name, '/work/servant');
  assert.equal(group.entries.length, 3, 'but it is still there');
  assert.equal(group.nodes.length, 2, 'two sessions, one of which has a thread');
  // "n of m analyzed" counts sessions: a thread is never analyzed on its own.
  assert.equal(group.analyzed, 0);
  parent.metrics = { cwd: '/work/servant' };
  assert.equal(reg.projects()[0].analyzed, 1);
  parent.metrics = null;
  assert.deepEqual(
    group.nodes.map((n) => n.entry.name),
    ['later.jsonl', 'parent.jsonl'],
    'newest session first, by when it started',
  );
  assert.deepEqual(group.nodes[1].children.map((c) => c.name), ['guardian.jsonl']);
  assert.equal(group.nodes[0].children.length, 0);

  assert.equal(reg.parentOf(child)?.id, parent.id);
  assert.equal(reg.parentOf(parent), undefined);
  assert.deepEqual(reg.childrenOf(parent).map((c) => c.id), [child.id]);
  assert.equal(titleOf(other), 'add a component');
  assert.equal(startOf(parent), 2000);
});

test('ordering uses when the session started, not when the file was last written', () => {
  const reg = new Registry();
  const old = entryFor(reg, 'old.jsonl', { title: 'first', cwd: '/w', sessionId: '1', startTs: 1000, complete: true });
  const recent = entryFor(reg, 'new.jsonl', { title: 'second', cwd: '/w', sessionId: '2', startTs: 5000, complete: true });
  // Both files were touched at the same moment; only the transcripts differ.
  assert.equal(old.lastModified, recent.lastModified);
  assert.deepEqual(reg.projects()[0].nodes.map((n) => n.entry.name), ['new.jsonl', 'old.jsonl']);
});

test('a session that gains a thread is a different session to the cache', () => {
  const reg = new Registry();
  const parent = entryFor(reg, 'parent.jsonl', { title: 'run it', cwd: '/w', sessionId: 'aaa', startTs: 1, complete: true });
  const alone = reg.mergedKey(parent);
  assert.equal(alone, parent.key, 'with no threads it is just the file');

  // Files arrive in whatever order the disk hands them over, so this is also
  // how an already-parsed session learns it was read incompletely.
  entryFor(reg, 'guardian.jsonl', {
    cwd: '/w',
    sessionId: 'bbb',
    thread: { role: 'review', kind: 'guardian_review', label: 'guardian review', parentId: 'aaa' },
    startTs: 2,
    complete: true,
  });
  assert.notEqual(reg.mergedKey(parent), alone, 'the numbers cached without it must not be reused');
});

test('a file that says nothing about itself keeps its file name and its mtime', () => {
  const reg = new Registry();
  const entry = entryFor(reg, 'mystery.jsonl', { complete: false });
  assert.equal(titleOf(entry), 'mystery.jsonl');
  assert.equal(startOf(entry), 10);
  assert.equal(reg.projects()[0].name, 'folder');
});

/**
 * A Claude subagent writes its own file under the session's folder, and the job
 * it was sent to do is recorded beside it rather than inside it. Both facts have
 * to reach the list before anything is clicked: without the first, five threads
 * are five sessions; without the second, they are five rows reading "subagent".
 */
function subagentFolder() {
  const reg = new Registry();
  const parent = reg.add(new File(['{}'], 'S.jsonl', { lastModified: 10 }), 'wasm/S.jsonl');
  parent.vendor = 'claude';
  reg.identify(parent, { title: 'port the engine', cwd: '/work/engine', sessionId: 'S', startTs: 1000, complete: true });

  const jobs = [
    ['a1', 'Investigate gamepad/joystick support'],
    ['a2', 'Investigate in-game console UI'],
  ];
  const kids = jobs.map(([id, description], i) => {
    const entry = reg.add(new File(['{}'], `agent-${id}.jsonl`, { lastModified: 10 }), `wasm/S/subagents/agent-${id}.jsonl`);
    entry.vendor = 'claude';
    reg.identify(entry, {
      cwd: '/work/engine',
      sessionId: id,
      thread: { role: 'subagent', kind: 'sidechain', label: 'subagent', parentId: 'S' },
      startTs: 1100 + i,
      complete: true,
    });
    const meta = JSON.stringify({ agentType: 'Explore', description });
    return { entry, meta: reg.add(new File([meta], `agent-${id}.meta.json`), `wasm/S/subagents/agent-${id}.meta.json`) };
  });
  return { reg, parent, kids };
}

test('a subagent written to its own file is listed under the session, not beside it', () => {
  const { reg, parent, kids } = subagentFolder();
  for (const k of kids) assert.equal(k.meta, null, 'the runtime’s note is not a transcript');

  const groups = reg.projects();
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.nodes.length, 1, 'one session, whatever it spawned');
  assert.equal(group.entries.length, 3, 'and every file still accounted for');
  assert.equal(group.nodes[0].entry.id, parent.id);
  assert.deepEqual(
    group.nodes[0].children.map((c) => c.name),
    ['agent-a1.jsonl', 'agent-a2.jsonl'],
  );
  // "1 of 1 analyzed", never "1 of 3": a thread is read as part of its session.
  assert.equal(group.analyzed, 0);
  assert.equal(reg.parentOf(kids[0].entry)?.id, parent.id);
  assert.notEqual(reg.mergedKey(parent), parent.key, 'and the cached numbers cover them');
});

test('a dependent thread is named after the job it was given', async () => {
  const { reg, kids } = subagentFolder();
  assert.equal(kids[0].entry.identity.thread.label, 'subagent', 'the thread itself knows only that much');

  await reg.nameThreads();
  assert.equal(kids[0].entry.identity.thread.label, 'subagent · Investigate gamepad/joystick support');
  assert.equal(kids[1].entry.identity.thread.label, 'subagent · Investigate in-game console UI');
  assert.equal(kids[0].entry.identity.thread.kind, 'Explore');
  // A lane was named; nothing said what the transcript is.
  assert.equal(kids[0].entry.identity.thread.role, 'subagent');
  assert.equal(titleOf(kids[0].entry), 'agent-a1.jsonl');
});
