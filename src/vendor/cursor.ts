/**
 * Cursor adapter (experimental).
 *
 * Cursor keeps chats in a VS Code `state.vscdb` SQLite file as JSON blobs, in a
 * schema that is undocumented and moves between versions — the highest-risk part
 * of this tool (SPEC §13.1). Everything here is written defensively: unknown
 * shapes degrade to fewer events, never to wrong ones, and every gap is pushed
 * into the quality report instead of being papered over.
 *
 * Known gaps, all surfaced in the UI:
 *   - token usage is usually absent, so token figures are estimated;
 *   - per-message timestamps are often absent, so durations are unavailable;
 *   - tool results are sometimes stored post-rendered, so line counts are lost.
 */

import type { CanonSession, OpCategory, OpFacts, SessionPart } from '../model/canon.js';
import type { Calibration } from '../metrics/estimate.js';
import { extractSteps } from '../metrics/steps.js';
import { Builder } from './builder.js';
import { SqliteDb } from './sqlite.js';
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

/** Cursor DBs above this are refused: the whole file has to be resident to walk it. */
export const MAX_DB_BYTES = 512 * 1024 * 1024;
/** Above this the user is warned before it is opened. */
export const WARN_DB_BYTES = 128 * 1024 * 1024;

const CATEGORY: Record<string, OpCategory> = {
  read_file: 'read',
  list_dir: 'read',
  edit_file: 'edit',
  search_replace: 'edit',
  write: 'edit',
  create_file: 'edit',
  delete_file: 'edit',
  run_terminal_cmd: 'execute',
  run_terminal_command: 'execute',
  codebase_search: 'search',
  grep_search: 'search',
  file_search: 'search',
  semantic_search: 'search',
  web_search: 'web',
  fetch_rules: 'read',
  todo_write: 'plan',
  update_plan: 'plan',
};

export function categoryOf(name: string): OpCategory {
  const key = name.toLowerCase();
  if (CATEGORY[key]) return CATEGORY[key];
  if (/terminal|shell|command|exec/.test(key)) return 'execute';
  if (/edit|write|patch|apply|create|delete/.test(key)) return 'edit';
  if (/read|list|view/.test(key)) return 'read';
  if (/search|grep|find/.test(key)) return 'search';
  if (/web|fetch/.test(key)) return 'web';
  if (/todo|plan/.test(key)) return 'plan';
  return 'other';
}

interface Bubble {
  role: 'user' | 'assistant';
  text: string;
  thinking?: string;
  tool?: any;
  ts: number;
  endTs?: number;
  tokens?: { input: number; output: number };
}

export interface CursorChat {
  id: string;
  title: string;
  createdAt: number;
  bubbles: Bubble[];
}

function json(v: unknown): any {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function textOf(raw: any): string {
  if (typeof raw?.text === 'string' && raw.text.trim()) return raw.text;
  const rich = raw?.richText;
  if (typeof rich === 'string') {
    const parsed = json(rich);
    if (parsed) return richToText(parsed);
    return rich;
  }
  if (rich) return richToText(rich);
  return '';
}

/** Cursor stores prompts as a Lexical-ish document; flatten it to text. */
function richToText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(richToText).join('');
  if (typeof node !== 'object') return '';
  let out = typeof node.text === 'string' ? node.text : '';
  const kids = node.children ?? node.root?.children;
  if (Array.isArray(kids)) out += kids.map(richToText).join('');
  if (node.type === 'paragraph' || node.type === 'linebreak') out += '\n';
  return out;
}

function bubbleOf(raw: any): Bubble | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type ?? raw.messageType;
  const role: 'user' | 'assistant' = type === 1 || raw.role === 'user' ? 'user' : 'assistant';
  const timing = raw.timingInfo ?? {};
  const ts = Number(timing.clientStartTime ?? timing.clientRpcSendTime ?? raw.createdAt ?? 0) || 0;
  const endTs = Number(timing.clientSettleTime ?? timing.clientEndTime ?? 0) || undefined;
  const text = textOf(raw);
  const thinking =
    typeof raw.thinking?.text === 'string' ? raw.thinking.text
    : raw.isThought && text ? text
    : undefined;
  const tc = raw.tokenCount;
  const tokens =
    tc && (Number(tc.inputTokens) || Number(tc.outputTokens))
      ? { input: Number(tc.inputTokens) || 0, output: Number(tc.outputTokens) || 0 }
      : undefined;
  const tool = raw.toolFormerData ?? raw.toolCall ?? null;
  if (!text && !tool && !thinking) return null;
  return { role, text: thinking && raw.isThought ? '' : text, thinking, tool, ts, endTs, tokens };
}

/**
 * Pull every chat out of a `state.vscdb`. Both the current layout
 * (`composerData:` headers pointing at `bubbleId:` rows) and the older inline
 * `conversation` array are handled; whichever yields bubbles wins.
 */
export function readCursorDb(bytes: Uint8Array): { chats: CursorChat[]; notes: string[] } {
  const notes: string[] = [];
  const db = new SqliteDb(bytes);
  const kv = new Map<string, string>();
  for (const name of ['cursorDiskKV', 'ItemTable']) {
    if (!db.table(name)) continue;
    for (const row of db.scan(name)) {
      const key = row[0];
      const value = row[1];
      if (typeof key !== 'string') continue;
      kv.set(key, typeof value === 'string' ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : '');
    }
  }
  if (!kv.size) notes.push('Cursor: no cursorDiskKV/ItemTable rows found — the schema may have moved.');

  const chats: CursorChat[] = [];
  for (const [key, value] of kv) {
    if (!key.startsWith('composerData:')) continue;
    const data = json(value);
    if (!data) continue;
    const id = String(data.composerId ?? key.slice('composerData:'.length));
    const bubbles: Bubble[] = [];
    const headers = data.fullConversationHeadersOnly ?? data.conversationHeaders;
    if (Array.isArray(headers)) {
      for (const h of headers) {
        const bid = h?.bubbleId ?? h?.id;
        if (!bid) continue;
        const raw = json(kv.get(`bubbleId:${id}:${bid}`));
        const b = bubbleOf(raw);
        if (b) bubbles.push(b);
      }
    }
    if (!bubbles.length && Array.isArray(data.conversation)) {
      for (const raw of data.conversation) {
        const b = bubbleOf(raw);
        if (b) bubbles.push(b);
      }
    }
    if (!bubbles.length) continue;
    chats.push({
      id,
      title: String(data.name ?? data.title ?? '').trim() || oneLine(bubbles[0].text, 60) || id.slice(0, 8),
      createdAt: Number(data.createdAt ?? bubbles[0].ts ?? 0) || 0,
      bubbles,
    });
  }

  // Older builds keep everything under one workbench key.
  if (!chats.length) {
    for (const [key, value] of kv) {
      if (!key.includes('aichat')) continue;
      const data = json(value);
      const tabs = data?.tabs;
      if (!Array.isArray(tabs)) continue;
      for (const tab of tabs) {
        const bubbles = (Array.isArray(tab?.bubbles) ? tab.bubbles : [])
          .map(bubbleOf)
          .filter((b: Bubble | null): b is Bubble => !!b);
        if (!bubbles.length) continue;
        chats.push({
          id: String(tab.tabId ?? chats.length),
          title: String(tab.chatTitle ?? '').trim() || oneLine(bubbles[0].text, 60),
          createdAt: Number(tab.lastSendTime ?? 0) || 0,
          bubbles,
        });
      }
    }
    if (chats.length) notes.push('Cursor: read from the legacy aichat layout.');
  }

  chats.sort((a, b) => b.createdAt - a.createdAt || b.bubbles.length - a.bubbles.length);
  if (!chats.length) notes.push('Cursor: the database has no readable chats (it may be WAL-only or a newer schema).');
  return { chats, notes };
}

export class CursorAdapter {
  readonly b: Builder;

  constructor(id: string, name: string, bytes: number, confidence: number, cal: Calibration = {}) {
    this.b = new Builder(id, name, bytes, 'cursor', confidence, cal);
    this.b.note('Cursor records no per-request token usage: every token figure here is estimated.');
  }

  build(chat: CursorChat, parts: SessionPart[], notes: string[], parseMs: number): CanonSession {
    for (const n of notes) this.b.note(n);
    this.b.info.title = chat.title;
    this.b.info.sessionId = chat.id;
    let missingTs = 0;

    for (const bub of chat.bubbles) {
      const { ts, tsSource } = this.b.stamp(bub.ts);
      if (!bub.ts) missingTs++;

      if (bub.role === 'user' && bub.text.trim()) {
        this.b.openSegment(bub.text, ts);
        this.b.add(
          { kind: 'prompt', ts, tsSource, title: 'You', text: bub.text, format: 'md', cls: 'prose' },
          { start: 0, end: 0, block: -1 },
        );
        continue;
      }
      if (bub.thinking?.trim()) {
        this.b.add(
          {
            kind: 'reasoning',
            ts,
            tsSource,
            title: 'thinking',
            subtitle: oneLine(bub.thinking, 120),
            text: bub.thinking,
            format: 'md',
            cls: 'prose',
            collapsed: true,
          },
          { start: 0, end: 0, block: -1 },
        );
      }
      if (bub.text.trim()) {
        const idx = this.b.add(
          { kind: 'text', ts, tsSource, title: 'Cursor', text: bub.text, format: 'md', cls: 'prose' },
          { start: 0, end: 0, block: -1 },
        );
        if (bub.tokens) {
          this.b.events[idx].tokens.reported = {
            input: bub.tokens.input,
            cacheWrite: 0,
            cacheRead: 0,
            output: bub.tokens.output,
          };
        }
      }
      if (bub.tool) this.addTool(bub, ts, tsSource);
    }

    if (missingTs) {
      this.b.note(`Cursor: ${missingTs} messages carry no timestamp; durations and the busy clock are unavailable.`);
    }
    const session = this.b.finish(parseMs);
    if (parts.length > 1) session.parts = parts;
    return session;
  }

  private addTool(bub: Bubble, ts: number, tsSource: any): void {
    const t = bub.tool;
    const name = String(t.name ?? t.tool ?? 'tool');
    const category = categoryOf(name);
    if (!CATEGORY[name.toLowerCase()]) this.b.countUnknownTool(name);
    const params = typeof t.params === 'string' ? t.params : asText(t.params ?? t.rawArgs ?? t.args);
    const parsed = (() => {
      try {
        return typeof params === 'string' ? JSON.parse(params) : params;
      } catch {
        return {};
      }
    })();
    const target =
      parsed?.command ??
      parsed?.target_file ??
      parsed?.relative_workspace_path ??
      parsed?.path ??
      parsed?.query ??
      parsed?.url;
    const targetStr = typeof target === 'string' ? target : undefined;
    const op: OpFacts = {
      name,
      category,
      target: targetStr,
      subgroup: subgroupOf(category, targetStr),
      status: 'unpaired',
    };
    const argText = typeof params === 'string' ? params : asText(params);
    const idx = this.b.add(
      {
        kind: 'op',
        ts,
        tsSource,
        title: name,
        subtitle:
          category === 'execute' ? firstLine(targetStr ?? '')
          : targetStr ? shortPath(targetStr, this.b.info.cwd)
          : oneLine(argText, 120),
        text: argText,
        format: 'text',
        cls: 'json',
        collapsed: true,
        op,
        payloadIn: this.b.est(argText, 'json'),
      },
      { start: 0, end: 0, block: -1 },
    );

    if (category === 'plan') {
      const steps = extractSteps(argText.includes('\n') ? argText : asText(parsed));
      if (steps.length) {
        this.b.events[idx].plan = {
          source: 'plan-tool',
          role: 'revision',
          approved: true,
          text: steps.map((s) => `- ${s.text}`).join('\n'),
          steps,
        };
      }
    }

    const result = t.result ?? t.output;
    if (result === undefined || result === null) return;
    const text = stripAnsi(typeof result === 'string' ? result : asText(result));
    const isEdit = category === 'edit';
    const diff = isEdit ? countDiffLines(text) : undefined;
    const status = t.status === 'error' || /^error/i.test(text) ? 'error' : 'ok';
    this.b.close(idx, {
      text,
      format: isEdit && /^[-+@]/m.test(text) ? 'diff' : 'text',
      cls: isEdit ? 'code' : 'terminal',
      status,
      linesAdded: diff?.adds,
      linesRemoved: diff?.dels,
      ts: bub.endTs ?? 0,
    });
  }
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
 * Fallback intake: an exported chat, as JSON or as the markdown Cursor's
 * "export chat" produces. Used when the DB is too large or unreadable.
 */
export function parseExportedChat(text: string): CursorChat | null {
  const data = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();

  if (data) {
    const raw = Array.isArray(data) ? data : (data.bubbles ?? data.conversation ?? data.messages);
    if (Array.isArray(raw)) {
      const bubbles = raw
        .map((r: any) =>
          bubbleOf(r) ?? (typeof r?.content === 'string'
            ? { role: r.role === 'user' ? 'user' : 'assistant', text: r.content, ts: 0 }
            : null),
        )
        .filter((b): b is Bubble => !!b);
      if (bubbles.length) {
        return {
          id: String(data.composerId ?? 'export'),
          title: String(data.name ?? data.title ?? 'exported chat'),
          createdAt: Number(data.createdAt ?? 0) || 0,
          bubbles,
        };
      }
    }
    return null;
  }

  // Markdown export: sections headed by **User** / **Cursor**.
  const parts = text.split(/^_?\*\*(User|Cursor|Assistant)\*\*_?\s*$/m);
  if (parts.length < 3) return null;
  const bubbles: Bubble[] = [];
  for (let i = 1; i < parts.length; i += 2) {
    const role = parts[i] === 'User' ? 'user' : 'assistant';
    const body = (parts[i + 1] ?? '').trim();
    if (body) bubbles.push({ role, text: body, ts: 0 });
  }
  if (!bubbles.length) return null;
  return { id: 'export', title: oneLine(bubbles[0].text, 60) || 'exported chat', createdAt: 0, bubbles };
}
