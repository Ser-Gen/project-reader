/**
 * The metrics cache (SPEC D17).
 *
 * IndexedDB holds *computed numbers only* — never a message, a prompt, a file
 * body, a diff or an image. Reopening a session body still needs the file; only
 * the metrics come back instantly, which is what makes a folder-wide rollup
 * survive a reload without the tool ever having stored your code.
 */

import { METRICS_SCHEMA_VERSION, type SessionMetrics } from '../model/metrics.js';

const DB_NAME = 'project-reader';
const STORE = 'sessions';
const VERSION = 1;

export interface CacheEntry {
  key: string;
  schemaVersion: number;
  path: string;
  size: number;
  lastModified: number;
  metrics: SessionMetrics;
  computedAt: number;
}

/** File identity: a changed byte count or mtime invalidates the entry. */
export function cacheKey(path: string, size: number, lastModified: number): string {
  return `${path}|${size}|${lastModified}`;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        let store: IDBObjectStore;
        try {
          store = db.transaction(STORE, mode).objectStore(STORE);
        } catch {
          return resolve(null);
        }
        const req = run(store);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      }),
  );
}

export async function getCached(key: string): Promise<SessionMetrics | null> {
  const entry = (await tx<CacheEntry>('readonly', (s) => s.get(key) as IDBRequest<CacheEntry>)) as CacheEntry | null;
  if (!entry) return null;
  if (entry.schemaVersion !== METRICS_SCHEMA_VERSION) return null;
  return entry.metrics;
}

export async function putCached(
  key: string,
  path: string,
  size: number,
  lastModified: number,
  metrics: SessionMetrics,
): Promise<void> {
  const entry: CacheEntry = {
    key,
    schemaVersion: METRICS_SCHEMA_VERSION,
    path,
    size,
    lastModified,
    metrics,
    computedAt: Date.now(),
  };
  await tx('readwrite', (s) => s.put(entry) as IDBRequest<IDBValidKey>);
}

export async function listCached(): Promise<CacheEntry[]> {
  const all = (await tx<CacheEntry[]>('readonly', (s) => s.getAll() as IDBRequest<CacheEntry[]>)) ?? [];
  return all.filter((e) => e.schemaVersion === METRICS_SCHEMA_VERSION);
}

export async function clearCache(): Promise<void> {
  await tx('readwrite', (s) => s.clear() as IDBRequest<undefined>);
}

/** Rough on-disk size of the cache, for the settings line that offers to clear it. */
export async function cacheSize(): Promise<{ entries: number; bytes: number }> {
  const all = await listCached();
  let bytes = 0;
  for (const e of all) {
    try {
      bytes += JSON.stringify(e).length;
    } catch {
      /* ignore an entry we cannot measure */
    }
  }
  return { entries: all.length, bytes };
}
