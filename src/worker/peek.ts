/**
 * Identity without a full read (SPEC §7, D14).
 *
 * The sidebar has to be right the moment a folder opens: the project a
 * transcript belongs to, what it is called, when it started, and whether it is
 * a dependent thread. Waiting for a full parse means the first click rewrites
 * the row and moves it — which is exactly what a reader is doing something else
 * with at that moment.
 *
 * All of that lives in the head of the file, but not in the first 64 KB the
 * sniff already reads: Codex opens with a ~10 KB runtime blob, so the first
 * thing a human actually said sits 70-90 KB in. So the peek reads a bounded
 * head and runs the *real* adapter over it, keeping nothing but `info`. No
 * second implementation of naming to drift out of step with the first.
 *
 * A Cursor database is the exception: it has no head — reading a chat's title
 * means walking the whole file — so those keep their file name until opened.
 */

import type { SessionInfo } from '../model/canon.js';
import type { SessionIdentity } from '../model/protocol.js';
import { ClaudeAdapter } from '../vendor/claude.js';
import { CodexAdapter } from '../vendor/codex.js';
import type { Detection } from '../vendor/detect.js';
import { streamLines } from './jsonl.js';

/** How much of a transcript the intake is willing to read to name it. */
export const PEEK_BYTES = 256 * 1024;

export async function peekIdentity(file: File, det: Detection): Promise<SessionIdentity> {
  if (det.vendor === 'unknown' || det.vendor === 'cursor') return { complete: false };
  const whole = file.size <= PEEK_BYTES;
  const head = whole ? file : file.slice(0, PEEK_BYTES);
  const adapter =
    det.vendor === 'codex'
      ? new CodexAdapter('peek', file.name, file.size, det.confidence, {})
      : new ClaudeAdapter('peek', file.name, file.size, det.confidence, {});

  for await (const line of streamLines(head)) {
    let rec: unknown;
    try {
      rec = JSON.parse(line.text);
    } catch {
      // The last line of a slice is usually cut in half; that is the point at
      // which the peek stops learning anything, not an error.
      continue;
    }
    adapter.push(rec, line.start, line.end);
  }
  return identityOf(adapter.finish(0).info, whole);
}

/** What the intake keeps out of a parse it is about to throw away. */
export function identityOf(info: SessionInfo, complete: boolean): SessionIdentity {
  return {
    // `title === name` means the builder fell back to the file name, which the
    // sidebar can produce by itself and must not be told is a title.
    title: info.title && info.title !== info.name ? info.title : undefined,
    cwd: info.cwd,
    sessionId: info.sessionId,
    thread: info.thread,
    startTs: info.startTs || undefined,
    model: info.model,
    complete,
  };
}
