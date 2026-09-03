/**
 * Codex rollout adapter (experimental).
 *
 * Records are `{ timestamp, type: "response_item" | "event_msg" | "session_meta", payload }`.
 *
 * Two things are genuinely tricky.
 *
 * **Token accounting.** Codex reports *cumulative* totals, so per-request usage
 * only exists as a difference, and a context reset shows up as a negative delta
 * that must be clamped rather than believed.
 *
 * **Where an operation lives.** Claude puts a `tool_use` block in the message:
 * one call, one operation, one row. Newer Codex gives the model a single tool,
 * `exec`, whose argument is a *program* — so the operations are what that
 * program did, and the runtime reports them separately as `item_completed`
 * events. Reading operations from those items reproduces Claude's granularity,
 * and the data cooperates: most calls emit exactly one item, so one call is
 * still one row. Rollouts with no item stream keep the older path, decided per
 * call rather than per file, so nothing has to sniff the format up front.
 */

import type {
  BodyFormat,
  CanonSession,
  ImageRef,
  OpCategory,
  OpFacts,
  OpStatus,
  PlanArtifact,
} from '../model/canon.js';
import type { ContentClass } from '../metrics/estimate.js';
import type { Calibration } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder, type EventSource } from './builder.js';
import {
  asText,
  type AskQuestion,
  encodeAsk,
  basename,
  commandHead,
  countDiffLines,
  extname,
  firstLine,
  hostOf,
  oneLine,
  shortPath,
  stripAnsi,
} from './text.js';

const CATEGORY: Record<string, OpCategory> = {
  shell: 'execute',
  local_shell: 'execute',
  exec_command: 'execute',
  container_exec: 'execute',
  apply_patch: 'edit',
  edit_file: 'edit',
  write_file: 'edit',
  read_file: 'read',
  view_image: 'read',
  list_dir: 'read',
  grep: 'search',
  file_search: 'search',
  web_search: 'web',
  web_fetch: 'web',
  update_plan: 'plan',
  ask_user: 'ask',
  request_user_input: 'ask',
  'web.search': 'web',
  wait: 'other',
};

/** Items that describe an operation, rather than repeating the message stream. */
const OP_ITEMS = new Set(['CommandExecution', 'FileChange', 'Extension', 'ImageView']);

/**
 * Codex classifies each shell command itself. Trusting that is what gives a
 * Codex session the same read/search/execute split a Claude session gets from
 * having separate tools.
 */
const PARSED_CATEGORY: Record<string, OpCategory> = {
  read: 'read',
  list_files: 'read',
  search: 'search',
  unknown: 'execute',
};

/** Separates a script from the output it produced, inside one result body. */
const RULE = '─'.repeat(24) + ' output';

export function categoryOf(name: string): OpCategory {
  if (CATEGORY[name]) return CATEGORY[name];
  if (/shell|exec|command/i.test(name)) return 'execute';
  if (/patch|edit|write/i.test(name)) return 'edit';
  if (/read|cat|view/i.test(name)) return 'read';
  if (/search|grep|find/i.test(name)) return 'search';
  if (/web|fetch|http/i.test(name)) return 'web';
  if (/plan|todo/i.test(name)) return 'plan';
  return 'other';
}

function parseArgs(v: unknown): any {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return { _raw: v };
    }
  }
  return {};
}

/**
 * Newer Codex rollouts have one tool — `exec` — whose input is a *program*:
 * JavaScript that calls `tools.exec_command({cmd})`, `tools.apply_patch(...)`
 * and friends. Printing that as JSON turns every shell command in the session
 * into an unreadable blob, so the script is shown as code and the commands
 * inside it are pulled out for the row head and the operations table.
 */

/** Read the JS string literal that starts at `at`, honouring escapes. */
function readLiteral(src: string, at: number): { value: string; end: number } | null {
  const quote = src[at];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      const n = src[i + 1];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '' : (n ?? '');
      i++;
      continue;
    }
    if (c === quote) return { value: out, end: i };
    out += c;
  }
  return null;
}

/** Every shell command a script hands to `exec_command`. */
export function scriptCommands(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:cmd|command)\s*:\s*/g;
  while (re.exec(src)) {
    const lit = readLiteral(src, re.lastIndex);
    if (!lit) continue;
    if (lit.value.trim()) out.push(lit.value.trim());
    re.lastIndex = lit.end;
  }
  return out;
}

/** The `tools.*` functions a script calls, in the order it calls them. */
export function scriptTools(src: string): string[] {
  return [...src.matchAll(/\btools\.(\w+)\s*\(/g)].map((m) => m[1]);
}

/**
 * The `*** Begin Patch` envelope a script hands to `apply_patch`, decoded.
 *
 * It travels as a JS string literal, so in the source every newline is a
 * two-character `\n` and every backslash is doubled — which is precisely why
 * the raw script is unreadable, and why the row shows the patch instead.
 */
export function patchText(src: string): string | undefined {
  const at = src.indexOf('*** Begin Patch');
  if (at === -1) return undefined;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c !== '"' && c !== "'" && c !== '`') continue;
    const lit = readLiteral(src, i);
    if (lit && lit.value.includes('*** Begin Patch')) return lit.value;
    break;
  }
  return undefined;
}

/** The files an `apply_patch` envelope touches. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File:[ \t]*(.+)$/gm)].map((m) => m[1].trim());
}

/** The one-line head of a codex call, whatever shape its arguments took. */
function callHead(args: any, cwd?: string): string {
  const cmd = args?.command ?? args?.cmd;
  if (Array.isArray(cmd)) return firstLine(cmd.join(' '));
  if (typeof cmd === 'string') return firstLine(cmd);
  const path = args?.path ?? args?.file_path ?? args?.filename;
  if (typeof path === 'string') return shortPath(path, cwd);
  if (typeof args?.query === 'string') return args.query;
  if (typeof args?.url === 'string') return args.url;
  if (Array.isArray(args?.plan)) return `${args.plan.length} steps`;
  if (typeof args?.input === 'string') return firstLine(args.input);
  return oneLine(asText(args), 160);
}

function targetOf(args: any): string | undefined {
  const cmd = args?.command ?? args?.cmd;
  if (Array.isArray(cmd)) return cmd.join(' ');
  if (typeof cmd === 'string') return cmd;
  const path = args?.path ?? args?.file_path ?? args?.filename;
  if (typeof path === 'string') return path;
  if (typeof args?.url === 'string') return args.url;
  if (typeof args?.query === 'string') return args.query;
  return undefined;
}

function subgroupOf(category: OpCategory, target?: string): string | undefined {
  if (!target) return undefined;
  switch (category) {
    case 'execute':
      return commandHead(target);
    case 'read':
    case 'edit':
      return extname(target) || basename(target) || '(no extension)';
    case 'web':
      return /^[a-z]+:\/\//i.test(target) ? hostOf(target) : 'query';
    default:
      return undefined;
  }
}

/**
 * One operation, ready to become a row. An item can describe more than one —
 * a patch touching three files is three edits, the way it would be under any
 * other agent.
 */
interface ItemRow {
  name: string;
  category: OpCategory;
  target?: string;
  subgroup?: string;
  subtitle?: string;
  chips: string[];
  text: string;
  /** the whole output, when `text` is deliberately the shorter version */
  fullText?: string;
  format: BodyFormat;
  cls: ContentClass;
  status: OpStatus;
  exitCode?: number;
  adds?: number;
  dels?: number;
  durationMs?: number;
}

/** An item waiting for the call that produced it to close. */
interface PendingItem {
  it: any;
  ts: number;
  tsSource: any;
  start: number;
  end: number;
  ms?: number;
}

/**
 * `EventSource.block` for a row built from an item, plus the index of the row
 * within that item — so expanding the second file of a patch rebuilds the
 * second file, not the first.
 */
const ITEM_BLOCK = 10;

/**
 * A duration, in milliseconds, or nothing.
 *
 * Codex reports 0 for most command items — two independent fields agree on it,
 * for commands that plainly took longer than that — so a sub-millisecond figure
 * is bookkeeping rather than a measurement, and the row is better off saying it
 * does not know. The call's own wall time fills the gap where there is one.
 */
const ms = (d: any): number | undefined => {
  if (!d || typeof d !== 'object') return undefined;
  const v = Math.round(num(d.secs) * 1000 + num(d.nanos) / 1e6);
  return v >= 1 ? v : undefined;
};

/** `file:///Users/me/Downloads/%D0%A1.png` -> `/Users/me/Downloads/С.png` */
function unfile(path: string): string {
  let out = String(path ?? '');
  if (out.startsWith('file://')) out = out.slice(7);
  try {
    out = decodeURIComponent(out);
  } catch {
    /* a path that is not percent-encoded is already what it says */
  }
  return out;
}

function joinOutput(...parts: unknown[]): string {
  return parts.map((x) => String(x ?? '')).filter((x) => x.trim()).join('\n');
}

/**
 * Translate one completed item into the operations it stands for.
 *
 * `rel` shortens a path for display; `fullBody` passes nothing, because the
 * expand path only ever wants the text.
 */
export function itemRows(it: any, rel: (p: string) => string = (p) => p): ItemRow[] {
  const type = String(it?.type ?? '');

  if (type === 'CommandExecution') {
    const parsed: any[] = Array.isArray(it.parsed_cmd) ? it.parsed_cmd : [];
    const cmds = parsed.map((c) => String(c?.cmd ?? '')).filter(Boolean);
    const argv: string[] = Array.isArray(it.command) ? it.command.map(String) : [];
    const cmd = cmds[0] ?? argv[argv.length - 1] ?? '';
    const kinds = new Set(parsed.map((c) => PARSED_CATEGORY[String(c?.type)] ?? 'execute'));
    const category: OpCategory = kinds.size === 1 ? ([...kinds][0] as OpCategory) : 'execute';
    const path = parsed.find((c) => typeof c?.path === 'string')?.path as string | undefined;
    const target = category === 'read' && path ? rel(path) : cmd;
    // What the model was handed, and what the command actually printed. They
    // differ when Codex truncated the output, and only the first one was paid
    // for — so the row shows it, and the rest is one expand away.
    const shown = String(it.formatted_output ?? it.aggregated_output ?? joinOutput(it.stdout, it.stderr));
    const full = joinOutput(it.stdout, it.stderr);
    const exitCode = typeof it.exit_code === 'number' ? it.exit_code : undefined;
    const chips: string[] = [];
    if (cmds.length > 1) chips.push(`${cmds.length} commands`);
    if (full.length > shown.length) chips.push('full output on expand');
    return [
      {
        name: 'exec_command',
        category,
        target,
        subgroup: category === 'read' && path ? extname(path) || basename(path) : commandHead(cmd),
        subtitle: cmds.length > 1 ? `${firstLine(cmd, 120)} (+${cmds.length - 1} more)` : firstLine(cmd, 160),
        chips,
        text: stripAnsi(shown),
        fullText: full.length > shown.length ? stripAnsi(full) : undefined,
        format: 'text',
        cls: 'terminal',
        status: it.status === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'error' : 'ok',
        exitCode,
        durationMs: ms(it.duration),
      },
    ];
  }

  if (type === 'FileChange') {
    const changes = it.changes && typeof it.changes === 'object' ? it.changes : {};
    const failed = it.status === 'failed';
    const rows: ItemRow[] = [];
    for (const [path, change] of Object.entries<any>(changes)) {
      const kind = String(change?.type ?? 'update');
      // An added file has no diff, because there was nothing to diff against.
      // Written as one all-added hunk it reads like every other edit row.
      const content = typeof change?.content === 'string' ? change.content : undefined;
      const lines = content ? content.split('\n') : [];
      const text =
        typeof change?.unified_diff === 'string' ? change.unified_diff
        : content !== undefined ? `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l: string) => `+${l}`).join('\n')
        : '';
      const counts = countDiffLines(text);
      const shortened = rel(path);
      const chips = [kind];
      if (change?.move_path) chips.push(`\u2192 ${rel(String(change.move_path))}`);
      rows.push({
        name: 'apply_patch',
        category: 'edit',
        target: shortened,
        subgroup: extname(shortened) || basename(shortened) || '(no extension)',
        subtitle: shortened,
        chips,
        text,
        format: text ? 'diff' : 'text',
        cls: 'code',
        status: failed ? 'error' : 'ok',
        adds: counts.adds,
        dels: counts.dels,
      });
    }
    return rows;
  }

  if (type === 'Extension') {
    const kind = String(it.kind ?? 'extension');
    const query = String(it.query ?? it.action?.query ?? '');
    const results: any[] = Array.isArray(it.results) ? it.results : [];
    const text = results
      .map((r) => `- [${String(r?.title ?? r?.url ?? '')}](${String(r?.url ?? '')})` + (r?.snippet ? `\n  ${oneLine(String(r.snippet), 200)}` : ''))
      .join('\n');
    return [
      {
        name: kind,
        category: kind.startsWith('web') ? 'web' : 'other',
        target: query,
        subgroup: results.length ? hostOf(String(results[0]?.url ?? '')) || 'query' : 'query',
        subtitle: query,
        chips: results.length ? [`${results.length} results`] : [],
        text,
        format: 'md',
        cls: 'prose',
        status: 'ok',
      },
    ];
  }

  if (type === 'ImageView') {
    const path = unfile(String(it.path ?? ''));
    return [
      {
        name: 'view_image',
        category: 'read',
        target: rel(path),
        subgroup: extname(path) || 'image',
        subtitle: rel(path),
        // The transcript names the file it looked at and stores none of it.
        chips: ['image not stored in the transcript'],
        text: '',
        format: 'text',
        cls: 'terminal',
        status: 'ok',
      },
    ];
  }

  return [];
}

/** Codex writes the result body itself; there is nothing to rebuild. */
export function fullBody(rec: any, src: EventSource): string {
  const p = rec?.payload;
  if (!p) return asText(rec);
  if (p.type === 'item_completed' && src.block >= ITEM_BLOCK) {
    const row = itemRows(p.item)[src.block - ITEM_BLOCK];
    return row ? (row.fullText ?? row.text) : '';
  }
  if (src.block === 1) {
    const out = p.output ?? p.result;
    return out == null ? asText(p) : stripScriptHeader(outputText(out)).text;
  }
  if (typeof p.text === 'string') return p.text;
  if (Array.isArray(p.content)) {
    return p.content.map((c: any) => String(c?.text ?? '')).filter(Boolean).join('\n');
  }
  return asText(p.arguments ?? p);
}

export class CodexAdapter {
  readonly b: Builder;
  private pending = new Map<string, number>();
  /** call id -> the script it ran, for calls the subtitle cannot represent */
  private scripts = new Map<string, string>();
  private totals = { input: 0, cached: 0, output: 0, reasoning: 0 };
  private lastEventIdx = -1;
  private sawResponseItems = false;
  private sawWallTime = false;
  private sealedReasoning = 0;
  /** the call currently awaiting its output, and the items it has produced */
  private openCallId = '';
  private itemsFor = new Map<string, PendingItem[]>();
  /** call id -> the questions it put to the human */
  private asked = new Map<string, AskQuestion[]>();
  private sawItems = false;
  private limits: any;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'codex', confidence, cal);
  }

  push(rec: any, start: number, end: number): void {
    this.b.info.lines++;
    const raw = rec?.timestamp ? Date.parse(rec.timestamp) : 0;
    const { ts, tsSource } = this.b.stamp(Number.isFinite(raw) ? raw : 0);
    const type = rec?.type;
    const p = rec?.payload ?? {};

    if (type === 'session_meta' || type === 'turn_context') {
      const info = this.b.info;
      if (p.cwd && !info.cwd) info.cwd = p.cwd;
      if (p.id && !info.sessionId) info.sessionId = String(p.id);
      if (p.model) info.model = String(p.model);
      if (p.cli_version) info.version = String(p.cli_version);
      if (p.git?.branch && !info.gitBranch) info.gitBranch = String(p.git.branch);
      this.b.addSystem(String(type), p.model ? String(p.model) : '', ts, start, end);
      return;
    }

    if (type === 'event_msg') {
      if (p.type === 'token_count') {
        if (p.rate_limits) this.limits = p.rate_limits;
        this.usage(p);
        this.b.addSystem('token_count', '', ts, start, end);
        return;
      }
      if (p.type === 'patch_apply_end' && p.changes && typeof p.changes === 'object') {
        this.patch(p, ts, tsSource, start, end);
        return;
      }
      if (p.type === 'item_completed') {
        this.itemEvent(p, ts, tsSource, start, end);
        return;
      }
      if (p.type === 'task_complete') {
        // The vendor timed its own turn; a measured number beats one inferred
        // from when records happened to be written.
        const seg = this.b.segments[this.b.segments.length - 1];
        const ttft = num(p.time_to_first_token_ms);
        if (seg && ttft > 0) seg.ttftMs = ttft;
        this.b.addSystem('task_complete', '', ts, start, end);
        return;
      }
      // Content also arrives as response_items; counting it twice would double
      // every token figure, so the event stream is kept as bookkeeping only.
      this.b.addSystem(String(p.type ?? 'event'), '', ts, start, end);
      return;
    }

    if (type !== 'response_item') {
      const t = String(type ?? 'unknown');
      this.b.countType(t);
      this.b.addSystem(t, '', ts, start, end);
      return;
    }

    this.sawResponseItems = true;
    switch (p.type) {
      case 'message': {
        const { text, images, files } = messageParts(p);
        if (!text.trim() && !images.length) return;
        const human = p.role === 'user';
        // `developer` is the IDE's own context, not something a human wrote:
        // counting it as a prompt would split the session into phantom turns.
        const dev = p.role === 'developer' || p.role === 'system';
        if (human) this.b.openSegment(text, ts);
        this.lastEventIdx = this.b.add(
          {
            kind: dev ? 'system' : human ? 'prompt' : 'text',
            ts,
            tsSource,
            title: dev ? String(p.role) : human ? 'You' : 'Codex',
            subtitle: dev ? oneLine(text, 120) : undefined,
            text,
            format: 'md',
            cls: 'prose',
            images: images.length ? images : undefined,
            chips: files.length ? files : undefined,
            collapsed: dev || undefined,
            id: p.id,
          },
          { start, end, block: 0 },
        );
        return;
      }
      case 'reasoning': {
        const text = reasoningText(p);
        if (!text.trim()) {
          // Codex ships the reasoning encrypted; the summary array is empty.
          // Saying so beats a session that looks like it never thought.
          if (p.encrypted_content) this.sealedReasoning++;
          return;
        }
        this.lastEventIdx = this.b.add(
          {
            kind: 'reasoning',
            ts,
            tsSource,
            title: 'reasoning',
            subtitle: oneLine(text, 120),
            text,
            format: 'md',
            cls: 'prose',
            collapsed: true,
            id: p.id,
          },
          { start, end, block: 0 },
        );
        return;
      }
      case 'function_call':
      case 'local_shell_call':
      case 'custom_tool_call': {
        this.openCall(p, ts, tsSource, start, end);
        return;
      }
      case 'function_call_output':
      case 'local_shell_call_output':
      case 'custom_tool_call_output': {
        this.closeCall(p, ts, start, end);
        return;
      }
      default: {
        const t = String(p.type ?? 'response_item');
        this.b.countType(t);
        this.b.addSystem(t, '', ts, start, end);
      }
    }
  }

  /** Cumulative counters -> per-request usage. */
  private usage(p: any): void {
    const info = p.info ?? p;
    const last = info.last_token_usage;
    const total = info.total_token_usage ?? info.total ?? info;
    let input = 0;
    let cached = 0;
    let output = 0;
    let reasoning = 0;

    if (last && typeof last === 'object') {
      input = num(last.input_tokens);
      cached = num(last.cached_input_tokens);
      output = num(last.output_tokens);
      reasoning = num(last.reasoning_output_tokens);
    } else if (total && typeof total === 'object') {
      const t = {
        input: num(total.input_tokens),
        cached: num(total.cached_input_tokens),
        output: num(total.output_tokens),
        reasoning: num(total.reasoning_output_tokens),
      };
      input = t.input - this.totals.input;
      cached = t.cached - this.totals.cached;
      output = t.output - this.totals.output;
      reasoning = t.reasoning - this.totals.reasoning;
      if (input < 0 || output < 0 || cached < 0) {
        // A reset means a new context, not negative usage.
        this.b.note('Codex: cumulative token counters reset mid-session; usage before the reset is not recoverable.');
        input = Math.max(0, input);
        cached = Math.max(0, cached);
        output = Math.max(0, output);
        reasoning = Math.max(0, reasoning);
      }
      this.totals = t;
    }
    if (!input && !output && !cached) return;

    // Codex counts cached input inside `input_tokens`; split it the way the
    // canonical model does, where fresh input excludes anything served from cache.
    const fresh = Math.max(0, input - cached);
    const target = this.lastEventIdx >= 0 ? this.b.events[this.lastEventIdx] : undefined;
    const reported = { input: fresh, cacheWrite: 0, cacheRead: cached, output, reasoning };
    if (target && !target.tokens.reported) target.tokens.reported = reported;
    else if (this.b.events.length) {
      const ev = this.b.events[this.b.events.length - 1];
      if (!ev.tokens.reported) ev.tokens.reported = reported;
    }
  }

  /**
   * A path as the row should show it. Codex runs on Windows too, where the
   * transcript mixes `\\` with `/` and disagrees with itself about the drive
   * letter's case — so the prefix match is done on a normalized, case-folded
   * copy while the displayed text keeps the separators the reader expects.
   */
  private rel(path: string): string {
    const norm = path.replace(/\\/g, '/');
    const cwd = this.b.info.cwd?.replace(/\\/g, '/');
    if (cwd && norm.toLowerCase().startsWith(cwd.toLowerCase() + '/')) return norm.slice(cwd.length + 1);
    return shortPath(norm);
  }

  /**
   * `patch_apply_end` is the only record that says which files an edit touched
   * and how. The call that applied it is a *script*, so without this the whole
   * session reads as shell noise and every metric that counts edits — files
   * touched, implementation end, unplanned work — sees nothing at all.
   *
   * The diff never entered the model's context (only the "Success…" summary
   * did, on the call's own result), so these rows carry no token cost.
   */
  private patch(p: any, ts: number, tsSource: any, start: number, end: number): void {
    const failed = p.success === false;
    for (const [path, change] of Object.entries<any>(p.changes)) {
      const diffText = String(change?.unified_diff ?? '');
      const counts = countDiffLines(diffText);
      const rel = this.rel(path);
      const kind = String(change?.type ?? 'update');
      const chips = [kind];
      if (change?.move_path) chips.push(`→ ${this.rel(String(change.move_path))}`);
      this.lastEventIdx = this.b.add(
        {
          kind: 'op',
          ts,
          tsSource,
          title: 'apply_patch',
          subtitle: rel,
          text: diffText,
          format: diffText ? 'diff' : 'text',
          cls: 'code',
          chips,
          collapsed: true,
          op: {
            name: 'apply_patch',
            category: 'edit',
            target: rel,
            subgroup: extname(rel) || basename(rel) || '(no extension)',
            status: failed ? 'error' : 'ok',
            linesAdded: counts.adds,
            linesRemoved: counts.dels,
          },
          payloadIn: 0,
        },
        { start, end, block: 0, tool: 'apply_patch' },
      );
    }
  }

  /**
   * A completed item. Operation items are held until their call closes, so the
   * common case — one call, one item — stays one row; anything arriving with no
   * call open is an operation in its own right and is emitted at once.
   */
  private itemEvent(p: any, ts: number, tsSource: any, start: number, end: number): void {
    const it = p.item ?? {};
    const type = String(it.type ?? '');
    if (type === 'Plan' && typeof it.text === 'string' && it.text.trim()) {
      this.planRow(it, ts, tsSource, start, end);
      return;
    }
    if (!OP_ITEMS.has(type)) {
      // Messages and reasoning arrive here too, and again as response items.
      // Reading them from both channels would double every figure they carry.
      this.b.addSystem(`item:${type || 'unknown'}`, '', ts, start, end);
      return;
    }
    this.sawItems = true;
    const span = num(p.completed_at_ms) - num(p.started_at_ms);
    const pending: PendingItem = { it, ts, tsSource, start, end, ms: span >= 1 ? span : undefined };
    if (this.openCallId) {
      const list = this.itemsFor.get(this.openCallId);
      if (list) list.push(pending);
      else this.itemsFor.set(this.openCallId, [pending]);
      return;
    }
    for (const [i, row] of this.itemRowsOf(pending).entries()) this.addItemRow(row, pending, i);
  }

  /** A plan, which in this format is an item and never a tool call. */
  private planRow(it: any, ts: number, tsSource: any, start: number, end: number): void {
    const text = String(it.text ?? '');
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: 'plan',
        subtitle: firstLine(text.replace(/^#+\s*/, ''), 160),
        text,
        format: 'md',
        cls: 'prose',
        collapsed: true,
        op: { name: 'plan', category: 'plan', status: 'ok' },
        payloadIn: 0,
        id: it.id ? String(it.id) : undefined,
      },
      { start, end, block: 3 },
    );
    this.b.events[idx].plan = {
      source: 'plan-tool',
      role: 'revision',
      approved: true,
      text,
      steps: extractSteps(text),
    };
    this.lastEventIdx = idx;
  }

  private itemRowsOf(pending: PendingItem): ItemRow[] {
    const rows = itemRows(pending.it, (path) => this.rel(path));
    for (const row of rows) if (row.durationMs === undefined) row.durationMs = pending.ms;
    return rows;
  }

  /** Add a row for an item that no call will close. */
  private addItemRow(row: ItemRow, pending: PendingItem, rowIdx: number, payloadOut = 0): number {
    const idx = this.b.add(
      {
        kind: 'op',
        ts: pending.ts,
        tsSource: pending.tsSource,
        title: row.name,
        subtitle: row.subtitle,
        text: '',
        format: 'text',
        collapsed: true,
        op: { name: row.name, category: row.category, target: row.target, subgroup: row.subgroup, status: 'unpaired' },
        // The script that caused this was charged on the way in, and a diff or
        // an image the model never received costs the context nothing.
        payloadIn: 0,
      },
      { start: pending.start, end: pending.end, block: ITEM_BLOCK + rowIdx, tool: row.name },
    );
    this.closeItemRow(idx, row, pending, rowIdx, payloadOut);
    this.lastEventIdx = idx;
    return idx;
  }

  private closeItemRow(idx: number, row: ItemRow, pending: PendingItem, rowIdx: number, payloadOut?: number): void {
    const ev = this.b.events[idx];
    this.b.close(
      idx,
      {
        text: row.text,
        fullText: row.fullText,
        format: row.format,
        cls: row.cls,
        chips: [...(ev.chips ?? []), ...row.chips],
        status: row.status,
        exitCode: row.exitCode,
        linesAdded: row.adds,
        linesRemoved: row.dels,
        ts: pending.ts,
        durationMs: row.durationMs,
        payloadOut,
      },
      { start: pending.start, end: pending.end, block: ITEM_BLOCK + rowIdx },
    );
  }

  private openCall(p: any, ts: number, tsSource: any, start: number, end: number): void {
    const name = String(p.name ?? p.action?.type ?? 'call');
    const args = parseArgs(p.arguments ?? p.input ?? p.action);
    const category = categoryOf(name);
    if (!CATEGORY[name]) this.b.countUnknownTool(name);

    // A question to the human is neither a script nor a blob of arguments: it
    // is a decision, and the options it offered are the point of showing it.
    if (Array.isArray(args?.questions) && args.questions.length) {
      this.openAsk(p, args.questions as AskQuestion[], name, ts, tsSource, start, end);
      return;
    }

    // Arguments that would not parse as JSON are a script, not a mangled
    // object: show the source, and lift the commands out of it.
    const script = typeof args._raw === 'string' ? args._raw : undefined;
    const cmds = script ? scriptCommands(script) : [];
    const patch = script ? patchText(script) : undefined;
    const patched = patch ? patchFiles(patch) : [];
    const chips: string[] = [];
    if (cmds.length > 1) chips.push(`${cmds.length} commands`);
    if (patched.length) chips.push(patched.length === 1 ? '1 file' : `${patched.length} files`);

    const text = script ?? asText(args);
    const cls = script ? 'code' : 'json';
    const target =
      cmds.length ? cmds[0]
      : patched.length ? this.rel(patched[0])
      : targetOf(args);
    const subtitle =
      cmds.length === 1 ? firstLine(cmds[0], 160)
      : cmds.length > 1 ? `${firstLine(cmds[0], 120)} (+${cmds.length - 1} more)`
      : patched.length ? patched.map((f) => basename(this.rel(f))).join(', ')
      : script ? firstLine(script, 160)
      : callHead(args, this.b.info.cwd);
    const op: OpFacts = {
      name,
      category,
      target,
      // Group by the command that ran, not by the one tool every call uses:
      // an ops table of 23 rows all called `exec` says nothing.
      subgroup:
        cmds.length ? commandHead(cmds[0])
        : script ? (scriptTools(script)[0] ?? 'script')
        : subgroupOf(category, target),
      status: 'unpaired',
    };
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle,
        text,
        format: 'text',
        cls,
        chips: chips.length ? chips : undefined,
        collapsed: true,
        op,
        payloadIn: this.b.est(text, cls),
        id: p.call_id ?? p.id,
      },
      { start, end, block: 0, tool: name },
    );
    this.lastEventIdx = idx;

    const plan = planOf(name, args);
    if (plan) this.b.events[idx].plan = plan;
    const callId = p.call_id ?? p.id;
    if (callId) {
      this.pending.set(String(callId), idx);
      this.openCallId = String(callId);
      // Most scripts are a wrapper around one shell command, and the row head
      // already shows it — repeating the boilerplate above every output would
      // be the noise this is meant to remove. A real program is different: the
      // result body is the only place left to show what actually ran.
      const wrapper = cmds.length === 1 && scriptTools(script ?? '').length <= 1;
      // For a patch, the envelope is the readable half of the script.
      if (patch) this.scripts.set(String(callId), patch);
      else if (script && !wrapper) this.scripts.set(String(callId), script);
    }
  }

  /**
   * Fold a call's items into rows. The first takes over the call's own row, so
   * the ordinary case stays one call, one row; the rest become rows of their
   * own, exactly as parallel tool calls do under Claude. The script's cost was
   * charged on the way in and the output's on the way out, both on the first
   * row — the others cost nothing, because nothing else re-entered the context.
   */
  private mergeItems(
    idx: number,
    items: PendingItem[],
    callId: string,
    context: string,
    callMs: number | undefined,
  ): void {
    const script = this.scripts.get(callId);
    this.scripts.delete(callId);
    const all = items.map((pending) => ({ pending, rows: this.itemRowsOf(pending) }));
    // A program worth reading is one that did several *different* things. Two
    // files of the same patch are one operation told twice; their diffs say
    // everything the script would.
    const kinds = new Set(all.flatMap((g) => g.rows.map((r) => r.name)));
    // One envelope carried every one of these back into the context, so its
    // cost is shared out by how much text each row accounts for rather than
    // landing entirely on whichever row happens to come first.
    const cost = this.b.est(context, 'terminal');
    const weights = all.flatMap((g) => g.rows.map((r) => Math.max(1, r.text.length)));
    const total = weights.reduce((n, w) => n + w, 0);
    let at = 0;
    let first = true;
    for (const { pending, rows } of all) {
      for (const [rowIdx, row] of rows.entries()) {
        const share = Math.round((cost * weights[at++]) / total);
        if (first) {
          first = false;
          if (row.durationMs === undefined) row.durationMs = callMs;
          const ev = this.b.events[idx];
          ev.title = row.name;
          ev.subtitle = row.subtitle;
          if (ev.op) {
            ev.op.name = row.name;
            ev.op.category = row.category;
            ev.op.target = row.target;
            ev.op.subgroup = row.subgroup;
          }
          // A program that did several things is worth showing above what it
          // produced. One that did one thing is not: the item already says what
          // ran, and a patch envelope repeated above its own diff is the noise
          // this was meant to remove.
          if (script && kinds.size > 1) {
            const head = script.replace(/\s+$/, '');
            // Nothing to separate the script from when the item printed nothing.
            const join = (body: string) => (body.trim() ? `${head}\n${RULE}\n${body}` : head);
            row.text = join(row.text);
            if (row.fullText) row.fullText = join(row.fullText);
          }
          this.closeItemRow(idx, row, pending, rowIdx, share);
          this.lastEventIdx = idx;
        } else {
          this.addItemRow(row, pending, rowIdx, share);
        }
      }
    }
    // Items that describe nothing renderable still closed the call.
    if (first) this.b.events[idx].op!.status = 'ok';
  }

  private openAsk(
    p: any,
    questions: AskQuestion[],
    name: string,
    ts: number,
    tsSource: any,
    start: number,
    end: number,
  ): void {
    const text = encodeAsk(questions, undefined);
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle:
          questions.length > 1 ?
            `${oneLine(String(questions[0]?.question ?? ''), 120)} (+${questions.length - 1} more)`
          : oneLine(String(questions[0]?.question ?? ''), 160),
        text,
        format: 'ask',
        cls: 'prose',
        chips: [questions.length === 1 ? '1 question' : `${questions.length} questions`],
        collapsed: true,
        op: { name, category: 'ask', status: 'unpaired' },
        payloadIn: this.b.est(text, 'prose'),
        id: p.call_id ?? p.id,
      },
      { start, end, block: 0, tool: name },
    );
    this.lastEventIdx = idx;
    const callId = p.call_id ?? p.id;
    if (callId) {
      this.pending.set(String(callId), idx);
      this.openCallId = String(callId);
      this.asked.set(String(callId), questions);
    }
  }

  /**
   * The answers come back keyed by question id, each one a list, and a human
   * who typed their own words instead of picking is common — all of which the
   * shared `ask` encoding already has a place for.
   */
  private closeAsk(idx: number, questions: AskQuestion[], raw: string, ts: number, start: number, end: number): void {
    let map: any = {};
    try {
      const parsed = JSON.parse(raw);
      map = parsed?.answers ?? parsed ?? {};
    } catch {
      /* an answer that is not JSON is no answer this can read */
    }
    const answersOf = (q: AskQuestion): string[] | undefined => {
      const hit = (q.id ? map[q.id] : undefined) ?? map[q.question];
      if (hit == null) return undefined;
      const list = Array.isArray(hit) ? hit : Array.isArray(hit.answers) ? hit.answers : [hit];
      const out = list.map((a: unknown) => String(a ?? '')).filter((a: string) => a.trim());
      return out.length ? out : undefined;
    };
    const answered = questions.filter((q) => answersOf(q)).length;
    const chips = [questions.length === 1 ? '1 question' : `${questions.length} questions`];
    if (answered < questions.length) chips.push(answered ? `${answered} answered` : 'unanswered');
    this.b.close(
      idx,
      {
        text: encodeAsk(questions, answersOf),
        format: 'ask',
        cls: 'prose',
        chips,
        status: answered ? 'ok' : 'interrupted',
        ts,
        // The row shows the options again; only the answers came back.
        payloadOut: this.b.est(raw, 'json'),
      },
      { start, end, block: 1 },
    );
    this.lastEventIdx = idx;
  }

  private closeCall(p: any, ts: number, start: number, end: number): void {
    const callId = String(p.call_id ?? p.id ?? '');
    const idx = this.pending.get(callId);
    const out = p.output ?? p.result;
    let text = outputText(out);
    const context = text;

    const questions = this.asked.get(callId);
    if (questions && idx !== undefined) {
      this.asked.delete(callId);
      this.pending.delete(callId);
      if (this.openCallId === callId) this.openCallId = '';
      this.closeAsk(idx, questions, context, ts, start, end);
      return;
    }
    const chips: string[] = [];
    let exitCode: number | undefined;
    let status: OpStatus = 'ok';
    let durationMs: number | undefined;

    const parsed = stripScriptHeader(text);
    text = parsed.text;
    if (parsed.failed) status = 'error';
    if (parsed.wallMs !== undefined) {
      durationMs = parsed.wallMs;
      this.sawWallTime = true;
    }
    if (parsed.truncatedTokens !== undefined) {
      chips.push(`truncated · ~${Math.round(parsed.truncatedTokens / 1000)}k tokens`);
    }

    // The output is often itself a JSON envelope with the metadata attached.
    if (typeof out === 'string' && out.startsWith('{')) {
      try {
        const j = JSON.parse(out);
        if (typeof j.output === 'string') text = j.output;
        const meta = j.metadata ?? j;
        if (typeof meta.exit_code === 'number') exitCode = meta.exit_code;
        if (typeof meta.duration_seconds === 'number') durationMs = meta.duration_seconds * 1000;
      } catch {
        /* keep the raw string */
      }
    } else if (out && typeof out === 'object') {
      if (typeof (out as any).output === 'string') text = (out as any).output;
      if (typeof (out as any).exit_code === 'number') exitCode = (out as any).exit_code;
    }
    text = stripAnsi(text);
    if (exitCode !== undefined && exitCode !== 0) status = 'error';
    if (p.success === false || /^error:/i.test(text)) status = 'error';

    if (idx === undefined) {
      this.b.quality.orphanResults++;
      this.b.add(
        { kind: 'notice', ts, title: 'orphan result', text, format: 'text', cls: 'terminal', collapsed: true },
        { start, end, block: 1 },
      );
      return;
    }
    this.pending.delete(callId);
    if (this.openCallId === callId) this.openCallId = '';

    // The call ran a program, and the runtime already said what the program
    // did. Those items are the operations; the call's own output is the
    // envelope they were reported through, and is worth only its cost.
    const items = this.itemsFor.get(callId);
    this.itemsFor.delete(callId);
    if (items?.length) {
      this.mergeItems(idx, items, callId, context, durationMs);
      return;
    }

    const ev = this.b.events[idx];
    const isPatch = ev.op?.category === 'edit';
    const diff = isPatch ? countDiffLines(text) : undefined;
    if (!text.trim()) chips.push('no output');

    // Show the program above what it printed, the way a terminal would. The
    // cost is still charged separately: the script was paid for on the way in.
    const script = this.scripts.get(callId);
    this.scripts.delete(callId);
    const body = script ? `${script.replace(/\s+$/, '')}\n${RULE}\n${text}` : text;
    // A patch envelope reads as a diff, and the summary printed under it is
    // plain enough to sit in the same block.
    const patchBody = script?.startsWith('*** Begin Patch') === true;
    this.b.close(
      idx,
      {
        text: body,
        format: patchBody || (isPatch && /^[-+@]/m.test(text)) ? 'diff' : 'text',
        cls: isPatch || patchBody ? 'code' : 'terminal',
        chips: [...(ev.chips ?? []), ...chips],
        status,
        exitCode,
        linesAdded: diff?.adds,
        linesRemoved: diff?.dels,
        ts,
        durationMs,
        // The header and the truncation warning were in the context even though
        // the row drops them, and the script was charged on the way in — so the
        // result's cost is measured from the result, not from what is displayed.
        payloadOut: context === body ? undefined : this.b.est(context, 'terminal'),
      },
      { start, end, block: 1 },
    );
    this.lastEventIdx = idx;
  }

  finish(parseMs: number): CanonSession {
    this.b.note(
      this.sawWallTime ?
        'Codex: script calls report their own wall time; every other duration is derived from record timestamps.'
      : 'Codex: durations are derived from record timestamps; per-call timings are not reported.',
    );
    if (this.sealedReasoning) {
      this.b.note(
        `Codex: ${this.sealedReasoning} reasoning turns carry no readable text — the rollout stores them ` +
          'encrypted or empty; their tokens are still counted in the reported usage.',
      );
    }
    if (this.sawItems) {
      this.b.note(
        'Codex: operations are read from the completed-item stream, which is where this format records ' +
          'what a script actually did — one row per command, patched file, search or image.',
      );
    }
    const lim = this.limits;
    if (lim && typeof lim === 'object') {
      const window = (w: any, name: string) =>
        w && typeof w.used_percent === 'number' ?
          `${Math.round(w.used_percent)}% of the ${humanWindow(num(w.window_minutes))} ${name}`
        : '';
      const parts = [window(lim.primary, 'window'), window(lim.secondary, 'window')].filter(Boolean);
      if (parts.length) {
        this.b.note(
          `Codex: rate limits at ${parts.join(' and ')}` +
            (lim.plan_type ? ` (${String(lim.plan_type)} plan)` : '') +
            ', as reported by the last usage record.',
        );
      }
    }
    if (!this.sawResponseItems && this.b.events.length) {
      this.b.note('Codex: this rollout carries only event messages; content could not be reconstructed.');
    }
    for (const idx of this.pending.values()) {
      const op = this.b.events[idx]?.op;
      if (op) op.status = 'unpaired';
    }
    return this.b.finish(parseMs);
  }
}

/** 300 -> "5-hour", 10080 -> "weekly" — the shape a limit is usually quoted in. */
function humanWindow(minutes: number): string {
  if (!minutes) return 'rolling';
  if (minutes >= 10080) return minutes === 10080 ? 'weekly' : `${Math.round(minutes / 1440)}-day`;
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}-day`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}-hour`;
  return `${minutes}-minute`;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * A message's parts: prose, the images the worker already decoded, and the
 * `<image name=… path=…>` wrapper Codex writes around each one. The wrapper is
 * markup, not something the human typed, so it leaves the body and comes back
 * as a chip naming the file that was dropped in.
 */
function messageParts(p: any): { text: string; images: ImageRef[]; files: string[] } {
  const images: ImageRef[] = [];
  const files: string[] = [];
  if (typeof p.text === 'string') return { text: p.text, images, files };
  if (typeof p.content === 'string') return { text: p.content, images, files };
  if (!Array.isArray(p.content)) return { text: '', images, files };

  const lines: string[] = [];
  for (const c of p.content) {
    if (typeof c === 'string') {
      lines.push(c);
      continue;
    }
    if (c?.__img) {
      images.push(c.__img as ImageRef);
      continue;
    }
    const text = String(c?.text ?? '');
    if (!text) continue;
    const open = /^\s*<image\b[^>]*>\s*$/i.exec(text);
    if (open) {
      const path = /path="([^"]*)"/i.exec(text)?.[1];
      if (path) files.push(basename(path.replace(/\\/g, '/')));
      continue;
    }
    if (/^\s*<\/image>\s*$/i.test(text)) continue;
    lines.push(text);
  }
  return { text: lines.join('\n'), images, files };
}

function messageText(p: any): string {
  return messageParts(p).text;
}

/**
 * `Script completed / Wall time 1.0 seconds / Output:` is the header Codex
 * wraps around every script result, sometimes followed by its own truncation
 * warning. It carries a real per-call duration — the one thing this adapter
 * otherwise has to infer from record stamps — so it is read, then removed from
 * the body it was describing.
 */
function stripScriptHeader(raw: string): {
  text: string;
  failed?: boolean;
  wallMs?: number;
  truncatedTokens?: number;
} {
  let text = raw;
  let failed: boolean | undefined;
  let wallMs: number | undefined;
  let truncatedTokens: number | undefined;
  const head = /^Script (completed|failed)[^\n]*\n(?:Wall time ([\d.]+) seconds?\n)?(?:Output:[ \t]*\n?)?/.exec(text);
  if (head) {
    if (head[1] === 'failed') failed = true;
    if (head[2]) wallMs = Math.round(Number(head[2]) * 1000);
    text = text.slice(head[0].length);
  }
  const trunc = /^Warning: truncated output \(original token count: (\d+)\)[^\n]*\n?/.exec(text);
  if (trunc) {
    truncatedTokens = Number(trunc[1]);
    text = text.slice(trunc[0].length);
  }
  return { text, failed, wallMs, truncatedTokens };
}

/** A result body, whether Codex sent a string, an envelope, or content parts. */
function outputText(out: unknown): string {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) {
    return out
      .map((x) => (typeof x === 'string' ? x : String((x as any)?.text ?? '')))
      .filter(Boolean)
      .join('');
  }
  return asText(out);
}

function reasoningText(p: any): string {
  if (Array.isArray(p.summary)) {
    return p.summary.map((s: any) => String(s?.text ?? s ?? '')).filter(Boolean).join('\n\n');
  }
  if (Array.isArray(p.content)) return messageText(p);
  return String(p.text ?? '');
}

function planOf(name: string, args: any): PlanArtifact | undefined {
  if (name !== 'update_plan') {
    return undefined;
  }
  const raw = Array.isArray(args?.plan) ? args.plan : Array.isArray(args?.steps) ? args.steps : null;
  if (!raw) {
    const text = String(args?.explanation ?? args?._raw ?? '');
    if (!text.trim()) return undefined;
    return { source: 'plan-tool', role: 'revision', approved: true, text, steps: extractSteps(text) };
  }
  const steps = raw.map((s: any, i: number) => ({
    id: String(s?.step ?? s?.id ?? i),
    text: String(s?.step ?? s?.text ?? s ?? ''),
    status:
      s?.status === 'completed' ? ('done' as const)
      : s?.status === 'in_progress' ? ('active' as const)
      : ('pending' as const),
  }));
  return {
    source: 'plan-tool',
    role: 'revision',
    approved: true,
    text: steps.map((s: { text: string }) => `- ${s.text}`).join('\n'),
    steps,
  };
}
