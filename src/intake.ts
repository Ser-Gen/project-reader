/**
 * Getting files in (SPEC §7).
 *
 * Three mechanisms, chosen by what the browser can do: the File System Access
 * picker (Chromium — the only one whose handle can be persisted), a
 * `webkitdirectory` input (everywhere else), and drag-and-drop of folders. The
 * difference is stated in the UI once rather than silently endured.
 *
 * Scanning is fully lazy (D14): the tree is built from filesystem metadata plus
 * a 64 KB sniff, and nothing is parsed until a session is opened or "analyze
 * all" is invoked.
 */

import type { Vendor } from './model/canon.js';
import type { SessionMetrics } from './model/metrics.js';
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
  /** metrics came from the cache rather than this session's work */
  cached: boolean;
  analyzing: boolean;
}

export interface ProjectGroup {
  name: string;
  entries: FileEntry[];
  analyzed: number;
}

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
  private seq = 0;

  add(file: File, path: string): FileEntry | null {
    const rel = path || file.name;
    if (!isCandidate(rel, file.size)) return null;
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
      cached: false,
      analyzing: false,
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): FileEntry | undefined {
    return this.entries.get(id);
  }

  /** Group by project, newest file first inside each. */
  projects(): ProjectGroup[] {
    const groups = new Map<string, FileEntry[]>();
    for (const e of this.entries.values()) {
      if (e.vendor === 'unknown') continue;
      const name = e.metrics?.cwd ?? e.project;
      const list = groups.get(name);
      if (list) list.push(e);
      else groups.set(name, [e]);
    }
    return [...groups.entries()]
      .map(([name, entries]) => ({
        name,
        entries: entries.sort((a, b) => b.lastModified - a.lastModified),
        analyzed: entries.filter((e) => e.metrics).length,
      }))
      .sort((a, b) => b.entries[0].lastModified - a.entries[0].lastModified);
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
