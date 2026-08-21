/**
 * Operation statistics (SPEC §6.1).
 *
 * Two groupings: by tool name (what you actually ran) and by canonical category
 * (the only axis that compares fairly across agents, since tool names differ but
 * "edit a file" does not). Timings exclude calls whose duration is unknowable,
 * and rows remember which of their timings were parallel-call upper bounds.
 */

import type { CanonEvent, OpCategory } from '../model/canon.js';
import { OP_CATEGORIES } from '../model/canon.js';
import type { OpRow, OpStats } from '../model/metrics.js';
import { basename } from '../vendor/text.js';

interface Bucket {
  key: string;
  label: string;
  category: OpCategory;
  calls: number;
  ok: number;
  error: number;
  interrupted: number;
  unpaired: number;
  retries: number;
  durations: number[];
  shared: boolean;
  tokensIn: number;
  tokensOut: number;
  firstIdx: number;
  idxs: number[];
  children?: Map<string, Bucket>;
}

function newBucket(key: string, label: string, category: OpCategory, idx: number): Bucket {
  return {
    key,
    label,
    category,
    calls: 0,
    ok: 0,
    error: 0,
    interrupted: 0,
    unpaired: 0,
    retries: 0,
    durations: [],
    shared: false,
    tokensIn: 0,
    tokensOut: 0,
    firstIdx: idx,
    idxs: [],
  };
}

function fold(bucket: Bucket, ev: CanonEvent): void {
  const op = ev.op!;
  bucket.calls++;
  bucket[op.status]++;
  bucket.tokensIn += ev.tokens.payloadIn ?? 0;
  bucket.tokensOut += ev.tokens.payloadOut ?? 0;
  if (ev.durationMs !== undefined && ev.durationSource !== 'unknown') {
    bucket.durations.push(ev.durationMs);
    if (ev.durationSource === 'shared') bucket.shared = true;
  }
  if (bucket.idxs.length < 5000) bucket.idxs.push(ev.idx);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

function toRow(b: Bucket, totalCost: number): OpRow {
  const sorted = [...b.durations].sort((x, y) => x - y);
  const row: OpRow = {
    key: b.key,
    label: b.label,
    category: b.category,
    calls: b.calls,
    ok: b.ok,
    error: b.error,
    interrupted: b.interrupted,
    unpaired: b.unpaired,
    retries: b.retries,
    timedCalls: sorted.length,
    totalMs: sorted.reduce((n, v) => n + v, 0),
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    shared: b.shared,
    tokensIn: b.tokensIn,
    tokensOut: b.tokensOut,
    share: totalCost ? (b.tokensIn + b.tokensOut) / totalCost : 0,
    firstIdx: b.firstIdx,
    idxs: b.idxs,
  };
  if (b.children?.size) {
    row.subgroups = [...b.children.values()]
      .map((c) => toRow(c, totalCost))
      .sort((x, y) => y.calls - x.calls || y.totalMs - x.totalMs);
  }
  return row;
}

/** File-touching rows break down twice: by extension, then by path. */
function childKey(ev: CanonEvent): { key: string; label: string; leaf?: string } | null {
  const op = ev.op!;
  const sub = op.subgroup;
  if (!sub) return null;
  if ((op.category === 'read' || op.category === 'edit') && op.target) {
    return { key: sub, label: sub, leaf: op.target };
  }
  return { key: sub, label: sub };
}

export function computeOps(events: readonly CanonEvent[], mainThreadOnly = false): OpStats {
  const byName = new Map<string, Bucket>();
  const byCat = new Map<OpCategory, Bucket>();
  const seen = new Map<string, number>();
  let totalCost = 0;
  let calls = 0;
  let failed = 0;
  let subagentCalls = 0;

  for (const ev of events) {
    if (ev.kind !== 'op' || !ev.op) continue;
    if (mainThreadOnly && ev.sidechain > 0) continue;
    const op = ev.op;
    calls++;
    if (op.status !== 'ok') failed++;
    if (ev.sidechain > 0) subagentCalls++;
    totalCost += (ev.tokens.payloadIn ?? 0) + (ev.tokens.payloadOut ?? 0);

    let name = byName.get(op.name);
    if (!name) {
      name = newBucket(op.name, op.name, op.category, ev.idx);
      byName.set(op.name, name);
    }
    fold(name, ev);

    const ck = childKey(ev);
    if (ck) {
      name.children ??= new Map();
      let child = name.children.get(ck.key);
      if (!child) {
        child = newBucket(`${op.name}/${ck.key}`, ck.label, op.category, ev.idx);
        name.children.set(ck.key, child);
      }
      fold(child, ev);
      if (ck.leaf) {
        child.children ??= new Map();
        const leafKey = ck.leaf;
        let leaf = child.children.get(leafKey);
        if (!leaf) {
          leaf = newBucket(`${op.name}/${ck.key}/${leafKey}`, basename(leafKey) || leafKey, op.category, ev.idx);
          child.children.set(leafKey, leaf);
        }
        fold(leaf, ev);
      }
    }

    let cat = byCat.get(op.category);
    if (!cat) {
      cat = newBucket(op.category, op.category, op.category, ev.idx);
      byCat.set(op.category, cat);
    }
    fold(cat, ev);
    // the category view breaks down by tool name
    cat.children ??= new Map();
    let catChild = cat.children.get(op.name);
    if (!catChild) {
      catChild = newBucket(`${op.category}/${op.name}`, op.name, op.category, ev.idx);
      cat.children.set(op.name, catChild);
    }
    fold(catChild, ev);

    // A repeat of the same call inside one segment is a retry, not new work.
    const rk = `${ev.seg}|${op.name}|${op.target ?? ''}`;
    const n = (seen.get(rk) ?? 0) + 1;
    seen.set(rk, n);
    if (n > 1) {
      name.retries++;
      cat.retries++;
    }
  }

  const nameRows = [...byName.values()]
    .map((b) => toRow(b, totalCost))
    .sort((a, b) => b.calls - a.calls || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));
  const catRows = OP_CATEGORIES.map((c) => byCat.get(c))
    .filter((b): b is Bucket => !!b)
    .map((b) => toRow(b, totalCost));

  let totalMs = 0;
  let timedCalls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const r of nameRows) {
    totalMs += r.totalMs;
    timedCalls += r.timedCalls;
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
  }

  return {
    byName: nameRows,
    byCategory: catRows,
    totals: { calls, failed, timedCalls, totalMs, tokensIn, tokensOut, subagentCalls },
  };
}

/** Files touched by edit operations, with how often each was written. */
export function fileChurn(events: readonly CanonEvent[], from = 0): Map<string, number> {
  const out = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind !== 'op' || ev.op?.category !== 'edit' || !ev.op.target) continue;
    if (ev.ts && from && ev.ts < from) continue;
    if (!ev.ts && from) continue;
    out.set(ev.op.target, (out.get(ev.op.target) ?? 0) + 1);
  }
  return out;
}
