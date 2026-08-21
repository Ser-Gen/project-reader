/**
 * Question rows.
 *
 * The other half of the line protocol in `vendor/text.ts`: that side writes
 * what was asked, what was offered and what came back; this side draws it. A
 * decision is the one thing in a transcript worth reading in full — which
 * options existed, what each one claimed, and which one won — so all of it is
 * rendered, with the picked option marked rather than merely listed first.
 *
 * Every field arrives as untrusted transcript text and is escaped here.
 */

import { escapeHtml } from './markdown.js';

interface Opt {
  label: string;
  description: string;
  preview?: string;
  picked: boolean;
  own?: boolean;
  none?: boolean;
}

interface Q {
  header: string;
  question: string;
  multi: boolean;
  options: Opt[];
}

/** Parse the encoded body. Tolerant by design: a truncated body yields whole questions plus a partial one. */
export function decodeAsk(body: string): Q[] {
  const out: Q[] = [];
  for (const line of body.split('\n')) {
    const tag = line[0];
    const f = line.slice(2).split('\t');
    const q = out[out.length - 1];
    if (tag === 'Q') {
      // A `Q` cut mid-line would open a question that has no text and can hold
      // no options, so it is dropped rather than drawn as an empty heading.
      if (f.length >= 3) out.push({ header: f[0], multi: f[1] === 'any', question: f[2], options: [] });
    } else if (!q) {
      continue;
    } else if (tag === '+' || tag === '-') {
      q.options.push({ label: f[0] ?? '', description: f[1] ?? '', picked: tag === '+' });
    } else if (tag === 'P') {
      const last = q.options[q.options.length - 1];
      if (last) last.preview = (f[0] ?? '').replace(/\\n/g, '\n');
    } else if (tag === '*') {
      q.options.push({ label: f[0] ?? '', description: '', picked: true, own: true });
    } else if (tag === '!') {
      q.options.push({ label: f[0] ?? '', description: '', picked: false, none: true });
    }
  }
  return out;
}

function option(o: Opt): string {
  const cls = ['opt'];
  if (o.picked) cls.push('on');
  if (o.own) cls.push('own');
  if (o.none) cls.push('none');
  const mark = o.none ? '·' : o.own ? '✎' : o.picked ? '✓' : '';
  return (
    `<div class="${cls.join(' ')}">` +
    `<span class="pk">${mark}</span>` +
    `<div class="oc">` +
    `<span class="ol">${escapeHtml(o.label)}</span>` +
    (o.description ? `<span class="od">${escapeHtml(o.description)}</span>` : '') +
    (o.preview ? `<pre class="code prev">${escapeHtml(o.preview)}</pre>` : '') +
    `</div></div>`
  );
}

export function renderAsk(body: string): string {
  const questions = decodeAsk(body);
  // A body clipped before its first `Q` line, or a shape this decoder does not
  // know: show the text rather than nothing.
  if (!questions.length) return `<pre class="code">${escapeHtml(body)}</pre>`;

  const out: string[] = [];
  for (const q of questions) {
    const picked = q.options.filter((o) => o.picked).length;
    out.push(
      '<div class="askq">' +
        (q.header ? `<span class="qh">${escapeHtml(q.header)}</span>` : '') +
        `<span class="qt">${escapeHtml(q.question)}</span>` +
        `<span class="qm">${q.multi ? `pick any${picked ? ` · ${picked} picked` : ''}` : 'pick one'}</span>` +
        '</div>',
    );
    out.push(`<div class="asko">${q.options.map(option).join('')}</div>`);
  }
  return `<div class="ask">${out.join('')}</div>`;
}
