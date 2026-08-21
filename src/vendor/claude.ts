/**
 * Claude Code `.jsonl` adapter — the reference implementation.
 *
 * This is the only format where every number the analyzer reports can be checked
 * against something the vendor recorded, so it is also where the token estimator
 * gets calibrated (SPEC §5.4).
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
import type { Calibration, ContentClass } from '../metrics/estimate.js';
import { CLASSES } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder, type EventSource } from './builder.js';
import {
  asText,
  type AskQuestion,
  basename,
  commandHead,
  encodeAsk,
  extname,
  firstLine,
  hostOf,
  oneLine,
  patchToDiff,
  shortPath,
  stripAnsi,
} from './text.js';

const NOISE_TYPES = new Set([
  'queue-operation',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'ai-title',
  'mode',
]);
const NOISE_ATTACHMENTS = new Set([
  'todo_reminder',
  'deferred_tools_delta',
  'agent_listing_delta',
  'skill_listing',
  'plan_mode',
  'plan_mode_exit',
  'selected_lines_in_ide',
  'opened_file_in_ide',
]);

const CATEGORY: Record<string, OpCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  Glob: 'search',
  Grep: 'search',
  ToolSearch: 'search',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  MultiEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  WebSearch: 'web',
  WebFetch: 'web',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  TodoWrite: 'plan',
  AskUserQuestion: 'ask',
  Task: 'agent',
  Agent: 'agent',
  Skill: 'agent',
};

/** Files an agent writes when it is writing down a plan. */
export const PLAN_FILE_RE = /(^|\/)(PLAN|SPEC|DESIGN|TODO|ROADMAP)([\w-]*)?\.md$|\.plan\.md$/i;

export function categoryOf(name: string): OpCategory {
  return CATEGORY[name] ?? 'other';
}

export interface ToolBody {
  text: string;
  /**
   * What actually entered the model's context, when the row shows something
   * else. The options and their descriptions travelled in the *call*; echoing
   * them back into the result's cost would count them twice.
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

/** Build the readable body of a finished tool call from its structured result. */
export function toolBody(name: string, input: any, tur: any, raw: string): ToolBody {
  const chips: string[] = [];

  switch (name) {
    case 'Bash': {
      if (tur && typeof tur === 'object') {
        const out = stripAnsi(String(tur.stdout ?? ''));
        const err = stripAnsi(String(tur.stderr ?? ''));
        let text = out;
        if (err.trim()) text += (text ? '\n' : '') + err;
        if (tur.interrupted) chips.push('interrupted');
        if (tur.returnCodeInterpretation) chips.push(String(tur.returnCodeInterpretation));
        const status = tur.interrupted ? 'interrupted' : err.trim() && !out.trim() ? 'error' : 'ok';
        return {
          text: text || '(no output)',
          format: 'text',
          chips,
          status,
          cls: 'terminal',
          exitCode: typeof tur.returnCode === 'number' ? tur.returnCode : undefined,
        };
      }
      break;
    }
    case 'Read': {
      const f = tur?.file;
      if (f) {
        if (f.numLines) chips.push(`${f.numLines} lines`);
        if (f.totalLines && f.totalLines !== f.numLines) chips.push(`of ${f.totalLines}`);
        return { text: String(f.content ?? ''), format: 'text', chips, status: 'ok', cls: 'code' };
      }
      break;
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (tur?.structuredPatch) {
        const d = patchToDiff(tur.structuredPatch);
        if (d.adds) chips.push(`+${d.adds}`);
        if (d.dels) chips.push(`−${d.dels}`);
        if (tur.userModified) chips.push('user modified');
        if (d.text) {
          return { text: d.text, format: 'diff', chips, status: 'ok', cls: 'code', adds: d.adds, dels: d.dels };
        }
      }
      if (typeof tur?.content === 'string') {
        const lines = tur.content ? tur.content.split('\n').length : 0;
        return { text: tur.content, format: 'text', chips, status: 'ok', cls: 'code', adds: lines, dels: 0 };
      }
      break;
    }
    case 'WebSearch': {
      if (tur?.results) {
        const lines: string[] = [];
        let n = 0;
        const walk = (r: any) => {
          if (typeof r === 'string') {
            lines.push(r);
          } else if (Array.isArray(r)) {
            r.forEach(walk);
          } else if (r && typeof r === 'object') {
            if (r.url) {
              n++;
              lines.push(`- [${r.title ?? r.url}](${r.url})`);
            } else if (r.content) walk(r.content);
          }
        };
        walk(tur.results);
        if (n) chips.push(`${n} results`);
        if (tur.durationSeconds) chips.push(`${Number(tur.durationSeconds).toFixed(1)}s`);
        return { text: lines.join('\n'), format: 'md', chips, status: 'ok', cls: 'prose' };
      }
      break;
    }
    case 'WebFetch': {
      if (tur && typeof tur === 'object' && (tur.result || tur.url)) {
        if (tur.code) chips.push(`HTTP ${tur.code}`);
        if (tur.bytes) chips.push(`${Math.round(tur.bytes / 1024)} KB`);
        if (tur.durationMs) chips.push(`${Math.round(tur.durationMs)}ms`);
        return {
          text: String(tur.result ?? ''),
          format: 'md',
          chips,
          status: tur.code && tur.code >= 400 ? 'error' : 'ok',
          cls: 'prose',
        };
      }
      break;
    }
    case 'TodoWrite': {
      if (tur?.newTodos) {
        const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
        const text = (tur.newTodos as any[])
          .map((t) => `${mark[t.status] ?? '[ ]'} ${t.content}`)
          .join('\n');
        const done = (tur.newTodos as any[]).filter((t) => t.status === 'completed').length;
        chips.push(`${done}/${tur.newTodos.length} done`);
        return { text, format: 'text', chips, status: 'ok', cls: 'prose' };
      }
      break;
    }
    case 'AskUserQuestion': {
      // The result echoes the questions back with the answers filled in. A call
      // that was declined carries no questions at all — `openTool` already put
      // them on screen, and the result handler keeps them there.
      const asked = tur?.questions as AskQuestion[] | undefined;
      if (Array.isArray(asked) && asked.length) {
        const answers = tur?.answers as Record<string, string> | undefined;
        const answered = asked.filter((q) => answers?.[q?.question]).length;
        chips.push(asked.length === 1 ? '1 question' : `${asked.length} questions`);
        if (answered < asked.length) chips.push(answered ? `${answered} answered` : 'unanswered');
        return {
          text: encodeAsk(asked, answers),
          costText: raw,
          format: 'ask',
          chips,
          status: answered ? 'ok' : 'interrupted',
          cls: 'prose',
        };
      }
      break;
    }
    case 'ExitPlanMode':
    case 'EnterPlanMode': {
      if (typeof tur?.plan === 'string') {
        return { text: tur.plan, format: 'md', chips, status: 'ok', cls: 'prose' };
      }
      break;
    }
    case 'ToolSearch': {
      if (tur?.matches) {
        chips.push(`${tur.matches.length} tools`);
        return { text: (tur.matches as string[]).join(', '), format: 'text', chips, status: 'ok', cls: 'path' };
      }
      break;
    }
    default:
      break;
  }

  // Fallbacks: the raw tool_result text, else the structured result, else the input.
  if (raw) return { text: stripAnsi(raw), format: 'text', chips, status: 'ok', cls: 'terminal' };
  if (tur != null) return { text: asText(tur), format: 'text', chips, status: 'ok', cls: 'json' };
  return { text: asText(input), format: 'text', chips, status: 'ok', cls: 'json' };
}

/**
 * Rebuild an event's untruncated body from its raw record. Used by the expand
 * path for bodies too large to keep in the worker's store.
 */
export function fullBody(rec: any, src: EventSource): string {
  const content = rec?.message?.content;
  if (src.block < 0 || !Array.isArray(content)) return asText(rec?.error ?? rec?.attachment ?? rec);
  const b = content[src.block];
  if (!b) return '';
  switch (b.type) {
    case 'text':
      return String(b.text ?? '');
    case 'thinking':
      return String(b.thinking ?? b.text ?? '');
    case 'tool_use':
      return asText(b.input);
    case 'tool_result': {
      let raw = '';
      if (typeof b.content === 'string') raw = b.content;
      else if (Array.isArray(b.content)) {
        for (const part of b.content) {
          if (part?.type === 'text') raw += (raw ? '\n' : '') + String(part.text ?? '');
          else if (part?.type === 'tool_reference') raw += (raw ? '\n' : '') + `→ ${part.tool_name}`;
        }
      }
      return toolBody(src.tool ?? '', undefined, rec?.toolUseResult, raw).text;
    }
    default:
      return '';
  }
}

function toolHead(name: string, input: any, cwd?: string): string {
  if (!input || typeof input !== 'object') return '';
  switch (name) {
    case 'Bash':
      return firstLine(String(input.command ?? ''));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shortPath(input.file_path ?? input.notebook_path, cwd);
    case 'Glob':
    case 'Grep':
      return `${input.pattern ?? ''}${input.path ? ' in ' + shortPath(input.path, cwd) : ''}`;
    case 'WebSearch':
      return String(input.query ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'Task':
    case 'Agent':
      return String(input.description ?? input.subagent_type ?? '');
    case 'Skill':
      return String(input.skill ?? '');
    case 'TodoWrite':
      return `${(input.todos ?? []).length} items`;
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const head = oneLine(String(qs[0]?.question ?? ''), 120);
      return qs.length > 1 ? `${head} (+${qs.length - 1} more)` : head;
    }
    case 'ExitPlanMode':
    case 'EnterPlanMode':
      return firstLine(String(input.plan ?? '').replace(/^#+\s*/, ''), 160);
    default:
      return oneLine(asText(input), 160);
  }
}

function targetOf(name: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  switch (name) {
    case 'Bash':
      return String(input.command ?? '') || undefined;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return String(input.file_path ?? input.notebook_path ?? '') || undefined;
    case 'Glob':
    case 'Grep':
      return String(input.pattern ?? '') || undefined;
    case 'WebSearch':
      return String(input.query ?? '') || undefined;
    case 'WebFetch':
      return String(input.url ?? '') || undefined;
    case 'Task':
    case 'Agent':
      return String(input.subagent_type ?? input.description ?? '') || undefined;
    case 'Skill':
      return String(input.skill ?? '') || undefined;
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
      return name === 'WebFetch' ? hostOf(target) : 'query';
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

export class ClaudeAdapter {
  readonly b: Builder;

  private pending = new Map<string, number>(); // tool_use_id -> event index
  private lastAssistantId: string | null = null;
  private curMsgId: string | null = null;
  private curUsage: any = null;
  private outChars = zero();
  private inChars = zero();
  private requests = 0;
  /** the current request generated content the transcript did not keep */
  private lossy = false;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'claude', confidence, cal);
  }

  private chars(cls: ContentClass, n: number, into: number[]): void {
    into[CLASS_IDX[cls]] += n;
  }

  /** Close the calibration sample for one API request. */
  private flushSample(): void {
    if (this.curUsage) {
      const out = this.curUsage.output_tokens ?? 0;
      // A request whose reasoning was not persisted generated tokens this file
      // cannot see; calibrating against it would teach the estimator a lie.
      if (out > 0 && !this.lossy) this.b.samples.push({ chars: this.outChars, tokens: out, kind: 'out' });
      const fresh = (this.curUsage.input_tokens ?? 0) + (this.curUsage.cache_creation_input_tokens ?? 0);
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
    if (rec?.sessionId && !info.sessionId) info.sessionId = rec.sessionId;
    if (rec?.uuid) {
      if (!info.firstUuid) info.firstUuid = rec.uuid;
      info.lastUuid = rec.uuid;
    }
    if (type === 'ai-title' && rec.aiTitle) info.title = rec.aiTitle;

    if (NOISE_TYPES.has(type)) {
      this.b.addSystem(
        type,
        firstLine(asText(rec.aiTitle ?? rec.operation ?? rec.mode ?? rec.trackingPath ?? '')),
        ts,
        start,
        end,
      );
      return;
    }

    if (type === 'attachment') {
      const at = rec.attachment?.type ?? 'attachment';
      if (NOISE_ATTACHMENTS.has(at)) {
        this.b.addSystem(at, '', ts, start, end);
        return;
      }
      const text = asText(rec.attachment?.content ?? rec.attachment?.filename ?? rec.attachment);
      this.chars('code', text.length, this.inChars);
      this.b.add(
        {
          kind: 'notice',
          ts,
          tsSource,
          title: at.replace(/_/g, ' '),
          subtitle: shortPath(rec.attachment?.filename ?? rec.attachment?.path, info.cwd),
          text,
          format: 'text',
          cls: 'code',
          collapsed: true,
          id: rec.uuid,
        },
        { start, end, block: -1 },
      );
      return;
    }

    if (type === 'system') {
      const msg = rec.error?.formatted ?? rec.error?.message ?? rec.subtype ?? 'system';
      const text = asText(rec.error ?? rec);
      this.b.add(
        {
          kind: 'error',
          ts,
          tsSource,
          title: String(rec.subtype ?? 'system'),
          subtitle: firstLine(String(msg)),
          text,
          format: 'text',
          cls: 'json',
          collapsed: true,
          id: rec.uuid,
        },
        { start, end, block: -1 },
      );
      return;
    }

    const msg = rec?.message;
    const content = msg?.content;
    const sidechain = rec?.isSidechain === true ? 1 : 0;

    if (type === 'user' || type === 'summary') {
      if (rec.isCompactSummary || type === 'summary') {
        const text = typeof content === 'string' ? content : asText(rec.summary ?? content);
        if (rec.leafUuid) (info.compactRefs ??= []).push(String(rec.leafUuid));
        if (this.b.events.length === 0) info.startsCompacted = true;
        this.b.add(
          {
            kind: 'compaction',
            ts,
            tsSource,
            title: 'context compacted',
            subtitle: text ? oneLine(text, 100) : undefined,
            text,
            format: 'md',
            cls: 'prose',
            collapsed: true,
            id: rec.uuid,
          },
          { start, end, block: -1 },
        );
        return;
      }
      const blocks = Array.isArray(content)
        ? content
        : typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : [];
      const isHuman =
        rec.origin?.kind === 'human' ||
        rec.promptSource === 'sdk' ||
        (!!rec.promptId && blocks.some((x: any) => x?.type === 'text'));

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b?.type === 'text') {
          const text = String(b.text ?? '');
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
              sidechain,
              id: rec.uuid,
              parentId: rec.parentUuid,
            },
            { start, end, block: i },
          );
        } else if (b?.type === 'tool_result') {
          this.closeTool(rec, b, start, end, i, ts);
        }
      }
      return;
    }

    if (type === 'assistant') {
      if (msg?.model) info.model = msg.model;
      const usage = msg?.usage;
      const msgId = msg?.id ?? null;
      if (msgId !== this.curMsgId) {
        this.flushSample();
        this.curMsgId = msgId;
        this.curUsage = usage ?? null;
      }
      let reported: { input: number; cacheWrite: number; cacheRead: number; output: number } | undefined;
      if (usage && msgId !== this.lastAssistantId) {
        this.lastAssistantId = msgId;
        this.requests++;
        reported = {
          input: usage.input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
        };
      }

      const blocks = Array.isArray(content) ? content : [];
      const firstIdx = this.b.events.length;
      let made = 0;

      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b?.type === 'text') {
          const text = String(b.text ?? '');
          if (!text.trim()) continue;
          this.chars('prose', text.length, this.outChars);
          this.b.add(
            {
              kind: 'text',
              ts,
              tsSource,
              title: 'Claude',
              text,
              format: 'md',
              cls: 'prose',
              sidechain,
              id: rec.uuid ? `${rec.uuid}:${i}` : undefined,
              parentId: msgId ?? undefined,
            },
            { start, end, block: i },
          );
          made++;
        } else if (b?.type === 'thinking') {
          const text = String(b.thinking ?? b.text ?? '');
          if (!text.trim()) {
            // Signature-only block: the reasoning text was not persisted, so
            // this request's output tokens cannot be explained by the file.
            this.lossy = true;
            this.b.addSystem('thinking', 'not stored in this transcript', ts, start, end);
            continue;
          }
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
              sidechain,
              id: rec.uuid ? `${rec.uuid}:${i}` : undefined,
              parentId: msgId ?? undefined,
            },
            { start, end, block: i },
          );
          made++;
        } else if (b?.type === 'tool_use') {
          this.openTool(rec, b, start, end, i, ts, tsSource, sidechain, msgId);
          made++;
        }
      }

      if (reported) {
        if (made) {
          this.b.events[firstIdx].tokens.reported = reported;
        } else {
          // A request that produced nothing renderable still cost tokens.
          this.b.addSystem('request', 'usage only', ts, start, end);
          this.b.events[this.b.events.length - 1].tokens.reported = reported;
        }
      }
      return;
    }

    // Unknown record type: keep it, hidden behind the system toggle.
    const t = String(type ?? 'unknown');
    this.b.countType(t);
    this.b.addSystem(t, '', ts, start, end);
  }

  private openTool(
    rec: any,
    block: any,
    start: number,
    end: number,
    blockIdx: number,
    ts: number,
    tsSource: any,
    sidechain: number,
    msgId: string | null,
  ): void {
    const name = String(block.name ?? 'tool');
    const category = categoryOf(name);
    if (!CATEGORY[name]) this.b.countUnknownTool(name);
    const input = block.input;
    const json = asText(input);
    // Estimation and calibration both describe what the model actually emitted,
    // which is the JSON — even when the row shows something friendlier.
    this.chars('json', json.length, this.outChars);
    let text = json;
    let format: BodyFormat = 'text';
    let cls: ContentClass = 'json';
    if (name === 'AskUserQuestion' && Array.isArray(input?.questions)) {
      text = encodeAsk(input.questions, undefined);
      format = 'ask';
      cls = 'prose';
    }
    const target = targetOf(name, input);
    const op: OpFacts = {
      name,
      category,
      target,
      subgroup: subgroupOf(name, category, target),
      status: 'unpaired',
    };

    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle: toolHead(name, input, this.b.info.cwd),
        text,
        format,
        cls,
        collapsed: true,
        op,
        payloadIn: this.b.est(json, 'json'),
        sidechain,
        id: block.id ? String(block.id) : rec.uuid,
        parentId: msgId ?? undefined,
      },
      { start, end, block: blockIdx, tool: name },
    );

    const plan = this.planOf(name, input);
    if (plan) this.b.events[idx].plan = plan;
    if (block.id) this.pending.set(String(block.id), idx);
  }

  /** Recognize the three ways a Claude session can express a plan. */
  private planOf(name: string, input: any): PlanArtifact | undefined {
    if (name === 'EnterPlanMode') {
      return { source: 'plan-mode', role: 'start', approved: false, text: '', steps: [] };
    }
    if (name === 'ExitPlanMode') {
      const text = String(input?.plan ?? '');
      return { source: 'plan-mode', role: 'revision', approved: false, text, steps: extractSteps(text) };
    }
    if (name === 'TodoWrite') {
      const todos = Array.isArray(input?.todos) ? input.todos : [];
      if (!todos.length) return undefined;
      const steps = todos.map((t: any, i: number) => ({
        id: String(t.id ?? t.content ?? i),
        text: String(t.content ?? t.activeForm ?? ''),
        status:
          t.status === 'completed' ? ('done' as const)
          : t.status === 'in_progress' ? ('active' as const)
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
    if (name === 'Write' || name === 'Edit') {
      const path = String(input?.file_path ?? '');
      if (!path || !PLAN_FILE_RE.test(path)) return undefined;
      // A Write carries the whole document; an Edit only carries the fragment it
      // replaced, so its revision is flagged partial and diffed as one change
      // rather than pretending the fragment is the plan.
      const whole = name === 'Write';
      const text = String(whole ? (input?.content ?? '') : (input?.new_string ?? ''));
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

  /** Attach a tool_result to the event created by its tool_use. */
  private closeTool(rec: any, block: any, start: number, end: number, blockIdx: number, ts: number): void {
    const id = String(block.tool_use_id ?? '');
    const idx = this.pending.get(id);
    const images: ImageRef[] = [];
    let raw = '';

    const cc = block.content;
    if (typeof cc === 'string') raw = cc;
    else if (Array.isArray(cc)) {
      for (const part of cc) {
        if (part?.type === 'text') raw += (raw ? '\n' : '') + String(part.text ?? '');
        else if (part?.type === 'image' && part.__img) images.push(part.__img as ImageRef);
        else if (part?.type === 'tool_reference') raw += (raw ? '\n' : '') + `→ ${part.tool_name}`;
      }
    }

    if (idx === undefined) {
      // Orphan result (no matching tool_use in this file) — show it standalone.
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
        { start, end, block: blockIdx },
      );
      return;
    }
    this.pending.delete(id);

    const ev = this.b.events[idx];
    const body = toolBody(ev.op?.name ?? '', undefined, rec?.toolUseResult, raw);
    const isErr = block.is_error === true;
    const status: OpStatus = isErr ? 'error' : (body.status ?? 'ok');
    const cost = body.costText ?? body.text;
    const costCls = body.costText != null ? 'terminal' : (body.cls ?? 'terminal');
    this.chars(costCls, cost.length, this.inChars);
    let payloadOut = body.costText != null ? this.b.est(cost, costCls) : undefined;

    // A declined question answers with a notice, not with questions. Keeping the
    // options on screen says more than the notice does: these were the choices,
    // and the human walked away — but the notice is still what the context paid
    // for, so the estimate is taken before the body is swapped.
    if (ev.format === 'ask' && body.format !== 'ask') {
      payloadOut = this.b.est(body.text, body.cls ?? 'terminal');
      body.text = ev.body;
      body.format = 'ask';
      body.cls = 'prose';
      body.chips = [...(body.chips ?? []), 'declined'];
    }

    const tur = rec?.toolUseResult;
    const reportedMs =
      typeof tur?.durationMs === 'number' ? tur.durationMs
      : typeof tur?.durationSeconds === 'number' ? tur.durationSeconds * 1000
      : undefined;

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
        durationMs: reportedMs,
        payloadOut,
      },
      { start, end, block: blockIdx },
    );

    // Plan mode approval is only knowable from the result of the exit call.
    if (ev.plan?.source === 'plan-mode' && ev.plan.role === 'revision') {
      const approved = !isErr && !/rejected|not approve|keep planning/i.test(raw);
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
