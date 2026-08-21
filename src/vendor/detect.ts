/**
 * Vendor sniffing.
 *
 * Never by file extension: transcripts get renamed, exported and hand-moved, and
 * three different products write `.jsonl`. Detection reads the first 64 KB (and
 * the 16-byte SQLite magic) and says how sure it is, so the intake UI can show
 * *why* a file was classified the way it was — or list it as unrecognized with
 * its first line, rather than silently ignoring it.
 */

import type { Vendor } from '../model/canon.js';

export interface Detection {
  vendor: Vendor | 'unknown';
  /** 0..1 */
  confidence: number;
  reason: string;
  /** for unrecognized files: what the head actually looked like */
  sample?: string;
}

export const SNIFF_BYTES = 64 * 1024;
const SQLITE_MAGIC = 'SQLite format 3\0';

const CLAUDE_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'attachment',
  'summary',
  'mode',
  'queue-operation',
  'ai-title',
  'last-prompt',
  'file-history-delta',
  'file-history-snapshot',
]);
const CODEX_TYPES = new Set(['response_item', 'event_msg', 'session_meta', 'turn_context']);

export function detectFromText(head: string): Detection {
  if (head.startsWith(SQLITE_MAGIC)) {
    return { vendor: 'cursor', confidence: 0.9, reason: 'SQLite database' };
  }

  const lines = head.split('\n').slice(0, 40).filter((l) => l.trim());
  let claude = 0;
  let codex = 0;
  let cursor = 0;
  let parsed = 0;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    parsed++;
    if (typeof rec.type === 'string' && CODEX_TYPES.has(rec.type) && 'payload' in rec) codex += 2;
    if (typeof rec.type === 'string' && CLAUDE_TYPES.has(rec.type)) claude++;
    if (rec.uuid && rec.sessionId) claude += 2;
    if (rec.message && Array.isArray(rec.message.content)) claude++;
    if (rec.composerId || rec.bubbleId || rec.composers || rec.fullConversationHeadersOnly) cursor += 3;
    if (Array.isArray(rec.bubbles) || Array.isArray(rec.conversation)) cursor += 2;
  }

  const sample = lines[0]?.slice(0, 240);
  if (!parsed) {
    // A Cursor markdown export is the one non-JSON shape worth recognizing.
    if (/^#{1,3} .*\n+\*\*(User|Cursor|Assistant)\*\*/m.test(head) || /^_\*\*(User|Assistant)\*\*_/m.test(head)) {
      return { vendor: 'cursor', confidence: 0.5, reason: 'exported chat markdown' };
    }
    return { vendor: 'unknown', confidence: 0, reason: 'not JSONL', sample };
  }

  const best = Math.max(claude, codex, cursor);
  if (best === 0) return { vendor: 'unknown', confidence: 0, reason: 'unrecognized JSONL', sample };
  const total = claude + codex + cursor;
  const confidence = Math.min(1, (best / total) * Math.min(1, parsed / 5) + 0.15);
  if (best === codex) return { vendor: 'codex', confidence, reason: 'codex rollout records' };
  if (best === cursor) return { vendor: 'cursor', confidence, reason: 'cursor chat export' };
  return { vendor: 'claude', confidence, reason: 'claude code transcript' };
}

/** Sniff a file without reading more than the head of it. */
export async function detectFile(file: Blob): Promise<Detection> {
  const head = file.slice(0, SNIFF_BYTES);
  const buf = await head.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 16) {
    let magic = '';
    for (let i = 0; i < 16; i++) magic += String.fromCharCode(bytes[i]);
    if (magic === SQLITE_MAGIC) {
      return { vendor: 'cursor', confidence: 0.9, reason: 'SQLite database (state.vscdb)' };
    }
  }
  // Decoding a 64 KB slice can split a multi-byte character at the tail; the
  // last line is discarded by the line filter anyway.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return detectFromText(text);
}
