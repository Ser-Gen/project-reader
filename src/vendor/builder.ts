/**
 * The machinery every adapter shares: body clipping, the worker-side body store,
 * segment opening, height estimation and the raw quality counters.
 *
 * Adapters decide *what* an event is; this decides how it is stored and paid for.
 */

import type {
  BodyFormat,
  CanonEvent,
  CanonKind,
  CanonSession,
  ImageRef,
  OpFacts,
  Segment,
  SessionInfo,
  TokenFacts,
  Vendor,
} from '../model/canon.js';
import { estTokens, type Calibration, type CalSample, type ContentClass } from '../metrics/estimate.js';
import { oneLine } from './text.js';

/** Bodies larger than this are truncated in the event and fetched on expand. */
export const INLINE_BODY = 16 * 1024;
/** How much of an over-sized body travels inline as the collapsed preview. */
export const PREVIEW_BODY = 8 * 1024;
/** Per-body retention cap inside the worker's store. */
export const STORE_BODY = 256 * 1024;
/** Total retention cap for the worker's body store. */
export const STORE_TOTAL = 64 * 1024 * 1024;

/** Where an event's full body can be re-read from. Worker-side only. */
export interface EventSource {
  start: number;
  end: number;
  /** index of the content block inside the record, -1 when the record is the body */
  block: number;
  /** full body, when it fit in the store */
  stored?: string;
  /** text used by search: the full body when retained, else the inline preview */
  search?: string;
  /** tool name, needed to rebuild an over-sized tool body on expand */
  tool?: string;
}

export interface RawQuality {
  unknownTypes: Map<string, number>;
  unknownTools: Map<string, number>;
  missingTs: number;
  interpolatedTs: number;
  clockAnomalies: { idx: number; from: number; to: number }[];
  orphanResults: number;
  duplicateIds: number;
  badLineOffsets: number[];
  notes: string[];
}

export interface AddSpec {
  kind: CanonKind;
  ts: number;
  tsSource?: CanonEvent['tsSource'];
  title: string;
  subtitle?: string;
  /** the full body; clipping and storage are handled here */
  text: string;
  format: BodyFormat;
  /** content class for token estimation; defaults from `format` */
  cls?: ContentClass;
  images?: ImageRef[];
  collapsed?: boolean;
  chips?: string[];
  op?: OpFacts;
  tokens?: TokenFacts;
  sidechain?: number;
  id?: string;
  parentId?: string;
  /** estimated tokens of the call's arguments, for op events */
  payloadIn?: number;
}

export interface ResultSpec {
  text: string;
  format: BodyFormat;
  cls?: ContentClass;
  chips?: string[];
  images?: ImageRef[];
  status: OpFacts['status'];
  exitCode?: number;
  linesAdded?: number;
  linesRemoved?: number;
  ts: number;
  /** vendor-reported duration, when there is one */
  durationMs?: number;
  /**
   * Estimated tokens the result pushed into the context, when the row shows
   * something other than what the model was handed.
   */
  payloadOut?: number;
}

function estimateHeight(kind: CanonKind, body: string, images?: ImageRef[]): number {
  let h = kind === 'prompt' ? 92 : 56;
  if (images?.length) h += images.length * 180;
  if (!body) return h;
  // ~90 chars per rendered line at the default width, 21px line-height, capped
  // because long bodies render collapsed.
  const lines = Math.min(body.length / 90 + (body.match(/\n/g)?.length ?? 0), 400);
  return Math.round(h + Math.min(lines * 21, 8400));
}

const DEFAULT_CLASS: Record<BodyFormat, ContentClass> = {
  md: 'prose',
  diff: 'code',
  text: 'terminal',
  ask: 'prose',
};

export class Builder {
  events: CanonEvent[] = [];
  sources: EventSource[] = [];
  segments: Segment[] = [];
  info: SessionInfo;
  quality: RawQuality = {
    unknownTypes: new Map(),
    unknownTools: new Map(),
    missingTs: 0,
    interpolatedTs: 0,
    clockAnomalies: [],
    orphanResults: 0,
    duplicateIds: 0,
    badLineOffsets: [],
    notes: [],
  };
  /** per-request samples used to fit the estimator against reported usage */
  samples: CalSample[] = [];

  private storeUsed = 0;
  private lastTs = 0;
  private readonly cal: Calibration;
  private readonly seenIds = new Set<string>();

  constructor(id: string, name: string, bytes: number, vendor: Vendor, confidence: number, cal: Calibration = {}) {
    this.cal = cal;
    this.info = {
      id,
      name,
      title: name,
      vendor,
      confidence,
      bytes,
      lines: 0,
      badLines: 0,
      startTs: 0,
      endTs: 0,
      parseMs: 0,
    };
  }

  est(text: string, cls: ContentClass): number {
    return estTokens(text, cls, this.cal);
  }

  /** Timestamp bookkeeping shared by every adapter: order, inheritance, skew. */
  stamp(ts: number): { ts: number; tsSource: CanonEvent['tsSource'] } {
    if (!ts) {
      if (this.lastTs) {
        this.quality.interpolatedTs++;
        return { ts: this.lastTs, tsSource: 'inherited' };
      }
      this.quality.missingTs++;
      return { ts: 0, tsSource: 'missing' };
    }
    if (this.lastTs && ts < this.lastTs) {
      this.quality.clockAnomalies.push({ idx: this.events.length, from: this.lastTs, to: ts });
    }
    this.lastTs = ts;
    if (!this.info.startTs) this.info.startTs = ts;
    if (ts > this.info.endTs) this.info.endTs = ts;
    return { ts, tsSource: 'record' };
  }

  add(spec: AddSpec, src: { start: number; end: number; block: number; tool?: string }): number {
    const idx = this.events.length;
    const clipped = this.clip(spec.text);
    const cls = spec.cls ?? DEFAULT_CLASS[spec.format];
    const id = spec.id ?? `e${idx}`;
    if (spec.id) {
      if (this.seenIds.has(spec.id)) this.quality.duplicateIds++;
      else this.seenIds.add(spec.id);
    }

    const tokens: TokenFacts = spec.tokens ?? { estimated: true };
    if (spec.kind === 'op') {
      tokens.payloadIn = spec.payloadIn ?? 0;
      tokens.estimated = true;
    } else if (spec.text) {
      tokens.payloadIn = this.est(spec.text, cls);
      tokens.estimated = true;
    }

    const ev: CanonEvent = {
      idx,
      id,
      parentId: spec.parentId,
      kind: spec.kind,
      ts: spec.ts,
      tsSource: spec.tsSource ?? (spec.ts ? 'record' : 'missing'),
      durationSource: 'unknown',
      seg: Math.max(0, this.segments.length - 1),
      op: spec.op,
      tokens,
      sidechain: spec.sidechain ?? 0,
      title: spec.title,
      subtitle: spec.subtitle,
      body: clipped.body,
      format: spec.format,
      more: clipped.more,
      fullLen: clipped.fullLen,
      chips: spec.chips?.length ? spec.chips : undefined,
      images: spec.images?.length ? spec.images : undefined,
      collapsed: spec.collapsed,
      est: estimateHeight(spec.kind, clipped.body, spec.images),
    };
    this.events.push(ev);

    const source: EventSource = { start: src.start, end: src.end, block: src.block, tool: src.tool };
    this.retain(source, spec.text, clipped.body);
    this.sources.push(source);

    const seg = this.segments[this.segments.length - 1];
    if (seg) {
      if (spec.kind === 'op') {
        seg.toolCount++;
        if (spec.op?.category === 'edit') seg.fileCount++;
      }
      if (spec.images?.length) seg.imageCount += spec.images.length;
    }
    return idx;
  }

  /** Attach an operation's result to the event its call created. */
  close(idx: number, res: ResultSpec, src?: { start: number; end: number; block: number }): void {
    const ev = this.events[idx];
    if (!ev || !ev.op) return;
    const clipped = this.clip(res.text);
    ev.body = clipped.body;
    ev.format = res.format;
    ev.more = clipped.more;
    ev.fullLen = clipped.fullLen;
    ev.chips = res.chips?.length ? res.chips : ev.chips;
    ev.op.status = res.status;
    if (res.exitCode !== undefined) ev.op.exitCode = res.exitCode;
    if (res.linesAdded !== undefined) ev.op.linesAdded = res.linesAdded;
    if (res.linesRemoved !== undefined) ev.op.linesRemoved = res.linesRemoved;
    ev.tokens.payloadOut = res.payloadOut ?? this.est(res.text, res.cls ?? DEFAULT_CLASS[res.format]);
    if (res.images?.length) {
      ev.images = res.images;
      // a screenshot *is* the result — showing it beats a row you have to open
      ev.collapsed = false;
      const seg = this.segments[ev.seg];
      if (seg) seg.imageCount += res.images.length;
    }
    if (res.ts) {
      ev.endTs = res.ts;
      if (ev.ts && res.ts >= ev.ts) {
        ev.durationMs = res.ts - ev.ts;
        ev.durationSource = 'derived';
      }
    }
    if (res.durationMs !== undefined && res.durationMs >= 0) {
      ev.durationMs = res.durationMs;
      ev.durationSource = 'reported';
    }
    ev.est = estimateHeight(ev.kind, ev.body, ev.images);

    if (src) {
      const s = this.sources[idx];
      s.start = src.start;
      s.end = src.end;
      s.block = src.block;
      s.tool = ev.op.name;
      s.stored = undefined;
      this.retain(s, res.text, clipped.body);
    }
  }

  openSegment(promptText: string, ts: number): void {
    const prev = this.segments[this.segments.length - 1];
    if (prev) prev.lastEvent = this.events.length - 1;
    this.segments.push({
      idx: this.segments.length,
      promptIdx: this.events.length,
      title: oneLine(promptText, 140) || '(empty prompt)',
      ts,
      firstEvent: this.events.length,
      lastEvent: this.events.length,
      toolCount: 0,
      imageCount: 0,
      fileCount: 0,
    });
  }

  note(text: string): void {
    if (!this.quality.notes.includes(text)) this.quality.notes.push(text);
  }

  countType(type: string): void {
    this.quality.unknownTypes.set(type, (this.quality.unknownTypes.get(type) ?? 0) + 1);
  }

  countUnknownTool(name: string): void {
    this.quality.unknownTools.set(name, (this.quality.unknownTools.get(name) ?? 0) + 1);
  }

  addSystem(title: string, subtitle: string, ts: number, start: number, end: number): void {
    this.add(
      { kind: 'system', ts, title, subtitle: subtitle || undefined, text: '', format: 'text' },
      { start, end, block: -1 },
    );
  }

  private clip(text: string): { body: string; more: boolean; fullLen: number } {
    if (text.length <= INLINE_BODY) return { body: text, more: false, fullLen: text.length };
    return { body: text.slice(0, PREVIEW_BODY), more: true, fullLen: text.length };
  }

  /** Keep the full body for expansion and search while under the memory cap. */
  private retain(src: EventSource, full: string, body: string): void {
    if (full.length > body.length) {
      if (full.length <= STORE_BODY && this.storeUsed + full.length <= STORE_TOTAL) {
        src.stored = full;
        this.storeUsed += full.length;
      }
    } else {
      src.stored = full;
    }
    src.search = src.stored ?? body;
  }

  finish(parseMs: number): CanonSession {
    // Segments: close the last one, synthesize one when the file has no prompts,
    // and give everything before the first prompt a preamble to live in.
    if (this.segments.length) {
      this.segments[this.segments.length - 1].lastEvent = this.events.length - 1;
    } else if (this.events.length) {
      this.segments.push({
        idx: 0,
        promptIdx: -1,
        title: 'Session',
        ts: this.info.startTs,
        firstEvent: 0,
        lastEvent: this.events.length - 1,
        toolCount: 0,
        imageCount: 0,
        fileCount: 0,
      });
    }
    if (this.segments.length && this.segments[0].firstEvent > 0) {
      this.segments.unshift({
        idx: 0,
        promptIdx: -1,
        title: 'Session start',
        ts: this.info.startTs,
        firstEvent: 0,
        lastEvent: this.segments[0].firstEvent - 1,
        toolCount: 0,
        imageCount: 0,
        fileCount: 0,
      });
      for (let i = 0; i < this.segments.length; i++) this.segments[i].idx = i;
    }
    for (const s of this.segments) {
      for (let e = s.firstEvent; e <= s.lastEvent && e < this.events.length; e++) this.events[e].seg = s.idx;
    }

    // Parallel fan-out: several calls issued in one request cannot have their
    // individual durations recovered, only their envelope.
    const byRequest = new Map<string, number[]>();
    for (const ev of this.events) {
      if (ev.kind !== 'op' || !ev.ts) continue;
      const key = `${ev.parentId ?? ''}|${ev.ts}`;
      const list = byRequest.get(key);
      if (list) list.push(ev.idx);
      else byRequest.set(key, [ev.idx]);
    }
    for (const list of byRequest.values()) {
      if (list.length < 2) continue;
      for (const i of list) {
        const ev = this.events[i];
        if (ev.durationSource === 'derived') ev.durationSource = 'shared';
      }
    }

    // Subagent work belongs to the call that spawned it.
    let lastAgent = -1;
    for (const ev of this.events) {
      if (ev.sidechain === 0 && ev.op?.category === 'agent') lastAgent = ev.idx;
      else if (ev.sidechain > 0 && lastAgent >= 0) ev.spawnedBy = lastAgent;
    }

    this.info.parseMs = parseMs;
    return { info: this.info, events: this.events, segments: this.segments };
  }
}
