/**
 * Worker <-> UI messages.
 *
 * Everything here is structured-cloneable: the worker owns the File, the parsed
 * index and the body store; the UI thread only ever holds light records.
 */

import type { CanonSession, ThreadInfo, Vendor } from './canon.js';
import type { MetricOptions, SessionMetrics } from './metrics.js';

export interface SearchHit {
  idx: number;
  /** excerpt around the first match */
  excerpt: string;
  count: number;
}

/**
 * What a transcript says about itself, read from its head alone: enough to name
 * it, file it under the right project, order it by when it really started and
 * link it to the thread it serves — without parsing the whole of it.
 */
export interface SessionIdentity {
  /** the session's own name, absent when the file offers none */
  title?: string;
  cwd?: string;
  /** this file's own session id — what a child's `thread.parentId` points at */
  sessionId?: string;
  thread?: ThreadInfo;
  startTs?: number;
  model?: string;
  /** the peek reached the end of the file, so nothing here can change later */
  complete: boolean;
}

export interface SniffResult {
  id: string;
  vendor: Vendor | 'unknown';
  confidence: number;
  reason: string;
  identity: SessionIdentity;
}

export type ToWorker =
  /**
   * `part` selects one conversation out of a container that holds several.
   * `children` are dependent threads of this file (a Codex guardian review
   * rollout): separate files whose events belong in this timeline, merged by
   * the worker so that the reader deals with one session.
   */
  | {
      type: 'parse';
      fileId: string;
      file: File;
      options: MetricOptions;
      part?: string;
      children?: { id: string; file: File }[];
    }
  | { type: 'expand'; fileId: string; reqId: number; idx: number }
  | { type: 'search'; fileId: string; reqId: number; query: string }
  | { type: 'recompute'; fileId: string; reqId: number; options: MetricOptions }
  | { type: 'sniff'; reqId: number; id: string; file: File }
  /**
   * Parse for metrics only — nothing is retained, used by "analyze all". It
   * takes the same `children` as `parse` so a session's numbers are the same
   * whether they were swept or opened.
   */
  | {
      type: 'analyze';
      reqId: number;
      id: string;
      file: File;
      options: MetricOptions;
      children?: { id: string; file: File }[];
    }
  | { type: 'close'; fileId: string };

export type FromWorker =
  | { type: 'progress'; fileId: string; bytes: number; total: number; lines: number }
  | { type: 'done'; fileId: string; session: CanonSession; metrics: SessionMetrics }
  | { type: 'metrics'; fileId: string; reqId: number; metrics: SessionMetrics }
  | { type: 'failed'; fileId: string; reqId?: number; message: string }
  | { type: 'expanded'; fileId: string; reqId: number; body: string }
  | { type: 'results'; fileId: string; reqId: number; hits: SearchHit[]; capped: boolean }
  | { type: 'sniffed'; reqId: number; result: SniffResult }
  | { type: 'analyzed'; reqId: number; id: string; metrics: SessionMetrics | null; message?: string };
