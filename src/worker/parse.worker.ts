/// <reference lib="webworker" />
/**
 * The worker owns the File, the parsed index and the body store; the UI thread
 * only ever holds light records.
 *
 * Pipeline: sniff the vendor, run its adapter over the raw records, compute
 * metrics from the canonical events, and keep enough state to serve expands,
 * searches and metric recomputation without touching the file again.
 */

import type { CanonSession, SessionPart } from '../model/canon.js';
import type { MetricOptions, SessionMetrics } from '../model/metrics.js';
import type { FromWorker, SearchHit, ToWorker } from '../model/protocol.js';
import { computeMetrics } from '../metrics/index.js';
import { detectFile, type Detection } from '../vendor/detect.js';
import { ClaudeAdapter, fullBody as claudeBody } from '../vendor/claude.js';
import { CodexAdapter, fullBody as codexBody } from '../vendor/codex.js';
import { CursorAdapter, MAX_DB_BYTES, parseExportedChat, readCursorDb } from '../vendor/cursor.js';
import type { Builder, EventSource } from '../vendor/builder.js';
import { readLine, streamLines } from './jsonl.js';
import { extractImages, revokeAll } from './images.js';

interface State {
  file: File;
  vendor: Detection['vendor'];
  builder: Builder;
  session: CanonSession;
  sources: EventSource[];
  options: MetricOptions;
}

const sessions = new Map<string, State>();
const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'parse':
      void parse(msg.fileId, msg.file, msg.options, msg.part);
      break;
    case 'expand':
      void expand(msg.fileId, msg.reqId, msg.idx);
      break;
    case 'search':
      search(msg.fileId, msg.reqId, msg.query);
      break;
    case 'recompute':
      recompute(msg.fileId, msg.reqId, msg.options);
      break;
    case 'sniff':
      void sniff(msg.reqId, msg.id, msg.file);
      break;
    case 'analyze':
      void analyze(msg.reqId, msg.id, msg.file, msg.options);
      break;
    case 'close':
      sessions.delete(msg.fileId);
      revokeAll();
      break;
  }
};

async function sniff(reqId: number, id: string, file: File): Promise<void> {
  try {
    const d = await detectFile(file);
    post({ type: 'sniffed', reqId, result: { id, vendor: d.vendor, confidence: d.confidence, reason: d.reason } });
  } catch (err) {
    post({
      type: 'sniffed',
      reqId,
      result: { id, vendor: 'unknown', confidence: 0, reason: err instanceof Error ? err.message : 'unreadable' },
    });
  }
}

interface Parsed {
  builder: Builder;
  session: CanonSession;
  metrics: SessionMetrics;
  vendor: Detection['vendor'];
}

async function build(
  fileId: string,
  file: File,
  options: MetricOptions,
  part: string | undefined,
  onProgress?: (bytes: number) => void,
): Promise<Parsed> {
  const t0 = performance.now();
  const det = await detectFile(file);
  const cal = options.calibration ?? {};

  if (det.vendor === 'cursor' && det.reason.startsWith('SQLite')) {
    return cursorDb(fileId, file, options, part, det, t0);
  }

  const adapter =
    det.vendor === 'codex' ? new CodexAdapter(fileId, file.name, file.size, det.confidence, cal)
    : det.vendor === 'cursor' ? null
    : new ClaudeAdapter(fileId, file.name, file.size, det.confidence, cal);

  if (!adapter) return cursorExport(fileId, file, options, det, t0);
  if (det.vendor === 'unknown') {
    adapter.b.note(`Format not recognized (${det.reason}); read as a Claude Code transcript.`);
  }

  let lines = 0;
  for await (const line of streamLines(file, onProgress)) {
    lines++;
    let rec: unknown;
    try {
      rec = JSON.parse(line.text);
    } catch {
      adapter.b.info.badLines++;
      if (adapter.b.quality.badLineOffsets.length < 200) adapter.b.quality.badLineOffsets.push(line.start);
      continue;
    }
    // Only pay for the async image walk on records that actually carry one.
    if (line.text.length > 1024 && line.text.includes('"base64"')) {
      await extractImages(rec);
    }
    adapter.push(rec, line.start, line.end);
  }
  if (!lines) adapter.b.note('The file is empty.');

  const session = adapter.finish(Math.round(performance.now() - t0));
  const metrics = computeMetrics({
    session,
    raw: adapter.b.quality,
    samples: adapter.b.samples,
    options,
  });
  return { builder: adapter.b, session, metrics, vendor: det.vendor };
}

/** Cursor keeps every chat in one SQLite file; the reader opens one at a time. */
async function cursorDb(
  fileId: string,
  file: File,
  options: MetricOptions,
  part: string | undefined,
  det: Detection,
  t0: number,
): Promise<Parsed> {
  if (file.size > MAX_DB_BYTES) {
    throw new Error(
      `This Cursor database is ${(file.size / 1024 / 1024).toFixed(0)} MB. Walking it requires holding it in memory; ` +
        `export the chat from Cursor and open the export instead.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { chats, notes } = readCursorDb(bytes);
  if (!chats.length) throw new Error('No readable Cursor chats in this database.');
  const chat = chats.find((c) => c.id === part) ?? chats[0];
  const parts: SessionPart[] = chats.map((c) => ({
    id: c.id,
    title: c.title,
    messages: c.bubbles.length,
    ts: c.createdAt,
  }));
  const adapter = new CursorAdapter(fileId, file.name, file.size, det.confidence, options.calibration ?? {});
  const session = adapter.build(chat, parts, notes, Math.round(performance.now() - t0));
  const metrics = computeMetrics({ session, raw: adapter.b.quality, samples: [], options });
  return { builder: adapter.b, session, metrics, vendor: 'cursor' };
}

async function cursorExport(
  fileId: string,
  file: File,
  options: MetricOptions,
  det: Detection,
  t0: number,
): Promise<Parsed> {
  const chat = parseExportedChat(await file.text());
  if (!chat) throw new Error('This looks like a Cursor export but no messages could be read from it.');
  const adapter = new CursorAdapter(fileId, file.name, file.size, det.confidence, options.calibration ?? {});
  const session = adapter.build(chat, [], ['Cursor: read from an exported chat, not the database.'], Math.round(performance.now() - t0));
  const metrics = computeMetrics({ session, raw: adapter.b.quality, samples: [], options });
  return { builder: adapter.b, session, metrics, vendor: 'cursor' };
}

async function parse(fileId: string, file: File, options: MetricOptions, part?: string): Promise<void> {
  let lastPost = 0;
  const onProgress = (bytes: number) => {
    const now = performance.now();
    if (now - lastPost > 120) {
      lastPost = now;
      post({ type: 'progress', fileId, bytes, total: file.size, lines: 0 });
    }
  };

  try {
    const { builder, session, metrics, vendor } = await build(fileId, file, options, part, onProgress);
    sessions.set(fileId, { file, vendor, builder, session, sources: builder.sources, options });
    post({ type: 'done', fileId, session, metrics });
  } catch (err) {
    post({ type: 'failed', fileId, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Metrics only: nothing is retained, so a whole folder can be swept cheaply. */
async function analyze(reqId: number, id: string, file: File, options: MetricOptions): Promise<void> {
  try {
    const { metrics } = await build(id, file, options, undefined);
    post({ type: 'analyzed', reqId, id, metrics });
  } catch (err) {
    post({ type: 'analyzed', reqId, id, metrics: null, message: err instanceof Error ? err.message : String(err) });
  }
}

/** Changing the idle threshold or a phase boundary must never re-read the file. */
function recompute(fileId: string, reqId: number, options: MetricOptions): void {
  const st = sessions.get(fileId);
  if (!st) {
    post({ type: 'failed', fileId, reqId, message: 'session not loaded' });
    return;
  }
  st.options = options;
  const metrics = computeMetrics({
    session: st.session,
    raw: st.builder.quality,
    samples: st.builder.samples,
    options,
  });
  post({ type: 'metrics', fileId, reqId, metrics });
}

/** Full body for an event whose inline copy was truncated. */
async function expand(fileId: string, reqId: number, idx: number): Promise<void> {
  const st = sessions.get(fileId);
  const src = st?.sources[idx];
  if (!st || !src) {
    post({ type: 'expanded', fileId, reqId, body: '' });
    return;
  }
  if (src.stored !== undefined) {
    post({ type: 'expanded', fileId, reqId, body: src.stored });
    return;
  }
  // Too big to retain: re-read exactly that one line from disk and rebuild the body.
  try {
    const text = await readLine(st.file, src.start, src.end);
    const rec = JSON.parse(text);
    const body = st.vendor === 'codex' ? codexBody(rec, src) : claudeBody(rec, src);
    post({ type: 'expanded', fileId, reqId, body });
  } catch {
    post({ type: 'expanded', fileId, reqId, body: '' });
  }
}

const MAX_HITS = 500;

function search(fileId: string, reqId: number, query: string): void {
  const st = sessions.get(fileId);
  if (!st || !query) {
    post({ type: 'results', fileId, reqId, hits: [], capped: false });
    return;
  }
  const q = query.toLowerCase();
  const hits: SearchHit[] = [];
  let capped = false;

  for (let i = 0; i < st.sources.length; i++) {
    const body = st.sources[i].search;
    if (!body) continue;
    const hay = body.toLowerCase();
    const at = hay.indexOf(q);
    if (at === -1) continue;
    let count = 0;
    let scan = at;
    while (scan !== -1 && count < 50) {
      count++;
      scan = hay.indexOf(q, scan + q.length);
    }
    const from = Math.max(0, at - 60);
    const excerpt = (from ? '…' : '') + body.slice(from, at + q.length + 90).replace(/\s+/g, ' ');
    hits.push({ idx: i, excerpt, count });
    if (hits.length >= MAX_HITS) {
      capped = true;
      break;
    }
  }
  post({ type: 'results', fileId, reqId, hits, capped });
}
