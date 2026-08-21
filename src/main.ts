/**
 * App shell: intake, the worker pool, the session tree, and the wiring between
 * the reader (timeline) and the analyzer (dock).
 *
 * The reader stays the front door — the dock is collapsed until you ask for it —
 * and nothing is parsed until a session is opened, so pointing this at a folder
 * of ten thousand transcripts costs a directory listing and a 64 KB sniff each.
 */

import type { CanonSession } from './model/canon.js';
import type { MetricOptions, SessionMetrics } from './model/metrics.js';
import type { FromWorker, SearchHit, ToWorker } from './model/protocol.js';
import {
  canPickDirectory,
  filesFromInput,
  Registry,
  walkDataTransfer,
  walkDirectoryHandle,
  type FileEntry,
  type PickedFile,
} from './intake.js';
import { cacheSize, clearCache, getCached, putCached } from './store/cache.js';
import { optionsFor, prefs, savePrefs, saveOverrides } from './store/prefs.js';
import { mergeCalibration } from './metrics/estimate.js';
import { icon } from './view/icons.js';
import { CATEGORIES, countByCategory, type Category } from './view/kinds.js';
import { escapeHtml } from './view/markdown.js';
import { bytesHuman, msHuman, relTime, tokensHuman } from './view/rows.js';
import { Timeline, type Marker } from './view/timeline.js';
import { Dock } from './view/dock/index.js';
import { compareReport, sessionReport } from './view/report.js';

interface Loaded {
  entry: FileEntry;
  worker: Worker;
  session?: CanonSession;
  metrics?: SessionMetrics;
  progress: number;
  failed?: string;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $('app');
const elTree = $('tree');
const elPrompts = $('prompts');
const elQ = $<HTMLInputElement>('q');
const elTitle = $('ttl');
const elMeta = $('meta');
const elProg = $<HTMLElement>('prog');
const elProgBar = elProg.firstElementChild as HTMLElement;
const elDrop = $('drop');
const elFile = $<HTMLInputElement>('file');
const elDir = $<HTMLInputElement>('dir');
const elTypes = $('types');
const elSys = $<HTMLInputElement>('sys');
const elFold = $<HTMLButtonElement>('foldall');
const elLightbox = $('lightbox');
const elLightImg = elLightbox.firstElementChild as HTMLImageElement;
const elDock = $('dock');
const elDockToggle = $<HTMLButtonElement>('docktoggle');
const elPin = $('pin');
const elToast = $('toast');
const elGutter = $<HTMLCanvasElement>('gutter');
const elParts = $('parts');

const registry = new Registry();
const loaded = new Map<string, Loaded>();
const openOrder: string[] = [];
const MAX_OPEN = 4;

let active: Loaded | null = null;
let compareWith: SessionMetrics | null = null;
let reqSeq = 0;
const pending = new Map<number, (v: any) => void>();
let hits: SearchHit[] | null = null;
let lastQuery = '';
let activeSeg = -1;
let allFolded = true;
const typeFilter = new Set<Category>();

const timeline = new Timeline(
  $('scroller'),
  $('content'),
  {
    fetchBody: (idx) => request<{ body: string }>('expand', { idx }).then((r) => r.body),
    onImage: (src) => {
      elLightImg.src = src;
      elLightbox.hidden = false;
    },
    onTop: (topEventIdx) => {
      const seg = active?.session?.events[topEventIdx]?.seg ?? -1;
      if (seg !== activeSeg) {
        activeSeg = seg;
        markActiveSegment();
      }
    },
  },
  elGutter,
);

/* ---------------- worker pool ---------------- */

const POOL_SIZE = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
const pool: Worker[] = [];
const poolBusy = new Set<Worker>();
const poolQueue: { msg: ToWorker; done: (m: FromWorker) => void }[] = [];
const poolWaiters = new Map<number, { worker: Worker; done: (m: FromWorker) => void }>();

function newWorker(): Worker {
  return new Worker(new URL('./worker/parse.worker.ts', import.meta.url), { type: 'module' });
}

function poolRun(msg: ToWorker & { reqId: number }): Promise<FromWorker> {
  return new Promise((resolve) => {
    poolQueue.push({ msg, done: resolve });
    pumpPool();
  });
}

function pumpPool(): void {
  while (poolQueue.length) {
    let worker = pool.find((w) => !poolBusy.has(w));
    if (!worker && pool.length < POOL_SIZE) {
      worker = newWorker();
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const msg = e.data;
        const reqId = (msg as any).reqId as number | undefined;
        if (reqId === undefined) return;
        const waiter = poolWaiters.get(reqId);
        if (!waiter) return;
        poolWaiters.delete(reqId);
        poolBusy.delete(waiter.worker);
        waiter.done(msg);
        pumpPool();
      };
      pool.push(worker);
    }
    if (!worker) return;
    const task = poolQueue.shift()!;
    poolBusy.add(worker);
    poolWaiters.set((task.msg as any).reqId, { worker, done: task.done });
    worker.postMessage(task.msg);
  }
}

/* ---------------- intake ---------------- */

async function addFiles(picked: PickedFile[]): Promise<void> {
  const fresh: FileEntry[] = [];
  for (const p of picked) {
    const entry = registry.add(p.file, p.path);
    if (entry && entry.vendor === null) fresh.push(entry);
  }
  if (!fresh.length) {
    if (!registry.entries.size) toast('Nothing in there looked like a transcript.');
    return;
  }
  app.classList.remove('empty');
  renderTree();

  // Sniff in parallel across the pool; the tree fills in as answers arrive.
  let firstOpened = active !== null;
  await Promise.all(
    fresh.map(async (entry) => {
      const res = (await poolRun({ type: 'sniff', reqId: ++reqSeq, id: entry.id, file: entry.file })) as Extract<
        FromWorker,
        { type: 'sniffed' }
      >;
      entry.vendor = res.result.vendor;
      entry.confidence = res.result.confidence;
      entry.reason = res.result.reason;
      if (prefs().cacheEnabled) {
        const cached = await getCached(entry.key);
        if (cached) {
          entry.metrics = cached;
          entry.cached = true;
        }
      }
      renderTree();
      if (!firstOpened && entry.vendor !== 'unknown') {
        firstOpened = true;
        void select(entry);
      }
    }),
  );
  renderTree();
}

async function pickDirectory(): Promise<void> {
  try {
    const handle = await (window as any).showDirectoryPicker({ mode: 'read' });
    toast('Reading the folder…');
    const files = await walkDirectoryHandle(handle);
    await addFiles(files);
  } catch {
    /* the picker was dismissed */
  }
}

/* ---------------- opening a session ---------------- */

/** At most four sessions stay parsed; the rest give their worker back. */
function evict(): void {
  let guard = openOrder.length;
  while (openOrder.length > MAX_OPEN && guard-- > 0) {
    const id = openOrder.shift();
    if (!id) continue;
    if (id === active?.entry.id) {
      // never evict what is on screen — it goes to the back of the queue instead
      openOrder.push(id);
      continue;
    }
    const rec = loaded.get(id);
    if (!rec) continue;
    rec.worker.terminate();
    loaded.delete(id);
  }
}

async function select(entry: FileEntry): Promise<void> {
  hits = null;
  elQ.value = '';
  timeline.setPinned(null);
  elPin.hidden = true;

  let rec = loaded.get(entry.id);
  if (!rec) {
    const worker = newWorker();
    rec = { entry, worker, progress: 0 };
    worker.onmessage = (e: MessageEvent<FromWorker>) => onWorkerMessage(rec!, e.data);
    loaded.set(entry.id, rec);
    openOrder.push(entry.id);
    evict();
    worker.postMessage({ type: 'parse', fileId: entry.id, file: entry.file, options: optionsFor(entry.key) } as ToWorker);
  } else {
    const at = openOrder.indexOf(entry.id);
    if (at >= 0) openOrder.splice(at, 1);
    openOrder.push(entry.id);
  }
  active = rec;
  renderTree();
  if (rec.session) show(rec);
  else {
    elTitle.textContent = `Parsing ${entry.name}…`;
    elMeta.textContent = '';
    elProg.hidden = false;
    dock.setMetrics(null);
  }
}

function request<T>(type: 'expand' | 'search', body: Record<string, unknown>): Promise<T> {
  const rec = active;
  if (!rec) return Promise.resolve({} as T);
  const reqId = ++reqSeq;
  return new Promise<T>((resolve) => {
    pending.set(reqId, resolve);
    rec.worker.postMessage({ type, fileId: rec.entry.id, reqId, ...body } as unknown as ToWorker);
  });
}

function onWorkerMessage(rec: Loaded, msg: FromWorker): void {
  switch (msg.type) {
    case 'progress': {
      rec.progress = msg.total ? msg.bytes / msg.total : 0;
      if (rec === active) {
        elProg.hidden = false;
        elProgBar.style.width = `${Math.round(rec.progress * 100)}%`;
      }
      break;
    }
    case 'done': {
      rec.session = msg.session;
      rec.metrics = msg.metrics;
      rec.progress = 1;
      rec.entry.metrics = msg.metrics;
      rec.entry.cached = false;
      rec.entry.project = msg.metrics.cwd ?? rec.entry.project;
      absorbCalibration(msg.metrics);
      if (prefs().cacheEnabled) {
        void putCached(rec.entry.key, rec.entry.path, rec.entry.size, rec.entry.lastModified, msg.metrics);
      }
      renderTree();
      if (rec === active) show(rec);
      break;
    }
    case 'metrics': {
      rec.metrics = msg.metrics;
      rec.entry.metrics = msg.metrics;
      if (rec === active) {
        dock.setMetrics(msg.metrics);
        applyMarkers(rec);
        renderMeta(rec);
      }
      break;
    }
    case 'failed': {
      rec.failed = msg.message;
      if (rec === active) {
        elTitle.textContent = `Could not read ${rec.entry.name}`;
        elMeta.innerHTML = `<span>${escapeHtml(msg.message)}</span>`;
        elProg.hidden = true;
        dock.setMetrics(null);
      }
      renderTree();
      break;
    }
    case 'expanded': {
      pending.get(msg.reqId)?.({ body: msg.body });
      pending.delete(msg.reqId);
      break;
    }
    case 'results': {
      pending.get(msg.reqId)?.({ hits: msg.hits, capped: msg.capped });
      pending.delete(msg.reqId);
      break;
    }
    default:
      break;
  }
}

/**
 * Keep the estimator honest: Claude reports real usage, so each session it
 * parses refines the per-class divisors that Cursor and Codex then inherit.
 */
function absorbCalibration(m: SessionMetrics): void {
  const cal = m.quality.calibration;
  if (!cal?.fitted) return;
  const merged = mergeCalibration([prefs().calibration], cal.factors);
  savePrefs({ calibration: merged });
}

function show(rec: Loaded): void {
  const s = rec.session!;
  elProg.hidden = true;
  elTitle.textContent = s.info.title || rec.entry.name;
  renderMeta(rec);
  typeFilter.clear();
  timeline.setFilter(typeFilter);
  timeline.setSession(s);
  applyMarkers(rec);
  activeSeg = -1;
  renderTypes();
  renderPrompts();
  dock.setMetrics(rec.metrics ?? null);
}

function renderMeta(rec: Loaded): void {
  const s = rec.session!;
  // One Cursor database holds every chat; the reader opens one at a time.
  const chats = s.parts ?? [];
  elParts.hidden = chats.length < 2;
  if (chats.length > 1) {
    elParts.innerHTML =
      `<select id="partsel" title="this file holds ${chats.length} conversations">` +
      chats
        .map(
          (p) =>
            `<option value="${escapeHtml(p.id)}"${p.id === s.info.sessionId ? ' selected' : ''}>` +
            `${escapeHtml(p.title)} · ${p.messages} messages</option>`,
        )
        .join('') +
      `</select>`;
  }
  const m = rec.metrics;
  const dur = s.info.endTs && s.info.startTs ? relTime(s.info.endTs, s.info.startTs).slice(1) : '';
  const parts = [
    s.info.vendor + (s.info.confidence < 0.5 ? ' (guessed)' : ''),
    s.info.startTs ? new Date(s.info.startTs).toLocaleString() : '',
    dur ? `${dur} elapsed` : '',
    `${s.events.length} events`,
    `${s.segments.filter((g) => g.promptIdx >= 0).length} prompts`,
    `${bytesHuman(s.info.bytes)} · ${s.info.lines} lines · parsed in ${s.info.parseMs}ms`,
    s.info.model ?? '',
    s.info.cwd ?? '',
    m && m.tokens.headline.value !== null ? `${tokensHuman(m.tokens.headline.value)} tokens` : '',
    m && m.ops.totals.calls ? `${m.ops.totals.calls} ops` : '',
    m && m.time.busy.value ? `${msHuman(m.time.busy.value)} busy` : '',
    s.info.badLines ? `${s.info.badLines} unparsable lines` : '',
  ].filter(Boolean);
  elMeta.innerHTML = parts.map((t) => `<span>${escapeHtml(t)}</span>`).join('');
}

/** Phase boundaries, plan revisions and compactions, drawn into the timeline. */
function applyMarkers(rec: Loaded): void {
  const s = rec.session;
  const m = rec.metrics;
  if (!s) return;
  const markers = new Map<number, Marker[]>();
  const put = (idx: number, mk: Marker) => {
    const list = markers.get(idx);
    if (list) list.push(mk);
    else markers.set(idx, [mk]);
  };
  const atTs = (ts: number): number => {
    if (!ts) return -1;
    for (const ev of s.events) if (ev.ts && ev.ts >= ts) return ev.idx;
    return -1;
  };

  for (const ev of s.events) {
    if (ev.kind === 'compaction') put(ev.idx, { label: 'context compacted', kind: 'compaction' });
  }
  if (m?.plan.detected) {
    for (const d of m.plan.diffs) {
      if (d.structural) put(d.idx, { label: `plan edited · ${d.changes.length} change(s)`, kind: 'plan' });
    }
    const bounds: [string, number | undefined][] = [
      ['planning started', m.phases.planningStart?.ts],
      ['plan created', m.phases.planCreated?.ts],
      ['implementation ended', m.phases.implEnd?.ts],
    ];
    for (const [label, ts] of bounds) {
      const idx = atTs(ts ?? 0);
      if (idx >= 0) put(idx, { label, kind: 'phase' });
    }
  }
  timeline.setMarkers(markers);
}

/* ---------------- the dock ---------------- */

const dock = new Dock(elDock, {
  focus: (idxs, label) => {
    if (!idxs || !idxs.length) {
      timeline.setPinned(null);
      elPin.hidden = true;
      return;
    }
    timeline.setPinned(new Set(idxs));
    elPin.hidden = false;
    elPin.innerHTML = `showing <b>${escapeHtml(label)}</b><button class="ghost sm" id="unpin">show everything</button>`;
    timeline.scrollToEvent(idxs[0]);
  },
  scrollTo: (idx) => timeline.scrollToEvent(idx),
  topTs: () => active?.session?.events[timeline.topEvent()]?.ts ?? 0,
  setOptions: (patch) => applyOptions(patch),
  chooseCompare: (id) => void chooseCompare(id),
  sessionChoices: () =>
    [...registry.entries.values()]
      .filter((e) => e.id !== active?.entry.id && e.vendor && e.vendor !== 'unknown')
      .slice(0, 200)
      .map((e) => ({ id: e.id, title: e.metrics?.title ?? e.name })),
  exportReport: () => exportReport(),
});

elParts.addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  const rec = active;
  if (!rec || !sel.value) return;
  elTitle.textContent = 'Opening…';
  elProg.hidden = false;
  rec.session = undefined;
  rec.worker.postMessage({
    type: 'parse',
    fileId: rec.entry.id,
    file: rec.entry.file,
    options: optionsFor(rec.entry.key),
    part: sel.value,
  } as ToWorker);
});

elPin.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).id === 'unpin') {
    timeline.setPinned(null);
    elPin.hidden = true;
  }
});

/** Every option change recomputes metrics in the worker; nothing is re-parsed. */
function applyOptions(patch: Partial<MetricOptions>): void {
  const rec = active;
  if (!rec) return;
  const key = rec.entry.key;
  if (patch.overrides) {
    saveOverrides(key, patch.overrides as any);
  }
  if (patch.episode !== undefined) saveOverrides(key, { episode: patch.episode });
  if (patch.planSource !== undefined) saveOverrides(key, { planSource: patch.planSource });
  if (patch.idleThresholdMs !== undefined) savePrefs({ idleThresholdMs: patch.idleThresholdMs });
  if (patch.mainThreadOnly !== undefined) savePrefs({ mainThreadOnly: patch.mainThreadOnly });

  const reqId = ++reqSeq;
  rec.worker.postMessage({ type: 'recompute', fileId: rec.entry.id, reqId, options: optionsFor(key) } as ToWorker);
}

async function chooseCompare(id: string): Promise<void> {
  if (!id) {
    compareWith = null;
    dock.setCompare(null);
    return;
  }
  const entry = registry.get(id);
  if (!entry) return;
  if (!entry.metrics) {
    toast(`Analyzing ${entry.name}…`);
    await analyzeEntry(entry);
  }
  compareWith = entry.metrics;
  dock.setCompare(compareWith);
  renderTree();
}

function exportReport(): void {
  const m = active?.metrics;
  if (!m) return;
  const redact = prefs().redactExports;
  const text = compareWith ? compareReport(m, compareWith, { redact }) : sessionReport(m, { redact });
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast(`Markdown report copied${redact ? ' (paths redacted)' : ''}.`))
    .catch(() => download(`${m.title || 'report'}.md`, text));
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[^\w.-]+/g, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Report downloaded.');
}

/* ---------------- analyze all ---------------- */

async function analyzeEntry(entry: FileEntry): Promise<void> {
  if (entry.metrics || entry.analyzing || entry.vendor === 'unknown') return;
  entry.analyzing = true;
  renderTree();
  if (prefs().cacheEnabled) {
    const cached = await getCached(entry.key);
    if (cached) {
      entry.metrics = cached;
      entry.cached = true;
      entry.analyzing = false;
      renderTree();
      return;
    }
  }
  const res = (await poolRun({
    type: 'analyze',
    reqId: ++reqSeq,
    id: entry.id,
    file: entry.file,
    options: optionsFor(entry.key),
  })) as Extract<FromWorker, { type: 'analyzed' }>;
  entry.analyzing = false;
  if (res.metrics) {
    entry.metrics = res.metrics;
    entry.project = res.metrics.cwd ?? entry.project;
    absorbCalibration(res.metrics);
    if (prefs().cacheEnabled) {
      void putCached(entry.key, entry.path, entry.size, entry.lastModified, res.metrics);
    }
  } else {
    entry.reason = res.message ?? 'could not be analyzed';
  }
  renderTree();
}

let analyzing = false;

async function analyzeAll(project: string): Promise<void> {
  if (analyzing) return;
  const group = registry.projects().find((p) => p.name === project);
  if (!group) return;
  const todo = group.entries.filter((e) => !e.metrics);
  if (!todo.length) return;
  analyzing = true;
  renderTree();
  let done = 0;
  await Promise.all(
    todo.map(async (entry) => {
      await analyzeEntry(entry);
      done++;
      toast(`Analyzing ${project}: ${done}/${todo.length}`);
    }),
  );
  analyzing = false;
  toast(`${project}: ${todo.length} sessions analyzed.`);
  renderTree();
}

/* ---------------- the tree ---------------- */

function summaryOf(e: FileEntry): string {
  const m = e.metrics;
  if (e.analyzing) return 'analyzing…';
  if (!m) return bytesHuman(e.size);
  const bits = [
    m.tokens.headline.value !== null ? tokensHuman(m.tokens.headline.value) : `~${tokensHuman(m.tokens.contextCost.value ?? 0)}`,
    `${m.ops.totals.calls} ops`,
    m.plan.detected ? `${m.plan.planEdits.value ?? 0} plan edits` : 'no plan',
  ];
  return bits.join(' · ');
}

function renderTree(): void {
  const groups = registry.projects();
  if (!groups.length && !registry.unrecognized().length) {
    elTree.textContent = '';
    return;
  }
  const html = groups
    .map((g) => {
      const partial = g.analyzed < g.entries.length;
      const head =
        `<div class="pgrp"><b title="${escapeHtml(g.name)}">${escapeHtml(shorten(g.name))}</b>` +
        `<span class="cnt">${g.analyzed} of ${g.entries.length} analyzed</span>` +
        (partial
          ? `<button class="ghost sm" data-analyze="${escapeHtml(g.name)}" ${analyzing ? 'disabled' : ''}>analyze all</button>`
          : '') +
        `</div>`;
      const rows = g.entries
        .map((e) => {
          const on = e.id === active?.entry.id;
          const cmp = compareWith && e.metrics?.key === compareWith.key ? ' cmp' : '';
          return (
            `<button class="sess${on ? ' on' : ''}${cmp}" data-id="${e.id}">` +
            `<span class="vd v-${e.vendor ?? 'pending'}">${escapeHtml(e.vendor ?? '…')}</span>` +
            `<b>${escapeHtml(e.metrics?.title ?? e.name)}</b>` +
            `<span class="sub">${escapeHtml(summaryOf(e))}${e.cached ? ' · cached' : ''}</span>` +
            `</button>`
          );
        })
        .join('');
      return head + rows;
    })
    .join('');

  const unknown = registry.unrecognized();
  const unknownHtml = unknown.length
    ? `<div class="pgrp"><b>unrecognized</b><span class="cnt">${unknown.length}</span></div>` +
      unknown
        .slice(0, 50)
        .map(
          (e) =>
            `<div class="sess dim" title="${escapeHtml(e.reason)}"><b>${escapeHtml(e.name)}</b>` +
            `<span class="sub">${escapeHtml(e.reason || 'not a transcript')}</span></div>`,
        )
        .join('')
    : '';

  elTree.innerHTML = html + unknownHtml;
}

function shorten(name: string): string {
  const parts = name.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : name;
}

elTree.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const project = target.closest<HTMLElement>('[data-analyze]')?.dataset.analyze;
  if (project) {
    void analyzeAll(project);
    return;
  }
  const id = target.closest<HTMLElement>('.sess')?.dataset.id;
  const entry = id && registry.get(id);
  if (entry) void select(entry);
});

/* ---------------- type filter ---------------- */

function renderTypes(): void {
  const s = active?.session;
  if (!s) {
    elTypes.textContent = '';
    return;
  }
  const counts = countByCategory(s.events);
  const chips = CATEGORIES.map((c) => {
    const n = counts[c.key];
    const on = typeFilter.has(c.key);
    return (
      `<button class="ty c-${c.key}${on ? ' on' : ''}${n ? '' : ' empty'}" data-cat="${c.key}"` +
      ` type="button" aria-pressed="${on}" ${n ? '' : 'disabled '}title="${escapeHtml(c.label)} — ${n}">` +
      icon(c.key) +
      `<span class="n">${n}</span></button>`
    );
  }).join('');
  const showing = typeFilter.size
    ? `<button class="ty clear" data-cat="" type="button" title="clear the type filter">` +
      `showing ${timeline.visibleCount.toLocaleString()} ×</button>`
    : '';
  elTypes.innerHTML = chips + showing;
}

elTypes.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.ty');
  if (!btn) return;
  const cat = btn.dataset.cat as Category | '';
  if (!cat) typeFilter.clear();
  else if (typeFilter.has(cat)) typeFilter.delete(cat);
  else typeFilter.add(cat);
  timeline.setPinned(null);
  elPin.hidden = true;
  timeline.setFilter(typeFilter);
  renderTypes();
});

/* ---------------- prompts ---------------- */

function mark(text: string, query: string): string {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const needle = escapeHtml(query).toLowerCase();
  const hay = safe.toLowerCase();
  let out = '';
  let at = 0;
  for (;;) {
    const i = hay.indexOf(needle, at);
    if (i === -1) break;
    out += safe.slice(at, i) + '<mark>' + safe.slice(i, i + needle.length) + '</mark>';
    at = i + needle.length;
  }
  return out + safe.slice(at);
}

function renderPrompts(): void {
  const s = active?.session;
  if (!s) {
    elPrompts.textContent = '';
    return;
  }

  if (hits) {
    elPrompts.innerHTML =
      hits.length === 0
        ? `<div class="pr"><span class="n">no matches</span></div>`
        : hits
            .map((h) => {
              const ev = s.events[h.idx];
              const seg = ev ? s.segments[ev.seg] : undefined;
              const where = seg && seg.promptIdx >= 0 ? ` · #${seg.idx}` : '';
              return `<button class="pr" data-ev="${h.idx}"><span class="n">${escapeHtml(
                ev?.op?.name ?? ev?.title ?? '',
              )}${h.count > 1 ? ` · ${h.count}×` : ''}${where}</span><div class="ex">${mark(h.excerpt, lastQuery)}</div></button>`;
            })
            .join('');
    return;
  }

  const q = elQ.value.trim().toLowerCase();
  const rows = s.segments
    .filter((g) => (q ? g.title.toLowerCase().includes(q) : true))
    .map((g) => {
      const stats = [
        g.toolCount ? `${g.toolCount} tools` : '',
        g.fileCount ? `${g.fileCount} files` : '',
        g.imageCount ? `${g.imageCount} img` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const n = g.promptIdx >= 0 ? `#${g.idx}` : '·';
      return (
        `<button class="pr" data-seg="${g.idx}" data-ev="${g.promptIdx >= 0 ? g.promptIdx : g.firstEvent}">` +
        `<span class="n">${n} ${relTime(g.ts, s.info.startTs)}</span>` +
        `<div class="t">${escapeHtml(g.title)}</div>` +
        (stats ? `<div class="st">${escapeHtml(stats)}</div>` : '') +
        `</button>`
      );
    });
  elPrompts.innerHTML = rows.join('') || `<div class="pr"><span class="n">no prompts match</span></div>`;
  markActiveSegment();
}

function markActiveSegment(): void {
  if (hits) return;
  for (const el of elPrompts.children) {
    const on = (el as HTMLElement).dataset.seg === String(activeSeg);
    el.classList.toggle('on', on);
    if (on) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }
}

function segmentButtons(): HTMLElement[] {
  return Array.from(elPrompts.querySelectorAll<HTMLElement>('.pr[data-seg]'));
}

function gotoSegment(delta: number): void {
  const btns = segmentButtons();
  if (!btns.length) return;
  const cur = btns.findIndex((b) => b.dataset.seg === String(activeSeg));
  const next = btns[Math.max(0, Math.min((cur < 0 ? 0 : cur) + delta, btns.length - 1))];
  if (next) timeline.scrollToEvent(Number(next.dataset.ev));
}

elPrompts.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.pr[data-ev]');
  if (btn) timeline.scrollToEvent(Number(btn.dataset.ev));
});

let searchTimer = 0;
elQ.addEventListener('input', () => {
  clearTimeout(searchTimer);
  if (hits) hits = null;
  searchTimer = window.setTimeout(renderPrompts, 60);
});

elQ.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const q = elQ.value.trim();
    if (q.length < 2) return;
    lastQuery = q;
    void request<{ hits: SearchHit[] }>('search', { query: q }).then((r) => {
      hits = r.hits;
      renderPrompts();
    });
  } else if (e.key === 'Escape') {
    elQ.value = '';
    hits = null;
    renderPrompts();
    elQ.blur();
  }
});

/* ---------------- chrome ---------------- */

elSys.addEventListener('change', () => timeline.setShowSystem(elSys.checked));

elFold.addEventListener('click', () => {
  allFolded = !allFolded;
  timeline.setAllFolded(allFolded);
  elFold.textContent = allFolded ? 'unfold all' : 'fold all';
});

elDockToggle.addEventListener('click', () => {
  const open = !dock.open;
  dock.setOpen(open);
  savePrefs({ dockOpen: open });
  app.classList.toggle('with-dock', open);
  requestAnimationFrame(() => timeline.paintGutter());
});

elLightbox.addEventListener('click', () => {
  elLightbox.hidden = true;
  elLightImg.removeAttribute('src');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !elLightbox.hidden) {
    elLightbox.hidden = true;
    return;
  }
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing) return;
  if (e.key === '/') {
    e.preventDefault();
    elQ.focus();
  } else if (e.key === 'j') {
    e.preventDefault();
    gotoSegment(1);
  } else if (e.key === 'k') {
    e.preventDefault();
    gotoSegment(-1);
  } else if (e.key === 'a') {
    elDockToggle.click();
  }
});

/* drag & drop over the whole window */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  elDrop.classList.add('over');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    elDrop.classList.remove('over');
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  elDrop.classList.remove('over');
  const dt = e.dataTransfer;
  if (!dt) return;
  // A dropped folder only exists through the entries API; fall back to the flat
  // file list when the browser does not offer it.
  if (dt.items?.length && (dt.items[0] as any).webkitGetAsEntry) {
    void walkDataTransfer(dt.items).then((files) => addFiles(files.length ? files : filesFromInput(dt.files)));
  } else if (dt.files.length) {
    void addFiles(filesFromInput(dt.files));
  }
});

elFile.addEventListener('change', () => {
  if (elFile.files?.length) void addFiles(filesFromInput(elFile.files));
});
elDir.addEventListener('change', () => {
  if (elDir.files?.length) void addFiles(filesFromInput(elDir.files));
});
$('browse').addEventListener('click', () => elFile.click());
$('browsedir').addEventListener('click', () => {
  if (canPickDirectory()) void pickDirectory();
  else elDir.click();
});
$('openfolder').addEventListener('click', () => {
  if (canPickDirectory()) void pickDirectory();
  else elDir.click();
});

$('clearcache').addEventListener('click', () => {
  void clearCache().then(() => {
    toast('Cached metrics cleared.');
    void refreshCacheLine();
  });
});

async function refreshCacheLine(): Promise<void> {
  const { entries, bytes } = await cacheSize();
  $('cacheline').textContent = entries
    ? `${entries} sessions cached · ${bytesHuman(bytes)}`
    : 'nothing cached yet';
}

let toastTimer = 0;
function toast(text: string): void {
  elToast.textContent = text;
  elToast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    elToast.hidden = true;
  }, 2600);
}

/* ---------------- boot ---------------- */

(function boot(): void {
  const p = prefs();
  elDock.style.width = `${p.dockWidth}px`;
  dock.setOpen(p.dockOpen);
  app.classList.toggle('with-dock', p.dockOpen);
  if (!canPickDirectory()) {
    $('dirnote').textContent =
      'This browser cannot remember a folder; pick it again after a reload (Chromium can keep it).';
  }
  void refreshCacheLine();
})();

/* dock resizing */
(function dockResize(): void {
  const grip = $('dockgrip');
  let startX = 0;
  let startW = 0;
  const move = (e: PointerEvent) => {
    const w = Math.max(320, Math.min(900, startW + (startX - e.clientX)));
    elDock.style.width = `${w}px`;
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    savePrefs({ dockWidth: elDock.getBoundingClientRect().width });
    timeline.paintGutter();
  };
  grip.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startW = elDock.getBoundingClientRect().width;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();
