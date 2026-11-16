/**
 * Kimi Code wire.jsonl adapter (protocol 1.5).
 *
 * The wire contains both the canonical loop stream and materialized messages,
 * request traces and cumulative session usage. Only the loop stream becomes a
 * timeline; turn-scoped usage is attached once to the request that produced it.
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
import { Builder, type EventSource } from './builder.js';
import {
  asText,
  basename,
  commandHead,
  encodeAsk,
  extname,
  firstLine,
  hostOf,
  oneLine,
  shortPath,
  stripAnsi,
  type AskQuestion,
} from './text.js';

const CATEGORY: Record<string, OpCategory> = {
  Read: 'read',
  ReadMediaFile: 'read',
  Glob: 'search',
  Grep: 'search',
  select_tools: 'search',
  Edit: 'edit',
  Write: 'edit',
  Bash: 'execute',
  TaskStop: 'execute',
  WebSearch: 'web',
  FetchURL: 'web',
  TodoList: 'plan',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'ask',
  Agent: 'agent',
  AgentSwarm: 'agent',
  Skill: 'agent',
  TaskList: 'other',
  TaskOutput: 'other',
  WaitFor: 'other',
  CronCreate: 'other',
  CronList: 'other',
  CronDelete: 'other',
  NotifyUser: 'other',
};

const NOISE_TYPES = new Set([
  'agent.message.appended',
  'agent.turn.started',
  'agent.turn.ended',
  'changeNotifier.snapshot',
  'config.update',
  'environment.set_binding',
  'file_history.checkpoint',
  'file_history.tracked',
  'full_compaction.begin',
  'full_compaction.complete',
  'interaction.request',
  'interaction.resolved',
  'llm.request',
  'llm.tools_snapshot',
  'mcp.tools_discovered',
  'permission.record_approval_result',
  'permission.set_mode',
  'plugin.session_start',
  'prompt.completed',
  'prompt.steered',
  'runtime.set_binding',
  'task.started',
  'task.terminated',
  'task.waitDelivered',
  'token_counting.measured',
  'token_counting.rebased',
  'token_counting.turn_recorded',
  'tool_select.initialized',
  'tools.update_store',
  'turn.ended',
  'turn.steer',
]);

type ReportedUsage = NonNullable<TokenFacts['reported']>;

interface OutputBody {
  text: string;
  images: ImageRef[];
}

interface CallBody {
  text: string;
  format: BodyFormat;
  cls: ContentClass;
  adds?: number;
  dels?: number;
  chips?: string[];
}

export function categoryOf(name: string): OpCategory {
  return CATEGORY[name] ?? 'other';
}

function targetOf(name: string, args: any): string | undefined {
  if (name === 'Bash') return typeof args?.command === 'string' ? args.command : undefined;
  const path = args?.path ?? args?.file_path;
  if (typeof path === 'string') return path;
  if (typeof args?.url === 'string') return args.url;
  if (typeof args?.query === 'string') return args.query;
  if (name === 'Agent') return String(args?.description ?? args?.prompt ?? '');
  if (name === 'Skill') return typeof args?.skill === 'string' ? args.skill : undefined;
  return undefined;
}

function subgroupOf(category: OpCategory, target: string | undefined, args: any): string | undefined {
  if (category === 'execute' && target) return commandHead(target);
  if ((category === 'read' || category === 'edit') && target) return extname(target) || basename(target) || '(no extension)';
  if (category === 'web' && target) return /^[a-z]+:\/\//i.test(target) ? hostOf(target) : 'query';
  if (category === 'agent') return String(args?.subagent_type ?? args?.agent_type ?? '') || undefined;
  return undefined;
}

function toolHead(name: string, args: any, cwd: string | undefined): string {
  const target = targetOf(name, args);
  if (name === 'Bash') return firstLine(target ?? '');
  if (target) {
    if (name === 'FetchURL' || name === 'WebSearch') return oneLine(target, 180);
    if (name === 'Agent') return oneLine(target, 100);
    return shortPath(target, cwd);
  }
  if (name === 'TodoList') return `${Array.isArray(args?.todos) ? args.todos.length : 0} tasks`;
  if (name === 'AskUserQuestion') return oneLine(String(args?.questions?.[0]?.question ?? ''), 140);
  if (typeof args?.task_id === 'string') return args.task_id;
  if (typeof args?.description === 'string') return oneLine(args.description, 120);
  return oneLine(asText(args), 160);
}

function splitLines(text: string): string[] {
  return text ? text.replace(/\n$/, '').split('\n') : [];
}

function diffHeader(path: string): string[] {
  return [`--- a/${path}`, `+++ b/${path}`];
}

function editDiff(before: string, after: string, path: string): { text: string; adds: number; dels: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const lines = diffHeader(path);
  lines.push(`@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`);
  for (const line of a.slice(Math.max(0, prefix - 2), prefix)) lines.push(` ${line}`);
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  for (const line of a.slice(a.length - suffix, a.length - suffix + 2)) lines.push(` ${line}`);
  return { text: lines.join('\n'), adds: added.length, dels: removed.length };
}

function writeDiff(content: string, path: string): { text: string; adds: number } {
  const added = splitLines(content);
  const lines = [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${added.length} @@`];
  for (const line of added) lines.push(`+${line}`);
  return { text: lines.join('\n'), adds: added.length };
}

function todoPlan(args: any): PlanArtifact | undefined {
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  if (!todos.length) return undefined;
  const steps = todos.map((todo: any, i: number) => ({
    id: String(todo?.id ?? todo?.title ?? i),
    text: String(todo?.title ?? todo?.content ?? ''),
    status:
      todo?.status === 'done' || todo?.status === 'completed' ? ('done' as const)
      : todo?.status === 'in_progress' ? ('active' as const)
      : ('pending' as const),
  }));
  return {
    source: 'plan-tool',
    role: 'revision',
    approved: true,
    text: steps.map((step: { text: string }) => `- ${step.text}`).join('\n'),
    steps,
  };
}

function callBody(event: any): CallBody {
  const name = String(event?.name ?? '');
  const args = event?.args ?? {};
  if (name === 'Edit') {
    const path = String(args?.path ?? event?.display?.path ?? '');
    const before = String(event?.display?.before ?? args?.old_string ?? '');
    const after = String(event?.display?.after ?? args?.new_string ?? '');
    const diff = editDiff(before, after, path);
    return {
      text: diff.text,
      format: 'diff',
      cls: 'code',
      adds: args?.replace_all ? undefined : diff.adds,
      dels: args?.replace_all ? undefined : diff.dels,
      chips: args?.replace_all ? ['replace all'] : undefined,
    };
  }
  if (name === 'Write') {
    const path = String(args?.path ?? event?.display?.path ?? '');
    const content = String(event?.display?.content ?? args?.content ?? '');
    const diff = writeDiff(content, path);
    return { text: diff.text, format: 'diff', cls: 'code', adds: diff.adds };
  }
  if (name === 'AskUserQuestion' && Array.isArray(args?.questions)) {
    return { text: encodeAsk(args.questions as AskQuestion[], undefined), format: 'ask', cls: 'prose' };
  }
  const plan = todoPlan(args);
  if (name === 'TodoList' && plan) {
    const text = plan.steps
      .map((step) => `${step.status === 'done' ? '[x]' : step.status === 'active' ? '[~]' : '[ ]'} ${step.text}`)
      .join('\n');
    const done = plan.steps.filter((step) => step.status === 'done').length;
    return { text, format: 'text', cls: 'prose', chips: [`${done}/${plan.steps.length} done`] };
  }
  return { text: asText(args), format: 'text', cls: 'json' };
}

function outputBody(output: unknown): OutputBody {
  const images: ImageRef[] = [];
  if (typeof output === 'string') return { text: stripAnsi(output), images };
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const part of output) {
      if (part?.__img) {
        images.push(part.__img as ImageRef);
        continue;
      }
      if (typeof part === 'string') parts.push(part);
      else if (part?.type === 'text' || typeof part?.text === 'string') parts.push(String(part.text ?? ''));
      else if (part && typeof part === 'object') parts.push(asText(part));
    }
    return { text: stripAnsi(parts.join('\n')), images };
  }
  return { text: stripAnsi(asText(output)), images };
}

function answersOf(output: unknown): Record<string, string> | undefined {
  if (typeof output !== 'string') return undefined;
  try {
    const parsed = JSON.parse(output);
    if (!parsed?.answers || typeof parsed.answers !== 'object') return undefined;
    const answers: Record<string, string> = {};
    for (const [question, answer] of Object.entries(parsed.answers)) {
      if (typeof answer === 'string') answers[question] = answer;
      else if (Array.isArray(answer)) answers[question] = answer.map(String).join(', ');
    }
    return answers;
  } catch {
    return undefined;
  }
}

function usageFacts(usage: any): ReportedUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  return {
    input: Number(usage.inputOther ?? 0),
    cacheWrite: Number(usage.inputCacheCreation ?? 0),
    cacheRead: Number(usage.inputCacheRead ?? 0),
    output: Number(usage.output ?? 0),
  };
}

export function fullBody(rec: any, src: EventSource): string {
  if (rec?.type === 'context.append_message') {
    const content = rec?.message?.content;
    if (Array.isArray(content)) return String(content[src.block]?.text ?? asText(content[src.block]));
    return String(content ?? '');
  }
  if (rec?.type === 'context.apply_compaction') return String(rec?.summary ?? rec?.contextSummary ?? '');
  if (rec?.type !== 'context.append_loop_event') return asText(rec);
  const event = rec.event;
  if (event?.type === 'content.part') return String(event?.part?.text ?? event?.part?.think ?? '');
  if (event?.type === 'tool.call') return callBody(event).text;
  if (event?.type === 'tool.result') return outputBody(event?.result?.output).text || String(event?.result?.note ?? '');
  return asText(event);
}

export class KimiAdapter {
  readonly b: Builder;

  private pending = new Map<string, number>();
  private callRecords = new Map<string, any>();
  private turnSegments = new Map<string, number>();
  private inStep = false;
  private stepFirstEvent = 0;
  private pendingUsage: { reported: ReportedUsage; ts: number; start: number; end: number } | undefined;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'kimi', confidence, cal);
  }

  push(rec: any, start: number, end: number): void {
    this.b.info.lines++;
    const type = String(rec?.type ?? 'unknown');
    const created = typeof rec?.created_at === 'string' ? Date.parse(rec.created_at) : 0;
    const raw = typeof rec?.time === 'number' ? rec.time : created;
    const { ts, tsSource } = this.b.stamp(Number.isFinite(raw) ? raw : 0);

    if (type === 'metadata') {
      this.b.info.version = `wire ${String(rec?.protocol_version ?? 'unknown')}`;
      return;
    }
    if (type === 'profile.bind') {
      if (rec?.modelAlias) this.b.info.model = String(rec.modelAlias);
      return;
    }
    if (type === 'turn.prompt') {
      this.turnSegments.set(String(rec?.turnId ?? ''), Math.max(0, this.b.segments.length - 1));
      return;
    }
    if (type === 'usage.record') {
      this.recordUsage(rec, ts, start, end);
      return;
    }
    if (type === 'context.append_message') {
      this.appendMessage(rec, ts, tsSource, start, end);
      return;
    }
    if (type === 'context.append_loop_event') {
      this.appendLoop(rec, ts, tsSource, start, end);
      return;
    }
    if (type === 'context.apply_compaction') {
      const text = String(rec?.summary ?? rec?.contextSummary ?? '');
      const chips = [
        typeof rec?.compactedCount === 'number' ? `${rec.compactedCount} compacted` : '',
        typeof rec?.tokensBefore === 'number' && typeof rec?.tokensAfter === 'number'
          ? `${rec.tokensBefore} → ${rec.tokensAfter} tokens`
          : '',
      ].filter(Boolean);
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
          chips,
          collapsed: true,
        },
        { start, end, block: -1 },
      );
      return;
    }
    if (type === 'turn.step.interrupted' || type === 'turn.step.retrying' || type === 'prompt.aborted' || type === 'turn.cancel') {
      this.b.add(
        {
          kind: type === 'prompt.aborted' || type === 'turn.cancel' ? 'error' : 'notice',
          ts,
          tsSource,
          title: type,
          text: asText(rec?.reason ?? rec?.error ?? ''),
          format: 'text',
          cls: 'prose',
          collapsed: true,
        },
        { start, end, block: -1 },
      );
      return;
    }
    if (NOISE_TYPES.has(type)) return;

    this.b.countType(type);
    this.b.addSystem(type, '', ts, start, end);
  }

  private appendMessage(rec: any, ts: number, tsSource: any, start: number, end: number): void {
    const message = rec?.message ?? {};
    const content = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: String(message?.content ?? '') }];
    const origin = String(message?.origin?.kind ?? '');
    const human = message?.role === 'user' && origin === 'user';
    const images: ImageRef[] = [];
    const firstEvent = this.b.events.length;
    let opened = false;

    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      if (part?.__img) {
        images.push(part.__img as ImageRef);
        continue;
      }
      const text = String(part?.text ?? (typeof part === 'string' ? part : ''));
      if (!text.trim()) continue;
      if (human && !opened) {
        this.b.openSegment(text, ts);
        opened = true;
      }
      this.b.add(
        {
          kind: human ? 'prompt' : message?.role === 'system' ? 'system' : 'notice',
          ts,
          tsSource,
          title: human ? 'You' : origin ? `user · ${origin}` : String(message?.role ?? 'message'),
          text,
          format: 'md',
          cls: 'prose',
          collapsed: !human,
          id: message?.id ? `${message.id}:${i}` : undefined,
        },
        { start, end, block: i },
      );
    }
    if (images.length && this.b.events.length === firstEvent) {
      if (human) this.b.openSegment('(media prompt)', ts);
      this.b.add(
        {
          kind: human ? 'prompt' : 'notice',
          ts,
          tsSource,
          title: human ? 'You' : 'media',
          text: '',
          format: 'text',
          images,
        },
        { start, end, block: -1 },
      );
    } else if (images.length) {
      const ev = this.b.events[this.b.events.length - 1];
      ev.images = [...(ev.images ?? []), ...images];
      ev.collapsed = false;
    }
  }

  private appendLoop(rec: any, ts: number, tsSource: any, start: number, end: number): void {
    const event = rec?.event ?? {};
    const type = String(event?.type ?? 'unknown');
    if (type === 'step.begin') {
      if (this.pendingUsage) {
        const pending = this.pendingUsage;
        this.attachUsage(pending.reported, this.b.events.length - 1, pending.ts, pending.start, pending.end);
      }
      this.inStep = true;
      this.stepFirstEvent = this.b.events.length;
      this.pendingUsage = undefined;
      return;
    }
    if (type === 'step.end') {
      const pending = this.pendingUsage;
      const reported = pending?.reported ?? usageFacts(event?.usage);
      if (reported) {
        const idx = this.b.events.length > this.stepFirstEvent ? this.b.events.length - 1 : -1;
        this.attachUsage(reported, idx, pending?.ts ?? ts, pending?.start ?? start, pending?.end ?? end);
      }
      this.pendingUsage = undefined;
      this.inStep = false;
      const turn = String(event?.turnId ?? '');
      const segIdx = this.turnSegments.get(turn) ?? this.b.segments.length - 1;
      const seg = this.b.segments[segIdx];
      if (seg && typeof event?.llmFirstTokenLatencyMs === 'number') seg.ttftMs = event.llmFirstTokenLatencyMs;
      return;
    }
    if (type === 'content.part') {
      const reasoning = event?.part?.type === 'think';
      const text = String(reasoning ? (event?.part?.think ?? '') : (event?.part?.text ?? ''));
      if (!text.trim()) return;
      this.b.add(
        {
          kind: reasoning ? 'reasoning' : 'text',
          ts,
          tsSource,
          title: reasoning ? 'thinking' : 'Kimi',
          text,
          format: 'md',
          cls: 'prose',
          collapsed: reasoning || undefined,
          id: event?.uuid ? String(event.uuid) : undefined,
          parentId: event?.stepUuid ? String(event.stepUuid) : undefined,
        },
        { start, end, block: Number(event?.block ?? 0) },
      );
      return;
    }
    if (type === 'tool.call') {
      this.openTool(event, ts, tsSource, start, end);
      return;
    }
    if (type === 'tool.result') {
      this.closeTool(event, ts, start, end);
      return;
    }

    this.b.countType(`event:${type}`);
    this.b.addSystem(`event:${type}`, '', ts, start, end);
  }

  private openTool(event: any, ts: number, tsSource: any, start: number, end: number): void {
    const name = String(event?.name ?? 'tool');
    const category = categoryOf(name);
    if (!CATEGORY[name] && !name.startsWith('mcp__')) this.b.countUnknownTool(name);
    const args = event?.args ?? {};
    const rawArgs = asText(args);
    const body = callBody(event);
    const target = targetOf(name, args);
    const op: OpFacts = {
      name,
      category,
      target,
      subgroup: subgroupOf(category, target, args),
      command: name === 'Bash' ? target : undefined,
      status: 'unpaired',
    };
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle: toolHead(name, args, this.b.info.cwd),
        text: body.text,
        format: body.format,
        cls: body.cls,
        chips: body.chips,
        collapsed: true,
        op,
        payloadIn: this.b.est(rawArgs, 'json'),
        id: event?.uuid ? String(event.uuid) : undefined,
        parentId: event?.stepUuid ? String(event.stepUuid) : undefined,
      },
      { start, end, block: 0, tool: name },
    );
    const plan = todoPlan(args);
    if (name === 'TodoList' && plan) this.b.events[idx].plan = plan;
    if (event?.toolCallId) {
      const id = String(event.toolCallId);
      this.pending.set(id, idx);
      this.callRecords.set(id, event);
    }
  }

  private closeTool(event: any, ts: number, start: number, end: number): void {
    const id = String(event?.toolCallId ?? '');
    const idx = this.pending.get(id);
    const output = outputBody(event?.result?.output);
    if (!output.text && event?.result?.note) output.text = String(event.result.note);
    if (idx === undefined) {
      this.b.quality.orphanResults++;
      this.b.add(
        {
          kind: 'notice',
          ts,
          title: 'orphan result',
          text: output.text,
          format: 'text',
          cls: 'terminal',
          images: output.images,
          collapsed: true,
          id: event?.parentUuid ? String(event.parentUuid) : undefined,
        },
        { start, end, block: 0 },
      );
      return;
    }
    this.pending.delete(id);
    const ev = this.b.events[idx];
    const name = ev.op?.name ?? '';
    const status: OpStatus = event?.result?.isError === true ? 'error' : 'ok';
    const friendly = name === 'Edit' || name === 'Write' || name === 'TodoList' || name === 'AskUserQuestion';
    const keepCall = friendly && (status === 'ok' || name === 'AskUserQuestion');
    let text = keepCall ? ev.body : output.text;
    let format = keepCall ? ev.format : 'text';
    let chips = keepCall ? ev.chips : undefined;
    let adds: number | undefined;
    let dels: number | undefined;

    if (name === 'AskUserQuestion') {
      const call = this.callRecords.get(id);
      const answers = answersOf(event?.result?.output);
      text = encodeAsk((call?.args?.questions ?? []) as AskQuestion[], answers);
      format = 'ask';
    } else if (name === 'Edit' || name === 'Write') {
      const call = this.callRecords.get(id);
      const body = callBody(call ?? { name, args: {} });
      if (keepCall) {
        text = body.text;
        format = body.format;
        chips = body.chips;
        adds = body.adds;
        dels = body.dels;
      }
    }
    this.callRecords.delete(id);

    this.b.close(
      idx,
      {
        text,
        format,
        cls: format === 'diff' ? 'code' : format === 'ask' ? 'prose' : 'terminal',
        chips,
        images: output.images,
        status,
        linesAdded: adds,
        linesRemoved: dels,
        ts,
        durationMs: typeof event?.result?.durationMs === 'number' ? event.result.durationMs : undefined,
        payloadOut: this.b.est(output.text, 'terminal'),
      },
      keepCall ? undefined : { start, end, block: 0 },
    );
  }

  private recordUsage(rec: any, ts: number, start: number, end: number): void {
    if (rec?.model) this.b.info.model = String(rec.model);
    if (rec?.usageScope !== 'turn') return;
    const reported = usageFacts(rec?.usage);
    if (!reported) return;
    if (this.inStep) {
      this.pendingUsage = { reported, ts, start, end };
      return;
    }
    this.attachUsage(reported, this.b.events.length - 1, ts, start, end);
  }

  private attachUsage(reported: ReportedUsage, idx: number, ts: number, start: number, end: number): void {
    if (idx < 0 || !this.b.events[idx]) {
      this.b.addSystem('request', 'usage only', ts, start, end);
      idx = this.b.events.length - 1;
    }
    const tokens = this.b.events[idx].tokens;
    if (tokens.reported) {
      this.b.note('Duplicate turn usage record ignored.');
      return;
    }
    tokens.reported = reported;
  }

  finish(parseMs: number): CanonSession {
    if (this.pendingUsage) {
      const pending = this.pendingUsage;
      this.attachUsage(pending.reported, this.b.events.length - 1, pending.ts, pending.start, pending.end);
      this.pendingUsage = undefined;
    }
    return this.b.finish(parseMs);
  }
}
