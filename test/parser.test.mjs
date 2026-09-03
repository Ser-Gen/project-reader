import test from 'node:test';
import assert from 'node:assert/strict';

import { streamLines, readLine } from '../src/worker/jsonl.ts';
import { Fenwick } from '../src/view/fenwick.ts';
import { renderMarkdown, escapeHtml } from '../src/view/markdown.ts';
import { decodeAsk, renderAsk } from '../src/view/ask.ts';
import { encodeAsk, pickedOptions } from '../src/vendor/text.ts';
import { CATEGORIES, categoriesOf, countByCategory, iconOf, matchesFilter } from '../src/view/kinds.ts';
import { icon } from '../src/view/icons.ts';
import { commandHead, stripAnsi, patchToDiff, countDiffLines } from '../src/vendor/text.ts';

const blob = (s) => new Blob([s]);
const collect = async (b) => {
  const out = [];
  for await (const line of streamLines(b)) out.push(line);
  return out;
};

/* ---------- byte-level line splitting ---------- */

test('splits lines and reports exact byte offsets', async () => {
  const src = '{"a":1}\n{"b":2}\n{"c":3}';
  const lines = await collect(blob(src));
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.text),
    ['{"a":1}', '{"b":2}', '{"c":3}'],
  );
  assert.deepEqual(
    lines.map((l) => [l.start, l.end]),
    [
      [0, 7],
      [8, 15],
      [16, 23],
    ],
  );
});

test('offsets survive multi-byte characters and re-read exactly', async () => {
  const src = '{"t":"Ну, погоди!"}\n{"t":"日本語テキスト"}\n';
  const b = blob(src);
  const lines = await collect(b);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(await readLine(b, l.start, l.end), l.text);
    assert.doesNotThrow(() => JSON.parse(l.text));
  }
});

test('skips blank lines and tolerates a missing trailing newline', async () => {
  const lines = await collect(blob('\n{"a":1}\n\n{"b":2}'));
  assert.equal(lines.length, 2);
});

/* ---------- text helpers ---------- */

test('ANSI escapes are stripped from captured terminal output', () => {
  assert.equal(stripAnsi('[32mgreen[0m text'), 'green text');
  assert.equal(stripAnsi('plain'), 'plain');
});

test('the effective command ignores scaffolding and names the first stage', () => {
  assert.equal(commandHead('ls -la'), 'ls');
  assert.equal(commandHead('sudo  rm -rf /tmp/x'), 'rm');
  assert.equal(commandHead('FOO=1 BAR=2 node script.js'), 'node script.js');
  assert.equal(commandHead('cd /repo && npm test -- --watch'), 'npm test');
  assert.equal(commandHead('git commit -m "x"'), 'git commit');
  assert.equal(commandHead('cat file | grep x | wc -l'), 'cat');
  assert.equal(commandHead('/usr/local/bin/rg pattern'), 'rg');
  assert.equal(commandHead('   '), '(empty)');
});

test('diff counting agrees between structured patches and raw text', () => {
  const d = patchToDiff([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-gone', '+new', '+extra'] }]);
  assert.equal(d.adds, 2);
  assert.equal(d.dels, 1);
  assert.match(d.text, /^@@ -1,2 \+1,3 @@/);
  const raw = countDiffLines(d.text);
  assert.equal(raw.adds, 2);
  assert.equal(raw.dels, 1);
  // file headers are not content changes
  assert.deepEqual(countDiffLines('--- a/x\n+++ b/x\n+one'), { adds: 1, dels: 0 });
});

/* ---------- categories & filtering ---------- */

const ev = (o) => ({
  idx: 0,
  id: 'e',
  kind: 'op',
  ts: 0,
  tsSource: 'record',
  durationSource: 'unknown',
  seg: 0,
  tokens: { estimated: true },
  sidechain: 0,
  title: '',
  body: '',
  format: 'text',
  more: false,
  fullLen: 0,
  est: 0,
  ...o,
});
const op = (name, category, extra) => ev({ op: { name, category, status: 'ok', ...extra } });

test('events are categorized by kind and canonical operation category', () => {
  assert.deepEqual(categoriesOf(ev({ kind: 'prompt' })), ['prompt']);
  assert.deepEqual(categoriesOf(ev({ kind: 'text' })), ['reply']);
  assert.deepEqual(categoriesOf(ev({ kind: 'reasoning' })), ['thinking']);
  assert.deepEqual(categoriesOf(op('Bash', 'execute')), ['bash']);
  assert.deepEqual(categoriesOf(op('Write', 'edit')), ['edit']);
  assert.deepEqual(categoriesOf(op('Grep', 'search')), ['read']);
  assert.deepEqual(categoriesOf(op('WebFetch', 'web')), ['web']);
  assert.deepEqual(categoriesOf(op('TodoWrite', 'plan')), ['plan']);
  assert.deepEqual(categoriesOf(op('shell', 'other')), ['other']);
});

test('an event can belong to several categories at once', () => {
  const shot = op('Bash', 'execute', {});
  shot.images = [{ url: 'blob:x', w: 1, h: 1, bytes: 1 }];
  assert.deepEqual(categoriesOf(shot), ['bash', 'image']);
  assert.deepEqual(categoriesOf(op('Bash', 'execute', { status: 'error' })), ['bash', 'error']);
  // a screenshot is what you want to spot in a folded row, so it wins the icon
  assert.equal(iconOf(shot), 'image');
  assert.equal(iconOf(op('Bash', 'execute')), 'bash');
});

test('filtering keeps an event matching any selected category', () => {
  const shot = op('Bash', 'execute');
  shot.images = [{ url: 'blob:x', w: 1, h: 1, bytes: 1 }];
  const plain = op('Bash', 'execute');
  assert.equal(matchesFilter(shot, new Set(['image'])), true);
  assert.equal(matchesFilter(plain, new Set(['image'])), false);
  assert.equal(matchesFilter(plain, new Set(['image', 'bash'])), true);
  // an empty filter means "show everything"
  assert.equal(matchesFilter(plain, new Set()), true);
});

test('category counts skip system noise and count each membership', () => {
  const shot = op('Bash', 'execute');
  shot.images = [{ url: 'blob:x', w: 1, h: 1, bytes: 1 }];
  const counts = countByCategory([ev({ kind: 'prompt' }), shot, ev({ kind: 'system' })]);
  assert.equal(counts.prompt, 1);
  assert.equal(counts.bash, 1);
  assert.equal(counts.image, 1);
  assert.equal(counts.other, 0);
});

test('every category has an icon', () => {
  for (const c of CATEGORIES) {
    const svg = icon(c.key);
    assert.match(svg, /^<svg /);
    assert.ok(svg.length > 60, `${c.key} icon looks empty`);
  }
});

/* ---------- height index ---------- */

test('fenwick maps offsets and pixels both ways', () => {
  const f = new Fenwick([10, 20, 30, 40]);
  assert.equal(f.total, 100);
  assert.equal(f.offsetOf(0), 0);
  assert.equal(f.offsetOf(2), 30);
  assert.equal(f.indexAt(0), 0);
  assert.equal(f.indexAt(29), 1);
  assert.equal(f.indexAt(30), 2);
  assert.equal(f.indexAt(1000), 3);

  f.set(1, 50);
  assert.equal(f.total, 130);
  assert.equal(f.offsetOf(2), 60);
  assert.equal(f.indexAt(59), 1);
});

test('fenwick handles single and large lists', () => {
  assert.equal(new Fenwick([42]).indexAt(41), 0);
  const n = 100_000;
  const f = new Fenwick(new Float64Array(n).fill(20));
  assert.equal(f.total, n * 20);
  assert.equal(f.indexAt(20 * 777), 777);
});

/* ---------- questions ---------- */

const askQs = [
  {
    question: 'Which approach?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'Emulate the MCU (Recommended)', description: 'Port the CPU core.', preview: 'ROM\n └─ core' },
      { label: 'Rewrite the logic', description: 'Reimplement <by hand>.' },
    ],
  },
  {
    question: 'Which features?',
    header: 'Scope',
    multiSelect: true,
    options: [
      { label: 'Undo/redo, with safety', description: 'a' },
      { label: 'Snapping', description: 'b' },
      { label: 'Persistence', description: 'c' },
    ],
  },
];

test('an answer is matched back to the option it names', () => {
  const opts = askQs[1].options;
  assert.deepEqual([...pickedOptions('Snapping', opts).picked], [1]);
  // Labels contain commas of their own, so a multi-select answer cannot be split on ", ".
  const multi = pickedOptions('Undo/redo, with safety, Persistence', opts);
  assert.deepEqual([...multi.picked].sort(), [0, 2]);
  assert.equal(multi.extra, '');
});

test('an answer no option offered is kept as the human’s own words', () => {
  const opts = askQs[1].options;
  const typed = pickedOptions('none of these, do the other thing', opts);
  assert.equal(typed.picked.size, 0);
  assert.equal(typed.extra, 'none of these, do the other thing');

  const mixed = pickedOptions('Snapping, and also dark mode', opts);
  assert.deepEqual([...mixed.picked], [1]);
  assert.equal(mixed.extra, 'and also dark mode');
});

test('questions survive the round trip from adapter to renderer', () => {
  const body = encodeAsk(askQs, {
    'Which approach?': 'Emulate the MCU (Recommended)',
    'Which features?': 'Snapping, Persistence',
  });
  const back = decodeAsk(body);
  assert.equal(back.length, 2);
  assert.equal(back[0].header, 'Approach');
  assert.equal(back[0].multi, false);
  assert.equal(back[1].multi, true);
  assert.deepEqual(back[0].options.map((o) => o.picked), [true, false]);
  assert.deepEqual(back[1].options.map((o) => o.picked), [false, true, true]);
  assert.equal(back[0].options[0].description, 'Port the CPU core.');
  assert.equal(back[0].options[0].preview, 'ROM\n └─ core', 'newlines survive the flattening');
  assert.equal(back[0].options[1].preview, undefined, 'only the picked option carries its preview');
});

test('answers can arrive keyed by id and shaped as lists', () => {
  const questions = [
    { id: 'q1', question: 'Which approach?', options: askQs[0].options },
    { id: 'q2', question: 'Which features?', options: askQs[1].options },
  ];
  // Codex keys by question id and always answers with an array; the encoding
  // takes a lookup so neither adapter has to reshape what it was given.
  const body = encodeAsk(questions, (q) =>
    q.id === 'q1' ? ['Rewrite the logic'] : ['Snapping', 'Persistence', 'and dark mode'],
  );
  const back = decodeAsk(body);
  assert.deepEqual(back[0].options.map((o) => o.picked), [false, true]);
  assert.equal(back[0].multi, false, 'one answer is not a multi-select');
  assert.equal(back[1].multi, true, 'several answers are the only evidence that it was');
  assert.deepEqual(back[1].options.filter((o) => o.picked && !o.own).map((o) => o.label), ['Snapping', 'Persistence']);
  assert.ok(back[1].options.some((o) => o.own && o.label === 'and dark mode'));
});

test('an unanswered question still lists what was on offer', () => {
  const body = encodeAsk(askQs.slice(0, 1), undefined);
  const back = decodeAsk(body);
  assert.equal(back[0].options.filter((o) => !o.none).length, 2);
  assert.ok(back[0].options.some((o) => o.none), 'the missing answer is stated, not implied');
  assert.ok(!back[0].options.some((o) => o.picked));
});

test('a truncated question body still renders everything before the cut', () => {
  const body = encodeAsk(askQs, { 'Which approach?': 'Rewrite the logic' });
  const cut = body.slice(0, body.indexOf('Which features?') - 4);
  const back = decodeAsk(cut);
  assert.equal(back.length, 1, 'the whole first question survives');
  assert.deepEqual(back[0].options.map((o) => o.picked), [false, true]);
});

test('question rows escape transcript text', () => {
  const html = renderAsk(encodeAsk(askQs.slice(0, 1), { 'Which approach?': '<img src=x onerror=alert(1)>' }));
  assert.ok(html.includes('Reimplement &lt;by hand&gt;.'), 'descriptions are shown, escaped');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('class="opt on own"'), 'a typed answer is marked as the pick it was');
});

test('rendered questions show every option and mark the picked one', () => {
  const html = renderAsk(encodeAsk(askQs, {
    'Which approach?': 'Emulate the MCU (Recommended)',
    'Which features?': 'Snapping, Persistence',
  }));
  assert.equal((html.match(/class="opt/g) ?? []).length, 5, 'all five options are drawn');
  assert.equal((html.match(/class="opt on"/g) ?? []).length, 3, 'three of them are marked picked');
  assert.ok(html.includes('Port the CPU core.') && html.includes('Reimplement'), 'both descriptions survive');
  assert.ok(html.includes('pick any · 2 picked'));
  assert.ok(!html.includes('undefined'));
});

/* ---------- markdown ---------- */

test('markdown escapes untrusted transcript text', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
  assert.equal(escapeHtml(`<&">'`), '&lt;&amp;&quot;&gt;&#39;');
});

test('markdown renders a pipe table as a table', () => {
  const src = [
    'before',
    '',
    '| tool | calls | p95 |',
    '|:-----|------:|:---:|',
    '| Edit | 12    | 1.4s |',
    '| Bash | 3     | 20s |',
    '',
    'after',
  ].join('\n');
  const html = renderMarkdown(src);
  assert.ok(html.includes('<table class="mdt">'), 'a table element is produced');
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, 'one header row and two body rows');
  assert.ok(html.includes('<th class="al">tool</th>'), 'alignment comes from the delimiter');
  assert.ok(html.includes('<th class="ar">calls</th>'));
  assert.ok(html.includes('<th class="ac">p95</th>'));
  assert.ok(html.includes('<td class="ar">12</td>'));
  assert.ok(html.includes('<p>before</p>') && html.includes('<p>after</p>'), 'the table does not swallow prose');
  assert.ok(!html.includes('|'), 'no pipe survives into the output');
});

test('table cells are inline-rendered and still escaped', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| `x<y` | **bold** |');
  assert.ok(html.includes('<code>x&lt;y</code>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(!html.includes('<y'));
});

test('a table survives ragged rows, escaped pipes and missing edge pipes', () => {
  const html = renderMarkdown('a | b | c\n--- | --- | ---\n1 | 2\nx \\| y | | 3 | 4');
  assert.ok(html.includes('<table class="mdt">'));
  // Short rows are padded, long ones truncated, so every row has three cells.
  for (const row of html.match(/<tr>.*?<\/tr>/g).slice(1)) {
    assert.equal((row.match(/<td/g) ?? []).length, 3);
  }
  assert.ok(html.includes('x | y'), 'an escaped pipe stays inside its cell');
});

test('pipes that are not a table stay prose', () => {
  const html = renderMarkdown('a | b\nnot a delimiter');
  assert.ok(!html.includes('<table'));
  assert.ok(html.includes('a | b'));
});

test('markdown renders fences, lists and links', () => {
  const html = renderMarkdown('# T\n\n- a\n- b\n\n```js\nlet x = 1 < 2;\n```\n\n[k](https://e.dev)');
  assert.ok(html.includes('<h2>T</h2>'));
  assert.ok(html.includes('<li>a</li><li>b</li>'));
  assert.ok(html.includes('data-lang="js"'));
  assert.ok(html.includes('let x = 1 &lt; 2;'));
  assert.ok(html.includes('<a href="https://e.dev" target="_blank" rel="noreferrer">k</a>'));
});
