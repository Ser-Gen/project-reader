/**
 * Codex rollout adapter (experimental).
 *
 * Records are `{ timestamp, type: "response_item" | "event_msg" | "session_meta", payload }`.
 * The one genuinely tricky part is token accounting: Codex reports *cumulative*
 * totals, so per-request usage only exists as a difference, and a context reset
 * shows up as a negative delta that must be clamped rather than believed.
 */

import type { CanonSession, OpCategory, OpFacts, OpStatus, PlanArtifact } from '../model/canon.js';
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
  if (src.block === 1) return asText(p.output ?? p.result ?? p);
  if (typeof p.text === 'string') return p.text;
  if (Array.isArray(p.content)) {
    return p.content.map((c: any) => String(c?.text ?? '')).filter(Boolean).join('\n');
  }
  return asText(p.arguments ?? p);
}

export class CodexAdapter {
  readonly b: Builder;
  private pending = new Map<string, number>();
  private totals = { input: 0, cached: 0, output: 0, reasoning: 0 };
  private lastEventIdx = -1;
  private sawResponseItems = false;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'codex', confidence, cal);
    this.b.note('Codex: durations are derived from record timestamps; per-call timings are not reported.');
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
        const text = messageText(p);
        if (!text.trim()) return;
        const human = p.role === 'user';
        if (human) this.b.openSegment(text, ts);
        this.lastEventIdx = this.b.add(
          {
            kind: human ? 'prompt' : 'text',
            ts,
            tsSource,
            title: human ? 'You' : 'Codex',
            text,
            format: 'md',
            cls: 'prose',
            id: p.id,
          },
          { start, end, block: 0 },
        );
        return;
      }
      case 'reasoning': {
        const text = reasoningText(p);
        if (!text.trim()) return;
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

  private openCall(p: any, ts: number, tsSource: any, start: number, end: number): void {
    const name = String(p.name ?? p.action?.type ?? 'call');
    const args = parseArgs(p.arguments ?? p.input ?? p.action);
    const category = categoryOf(name);
    if (!CATEGORY[name]) this.b.countUnknownTool(name);
    const target = targetOf(args);
    const text = asText(args);
    const op: OpFacts = {
      name,
      category,
      target,
      subgroup: subgroupOf(category, target),
      status: 'unpaired',
    };
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle: callHead(args, this.b.info.cwd),
        text,
        format: 'text',
        cls: 'json',
        collapsed: true,
        op,
        payloadIn: this.b.est(text, 'json'),
        id: p.call_id ?? p.id,
      },
      { start, end, block: 0, tool: name },
    );
    this.lastEventIdx = idx;

    const plan = planOf(name, args);
    if (plan) this.b.events[idx].plan = plan;
    const callId = p.call_id ?? p.id;
    if (callId) this.pending.set(String(callId), idx);
  }

  private closeCall(p: any, ts: number, start: number, end: number): void {
    const callId = String(p.call_id ?? p.id ?? '');
    const idx = this.pending.get(callId);
    const out = p.output ?? p.result;
    let text = typeof out === 'string' ? out : asText(out);
    let exitCode: number | undefined;
    let status: OpStatus = 'ok';
    let durationMs: number | undefined;

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
    this.b.close(
      idx,
      {
        text,
        format: isPatch && /^[-+@]/m.test(text) ? 'diff' : 'text',
        cls: isPatch ? 'code' : 'terminal',
        status,
        exitCode,
        linesAdded: diff?.adds,
        linesRemoved: diff?.dels,
        ts,
        durationMs,
      },
      { start, end, block: 1 },
    );
    this.lastEventIdx = idx;
  }

  finish(parseMs: number): CanonSession {
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

function messageText(p: any): string {
  if (typeof p.text === 'string') return p.text;
  if (typeof p.content === 'string') return p.content;
  if (Array.isArray(p.content)) {
    return p.content
      .map((c: any) => (typeof c === 'string' ? c : String(c?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
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
