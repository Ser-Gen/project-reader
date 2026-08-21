/**
 * Small text helpers shared by every adapter. Pure and DOM-free so they run
 * under `node --test`.
 */

// CSI escape sequences from terminal output captured in shell results.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(s: string): string {
  return s.indexOf('\u001b') === -1 ? s : s.replace(ANSI, '');
}

export function firstLine(s: string, max = 200): string {
  const nl = s.indexOf('\n');
  const line = nl === -1 ? s : s.slice(0, nl) + ' …';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

export function oneLine(s: string, max = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function shortPath(p: string | undefined, cwd?: string): string {
  if (!p) return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  const parts = p.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function extname(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1].replace(/^www\./, '') : url.slice(0, 40);
}

export function patchToDiff(patch: unknown): { text: string; adds: number; dels: number } {
  if (!Array.isArray(patch)) return { text: '', adds: 0, dels: 0 };
  const out: string[] = [];
  let adds = 0;
  let dels = 0;
  for (const h of patch) {
    if (!h || typeof h !== 'object') continue;
    const hunk = h as {
      oldStart?: number;
      oldLines?: number;
      newStart?: number;
      newLines?: number;
      lines?: string[];
    };
    out.push(
      `@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${hunk.newStart ?? 0},${hunk.newLines ?? 0} @@`,
    );
    for (const l of hunk.lines ?? []) {
      if (l[0] === '+') adds++;
      else if (l[0] === '-') dels++;
      out.push(l);
    }
  }
  return { text: out.join('\n'), adds, dels };
}

/** Count +/- lines of a unified diff that arrived as plain text. */
export function countDiffLines(text: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of text.split('\n')) {
    if (line[0] === '+' && !line.startsWith('+++')) adds++;
    else if (line[0] === '-' && !line.startsWith('---')) dels++;
  }
  return { adds, dels };
}

/**
 * The "effective command" of a shell invocation: what you would call the thing
 * it actually ran. Leading env assignments, `sudo`, `time` and `cd … &&` are
 * scaffolding, not the command, and a pipeline is named by its first stage.
 */
export function commandHead(raw: string): string {
  let s = raw.trim();
  // take the first stage of the first pipeline/sequence
  for (;;) {
    const before = s;
    s = s.replace(/^\(\s*/, '');
    // strip `cd path &&` and other setup prefixes
    s = s.replace(/^cd\s+[^&|;]+(&&|;)\s*/, '');
    s = s.replace(/^(sudo|time|command|nohup|exec|env)\s+/, '');
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/, '');
    if (s === before) break;
  }
  const stage = s.split(/\s*(?:\|\||&&|[|;])\s*/)[0] ?? '';
  const tokens = stage.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return raw.trim().slice(0, 24) || '(empty)';
  let bin = tokens[0];
  const slash = bin.lastIndexOf('/');
  if (slash >= 0) bin = bin.slice(slash + 1);
  // for multiplexers the subcommand is the interesting part
  const KEEP_SUB = new Set([
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'git',
    'cargo',
    'go',
    'docker',
    'kubectl',
    'brew',
    'pip',
    'python',
    'python3',
    'node',
    'gh',
    'terraform',
    'make',
  ]);
  if (KEEP_SUB.has(bin)) {
    const sub = tokens.slice(1).find((t) => !t.startsWith('-'));
    if (sub) return `${bin} ${sub.length > 24 ? sub.slice(0, 24) : sub}`;
  }
  return bin.slice(0, 32);
}

/* ------------------------------------------------------------------ *
 * Question/answer bodies.
 *
 * An `AskUserQuestion` row is a decision: what was offered, what each
 * option meant, and which one the human picked. That does not survive as
 * prose, so adapters encode it as a tiny line protocol and the reader
 * draws it (see `renderAsk` in view/ask.ts — the two must stay in step,
 * which `test/parser.test.mjs` asserts by round-tripping).
 *
 *   Q <tab> header <tab> one|any <tab> question text
 *   + <tab> label  <tab> description        picked
 *   - <tab> label  <tab> description        offered, not picked
 *   P <tab> preview                         the picked option's preview
 *   * <tab> text                            an answer no option offered
 *   ! <tab> text                            why there is no answer
 *
 * Truncation is the reason for a line protocol rather than JSON: a body
 * cut mid-way still parses into everything before the cut.
 * ------------------------------------------------------------------ */

export interface AskOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: AskOption[];
}

/** Tabs and newlines are the protocol's own punctuation, so they cannot survive in a field. */
const flat = (s: unknown): string => String(s ?? '').replace(/\t/g, '  ').replace(/\r?\n/g, '\\n');

/**
 * Which options an answer names.
 *
 * A multi-select answer is its labels joined with ", " — but labels contain
 * commas of their own, so this matches whole labels against the answer rather
 * than splitting on the separator. What no label claims is the human's own
 * words, typed into "Other", and is worth keeping: it is the answer that the
 * question failed to anticipate.
 */
export function pickedOptions(answer: string, options: readonly AskOption[]): { picked: Set<number>; extra: string } {
  const picked = new Set<number>();
  const a = answer.trim();
  if (!a) return { picked, extra: '' };

  const exact = options.findIndex((o) => o.label.trim() === a);
  if (exact >= 0) {
    picked.add(exact);
    return { picked, extra: '' };
  }

  // Longest first, so a label that contains another one wins its own match.
  const order = options.map((_o, i) => i).sort((x, y) => options[y].label.length - options[x].label.length);
  let rest = `, ${a}, `;
  for (const i of order) {
    const needle = `, ${options[i].label.trim()}, `;
    const at = rest.indexOf(needle);
    if (at === -1) continue;
    picked.add(i);
    rest = rest.slice(0, at) + ', ' + rest.slice(at + needle.length);
  }
  const extra = rest
    .split(', ')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
  return { picked, extra: picked.size ? extra : a };
}

/** Encode the questions, their options and the human's answers into a body. */
export function encodeAsk(questions: readonly AskQuestion[], answers: Record<string, string> | undefined): string {
  const out: string[] = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const options = Array.isArray(q.options) ? q.options : [];
    out.push(`Q\t${flat(q.header)}\t${q.multiSelect ? 'any' : 'one'}\t${flat(q.question)}`);
    const answer = answers?.[q.question];
    const { picked, extra } = answer ? pickedOptions(String(answer), options) : { picked: new Set<number>(), extra: '' };
    options.forEach((o, i) => {
      const on = picked.has(i);
      out.push(`${on ? '+' : '-'}\t${flat(o?.label)}\t${flat(o?.description)}`);
      // Only the chosen option's preview: the others cost bytes for a mockup
      // nobody acted on.
      if (on && o?.preview) out.push(`P\t${flat(o.preview)}`);
    });
    if (extra) out.push(`*\t${flat(extra)}`);
    if (!answer) out.push(`!\t${answers ? 'no answer recorded' : 'never answered'}`);
  }
  return out.join('\n');
}
