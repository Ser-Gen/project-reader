/**
 * Small, allocation-light markdown subset.
 *
 * Deliberately not a dependency: a general markdown+highlighter pair costs
 * several hundred KB and shows up in every row render. This covers what actually
 * appears in transcripts (prose, fences, lists, links, emphasis) and escapes
 * everything, so no untrusted transcript text can inject markup.
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return /[&<>"']/.test(s) ? s.replace(/[&<>"']/g, (c) => ESC[c]) : s;
}

/** Inline spans: `code`, **bold**, *italic*, [text](url), bare urls. */
function inline(src: string): string {
  let s = escapeHtml(src);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
  );
  return s;
}

/**
 * GFM pipe tables.
 *
 * Transcripts are full of them — agents answer with tables constantly — and a
 * raw `| a | b |` grid is unreadable once it wraps. Only the pipe form is
 * supported; that is the only one that appears.
 */
type Align = '' | 'l' | 'c' | 'r';

/** Split one table row on unescaped pipes, dropping the edge cells `|…|` makes. */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  if (s.startsWith('|')) cells.shift();
  if (cells.length && s.endsWith('|') && !s.endsWith('\\|')) cells.pop();
  return cells.map((c) => c.trim());
}

/** `|---|:--:|` -> per-column alignment, or null when the line is not a delimiter. */
function delimiter(line: string): Align[] | null {
  if (!line || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.length) return null;
  const align: Align[] = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const l = c.startsWith(':');
    const r = c.endsWith(':') && c.length > 1;
    align.push(l && r ? 'c' : r ? 'r' : l ? 'l' : '');
  }
  return align;
}

function cell(tag: 'th' | 'td', text: string, align: Align): string {
  return `<${tag}${align ? ` class="a${align}"` : ''}>${inline(text)}</${tag}>`;
}

function renderTable(head: string[], align: Align[], rows: string[][]): string {
  const th = head.map((c, k) => cell('th', c, align[k])).join('');
  // Ragged rows are padded and over-long ones truncated, so the grid stays a
  // grid instead of leaking a stray column into the layout.
  const body = rows
    .map((r) => `<tr>${head.map((_c, k) => cell('td', r[k] ?? '', align[k])).join('')}</tr>`)
    .join('');
  return `<div class="tw-wrap"><table class="mdt"><thead><tr>${th}</tr></thead>${
    body ? `<tbody>${body}</tbody>` : ''
  }</table></div>`;
}

export function renderMarkdown(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let quote = false;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (quote) {
      out.push('</blockquote>');
      quote = false;
    }
  };
  const closeAll = () => {
    flushPara();
    closeList();
    closeQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      closeAll();
      const marker = fence[1][0];
      const lang = fence[2].trim().split(/\s+/)[0] ?? '';
      const buf: string[] = [];
      i++;
      for (; i < lines.length; i++) {
        if (new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{3,}\\s*$`).test(lines[i])) break;
        buf.push(lines[i]);
      }
      out.push(
        `<pre class="code"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    if (!line.trim()) {
      closeAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      closeAll();
      out.push('<hr>');
      continue;
    }

    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      flushPara();
      closeList();
      if (!quote) {
        out.push('<blockquote>');
        quote = true;
      }
      out.push(`<p>${inline(bq[1])}</p>`);
      continue;
    }
    closeQuote();

    // tables: a header row, a delimiter row of matching width, then body rows
    if (line.includes('|')) {
      const align = delimiter(lines[i + 1] ?? '');
      const head = align ? splitRow(line) : null;
      if (align && head && head.length > 1 && head.length === align.length) {
        closeAll();
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim() || !l.includes('|')) break;
          rows.push(splitRow(l));
        }
        out.push(renderTable(head, align, rows));
        i = j - 1;
        continue;
      }
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();

    para.push(line);
  }
  closeAll();
  return out.join('');
}

/** Unified-diff colouring, one span-free line per row for cheap painting. */
export function renderDiff(src: string): string {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const c = line[0];
    const cls = c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : '';
    out.push(`<span class="dl${cls ? ' ' + cls : ''}">${escapeHtml(line) || ' '}</span>`);
  }
  // No separator: each line is its own block, and a newline between them would
  // render as a second blank line under `white-space: pre`.
  return `<pre class="code diff">${out.join('')}</pre>`;
}

export function renderPlain(src: string): string {
  return `<pre class="code">${escapeHtml(src)}</pre>`;
}
