/**
 * ZCode adapter.
 *
 * ZCode does not write transcripts: its sessions live in a SQLite database
 * (`~/.zcode/cli/db/db.sqlite`) with a relational schema — `session`,
 * `message`, `part`, `model_usage` — where every message and every block of one
 * is a row with its own clock. That structure is what this adapter reads; the
 * same database holds every session the runtime ever ran, so it is a container
 * like a Cursor `state.vscdb`, and the reader opens one session at a time.
 *
 * What the schema gives, and what the adapter does with it:
 *   - `message` carries `role`, `time`, `semantics.kind` (a `user_prompt` is
 *     what a human actually said; everything else on the user side is a
 *     runtime-written reminder or notification and never becomes a prompt) and
 *     `contextSnapshot.envInfo.cwd`;
 *   - `part` is one block of a message: `text`, `reasoning`, `tool` (whose
 *     `state` holds input, output, status and its own timing), `step-finish`
 *     (per-request usage), `timeline` (compaction and model changes);
 *   - `model_usage` is the vendor-reported bill for every request, with cache
 *     read/write split out, TTFT and retries. Reported usage needs no
 *     estimation at all, whichever provider the session ran on: the provider
 *     is a field, not a format, so a third-party provider is the same
 *     transcript with a different name in it;
 *   - `session.parent_id` marks a subagent's session, whose `id` is
 *     `sess_subagent_agent_<agentId>`; the Agent call that started it names
 *     its agent id in the hand-back, which is what anchors the lane to the
 *     call — the same role `toolUseResult.agentId` plays for Claude.
 *
 * Two traps, both handled by reading one channel:
 *   - a compaction is written three times (a `compaction` part on the last
 *     user message, a `compaction` + `timeline` part pair on the assistant
 *     message that performed it, and a `compact_summary` user message with the
 *     summary prose). Counting them all is three compactions per one; the
 *     boundary is emitted once, from the assistant side, and the summary text
 *     is attached to it.
 *   - usage arrives twice too: `step-finish` parts (scoped to exactly their
 *     message) and `model_usage` rows (with retries and TTFT). The
 *     step-finish wins per message; model_usage is the fallback.
 *
 * Known gap, surfaced rather than hidden: a `-wal` sidecar holds the most
 * recent writes, and this reader does not replay it. The note in the quality
 * report says so.
 */

import type {
  CanonSession,
  OpCategory,
  OpFacts,
  OpStatus,
  PlanArtifact,
  SessionPart,
  TokenFacts,
} from '../model/canon.js';
import type { Calibration } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder } from './builder.js';
import { SqliteDb, type SqlValue } from './sqlite.js';
import {
  asText,
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
  type AskQuestion,
} from './text.js';

/** ZCode DBs above this are refused: the whole file has to be resident to walk it. */
export const MAX_DB_BYTES = 512 * 1024 * 1024;
/** Above this the user is warned before it is opened. */
export const WARN_DB_BYTES = 128 * 1024 * 1024;

const CATEGORY: Record<string, OpCategory> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  Bash: 'execute',
  TaskStop: 'execute',
  TaskOutput: 'other',
  WebSearch: 'web',
  WebFetch: 'web',
  TodoWrite: 'plan',
  EnterPlanMode: 'plan',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'ask',
  Agent: 'agent',
  Skill: 'agent',
  CronCreate: 'other',
  CronList: 'other',
  CronDelete: 'other',
  CronPause: 'other',
  CronPauseSelf: 'other',
  CronUpdate: 'other',
  SendMessage: 'other',
  InterruptSession: 'other',
  ListSessions: 'other',
  RenameSession: 'other',
  ReadSession: 'other',
  SendToSession: 'other',
  ForkSession: 'other',
  WaitSessions: 'other',
  RespondToCoordinator: 'other',
};

function categoryOf(name: string): OpCategory {
  return CATEGORY[name] ?? 'other';
}

/** A part of a message, as the database holds it. */
interface ZPart {
  id: string;
  messageId: string;
  sequence: number;
  ts: number;
  data: any;
}

interface ZMessage {
  id: string;
  sequence: number;
  ts: number;
  role: string;
  data: any;
}

export interface ZSession {
  id: string;
  title: string;
  cwd?: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  taskType?: string;
  messages: ZMessage[];
  parts: ZPart[];
  /** model_usage rows for this session, by the assistant message they billed */
  usage: Map<string, SqlValue[][]>;
}

/**
 * A SQLite database is or is not a ZCode one, by its tables: `message`/`part`
 * beside `session` is the ZCode schema; Cursor's key/value tables are not.
 */
export function isZcodeDb(db: SqliteDb): boolean {
  return !!db.table('session') && !!db.table('message') && !!db.table('part');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function json(v: unknown): any {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * Read every session out of a ZCode `db.sqlite`. One pass per table; parts and
 * usage are grouped under the message they belong to, and a session with no
 * messages is still a session — an interrupted run says so by being empty.
 */
export function readZcodeDb(bytes: Uint8Array, walBytes = 0): { sessions: ZSession[]; notes: string[] } {
  const notes: string[] = [];
  const db = new SqliteDb(bytes);
  if (!isZcodeDb(db)) throw new Error('not a ZCode database (no session/message/part tables)');
  if (walBytes) {
    notes.push(
      `ZCode: ${(walBytes / 1024 / 1024).toFixed(1)} MB of write-ahead log was not replayed; ` +
        `the most recent operations may be missing from this database.`,
    );
  }

  const sessions = new Map<string, ZSession>();
  const order: string[] = [];
  for (const row of db.scan('session')) {
    // session: id, project_id, workspace_id, parent_id, slug, directory, path,
    // title, version, share_url, summary_additions, summary_deletions,
    // summary_files, summary_diffs, revert, permission, time_created,
    // time_updated, time_compacting, time_archived, task_type, title_source,
    // title_message_id, time_title_updated, trace_id, time_deleted, last_outcome
    const id = row[0];
    if (typeof id !== 'string') continue;
    // A deleted session is gone as far as the runtime is concerned; the row
    // lingers in the file, and listing it would resurrect what was thrown away.
    if (row[25] != null) continue;
    const parent = row[3];
    sessions.set(id, {
      id,
      title: typeof row[7] === 'string' && row[7].trim() ? row[7] : '',
      cwd: typeof row[5] === 'string' && row[5] ? row[5] : undefined,
      createdAt: num(row[16]),
      updatedAt: num(row[17]),
      parentId: typeof parent === 'string' && parent ? parent : undefined,
      taskType: typeof row[20] === 'string' ? row[20] : undefined,
      messages: [],
      parts: [],
      usage: new Map(),
    });
    order.push(id);
  }

  const messages = new Map<string, ZMessage>();
  for (const row of db.scan('message')) {
    // message: id, session_id, time_created, time_updated, data, sequence
    const id = row[0];
    const sessionId = row[1];
    if (typeof id !== 'string' || typeof sessionId !== 'string') continue;
    const s = sessions.get(sessionId);
    if (!s) continue;
    const data = json(row[4]) ?? {};
    const m: ZMessage = { id, sequence: num(row[5]), ts: num(row[2]), role: String(data?.role ?? ''), data };
    s.messages.push(m);
    messages.set(id, m);
  }

  for (const row of db.scan('part')) {
    // part: id, message_id, session_id, time_created, time_updated, data, sequence
    const messageId = row[1];
    const sessionId = row[2];
    if (typeof messageId !== 'string' || typeof sessionId !== 'string') continue;
    const s = sessions.get(sessionId);
    if (!s) continue;
    s.parts.push({
      id: typeof row[0] === 'string' ? row[0] : '',
      messageId,
      sequence: num(row[6]),
      ts: num(row[3]),
      data: json(row[5]) ?? {},
    });
  }

  for (const row of db.scan('model_usage')) {
    // model_usage: id, logical_request_id, attempt_index, session_id, turn_id,
    // trace_id, span_id, assistant_message_id, parent_user_message_id,
    // query_source, provider_id, model_id, variant, agent, mode, task_type,
    // status, started_at, first_token_at, completed_at, duration_ms,
    // time_to_first_token_ms, finish_reason, tool_call_count, input_tokens,
    // output_tokens, reasoning_tokens, cache_creation_input_tokens,
    // cache_read_input_tokens, ...
    const sessionId = row[3];
    const assistantId = row[7];
    if (typeof sessionId !== 'string' || typeof assistantId !== 'string') continue;
    const s = sessions.get(sessionId);
    if (!s) continue;
    // Retries are attempts at one request; the first attempt is the bill the
    // reader reports, and a retried row would count the request twice.
    if (num(row[2]) > 0) continue;
    const list = s.usage.get(assistantId);
    if (list) list.push(row);
    else s.usage.set(assistantId, [row]);
  }

  for (const s of sessions.values()) {
    // `part.sequence` is written as 0 for almost every row, so the part's own
    // clock is what orders the blocks inside a message; messages do carry a
    // real sequence, which is the spine of the timeline.
    s.parts.sort((a, b) => a.ts - b.ts || a.sequence - b.sequence || (a.id < b.id ? -1 : 1));
    s.messages.sort((a, b) => a.sequence - b.sequence || a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }

  const list = order.map((id) => sessions.get(id)!).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) notes.push('ZCode: the database holds no sessions.');
  return { sessions: list, notes };
}

/* ---------------- event building ---------------- */

type ReportedUsage = NonNullable<TokenFacts['reported']>;

function usageOfParts(data: any): ReportedUsage | undefined {
  const t = data?.tokens;
  if (!t || typeof t !== 'object') return undefined;
  const input = num(t.input);
  const output = num(t.output);
  if (!input && !output) return undefined;
  return {
    input,
    cacheWrite: num(t.cache?.write),
    cacheRead: num(t.cache?.read),
    output,
    reasoning: num(t.reasoning) || undefined,
  };
}

/** model_usage row -> reported usage, in the reader's vocabulary. */
function usageOfRow(row: SqlValue[]): ReportedUsage | undefined {
  const input = num(row[24]);
  const output = num(row[25]);
  if (!input && !output) return undefined;
  return {
    input,
    cacheWrite: num(row[27]),
    cacheRead: num(row[28]),
    output,
    reasoning: num(row[26]) || undefined,
  };
}

function targetOf(name: string, args: any): string | undefined {
  if (name === 'Bash') return typeof args?.command === 'string' ? args.command : undefined;
  const path = args?.file_path ?? args?.path;
  if (typeof path === 'string' && path) return path;
  if (typeof args?.url === 'string' && args.url) return args.url;
  if (typeof args?.query === 'string' && args.query) return args.query;
  if (name === 'Agent') return String(args?.description ?? '');
  if (name === 'Skill') return typeof args?.skill === 'string' ? args.skill : undefined;
  return undefined;
}

function subgroupOf(name: string, category: OpCategory, target: string | undefined, args: any): string | undefined {
  if (category === 'execute' && target) return commandHead(target);
  if ((category === 'read' || category === 'edit') && target) return extname(target) || basename(target) || '(no extension)';
  if (category === 'web' && target) return /^[a-z]+:\/\//i.test(target) ? hostOf(target) : 'query';
  if (category === 'agent' && name === 'Agent') return String(args?.subagent_type ?? '') || 'subagent';
  return undefined;
}

function toolHead(name: string, args: any, cwd: string | undefined): string {
  const target = targetOf(name, args);
  if (name === 'Bash') return firstLine(target ?? '');
  if (target) {
    if (name === 'WebFetch' || name === 'WebSearch') return oneLine(target, 180);
    if (name === 'Agent') return oneLine(target, 100);
    return shortPath(target, cwd);
  }
  if (name === 'TodoWrite') return `${Array.isArray(args?.todos) ? args.todos.length : 0} tasks`;
  if (name === 'AskUserQuestion') return oneLine(String(args?.questions?.[0]?.question ?? ''), 140);
  if (typeof args?.task_id === 'string') return args.task_id;
  return oneLine(asText(args), 160);
}

/** The readable body of a tool call's arguments, per tool. */
function callBody(name: string, args: any): { text: string; format: 'text' | 'ask'; cls: 'json' | 'prose' } {
  if (name === 'AskUserQuestion' && Array.isArray(args?.questions)) {
    return { text: encodeAsk(args.questions as AskQuestion[], undefined), format: 'ask', cls: 'prose' };
  }
  return { text: asText(args), format: 'text', cls: 'json' };
}

/** What a tool call's result should look like on a row. */
interface ResultBody {
  text: string;
  format: 'text' | 'diff' | 'md';
  cls: 'terminal' | 'code' | 'prose';
  status: OpStatus;
  adds?: number;
  dels?: number;
  chips: string[];
}

/**
 * The result of a tool call. `state.metadata.display` carries what the reader
 * wants when the runtime kept it — a `structuredPatch` for edits, line counts
 * for reads; `state.output` is the plain text otherwise.
 */
function resultBody(name: string, state: any): ResultBody {
  const chips: string[] = [];
  const display = state?.metadata?.display;
  const raw = state?.output;
  const out = typeof raw === 'string' ? stripAnsi(raw) : asText(raw);
  const status: OpStatus = state?.status === 'error' ? 'error' : 'ok';

  if (display?.kind === 'file_diff' && Array.isArray(display.structuredPatch)) {
    const d = patchToDiff(display.structuredPatch);
    if (typeof display.additions === 'number' && display.additions) chips.push(`+${display.additions}`);
    if (typeof display.deletions === 'number' && display.deletions) chips.push(`−${display.deletions}`);
    return { text: d.text || out, format: 'diff', cls: 'code', status, adds: d.adds, dels: d.dels, chips };
  }
  if (name === 'Read') {
    const lines = out.replace(/\n$/, '').split('\n').length;
    if (lines > 1) chips.push(`${lines} lines`);
    return { text: out, format: 'text', cls: 'code', status, chips };
  }
  if (name === 'TodoWrite' && out) {
    const parsed = (() => {
      try {
        return JSON.parse(out);
      } catch {
        return null;
      }
    })();
    const todos = Array.isArray(parsed?.todos) ? parsed.todos : [];
    if (todos.length) {
      const mark: Record<string, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
      const text = todos.map((t: any) => `${mark[t.status] ?? '[ ]'} ${t.content ?? ''}`).join('\n');
      const done = todos.filter((t: any) => t.status === 'completed').length;
      chips.push(`${done}/${todos.length} done`);
      return { text, format: 'text', cls: 'prose', status, chips };
    }
  }
  if (name === 'WebFetch' || name === 'WebSearch') {
    return { text: out, format: 'md', cls: 'prose', status, chips };
  }
  return { text: out, format: 'text', cls: 'terminal', status, chips };
}

/** The three ways a ZCode session can express a plan, in Claude's shape. */
function planOf(name: string, args: any): PlanArtifact | undefined {
  if (name === 'EnterPlanMode') return { source: 'plan-mode', role: 'start', approved: false, text: '', steps: [] };
  if (name === 'ExitPlanMode') {
    const text = String(args?.plan ?? '');
    return { source: 'plan-mode', role: 'revision', approved: false, text, steps: extractSteps(text) };
  }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    if (!todos.length) return undefined;
    const steps = todos.map((t: any, i: number) => ({
      id: String(t.id ?? t.content ?? i),
      text: String(t.content ?? ''),
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
  return undefined;
}

/** Parse the agent id out of a subagent hand-back, the only place it is said. */
const HANDBACK_ID = /agent_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export class ZcodeAdapter {
  readonly b: Builder;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'zcode', confidence, cal);
  }

  build(
    session: ZSession,
    parts: SessionPart[],
    notes: string[],
    parseMs: number,
  ): CanonSession {
    for (const n of notes) this.b.note(n);

    const info = this.b.info;
    info.sessionId = session.id;
    info.title = session.title || session.id;
    info.cwd = session.cwd;
    if (session.messages.length) {
      const withSel = session.messages.find((m) => m.data?.modelSelection?.modelId);
      if (withSel) info.model = String(withSel.data.modelSelection.modelId);
      const env = session.messages.find((m) => m.data?.contextSnapshot?.envInfo)?.data?.contextSnapshot?.envInfo;
      if (env?.cwd && !info.cwd) info.cwd = String(env.cwd);
      if (env?.gitBranch) info.gitBranch = String(env.gitBranch);
    }
    // A subagent's session is a thread: its own id really is its own here
    // (unlike a Claude subagent transcript, which records the parent's), so
    // nothing has to be swapped — only said.
    if (session.parentId) {
      info.thread = {
        role: 'subagent',
        kind: session.taskType ?? 'subagent_child',
        label: 'subagent',
        parentId: session.parentId,
      };
    }

    const partsByMessage = new Map<string, ZPart[]>();
    for (const p of session.parts) {
      const list = partsByMessage.get(p.messageId);
      if (list) list.push(p);
      else partsByMessage.set(p.messageId, [p]);
    }
    this.usageByMessage = session.usage;
    this.messageById = new Map(session.messages.map((m) => [m.id, m]));

    // The prose account of what each compaction threw away lives in the
    // `compact_summary` message it left behind; the boundary itself is rendered
    // from the assistant side (see `compaction()`), so the text is collected
    // first and attached there.
    for (const [messageId, msgParts] of partsByMessage) {
      const m = this.messageById.get(messageId);
      if (!m || String(m.data?.semantics?.kind) !== 'compact_summary') continue;
      const op = String(msgParts.find((p) => p.data?.type === 'compaction')?.data?.operationId ?? m.id);
      const text = msgParts
        .filter((p) => p.data?.type === 'text')
        .map((p) => String(p.data?.text ?? ''))
        .join('\n\n')
        .trim();
      if (text) this.compactSummaries.set(op, text);
    }

    for (const m of session.messages) {
      this.message(m, partsByMessage.get(m.id) ?? []);
    }

    const built = this.b.finish(parseMs);
    if (parts.length > 1) built.parts = parts;
    return built;
  }

  private message(m: ZMessage, msgParts: ZPart[]): void {
    const kind = String(m.data?.semantics?.kind ?? '');

    // The user side is mostly the runtime talking to itself: reminders,
    // notifications, compaction boundaries. Only a `user_prompt` is a human
    // speaking, and only that becomes a prompt. A `compact_summary` is the
    // prose account of what a compaction threw away — it belongs to the
    // boundary, which is emitted from the assistant side (see below), so here
    // it is only remembered, not rendered.
    if (m.role === 'user') {
      if (kind !== 'user_prompt') return;
      for (const p of msgParts) {
        if (p.data?.type !== 'text') continue;
        const text = String(p.data?.text ?? '');
        if (!text.trim()) continue;
        const { ts, tsSource } = this.b.stamp(p.ts || m.ts);
        this.b.openSegment(text, ts);
        this.b.add(
          {
            kind: 'prompt',
            ts,
            tsSource,
            title: 'You',
            text,
            format: 'md',
            cls: 'prose',
            id: p.id,
          },
          { start: 0, end: 0, block: -1 },
        );
      }
      return;
    }
    if (m.role !== 'assistant') return;

    // An assistant message is a step: parts in order — reasoning, text, tool
    // calls — closed by a step-finish with the request's usage.
    let firstIdx = -1;
    let usage: ReportedUsage | undefined;
    for (const p of msgParts) {
      const type = String(p.data?.type ?? '');
      const { ts, tsSource } = this.b.stamp(p.ts || m.ts);
      const src = { start: 0, end: 0, block: -1 };

      if (type === 'text') {
        const text = String(p.data?.text ?? '');
        if (!text.trim()) continue;
        const idx = this.b.add(
          {
            kind: 'text',
            ts,
            tsSource,
            title: 'ZCode',
            text,
            format: 'md',
            cls: 'prose',
            id: p.id,
            parentId: m.id,
          },
          src,
        );
        if (firstIdx < 0) firstIdx = idx;
        continue;
      }
      if (type === 'reasoning') {
        const text = String(p.data?.text ?? p.data?.thinking ?? '');
        if (!text.trim()) continue;
        const idx = this.b.add(
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
            id: p.id,
            parentId: m.id,
          },
          src,
        );
        if (firstIdx < 0) firstIdx = idx;
        continue;
      }
      if (type === 'tool') {
        const idx = this.tool(p, ts, tsSource, m.id);
        if (firstIdx < 0) firstIdx = idx;
        continue;
      }
      if (type === 'step-finish') {
        const reported = usageOfParts(p.data);
        if (reported) {
          // A message with several steps carries several finishes; the request
          // is what the reader bills, so they are summed, once per message.
          if (!usage) usage = reported;
          else {
            usage = {
              input: usage.input + reported.input,
              cacheWrite: usage.cacheWrite + reported.cacheWrite,
              cacheRead: usage.cacheRead + reported.cacheRead,
              output: usage.output + reported.output,
              reasoning:
                (usage.reasoning ?? 0) + (reported.reasoning ?? 0) || undefined,
            };
          }
        }
        continue;
      }
      if (type === 'timeline') {
        this.timeline(p, ts, tsSource);
        continue;
      }
      if (type === 'compaction') {
        this.compaction(p, ts, tsSource);
        continue;
      }
      if (type === 'step-start') continue;
      this.b.countType(`part:${type}`);
    }

    // The bill: step-finish first, model_usage as the fallback. Attached to the
    // message's first event, or to a system row of its own when the request
    // produced nothing renderable — a request that cost tokens still shows.
    if (!usage) {
      const rows = this.usageByMessage.get(m.id);
      if (rows?.length) usage = usageOfRow(rows[0]);
    }
    if (usage) {
      let idx = firstIdx;
      if (idx < 0) {
        this.b.addSystem('request', 'usage only', m.ts, 0, 0);
        idx = this.b.events.length - 1;
      }
      const ev = this.b.events[idx];
      if (ev && !ev.tokens.reported) {
        ev.tokens.reported = usage;
        ev.tokens.estimated = false;
      }
    }
  }

  /** model_usage rows by message, set by build() before events are made. */
  private usageByMessage = new Map<string, SqlValue[][]>();
  /** every message of the session, by id, set by build() alongside the above */
  private messageById = new Map<string, ZMessage>();

  private tool(p: ZPart, ts: number, tsSource: any, msgId: string): number {
    const d = p.data;
    const name = String(d?.tool ?? 'tool');
    const category = categoryOf(name);
    if (!CATEGORY[name] && !name.startsWith('mcp__')) this.b.countUnknownTool(name);
    const state = d?.state ?? {};
    const args = state?.input ?? {};
    const body = callBody(name, args);
    const target = targetOf(name, args);
    const op: OpFacts = {
      name,
      category,
      target,
      subgroup: subgroupOf(name, category, target, args),
      command: name === 'Bash' && typeof target === 'string' ? target : undefined,
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
        collapsed: true,
        op,
        payloadIn: this.b.est(asText(args), 'json'),
        id: p.id,
        parentId: msgId,
      },
      { start: 0, end: 0, block: -1, tool: name },
    );
    const plan = planOf(name, args);
    if (plan) this.b.events[idx].plan = plan;

    // A tool part carries its state with it: there is no separate result row to
    // wait for, only a call whose status is still `running` at the end of the
    // file (or of the WAL gap).
    if (state?.status && state.status !== 'running') this.closeTool(idx, name, state, p.ts || ts);
    return idx;
  }

  private closeTool(idx: number, name: string, state: any, ts: number): void {
    const body = resultBody(name, state);
    const time = state?.time;
    const endTs = num(time?.end) || ts;
    const dur = num(time?.start) && endTs > num(time.start) ? endTs - num(time.start) : undefined;
    // A subagent's hand-back names the agent id, and the session it started is
    // named after it (`sess_subagent_agent_<id>`): that is the link a lane
    // anchors to, the same way `toolUseResult.agentId` does for Claude.
    let spawnedThread: string | undefined;
    if (name === 'Agent' && typeof state?.output === 'string') {
      const id = HANDBACK_ID.exec(state.output);
      if (id) spawnedThread = `sess_subagent_${id[0]}`;
    }
    const ev = this.b.events[idx];
    if (ev?.op && spawnedThread) ev.op.spawnedThread = spawnedThread;

    this.b.close(
      idx,
      {
        text: body.text,
        format: body.format,
        cls: body.cls,
        chips: body.chips,
        status: body.status,
        linesAdded: body.adds,
        linesRemoved: body.dels,
        ts: endTs,
        durationMs: dur,
        payloadOut: this.b.est(body.text, body.cls === 'code' ? 'code' : 'terminal'),
      },
      undefined,
    );
  }

  private timeline(p: ZPart, ts: number, tsSource: any): void {
    const d = p.data;
    if (d?.timelineType === 'model_change') {
      const label = d?.toModelSelection?.modelId ?? d?.toModel?.modelID ?? '';
      if (!label) return;
      this.b.add(
        {
          kind: 'notice',
          ts,
          tsSource,
          title: 'model changed',
          subtitle: String(label),
          text: '',
          format: 'text',
          collapsed: true,
          id: p.id,
        },
        { start: 0, end: 0, block: -1 },
      );
    }
    // `context_compaction` is dropped here on purpose: the same operation also
    // writes a `compaction` part, which carries the token counts and renders
    // the boundary (see `compaction()`). One boundary, one channel.
  }

  private compaction(p: ZPart, ts: number, tsSource: any): void {
    const d = p.data;
    const op = String(d?.operationId ?? p.id);
    // The operation is written on two messages (the last user message and the
    // assistant one that performed it); one boundary per operation.
    if (this.renderedCompactions.has(op)) return;
    this.renderedCompactions.add(op);
    const chips = [
      typeof d?.preCompactTokenCount === 'number' && typeof d?.postCompactTokenCount === 'number'
        ? `${d.preCompactTokenCount} → ${d.postCompactTokenCount} tokens`
        : '',
    ].filter(Boolean);
    this.b.add(
      {
        kind: 'compaction',
        ts,
        tsSource,
        title: 'context compacted',
        subtitle: d?.compactReason ? String(d.compactReason) : undefined,
        text: this.compactSummaries.get(op) ?? '',
        format: 'md',
        cls: 'prose',
        chips,
        collapsed: true,
        id: p.id,
      },
      { start: 0, end: 0, block: -1 },
    );
  }

  /** operationIds already rendered as a compaction boundary. */
  private renderedCompactions = new Set<string>();

  /** summary text by compaction operation, from the compact_summary messages. */
  private compactSummaries = new Map<string, string>();
}

/** The `SessionPart` list for the reader's dropdown: one per session in the database. */
export function partsOf(sessions: ZSession[]): SessionPart[] {
  return sessions.map((s) => ({
    id: s.id,
    title: s.title || s.id.slice(0, 12),
    messages: s.messages.length,
    ts: s.createdAt,
  }));
}
