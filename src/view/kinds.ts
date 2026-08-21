/**
 * Event categories — the vocabulary shared by the type filter and the row icons.
 *
 * These are *display* categories, deliberately coarser than the canonical
 * `OpCategory`: they answer "what am I looking at while scrolling", not "how do
 * these two agents compare".
 */

import type { CanonEvent, OpCategory } from '../model/canon.js';

export type Category =
  | 'prompt'
  | 'reply'
  | 'thinking'
  | 'bash'
  | 'edit'
  | 'read'
  | 'web'
  | 'plan'
  | 'image'
  | 'error'
  | 'other';

/** Display order of the filter bar. */
export const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'prompt', label: 'your prompts' },
  { key: 'reply', label: 'replies' },
  { key: 'thinking', label: 'reasoning' },
  { key: 'bash', label: 'commands' },
  { key: 'edit', label: 'file edits' },
  { key: 'read', label: 'file reads & searches' },
  { key: 'web', label: 'web search & fetch' },
  { key: 'plan', label: 'plans, todos, questions' },
  { key: 'image', label: 'screenshots' },
  { key: 'error', label: 'errors' },
  { key: 'other', label: 'other' },
];

const BY_OP: Record<OpCategory, Category> = {
  read: 'read',
  search: 'read',
  edit: 'edit',
  execute: 'bash',
  web: 'web',
  plan: 'plan',
  ask: 'plan',
  agent: 'plan',
  other: 'other',
};

/** Every category an event belongs to, most specific first. */
export function categoriesOf(ev: CanonEvent): Category[] {
  const out: Category[] = [];
  switch (ev.kind) {
    case 'prompt':
      out.push('prompt');
      break;
    case 'text':
      out.push('reply');
      break;
    case 'reasoning':
      out.push('thinking');
      break;
    case 'error':
      out.push('error');
      break;
    case 'plan':
      out.push('plan');
      break;
    case 'op':
      out.push(BY_OP[ev.op?.category ?? 'other']);
      if (ev.op?.status === 'error') out.push('error');
      break;
    default:
      out.push('other');
  }
  if (ev.images?.length) out.push('image');
  return out;
}

/** The single glyph shown at the left of a row; a screenshot wins the slot. */
export function iconOf(ev: CanonEvent): Category {
  const cats = categoriesOf(ev);
  return cats.includes('image') ? 'image' : cats[0];
}

export function matchesFilter(ev: CanonEvent, filter: ReadonlySet<Category>): boolean {
  if (filter.size === 0) return true;
  for (const c of categoriesOf(ev)) if (filter.has(c)) return true;
  return false;
}

/** How many events fall in each category, for the counts on the filter chips. */
export function countByCategory(events: readonly CanonEvent[]): Record<Category, number> {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0])) as Record<Category, number>;
  for (const ev of events) {
    if (ev.kind === 'system') continue;
    for (const c of categoriesOf(ev)) counts[c]++;
  }
  return counts;
}
