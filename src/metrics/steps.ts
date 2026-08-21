/**
 * Turning a plan into steps, and telling two versions of a plan apart.
 *
 * Shared by the adapters (which extract steps at parse time) and by the plan
 * metrics (which diff consecutive revisions). Deliberately conservative: a step
 * that merely got ticked off must not read as an edit to the plan (SPEC D6).
 */

import type { PlanStep } from '../model/canon.js';

const LIST_RE = /^(\s{0,3})(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEAD_RE = /^(#{2,3})\s+(.+?)\s*#*$/;
const BOX_RE = /^\[( |x|X|~|-|\/)\]\s*/;

/** Strip formatting so "1. **Fix** the parser." and "fix the parser" match. */
export function normalizeStep(text: string): string {
  return text
    .toLowerCase()
    .replace(BOX_RE, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s/.\-_]/gu, ' ')
    // a trailing dot ends a sentence; a dot inside a name is part of it
    .replace(/\.+(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function statusOf(text: string): { status: PlanStep['status']; text: string } {
  const m = BOX_RE.exec(text);
  if (!m) return { status: 'unknown', text };
  const rest = text.slice(m[0].length);
  const c = m[1];
  if (c === 'x' || c === 'X') return { status: 'done', text: rest };
  if (c === '~' || c === '/' || c === '-') return { status: 'active', text: rest };
  return { status: 'pending', text: rest };
}

/**
 * Extract ordered steps from a markdown plan.
 *
 * Top-level list items and `##` headings are both candidates; whichever yields
 * at least three items wins, because a plan written as headings and a plan
 * written as a list are the same plan. Nested items belong to their parent and
 * are not steps of their own.
 */
export function extractSteps(markdown: string): PlanStep[] {
  const lines = markdown.split('\n');
  const items: string[] = [];
  const heads: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = HEAD_RE.exec(line);
    if (h) {
      heads.push(h[2].trim());
      continue;
    }
    const l = LIST_RE.exec(line);
    if (l && l[1].length < 2 && l[2].trim()) items.push(l[2].trim());
  }

  const chosen = items.length >= 3 ? items : heads.length >= 3 ? heads : items.length >= heads.length ? items : heads;
  const out: PlanStep[] = [];
  const seen = new Map<string, number>();
  for (const text of chosen) {
    const s = statusOf(text.trim());
    const norm = normalizeStep(s.text);
    if (!norm) continue;
    const n = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, n);
    out.push({ id: n > 1 ? `${norm}#${n}` : norm, text: s.text.trim(), status: s.status });
  }
  return out;
}

/** Token-set Dice coefficient: 2|A∩B| / (|A|+|B|). */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export const MATCH_THRESHOLD = 0.85;

export interface StepMatch {
  /** index in the previous revision, or -1 when the step is new */
  prev: number;
  /** index in the next revision, or -1 when the step was removed */
  next: number;
  similarity: number;
}

/**
 * Pair steps between two revisions: by id first, then by normalized text, then
 * by similarity above the threshold. Anything left over is an add or a removal.
 */
export function matchSteps(prev: PlanStep[], next: PlanStep[]): StepMatch[] {
  const out: StepMatch[] = [];
  const usedPrev = new Set<number>();
  const usedNext = new Set<number>();

  const byId = new Map<string, number>();
  prev.forEach((s, i) => { if (!byId.has(s.id)) byId.set(s.id, i); });
  next.forEach((s, j) => {
    const i = byId.get(s.id);
    if (i !== undefined && !usedPrev.has(i)) {
      usedPrev.add(i);
      usedNext.add(j);
      out.push({ prev: i, next: j, similarity: 1 });
    }
  });

  // Greedy best-similarity pairing over what is left.
  const pairs: { i: number; j: number; sim: number }[] = [];
  for (let i = 0; i < prev.length; i++) {
    if (usedPrev.has(i)) continue;
    const a = normalizeStep(prev[i].text);
    for (let j = 0; j < next.length; j++) {
      if (usedNext.has(j)) continue;
      const sim = dice(a, normalizeStep(next[j].text));
      if (sim >= MATCH_THRESHOLD) pairs.push({ i, j, sim });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  for (const p of pairs) {
    if (usedPrev.has(p.i) || usedNext.has(p.j)) continue;
    usedPrev.add(p.i);
    usedNext.add(p.j);
    out.push({ prev: p.i, next: p.j, similarity: p.sim });
  }

  for (let i = 0; i < prev.length; i++) if (!usedPrev.has(i)) out.push({ prev: i, next: -1, similarity: 0 });
  for (let j = 0; j < next.length; j++) if (!usedNext.has(j)) out.push({ prev: -1, next: j, similarity: 0 });
  return out.sort((a, b) => (a.next === -1 ? 1e9 : a.next) - (b.next === -1 ? 1e9 : b.next));
}
