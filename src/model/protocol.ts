/**
 * Worker <-> UI messages.
 *
 * Everything here is structured-cloneable: the worker owns the File, the parsed
 * index and the body store; the UI thread only ever holds light records.
 */

import type { CanonSession, Vendor } from './canon.js';
import type { MetricOptions, SessionMetrics } from './metrics.js';

export interface SearchHit {
  idx: number;
  /** excerpt around the first match */
  excerpt: string;
  count: number;
}

export interface SniffResult {
  id: string;
  vendor: Vendor | 'unknown';
  confidence: number;
  reason: string;
}

export type ToWorker =
  /** `part` selects one conversation out of a container that holds several */
  | { type: 'parse'; fileId: string; file: File; options: MetricOptions; part?: string }
  | { type: 'expand'; fileId: string; reqId: number; idx: number }
  | { type: 'search'; fileId: string; reqId: number; query: string }
  | { type: 'recompute'; fileId: string; reqId: number; options: MetricOptions }
  | { type: 'sniff'; reqId: number; id: string; file: File }
  /** parse for metrics only — nothing is retained, used by "analyze all" */
  | { type: 'analyze'; reqId: number; id: string; file: File; options: MetricOptions }
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
