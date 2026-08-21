#!/usr/bin/env node
/**
 * Synthetic transcript generator — the real example is only 5.7 MB, which is
 * small enough to hide architectural mistakes. This produces an arbitrarily
 * large, structurally faithful .jsonl to stress parsing, virtualization and
 * memory.
 *
 *   node tools/gen-fixture.mjs out.jsonl --mb 100 [--images 40]
 */

import { createWriteStream, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { scenarioJsonl, scenarioTruth } from './scenario.mjs';

const args = process.argv.slice(2);
const out = args[0] ?? 'fixture.jsonl';
const targetMB = Number(args[args.indexOf('--mb') + 1]) || 100;
const imageCount = Number(args[args.indexOf('--images') + 1]) || 30;
/** Emit the small transcript with known answers instead of a big random one. */
const wantScenario = args.includes('--scenario');
/** Leave the last line half-written, the way a killed process does. */
const wantTruncated = args.includes('--truncated');

if (wantScenario) {
  writeFileSync(out, scenarioJsonl());
  writeFileSync(out.replace(/\.jsonl$/, '') + '.truth.json', JSON.stringify(scenarioTruth(), null, 2) + '\n');
  console.log(`${out}: scenario transcript + ground truth`);
  process.exit(0);
}

const target = targetMB * 1024 * 1024;
const stream = createWriteStream(out);
const write = (o) =>
  new Promise((res) => {
    const s = JSON.stringify(o) + '\n';
    written += Buffer.byteLength(s);
    stream.write(s) ? res() : stream.once('drain', res);
  });

// A 1x1 PNG repeated to a realistic screenshot size.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const bigB64 = PNG_1x1.repeat(3600); // ~350 KB of base64, like a real screenshot

const LOREM =
  'The parser streams the file, pairs each tool_use with its tool_result, and keeps only light metadata on the main thread. ';
const code = Array.from({ length: 40 }, (_, i) => `  const value${i} = compute(${i}, options); // line ${i}`).join('\n');

let written = 0;
let t = Date.parse('2026-01-01T09:00:00.000Z');
const sessionId = randomUUID();
const tick = () => new Date((t += 1500 + Math.floor(Math.random() * 4000))).toISOString();
const env = (extra) => ({
  parentUuid: randomUUID(),
  isSidechain: false,
  uuid: randomUUID(),
  timestamp: tick(),
  sessionId,
  userType: 'external',
  cwd: '/Users/dev/project',
  version: '2.1.220',
  gitBranch: 'main',
  ...extra,
});

await write({ type: 'ai-title', aiTitle: `Synthetic ${targetMB} MB transcript`, sessionId });

let prompt = 0;
let imagesLeft = imageCount;

while (written < target) {
  prompt++;
  await write(
    env({
      type: 'user',
      promptId: randomUUID(),
      origin: { kind: 'human' },
      promptSource: 'sdk',
      message: { role: 'user', content: [{ type: 'text', text: `Prompt #${prompt}: ${LOREM.repeat(2)}` }] },
    }),
  );

  const turns = 4 + Math.floor(Math.random() * 8);
  for (let i = 0; i < turns && written < target; i++) {
    await write(
      env({
        type: 'assistant',
        requestId: randomUUID(),
        message: {
          model: 'claude-opus-5',
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: LOREM.repeat(6) },
            { type: 'text', text: `Step ${i}. ${LOREM.repeat(3)}\n\n\`\`\`ts\n${code}\n\`\`\`` },
          ],
          usage: { input_tokens: 3, cache_read_input_tokens: 12000, output_tokens: 400 },
        },
      }),
    );

    const id = `toolu_${randomUUID()}`;
    const kind = i % 4;
    const input =
      kind === 0
        ? { command: `npm run build -- --flag${i}`, description: 'build' }
        : kind === 1
          ? { file_path: `/Users/dev/project/src/module${i}.ts`, old_string: 'a', new_string: 'b' }
          : kind === 2
            ? { file_path: `/Users/dev/project/src/module${i}.ts` }
            : { query: `how to virtualize a list ${i}` };
    const name = ['Bash', 'Edit', 'Read', 'WebSearch'][kind];

    await write(
      env({
        type: 'assistant',
        requestId: randomUUID(),
        message: {
          model: 'claude-opus-5',
          id: `msg_${randomUUID()}`,
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input }],
        },
      }),
    );

    const withImage = kind === 0 && imagesLeft > 0 && Math.random() < 0.35;
    if (withImage) imagesLeft--;

    const toolUseResult =
      kind === 0
        ? { stdout: (code + '\n').repeat(6), stderr: '', interrupted: false, isImage: withImage }
        : kind === 1
          ? {
              filePath: input.file_path,
              structuredPatch: [
                { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' ctx', '-old line', '+new line', '+added line'] },
              ],
            }
          : kind === 2
            ? { type: 'text', file: { filePath: input.file_path, content: code.repeat(4), numLines: 160 } }
            : {
                query: input.query,
                durationSeconds: 3.2,
                results: [{ content: [{ title: 'Virtual scrolling', url: 'https://example.com/vs' }] }],
              };

    const content = withImage
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigB64 } }]
      : 'ok';

    await write(
      env({
        type: 'user',
        toolUseResult,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      }),
    );
  }
}

// Structural awkwardness the parser has to survive: a plan cycle, a subagent,
// a compaction, a call nobody answered, and a clock that went backwards.
await write(env({ type: 'assistant', message: { role: 'assistant', id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: 'toolu_hang', name: 'Bash', input: { command: 'npm run watch' } }] } }));
await write(env({ type: 'assistant', isSidechain: true, message: { role: 'assistant', id: `msg_${randomUUID()}`, content: [{ type: 'tool_use', id: 'toolu_side', name: 'Grep', input: { pattern: 'x' } }] } }));
await write(env({ type: 'user', isSidechain: true, toolUseResult: { mode: 'content' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_side', content: 'match' }] } }));
await write({ ...env({ type: 'assistant', message: { role: 'assistant', id: `msg_${randomUUID()}`, content: [{ type: 'text', text: 'A record whose clock ran backwards.' }] } }), timestamp: new Date(t - 60_000).toISOString() });
await write(env({ type: 'user', isCompactSummary: true, leafUuid: randomUUID(), message: { role: 'user', content: 'Summary so far.' } }));

if (wantTruncated) stream.write('{"type":"assistant","message":{"role":"assis');

await new Promise((res) => stream.end(res));
console.log(`${out}: ${(written / 1048576).toFixed(1)} MB, ${prompt} prompts`);
