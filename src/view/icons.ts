/**
 * One 16px line-art glyph per category, inlined as SVG.
 *
 * They render in `currentColor` so a row's icon inherits the accent CSS already
 * gives its kind, and they cost nothing at runtime: rows are memoized strings,
 * so each icon's markup is built once per distinct row state.
 */

import type { Category } from './kinds.js';

const PATHS: Record<Category, string> = {
  // speech bubble
  prompt: '<rect x="2" y="2.75" width="12" height="8.5" rx="2"/><path d="M5.5 11.25V14l3-2.75"/>',
  // asterisk / spark
  reply: '<path d="M8 2.2v11.6M3 4.6l10 6.8M13 4.6l-10 6.8"/>',
  // ellipsis
  thinking:
    '<circle cx="3.6" cy="8" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/>' +
    '<circle cx="12.4" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  // terminal
  bash: '<rect x="2" y="2.75" width="12" height="10.5" rx="2"/><path d="m5 6.5 2.2 1.5L5 9.5M8.75 10.5h2.5"/>',
  // pencil
  edit: '<path d="M11.2 2.3 13.7 4.8 5.7 12.8 2.5 13.5l.7-3.2z"/><path d="m9.8 3.7 2.5 2.5"/>',
  // document
  read: '<path d="M4 1.75h5l3.2 3.2v9.3H4z"/><path d="M8.8 1.75v3.4h3.4"/>',
  // globe
  web: '<circle cx="8" cy="8" r="6"/><path d="M2.2 8h11.6"/><ellipse cx="8" cy="8" rx="2.9" ry="6"/>',
  // checklist
  plan: '<path d="m2.2 4.4 1.5 1.5 2.6-2.7M2.2 11.4l1.5 1.5 2.6-2.7M8.4 4.6h5.4M8.4 11.6h5.4"/>',
  // picture
  image:
    '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" stroke="none"/><path d="m2.6 12 3.6-3.5 2.3 2.2 2.3-2.2 2.6 2.5"/>',
  // alert triangle
  error: '<path d="M8 2.4 14.4 13.4H1.6z"/><path d="M8 6.4v3.3"/><circle cx="8" cy="11.6" r=".75" fill="currentColor" stroke="none"/>',
  // wrench
  other: '<path d="M10.6 2.2a3.6 3.6 0 0 0-4.4 4.5L2.3 10.6l3.1 3.1 3.9-3.9a3.6 3.6 0 0 0 4.5-4.4l-2.2 2.2-2.2-2.2z"/>',
};

/** Inline SVG for a category, sized to the surrounding text. */
export function icon(cat: Category, cls = 'ico'): string {
  return (
    `<svg class="${cls}" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" ` +
    `fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
    PATHS[cat] +
    `</svg>`
  );
}
