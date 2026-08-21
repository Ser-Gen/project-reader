#!/usr/bin/env node
/**
 * Schema/stat dump for a .jsonl transcript.
 *
 * This exists so the format can be learned without ever opening a multi-megabyte
 * file in an editor: it streams the file and prints only aggregates.
 *
 *   node tools/inspect.mjs example.jsonl [--top 20]
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/inspect.mjs <file.jsonl> [--top N]');
  process.exit(1);
}
const topN = Number(process.argv[process.argv.indexOf('--top') + 1]) || 12;

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const show = (label, map, n = topN) => {
  console.log(`\n${label}`);
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
};

const types = new Map();
const blocks = new Map();
const tools = new Map();
const results = new Map();
const attachments = new Map();
const keys = new Map();
const biggest = [];

let lines = 0;
let bad = 0;
let bytes = 0;
let prompts = 0;
let images = 0;
let imageBytes = 0;
let first = null;
let last = null;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  lines++;
  bytes += Buffer.byteLength(line) + 1;
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    bad++;
    continue;
  }

  bump(types, o.type ?? '(none)');
  for (const k of Object.keys(o)) bump(keys, k);
  if (o.timestamp) {
    first ??= o.timestamp;
    last = o.timestamp;
  }
  if (o.type === 'attachment') bump(attachments, o.attachment?.type ?? '?');
  if (o.origin?.kind === 'human') prompts++;

  const content = o.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      bump(blocks, `${o.type} > ${b?.type}`);
      if (b?.type === 'tool_use') bump(tools, b.name);
      if (b?.type === 'tool_result') {
        if (typeof b.content === 'string') bump(results, 'string');
        else if (Array.isArray(b.content))
          for (const p of b.content) {
            bump(results, p?.type ?? '?');
            if (p?.type === 'image' && p.source?.data) {
              images++;
              imageBytes += Math.floor(p.source.data.length * 0.75);
            }
          }
      }
    }
  } else if (typeof content === 'string') bump(blocks, `${o.type} > (string)`);

  biggest.push([Buffer.byteLength(line), lines, o.type]);
  if (biggest.length > 4000) {
    biggest.sort((a, b) => b[0] - a[0]);
    biggest.length = 20;
  }
}

const size = (await stat(file)).size;
biggest.sort((a, b) => b[0] - a[0]);

console.log(`file      ${file}`);
console.log(`size      ${(size / 1048576).toFixed(2)} MB in ${lines} lines${bad ? `  (${bad} unparsable)` : ''}`);
console.log(`span      ${first ?? '?'} → ${last ?? '?'}`);
console.log(`prompts   ${prompts} human`);
console.log(`images    ${images}  ≈ ${(imageBytes / 1048576).toFixed(2)} MB decoded`);
show('record types', types);
show('content blocks', blocks);
show('tools', tools);
show('tool_result parts', results);
show('attachments', attachments);
show('envelope keys', keys, 20);
console.log('\nlargest lines (bytes, line, type)');
for (const [b, l, t] of biggest.slice(0, 10)) console.log(`  ${String(b).padStart(8)}  ${String(l).padStart(6)}  ${t}`);
