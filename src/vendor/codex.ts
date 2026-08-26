/**
 * Codex rollout adapter (experimental).
 *
 * Records are `{ timestamp, type: "response_item" | "event_msg" | "session_meta", payload }`.
 * The one genuinely tricky part is token accounting: Codex reports *cumulative*
 * totals, so per-request usage only exists as a difference, and a context reset
 * shows up as a negative delta that must be clamped rather than believed.
 */

import type { CanonSession, ImageRef, OpCategory, OpFacts, OpStatus, PlanArtifact } from '../model/canon.js';
import type { Calibration } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder, type EventSource } from './builder.js';
import {
  asText,
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

/** Codex writes the result body itself; there is nothing to rebuild. */
export function fullBody(rec: any, src: EventSource): string {
  const p = rec?.payload;
  if (!p) return asText(rec);
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
        this.usage(p);
        this.b.addSystem('token_count', '', ts, start, end);
        return;
      }
      if (p.type === 'patch_apply_end' && p.changes && typeof p.changes === 'object') {
        this.patch(p, ts, tsSource, start, end);
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

  private openCall(p: any, ts: number, tsSource: any, start: number, end: number): void {
    const name = String(p.name ?? p.action?.type ?? 'call');
    const args = parseArgs(p.arguments ?? p.input ?? p.action);
    const category = categoryOf(name);
    if (!CATEGORY[name]) this.b.countUnknownTool(name);

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

  private closeCall(p: any, ts: number, start: number, end: number): void {
    const callId = String(p.call_id ?? p.id ?? '');
    const idx = this.pending.get(callId);
    const out = p.output ?? p.result;
    let text = outputText(out);
    const context = text;
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
        `Codex: ${this.sealedReasoning} reasoning turns are stored encrypted and carry no readable text; ` +
          'their tokens are still counted in the reported usage.',
      );
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
