/**
 * Getting files in (SPEC §7).
 *
 * Three mechanisms, chosen by what the browser can do: the File System Access
 * picker (Chromium — the only one whose handle can be persisted), a
 * `webkitdirectory` input (everywhere else), and drag-and-drop of folders. The
 * difference is stated in the UI once rather than silently endured.
 *
 * Scanning stays lazy (D14): the tree is built from filesystem metadata, a
 * 64 KB vendor sniff and a bounded peek at each file's own header, and nothing
 * is fully parsed until a session is opened or "analyze all" is invoked. The
 * peek is what lets the list be right — real names, real projects, real start
 * times, and the links between dependent threads — before anything is clicked.
 */

import type { Vendor } from './model/canon.js';
import type { SessionMetrics } from './model/metrics.js';
import type { SessionIdentity } from './model/protocol.js';
import { jobLabel } from './vendor/merge.js';
import { cacheKey } from './store/cache.js';

export interface FileEntry {
  id: string;
  /** display name */
  name: string;
  /** path relative to the folder that was opened */
  path: string;
  file: File;
  size: number;
  lastModified: number;
  key: string;
  project: string;
  vendor: Vendor | 'unknown' | null;
  confidence: number;
  reason: string;
  metrics: SessionMetrics | null;
  /** what the file says about itself, read from its head at intake */
  identity: SessionIdentity | null;
  /** metrics came from the cache rather than this session's work */
  cached: boolean;
  analyzing: boolean;
}

/**
 * One openable session and the dependent threads that belong to it. A child is
 * not a session of its own: opening it opens the parent, at the child's work.
 */
export interface SessionNode {
  entry: FileEntry;
  children: FileEntry[];
}

export interface ProjectGroup {
  name: string;
  /** every file in the group, dependent threads included */
  entries: FileEntry[];
  /** the sessions, each with the threads that belong to it — what the sidebar draws */
  nodes: SessionNode[];
  /**
   * How many *sessions* have numbers. A dependent thread is never analyzed on
   * its own — it is read as part of its session — so counting the files would
   * report a folder as half-analyzed forever.
   */
  analyzed: number;
}

/** When a session began, by its own clock; the file's mtime only as a fallback. */
export function startOf(e: FileEntry): number {
  return e.identity?.startTs || e.metrics?.startTs || e.lastModified;
}

/** The session this file serves, when it is a dependent thread. */
export function parentIdOf(e: FileEntry): string | undefined {
  return e.identity?.thread?.parentId ?? e.metrics?.thread?.parentId;
}

export function sessionIdOf(e: FileEntry): string | undefined {
  return e.identity?.sessionId ?? e.metrics?.sessionId;
}

/** The name to show: the session's own, never the file's, when there is one. */
export function titleOf(e: FileEntry): string {
  return e.metrics?.title ?? e.identity?.title ?? e.name;
}

/**
 * What a runtime writes *beside* a dependent thread rather than inside it.
 *
 * Claude Code puts a subagent's transcript in `<session>/subagents/agent-<id>.jsonl`
 * and the job it was given in `agent-<id>.meta.json` next to it. The sidecar is
 * not a transcript and must never be listed as one — but it is the only place
 * the job can be read before anything is parsed, which is what the list needs.
 */
const SIDECAR = /(?:^|\/)agent-([A-Za-z0-9_-]+)\.meta\.json$/i;

const TEXT_EXT = /\.(jsonl|json|log|md|txt)$/i;
const DB_EXT = /\.(vscdb|sqlite|db)$/i;
/** Files that cannot be a transcript, skipped before they cost a sniff. */
const SKIP = /(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)|\.(png|jpe?g|gif|webp|zip|gz|mp4|wasm|map|lock)$/i;

export function isCandidate(path: string, size: number): boolean {
  if (SKIP.test(path)) return false;
  if (!size) return false;
  return TEXT_EXT.test(path) || DB_EXT.test(path) || !/\.[a-z0-9]{1,5}$/i.test(path);
}

/**
 * Which project a transcript belongs to.
 *
 * Agent history roots encode it in the directory (`~/.claude/projects/<slug>/`,
 * `~/.codex/sessions/YYYY/MM/DD/`); an arbitrary folder does not, so the `cwd`
 * recorded inside the transcript wins as soon as the session has been analyzed.
 */
export function projectOf(path: string, cwd?: string): string {
  if (cwd) return cwd;
  const parts = path.split('/').filter(Boolean);
  const projects = parts.indexOf('projects');
  if (projects >= 0 && parts[projects + 1]) return parts[projects + 1];
  const sessions = parts.indexOf('sessions');
  if (sessions >= 0) return parts.slice(0, sessions + 1).join('/') || 'sessions';
  if (parts.length > 1) return parts.slice(0, -1).join('/');
  return '(loose files)';
}

export class Registry {
  readonly entries = new Map<string, FileEntry>();
  /** thread id -> the runtime's own note about what that thread was asked to do */
  private readonly sidecars = new Map<string, File>();
  private seq = 0;

  add(file: File, path: string): FileEntry | null {
    const rel = path || file.name;
    if (!isCandidate(rel, file.size)) return null;
    const sidecar = SIDECAR.exec(rel);
    if (sidecar) {
      this.sidecars.set(sidecar[1], file);
      return null;
    }
    const key = cacheKey(rel, file.size, file.lastModified);
    for (const e of this.entries.values()) if (e.key === key) return e;
    const entry: FileEntry = {
      id: `f${++this.seq}`,
      name: file.name,
      path: rel,
      file,
      size: file.size,
      lastModified: file.lastModified,
      key,
      project: projectOf(rel),
      vendor: null,
      confidence: 0,
      reason: '',
      metrics: null,
      identity: null,
      cached: false,
      analyzing: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): FileEntry | undefined {
    return this.entries.get(id);
  }

  /** Apply what the head of the file said about itself. */
  identify(entry: FileEntry, identity: SessionIdentity): void {
    entry.identity = identity;
    if (identity.cwd) entry.project = identity.cwd;
  }

  /**
   * Give each dependent thread the name its parent gave it.
   *
   * A subagent transcript knows that it is a subagent and nothing else: its own
   * first prompt was written by the runtime, and five of them under one session
   * would otherwise be five rows reading "subagent". The job is recorded in two
   * places — the parent's tool call, which needs a full parse of a file that can
   * be tens of megabytes, and the sidecar next to the thread, which is a few
   * hundred bytes. This reads the cheap one.
   *
   * It names a lane and nothing else. The adapter stays the only thing that says
   * what a transcript *is*, so there is no second naming path to drift.
   */
  async nameThreads(): Promise<void> {
    if (!this.sidecars.size) return;
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const thread = entry.identity?.thread;
        const file = thread && entry.identity?.sessionId ? this.sidecars.get(entry.identity.sessionId) : undefined;
        if (!thread || !file) return;
        try {
          const meta = JSON.parse(await file.text());
          const job = String(meta?.description ?? meta?.agentType ?? '').trim();
          if (job) thread.label = jobLabel(job);
          if (meta?.agentType) thread.kind = String(meta.agentType);
        } catch {
          /* an unreadable sidecar leaves the thread with the name it had */
        }
      }),
    );
  }

  /** The loaded session this one is a thread of, when it is in the folder too. */
  parentOf(entry: FileEntry): FileEntry | undefined {
    const parent = parentIdOf(entry);
    if (!parent) return undefined;
    for (const e of this.entries.values()) {
      if (e.id !== entry.id && sessionIdOf(e) === parent) return e;
    }
    return undefined;
  }

  /**
   * The cache key for this session *as it will be read* — its own bytes plus
   * every thread merged into it. A session that gained a reviewer since the
   * numbers were cached is a different session, and must not be served the old
   * total.
   */
  mergedKey(entry: FileEntry): string {
    const kids = this.childrenOf(entry);
    return kids.length ? `${entry.key}+${kids.map((k) => k.key).join('+')}` : entry.key;
  }

  /** The dependent threads whose work belongs in this session's timeline. */
  childrenOf(entry: FileEntry): FileEntry[] {
    const id = sessionIdOf(entry);
    if (!id) return [];
    return [...this.entries.values()]
      .filter((e) => e.id !== entry.id && parentIdOf(e) === id)
      .sort((a, b) => startOf(a) - startOf(b));
  }

  /**
   * Group by project, newest session first inside each, dependent threads under
   * the session they serve.
   *
   * Ordering is by the session's own start time rather than the file's mtime,
   * which is when it was last *written* — a long session and a short one that
   * ran at the same time end up in the wrong order otherwise. A child never
   * sorts on its own: it lives where its parent lives, even when its own `cwd`
   * says something else, because it is part of that parent's work.
   */
  projects(): ProjectGroup[] {
    const all = [...this.entries.values()].filter((e) => e.vendor !== 'unknown');
    const byId = new Map<string, FileEntry>();
    for (const e of all) {
      const id = sessionIdOf(e);
      if (id && !byId.has(id)) byId.set(id, e);
    }
    const childrenOf = new Map<string, FileEntry[]>();
    const nested = new Set<string>();
    for (const e of all) {
      const parentId = parentIdOf(e);
      const parent = parentId ? byId.get(parentId) : undefined;
      if (!parent || parent.id === e.id) continue;
      const list = childrenOf.get(parent.id);
      if (list) list.push(e);
      else childrenOf.set(parent.id, [e]);
      nested.add(e.id);
    }

    const groups = new Map<string, SessionNode[]>();
    for (const e of all) {
      if (nested.has(e.id)) continue;
      const name = e.metrics?.cwd ?? e.project;
      const node: SessionNode = {
        entry: e,
        children: (childrenOf.get(e.id) ?? []).sort((a, b) => startOf(a) - startOf(b)),
      };
      const list = groups.get(name);
      if (list) list.push(node);
      else groups.set(name, [node]);
    }

    return [...groups.entries()]
      .map(([name, nodes]) => {
        nodes.sort((a, b) => startOf(b.entry) - startOf(a.entry));
        const entries = nodes.flatMap((n) => [n.entry, ...n.children]);
        return { name, nodes, entries, analyzed: nodes.filter((n) => n.entry.metrics).length };
      })
      .sort((a, b) => startOf(b.nodes[0].entry) - startOf(a.nodes[0].entry));
  }

  unrecognized(): FileEntry[] {
    return [...this.entries.values()].filter((e) => e.vendor === 'unknown');
  }
}

/* ---------------- traversal ---------------- */

export const canPickDirectory = (): boolean => typeof (window as any).showDirectoryPicker === 'function';

export interface PickedFile {
  file: File;
  path: string;
}

/** Walk a File System Access directory handle. */
export async function walkDirectoryHandle(handle: any, prefix = '', out: PickedFile[] = [], depth = 0): Promise<PickedFile[]> {
  if (depth > 12 || out.length > 20000) return out;
  for await (const [name, child] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (child.kind === 'directory') {
      if (SKIP.test(path + '/')) continue;
      await walkDirectoryHandle(child, path, out, depth + 1);
    } else {
      try {
        const file: File = await child.getFile();
        if (isCandidate(path, file.size)) out.push({ file, path });
      } catch {
        /* unreadable file — skipped, and the tree simply will not list it */
      }
    }
  }
  return out;
}

/** Walk a dropped folder through the legacy entries API (works everywhere). */
export async function walkDataTransfer(items: DataTransferItemList): Promise<PickedFile[]> {
  const roots: any[] = [];
  for (const item of Array.from(items)) {
    const entry = (item as any).webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const out: PickedFile[] = [];
  const readEntry = async (entry: any, prefix: string, depth: number): Promise<void> => {
    if (depth > 12 || out.length > 20000) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file: File = await new Promise((res, rej) => entry.file(res, rej));
      if (isCandidate(path, file.size)) out.push({ file, path });
      return;
    }
    if (!entry.isDirectory || SKIP.test(path + '/')) return;
    const reader = entry.createReader();
    for (;;) {
      const batch: any[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await readEntry(child, path, depth + 1);
    }
  };
  for (const root of roots) {
    try {
      await readEntry(root, '', 0);
    } catch {
      /* a folder we were not granted access to */
    }
  }
  return out;
}

/** Files from an `<input webkitdirectory>` or a plain multi-file input. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list).map((file) => ({
    file,
    path: (file as any).webkitRelativePath || file.name,
  }));
}
