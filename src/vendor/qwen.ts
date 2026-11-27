/**
 * Qwen Code `.jsonl` adapter.
 *
 * A Claude-shaped envelope (uuid/parentUuid/sessionId/timestamp/cwd/version)
 * carrying a Gemini-shaped payload: `message.parts` with text, thought and
 * functionCall; tool results as their own `tool_result` record; usage reported
 * per assistant record in `usageMetadata`.
 *
 * Two facts the accounting rests on, both verified against real transcripts:
 * every assistant record is one API request (its usageMetadata is attached
 * once, never summed across records), and `promptTokenCount` already includes
 * `cachedContentTokenCount` while `candidatesTokenCount` includes thoughts.
 * The human is `provenance === 'real_user'`; the rest of the user side is
 * runtime-written context.
 */

import type {
  BodyFormat,
  CanonSession,
  ImageRef,
  OpCategory,
  OpFacts,
  OpStatus,
  PlanArtifact,
  TokenFacts,
} from '../model/canon.js';
import type { Calibration, ContentClass } from '../metrics/estimate.js';
import { CLASSES } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder, type EventSource } from './builder.js';
import { PLAN_FILE_RE } from './claude.js';
import {
  asText,
  type AskQuestion,
  basename,
  commandHead,
  countDiffLines,
  encodeAsk,
  extname,
  firstLine,
  hostOf,
  oneLine,
  shortPath,
  stripAnsi,
} from './text.js';

const CATEGORY: Record<string, OpCategory> = {
  read_file: 'read',
  glob: 'search',
  grep_search: 'search',
  tool_search: 'search',
  edit: 'edit',
  write_file: 'edit',
  notebook_edit: 'edit',
  run_shell_command: 'execute',
  web_fetch: 'web',
  web_search: 'web',
  enter_plan_mode: 'plan',
  exit_plan_mode: 'plan',
  ask_user_question: 'ask',
  agent: 'agent',
  create_sub_session: 'agent',
  skill: 'agent',
};

export function categoryOf(name: string): OpCategory {
  return CATEGORY[name] ?? 'other';
}

/** System subtypes that are bookkeeping, not news. Hidden behind the system toggle. */
const NOISE_SUBTYPES = new Set([
  'ui_telemetry',
  'file_history_snapshot',
  'attribution_snapshot',
  'memory_catalog_snapshot',
  'session_artifact_event',
  'branch_checkpoint',
  'session_source',
  'session_model',
  'session_approval_mode',
  'turn_result',
]);

export interface ToolBody {
  text: string;
  /**
   * What actually entered the model's context, when the row shows something
   * else: the shell wrapper around a command's output, the short confirmation
   * an edit answers with instead of its diff. Charging the display would bill
   * the reader's reconstruction, not the request.
   */
  costText?: string;
  format: BodyFormat;
  chips?: string[];
  status?: 'ok' | 'error' | 'interrupted';
  cls?: ContentClass;
  adds?: number;
  dels?: number;
  exitCode?: number;
}

/**
 * Build the readable body of a finished tool call. Qwen types its display
 * (`resultDisplay.type` for shell and ask, `fileDiff` for edits); whatever is
 * untyped falls back to the text the model was actually handed.
 */
export function toolBody(tcr: any, raw: string, questions?: AskQuestion[]): ToolBody {
  const chips: string[] = [];
  const rd = tcr?.resultDisplay;
  if (rd && typeof rd === 'object') {
    if (rd.type === 'shell_result') {
      const out = stripAnsi(String(rd.text ?? rd.output ?? ''));
      if (rd.truncated) chips.push('truncated');
      if (rd.signal) chips.push(`signal ${rd.signal}`);
      if (Array.isArray(rd.notices)) for (const n of rd.notices) chips.push(oneLine(asText(n), 60));
      const status = rd.signal ? 'interrupted' : tcr?.executionStatus === 'error' ? 'error' : 'ok';
      return {
        text: out || '(no output)',
        costText: raw || undefined,
        format: 'text',
        chips,
        status,
        cls: 'terminal',
        exitCode: typeof rd.exitCode === 'number' ? rd.exitCode : undefined,
      };
    }
    if (rd.type === 'ask_user_question_answers' && questions?.length) {
      const answers: Record<string, string> = {};
      for (const a of Array.isArray(rd.answers) ? rd.answers : []) {
        if (a?.question) answers[String(a.question)] = String(a.answer ?? '');
      }
      const answered = questions.filter((q) => answers[q.question]).length;
      chips.push(questions.length === 1 ? '1 question' : `${questions.length} questions`);
      if (answered < questions.length) chips.push(answered ? `${answered} answered` : 'unanswered');
      return {
        text: encodeAsk(questions, answers),
        costText: raw || undefined,
        format: 'ask',
        chips,
        status: answered ? 'ok' : 'interrupted',
        cls: 'prose',
      };
    }
    if (typeof rd.fileDiff === 'string' && rd.fileDiff) {
      const stat = rd.diffStat ?? {};
      const counts = countDiffLines(rd.fileDiff);
      const adds = typeof stat.model_added_lines === 'number' ? stat.model_added_lines : counts.adds;
      const dels = typeof stat.model_removed_lines === 'number' ? stat.model_removed_lines : counts.dels;
      if (adds) chips.push(`+${adds}`);
      if (dels) chips.push(`−${dels}`);
      if ((stat.user_added_lines ?? 0) > 0 || (stat.user_removed_lines ?? 0) > 0) chips.push('user modified');
      if (rd.truncatedForSession || rd.fileDiffTruncated) chips.push('truncated');
      return { text: rd.fileDiff, costText: raw || undefined, format: 'diff', chips, status: 'ok', cls: 'code', adds, dels };
    }
    if (typeof rd.text === 'string' && rd.text) {
      if (rd.truncated) chips.push('truncated');
      return {
        text: stripAnsi(rd.text),
        costText: raw && raw !== rd.text ? raw : undefined,
        format: 'text',
        chips,
        status: 'ok',
        cls: 'terminal',
      };
    }
  }
  if (raw) return { text: stripAnsi(raw), format: 'text', chips, status: 'ok', cls: 'terminal' };
  if (tcr && typeof tcr === 'object' && Object.keys(tcr).length) {
    return { text: asText(tcr), format: 'text', chips, status: 'ok', cls: 'json' };
  }
  return { text: '(no output)', format: 'text', chips, status: 'ok', cls: 'terminal' };
}

/** The text a tool_result handed back to the model, and the call it answers. */
function responseOf(rec: any): { raw: string; callId: string; images: ImageRef[]; block: number } {
  const tcr = rec?.toolCallResult ?? {};
  let callId = String(tcr.callId ?? '');
  let raw = '';
  let block = -1;
  const images: ImageRef[] = [];
  const parts = Array.isArray(rec?.message?.parts) ? rec.message.parts : [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p?.__img) images.push(p.__img as ImageRef);
    const fr = p?.functionResponse;
    if (!fr) continue;
    if (!callId && fr.id) callId = String(fr.id);
    const resp = fr.response ?? {};
    const out = typeof resp.output === 'string' ? resp.output : resp.output != null ? asText(resp.output) : '';
    const err = typeof resp.error === 'string' ? resp.error : '';
    const one = out || err;
    if (one) raw += (raw ? '\n' : '') + one;
    block = i;
  }
  return { raw, callId, images, block };
}

/**
 * Rebuild an event's untruncated body from its raw record. Used by the expand
 * path for bodies too large to keep in the worker's store.
 */
export function fullBody(rec: any, src: EventSource): string {
  if (rec?.type === 'tool_result') {
    const { raw } = responseOf(rec);
    return toolBody(rec?.toolCallResult ?? {}, raw).text;
  }
  const parts = rec?.message?.parts;
  if (src.block < 0 || !Array.isArray(parts)) return asText(rec?.systemPayload ?? rec);
  const p = parts[src.block];
  if (!p) return '';
  if (p.functionCall) return asText(p.functionCall.args);
  if (p.functionResponse) {
    const resp = p.functionResponse.response ?? {};
    const raw = typeof resp.output === 'string' ? resp.output : asText(resp.output ?? resp.error ?? '');
    return toolBody(rec?.toolCallResult ?? {}, raw).text;
  }
  return String(p.text ?? '');
}

function toolHead(name: string, args: any, cwd?: string): string {
  if (!args || typeof args !== 'object') return '';
  switch (name) {
    case 'run_shell_command':
      return firstLine(String(args.command ?? ''));
    case 'read_file':
    case 'edit':
    case 'write_file':
    case 'notebook_edit':
      return shortPath(args.file_path ?? args.notebook_path, cwd);
    case 'glob':
    case 'grep_search':
      return `${args.pattern ?? ''}${args.path ? ' in ' + shortPath(args.path, cwd) : ''}`;
    case 'tool_search':
      return String(args.query ?? '');
    case 'web_search':
      return String(args.query ?? '');
    case 'web_fetch':
      return String(args.url ?? '');
    case 'agent':
      return String(args.description ?? args.subagent_type ?? '');
    case 'create_sub_session':
      return String(args.name ?? args.prompt ?? '');
    case 'skill':
      return String(args.skill ?? '');
    case 'ask_user_question': {
      const qs = Array.isArray(args.questions) ? args.questions : [];
      const head = oneLine(String(qs[0]?.question ?? ''), 120);
      return qs.length > 1 ? `${head} (+${qs.length - 1} more)` : head;
    }
    case 'enter_plan_mode':
    case 'exit_plan_mode':
      return firstLine(String(args.plan ?? '').replace(/^#+\s*/, ''), 160);
    default:
      return oneLine(asText(args), 160);
  }
}

/** The command line an operation ran, whole — the head cannot stand for a heredoc. */
function commandOf(name: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  if (name !== 'run_shell_command') return undefined;
  const cmd = String(args.command ?? '').trim();
  return cmd || undefined;
}

function targetOf(name: string, args: any): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  switch (name) {
    case 'run_shell_command':
      return String(args.command ?? '') || undefined;
    case 'read_file':
    case 'edit':
    case 'write_file':
    case 'notebook_edit':
      return String(args.file_path ?? args.notebook_path ?? '') || undefined;
    case 'glob':
    case 'grep_search':
      return String(args.pattern ?? '') || undefined;
    case 'tool_search':
    case 'web_search':
      return String(args.query ?? '') || undefined;
    case 'web_fetch':
      return String(args.url ?? '') || undefined;
    case 'agent':
      return String(args.subagent_type ?? args.description ?? '') || undefined;
    case 'create_sub_session':
      return String(args.name ?? '') || undefined;
    case 'skill':
      return String(args.skill ?? '') || undefined;
    default:
      return undefined;
  }
}

/** The drill-down key: what you want a row to break down *into*. */
export function subgroupOf(name: string, category: OpCategory, target?: string): string | undefined {
  if (!target) return undefined;
  switch (category) {
    case 'execute':
      return commandHead(target);
    case 'read':
    case 'edit':
      return extname(target) || basename(target) || '(no extension)';
    case 'web':
      return name === 'web_fetch' ? hostOf(target) : 'query';
    case 'agent':
      return target;
    default:
      return undefined;
  }
}

const zero = () => new Array<number>(CLASSES.length).fill(0);
const CLASS_IDX: Record<ContentClass, number> = {
  prose: CLASSES.indexOf('prose'),
  code: CLASSES.indexOf('code'),
  json: CLASSES.indexOf('json'),
  terminal: CLASSES.indexOf('terminal'),
  path: CLASSES.indexOf('path'),
};

export class QwenAdapter {
  readonly b: Builder;

  private pending = new Map<string, number>(); // functionCall.id -> event index
  /** the questions an ask call posed, kept so its answers can be rendered */
  private asked = new Map<string, AskQuestion[]>();
  private curUsage: any = null;
  private outChars = zero();
  private inChars = zero();
  private requests = 0;
  /** the current request generated reasoning the transcript did not keep */
  private lossy = false;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'qwen', confidence, cal);
  }

  private chars(cls: ContentClass, n: number, into: number[]): void {
    into[CLASS_IDX[cls]] += n;
  }

  /** Close the calibration sample for one API request (one assistant record). */
  private flushSample(): void {
    if (this.curUsage) {
      const out = this.curUsage.candidatesTokenCount ?? 0;
      if (out > 0 && !this.lossy) this.b.samples.push({ chars: this.outChars, tokens: out, kind: 'out' });
      const fresh = (this.curUsage.promptTokenCount ?? 0) - (this.curUsage.cachedContentTokenCount ?? 0);
      // The first requests carry the system prompt and tool schemas, which are
      // not in the transcript at all — fitting against them would be nonsense.
      if (fresh > 0 && this.requests > 3) this.b.samples.push({ chars: this.inChars, tokens: fresh, kind: 'in' });
    }
    this.outChars = zero();
    this.inChars = zero();
    this.curUsage = null;
    this.lossy = false;
  }

  push(rec: any, start: number, end: number): void {
    this.b.info.lines++;
    const type = rec?.type;
    const raw = rec?.timestamp ? Date.parse(rec.timestamp) : 0;
    const { ts, tsSource } = this.b.stamp(Number.isFinite(raw) ? raw : 0);
    const info = this.b.info;

    if (rec?.cwd && !info.cwd) info.cwd = rec.cwd;
    if (rec?.gitBranch && !info.gitBranch) info.gitBranch = rec.gitBranch;
    if (rec?.version) info.version = rec.version;
    if (!info.sessionId && typeof rec?.sessionId === 'string') info.sessionId = rec.sessionId;
    if (rec?.uuid) {
      if (!info.firstUuid) info.firstUuid = rec.uuid;
      info.lastUuid = rec.uuid;
    }

    if (type === 'system') {
      this.system(rec, ts, start, end);
      return;
    }
    if (type === 'user') {
      this.user(rec, ts, tsSource, start, end);
      return;
    }
    if (type === 'assistant') {
      this.assistant(rec, ts, tsSource, start, end);
      return;
    }
    if (type === 'tool_result') {
      this.closeTool(rec, ts, start, end);
      return;
    }

    // Unknown record type: keep it, hidden behind the system toggle.
    const t = String(type ?? 'unknown');
    this.b.countType(t);
    this.b.addSystem(t, '', ts, start, end);
  }

  private system(rec: any, ts: number, start: number, end: number): void {
    const sub = String(rec?.subtype ?? 'system');
    const p = rec?.systemPayload ?? {};
    if (sub === 'session_model') {
      if (p.modelId) this.b.info.model = String(p.modelId);
      this.b.addSystem(sub, String(p.modelId ?? ''), ts, start, end);
      return;
    }
    if (sub === 'session_source') {
      this.b.addSystem(sub, String(p.sourceType ?? ''), ts, start, end);
      return;
    }
    if (sub === 'session_approval_mode') {
      this.b.addSystem(sub, String(p.mode ?? ''), ts, start, end);
      return;
    }
    if (sub === 'turn_result') {
      // promptText/resultText duplicate the timeline; only the verdict is news.
      const state = String(p.state ?? '');
      const stop = String(p.stopReason ?? '');
      const ms =
        typeof p.startedAt === 'number' && typeof p.endedAt === 'number' ? p.endedAt - p.startedAt : undefined;
      const subtitle = [state, stop, ms !== undefined ? `${(ms / 1000).toFixed(1)}s` : '']
        .filter(Boolean)
        .join(' · ');
      if (state && state !== 'completed') {
        this.b.add(
          {
            kind: 'error',
            ts,
            title: `turn ${state}`,
            subtitle: stop || undefined,
            text: subtitle,
            format: 'text',
            cls: 'json',
            collapsed: true,
            id: rec.uuid,
          },
          { start, end, block: -1 },
        );
      } else {
        this.b.addSystem('turn result', subtitle, ts, start, end);
      }
      return;
    }
    if (!NOISE_SUBTYPES.has(sub)) this.b.countType(`system:${sub}`);
    this.b.addSystem(sub, '', ts, start, end);
  }

  private user(rec: any, ts: number, tsSource: any, start: number, end: number): void {
    const info = this.b.info;
    if (!info.model && rec?.executionContext?.modelId) info.model = String(rec.executionContext.modelId);
    const isHuman = rec?.provenance === 'real_user';
    const parts = Array.isArray(rec?.message?.parts) ? rec.message.parts : [];
    const images: ImageRef[] = parts.filter((p: any) => p?.__img).map((p: any) => p.__img as ImageRef);
    let made = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const text = typeof p?.text === 'string' ? p.text : '';
      if (!text.trim()) continue;
      this.chars('prose', text.length, this.inChars);
      if (isHuman) this.b.openSegment(text, ts);
      this.b.add(
        {
          kind: isHuman ? 'prompt' : 'notice',
          ts,
          tsSource,
          title: isHuman ? 'You' : 'user message',
          text,
          format: 'md',
          cls: 'prose',
          images: made === 0 && images.length ? images : undefined,
          id: rec.uuid ? `${rec.uuid}:${i}` : undefined,
          parentId: rec.parentUuid,
        },
        { start, end, block: i },
      );
      made++;
    }
    if (!made && images.length) {
      if (isHuman) this.b.openSegment('(image)', ts);
      this.b.add(
        {
          kind: isHuman ? 'prompt' : 'notice',
          ts,
          tsSource,
          title: isHuman ? 'You' : 'image',
          text: '',
          format: 'text',
          images,
          id: rec.uuid,
          parentId: rec.parentUuid,
        },
        { start, end, block: -1 },
      );
    }
  }

  private assistant(rec: any, ts: number, tsSource: any, start: number, end: number): void {
    // Each assistant record is one request: close the previous sample first.
    this.flushSample();
    const info = this.b.info;
    if (rec?.model) info.model = String(rec.model);
    const um = rec?.usageMetadata;
    this.curUsage = um ?? null;
    let reported: TokenFacts['reported'] | undefined;
    if (um) {
      this.requests++;
      const prompt = um.promptTokenCount ?? 0;
      const cached = um.cachedContentTokenCount ?? 0;
      reported = {
        input: Math.max(0, prompt - cached),
        cacheWrite: 0,
        cacheRead: cached,
        output: um.candidatesTokenCount ?? 0,
        reasoning: um.thoughtsTokenCount ?? 0,
      };
    }

    const parts = Array.isArray(rec?.message?.parts) ? rec.message.parts : [];
    const images: ImageRef[] = parts.filter((p: any) => p?.__img).map((p: any) => p.__img as ImageRef);
    const firstIdx = this.b.events.length;
    let made = 0;
    let thoughtText = false;

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p?.thought) {
        const text = String(p.text ?? '');
        if (!text.trim()) {
          this.lossy = true;
          this.b.addSystem('thinking', 'not stored in this transcript', ts, start, end);
          continue;
        }
        thoughtText = true;
        this.chars('prose', text.length, this.outChars);
        this.b.add(
          {
            kind: 'reasoning',
            ts,
            tsSource,
            title: 'thinking',
            subtitle: oneLine(text, 120),
            text,
            format: 'md',
            cls: 'prose',
            collapsed: true,
            id: rec.uuid ? `${rec.uuid}:${i}` : undefined,
          },
          { start, end, block: i },
        );
        made++;
      } else if (typeof p?.text === 'string' && p.text.trim()) {
        const text = p.text;
        this.chars('prose', text.length, this.outChars);
        this.b.add(
          {
            kind: 'text',
            ts,
            tsSource,
            title: 'Qwen',
            text,
            format: 'md',
            cls: 'prose',
            images: made === 0 && images.length ? images : undefined,
            id: rec.uuid ? `${rec.uuid}:${i}` : undefined,
          },
          { start, end, block: i },
        );
        made++;
      } else if (p?.functionCall) {
        this.openTool(rec, p.functionCall, start, end, i, ts, tsSource);
        made++;
      }
    }

    // Reasoning billed but not persisted: this request's output cannot be
    // explained by the file, so calibrating against it would teach a lie.
    if (um && (um.thoughtsTokenCount ?? 0) > 0 && !thoughtText) this.lossy = true;

    if (reported) {
      if (made) {
        this.b.events[firstIdx].tokens.reported = reported;
      } else {
        // A request that produced nothing renderable still cost tokens.
        this.b.addSystem('request', 'usage only', ts, start, end);
        this.b.events[this.b.events.length - 1].tokens.reported = reported;
      }
    }
  }

  private openTool(
    rec: any,
    fc: any,
    start: number,
    end: number,
    blockIdx: number,
    ts: number,
    tsSource: any,
  ): void {
    const name = String(fc?.name ?? 'tool');
    const args = fc?.args ?? {};
    // tool_call wraps a deferred tool: the real operation is its argument, and
    // the category/target must describe that operation, not the wrapper.
    const inner = name === 'tool_call' && typeof args?.name === 'string' ? String(args.name) : name;
    const innerArgs = name === 'tool_call' ? (args?.arguments ?? {}) : args;
    const category = categoryOf(inner);
    if (!CATEGORY[inner]) this.b.countUnknownTool(inner);

    const json = asText(args);
    this.chars('json', json.length, this.outChars);
    let text = json;
    let format: BodyFormat = 'text';
    let cls: ContentClass = 'json';
    if (inner === 'ask_user_question' && Array.isArray(innerArgs?.questions)) {
      text = encodeAsk(innerArgs.questions, undefined);
      format = 'ask';
      cls = 'prose';
      if (fc?.id) this.asked.set(String(fc.id), innerArgs.questions);
    }
    const target = targetOf(inner, innerArgs);
    const head = toolHead(inner, innerArgs, this.b.info.cwd);
    const op: OpFacts = {
      name,
      category,
      target,
      subgroup: subgroupOf(inner, category, target),
      command: commandOf(inner, innerArgs),
      status: 'unpaired',
    };

    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle: inner !== name ? `${inner} · ${head}` : head,
        text,
        format,
        cls,
        collapsed: true,
        op,
        chips: inner !== name ? [inner] : undefined,
        payloadIn: this.b.est(json, 'json'),
        id: fc?.id ? String(fc.id) : rec.uuid,
      },
      { start, end, block: blockIdx, tool: inner },
    );

    const plan = this.planOf(inner, innerArgs);
    if (plan) this.b.events[idx].plan = plan;
    if (fc?.id) this.pending.set(String(fc.id), idx);
  }

  /** Recognize the ways a Qwen session can express a plan. */
  private planOf(name: string, args: any): PlanArtifact | undefined {
    if (name === 'enter_plan_mode') {
      return { source: 'plan-mode', role: 'start', approved: false, text: '', steps: [] };
    }
    if (name === 'exit_plan_mode') {
      const text = String(args?.plan ?? '');
      return { source: 'plan-mode', role: 'revision', approved: false, text, steps: extractSteps(text) };
    }
    if (name === 'write_file' || name === 'edit') {
      const path = String(args?.file_path ?? '');
      if (!path || !PLAN_FILE_RE.test(path)) return undefined;
      // A write carries the whole document; an edit only the fragment it
      // replaced, so its revision is flagged partial rather than pretending
      // the fragment is the plan.
      const whole = name === 'write_file';
      const text = String(whole ? (args?.content ?? '') : (args?.new_string ?? ''));
      if (!text.trim()) return undefined;
      return {
        source: 'file',
        role: 'revision',
        approved: true,
        path,
        text,
        steps: extractSteps(text),
        partial: !whole,
      };
    }
    return undefined;
  }

  /** Attach a tool_result to the event created by its functionCall. */
  private closeTool(rec: any, ts: number, start: number, end: number): void {
    const tcr = rec?.toolCallResult ?? {};
    const { raw, callId, images, block } = responseOf(rec);
    const idx = this.pending.get(callId);

    if (idx === undefined) {
      // Orphan result (no matching functionCall in this file) — show it standalone.
      this.b.quality.orphanResults++;
      this.chars('terminal', raw.length, this.inChars);
      this.b.add(
        {
          kind: 'notice',
          ts,
          title: 'orphan result',
          text: raw,
          format: 'text',
          cls: 'terminal',
          images,
          collapsed: true,
          id: rec.uuid,
        },
        { start, end, block },
      );
      return;
    }
    this.pending.delete(callId);

    const ev = this.b.events[idx];
    const body = toolBody(tcr, raw, this.asked.get(callId));
    this.asked.delete(callId);
    const isErr = tcr?.executionStatus === 'error' || tcr?.status === 'error' || !!tcr?.error;
    const status: OpStatus = isErr ? 'error' : (body.status ?? 'ok');
    const cost = body.costText ?? body.text;
    const costCls = body.costText != null ? 'terminal' : (body.cls ?? 'terminal');
    this.chars(costCls, cost.length, this.inChars);
    let payloadOut = body.costText != null ? this.b.est(cost, costCls) : undefined;

    // A declined question answers with a notice, not with answers. Keeping the
    // options on screen says more than the notice does — but the notice is still
    // what the context paid for, so the estimate is taken before the swap.
    if (ev.format === 'ask' && body.format !== 'ask') {
      payloadOut = this.b.est(body.text, body.cls ?? 'terminal');
      body.text = ev.body;
      body.format = 'ask';
      body.cls = 'prose';
      body.chips = [...(body.chips ?? []), 'declined'];
    }

    this.b.close(
      idx,
      {
        text: body.text,
        format: body.format,
        cls: body.cls,
        chips: body.chips,
        images,
        status,
        exitCode: body.exitCode,
        linesAdded: body.adds,
        linesRemoved: body.dels,
        ts,
        payloadOut,
      },
      { start, end, block },
    );

    // Plan mode approval is only knowable from the result of the exit call.
    if (ev.plan?.source === 'plan-mode' && ev.plan.role === 'revision') {
      const approved = !isErr && !/rejected|not approve|keep planning|declined/i.test(raw);
      ev.plan = { ...ev.plan, approved };
    }
  }

  finish(parseMs: number): CanonSession {
    this.flushSample();
    for (const idx of this.pending.values()) {
      const op = this.b.events[idx]?.op;
      if (op) op.status = 'unpaired';
    }
    return this.b.finish(parseMs);
  }
}
