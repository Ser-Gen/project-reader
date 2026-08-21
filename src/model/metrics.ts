/**
 * The analyzer's output contract.
 *
 * Every number carries provenance, because a figure the vendor reported and one
 * this tool guessed are not the same kind of fact, and the UI must never let them
 * look alike. `null` + `unavailable` renders as "—", never as 0.
 */

import type { OpCategory, PlanRevision, Vendor } from './canon.js';

/** Bumped whenever a metric definition changes; invalidates the IndexedDB cache. */
export const METRICS_SCHEMA_VERSION = 1;

export type Provenance = 'reported' | 'derived' | 'estimated' | 'unavailable';

export interface Metric {
  value: number | null;
  provenance: Provenance;
  /** fraction of relevant events that contributed; < 0.9 renders a warning marker */
  coverage?: number;
  note?: string;
}

export function metric(
  value: number | null,
  provenance: Provenance,
  coverage?: number,
  note?: string,
): Metric {
  const m: Metric = { value, provenance };
  if (coverage !== undefined) m.coverage = coverage;
  if (note !== undefined) m.note = note;
  return m;
}

export const unavailable = (note?: string): Metric => metric(null, 'unavailable', undefined, note);

/* ---------------- tokens ---------------- */

export interface TokenTotals {
  /** freshInput + output — the headline figure */
  headline: Metric;
  freshInput: Metric;
  output: Metric;
  cacheRead: Metric;
  billedInput: Metric;
  contextPeak: Metric;
  requests: Metric;
  reasoning: Metric;
  /** Σ payloadIn + payloadOut over operations — a different measure, never summed with the above */
  contextCost: Metric;
  opIn: Metric;
  opOut: Metric;
  /** of the totals above, how much came from subagent work */
  subagentOutput: Metric;
  subagentContextCost: Metric;
}

/* ---------------- operations ---------------- */

export interface OpRow {
  key: string;
  label: string;
  category: OpCategory;
  calls: number;
  ok: number;
  error: number;
  interrupted: number;
  unpaired: number;
  /** repeat calls with the same (name, target) inside one segment */
  retries: number;
  /** calls with a usable duration — the population behind totalMs/median/p95 */
  timedCalls: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
  /** true when some of the timings are parallel-call upper bounds */
  shared: boolean;
  tokensIn: number;
  tokensOut: number;
  /** fraction of the session's total operation context cost */
  share: number;
  /** first event index, for deep-linking into the timeline */
  firstIdx: number;
  idxs: number[];
  subgroups?: OpRow[];
}

export interface OpTotals {
  calls: number;
  failed: number;
  timedCalls: number;
  totalMs: number;
  tokensIn: number;
  tokensOut: number;
  subagentCalls: number;
}

export interface OpStats {
  byName: OpRow[];
  byCategory: OpRow[];
  totals: OpTotals;
}

/* ---------------- time ---------------- */

export interface IdleGap {
  from: number;
  to: number;
  ms: number;
  /** event index the gap starts at */
  idx: number;
}

export interface TimeStats {
  wall: Metric;
  active: Metric;
  busy: Metric;
  idleMs: Metric;
  idleGaps: IdleGap[];
  idleThresholdMs: number;
  /** turn start -> first operation */
  thinkMs: Metric;
  /** result -> next human prompt */
  humanMs: Metric;
}

/* ---------------- phases ---------------- */

export type PhaseId = 'PRE_PLAN' | 'PLANNING' | 'IMPLEMENTATION' | 'POST_PLAN' | 'NO_PLAN';

export const PHASE_LABEL: Record<PhaseId, string> = {
  PRE_PLAN: 'before the plan',
  PLANNING: 'planning',
  IMPLEMENTATION: 'implementation',
  POST_PLAN: 'after implementation',
  NO_PLAN: 'no plan',
};

export interface Boundary {
  ts: number;
  /** which rule produced it, shown verbatim in the UI */
  rule: string;
  confidence: 'observed' | 'inferred';
  /** true when a human dragged the marker */
  manual?: boolean;
}

export interface PhaseStats {
  id: PhaseId;
  from: number;
  to: number;
  firstIdx: number;
  lastIdx: number;
  wallMs: number;
  activeMs: number;
  busyMs: number;
  freshInput: number;
  output: number;
  cacheRead: number;
  contextCost: number;
  requests: number;
  prompts: number;
  ops: number;
  opsByCategory: Partial<Record<OpCategory, number>>;
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface PhaseModel {
  /** null when the conversation has no plan at all */
  planningStart: Boundary | null;
  planCreated: Boundary | null;
  implEnd: Boundary | null;
  end: Boundary;
  phases: PhaseStats[];
  /** index of the episode these boundaries describe */
  episode: number;
  episodeCount: number;
  /** tokens before/after planCreated — the headline answer to requirement 3 */
  beforePlan: { freshInput: number; output: number; contextCost: number; requests: number };
  afterPlan: { freshInput: number; output: number; contextCost: number; requests: number };
  tokensProvenance: Provenance;
}

/* ---------------- plan ---------------- */

export type PlanChangeKind = 'added' | 'removed' | 'reworded' | 'reordered' | 'status';

export interface PlanStepChange {
  kind: PlanChangeKind;
  from?: string;
  to?: string;
  status?: string;
}

export interface PlanDiff {
  /** revision index within PlanStats.revisions */
  rev: number;
  idx: number;
  ts: number;
  structural: boolean;
  changes: PlanStepChange[];
  /** which phase the edit happened in */
  afterImplStart: boolean;
}

export interface PlanStats {
  detected: boolean;
  source: PlanRevision['source'] | null;
  /** why detection landed where it did */
  reason: string;
  revisions: PlanRevision[];
  diffs: PlanDiff[];
  planRevisions: Metric;
  /** "how many edits were made to the plan" */
  planEdits: Metric;
  progressTicks: Metric;
  planEditsDuringPlanning: Metric;
  planEditsAfterImplStart: Metric;
  stepsAdded: Metric;
  stepsRemoved: Metric;
  stepsReworded: Metric;
  stepsReordered: Metric;
  planTextGrowth: Metric;
  stepsTotal: Metric;
  stepsDone: Metric;
  /** >=80% of revisions were status-only: it was a checklist, not a plan */
  checklistLike: boolean;
  /** approved plan revisions, one per episode */
  episodes: { rev: number; idx: number; ts: number }[];
}

/* ---------------- improvements ---------------- */

export interface Iteration {
  seg: number;
  idx: number;
  ts: number;
  title: string;
  ops: number;
  edits: number;
  files: string[];
  linesAdded: number;
  linesRemoved: number;
  freshInput: number;
  output: number;
  contextCost: number;
  durationMs: number;
}

export interface ImprovementStats {
  available: boolean;
  iterations: Metric;
  questions: Metric;
  rows: Iteration[];
  postPlanEdits: Metric;
  postPlanLinesAdded: Metric;
  postPlanLinesRemoved: Metric;
  unplannedEdits: Metric;
  unplannedShare: Metric;
  unplannedFiles: { path: string; edits: number }[];
  plannedFiles: { path: string; edits: number }[];
  /** every file touched after the plan, with its edit count */
  churn: { path: string; edits: number }[];
}

/* ---------------- quality ---------------- */

export interface QualityReport {
  vendor: Vendor;
  confidence: number;
  lines: number;
  badLines: number;
  badLineOffsets: number[];
  events: number;
  unknownTypes: { type: string; count: number }[];
  unknownTools: { name: string; count: number }[];
  missingTs: number;
  interpolatedTs: number;
  clockAnomalies: { idx: number; from: number; to: number }[];
  unpairedCalls: number;
  orphanResults: number;
  duplicateIds: number;
  /** vendor-level caveats: "Cursor records no token usage", ... */
  notes: string[];
  coverage: { timestamps: number; durations: number; tokens: number };
  calibration?: CalibrationReport;
}

export interface CalibrationReport {
  fitted: boolean;
  samples: number;
  factors: Record<string, number>;
  /** median absolute relative error of the estimator against reported usage */
  medianError: number | null;
  /** why the fit was refused, when it was */
  note?: string;
}

/* ---------------- the whole thing ---------------- */

export interface SessionMetrics {
  schemaVersion: number;
  vendor: Vendor;
  key: string;
  title: string;
  model?: string;
  cwd?: string;
  startTs: number;
  endTs: number;
  events: number;
  prompts: number;
  segments: number;
  bytes: number;
  tokens: TokenTotals;
  time: TimeStats;
  ops: OpStats;
  plan: PlanStats;
  phases: PhaseModel;
  improvements: ImprovementStats;
  quality: QualityReport;
}

/** Options a human can change; every one of them recomputes metrics, never re-parses. */
export interface MetricOptions {
  idleThresholdMs: number;
  /** force which plan artifact counts */
  planSource?: PlanRevision['source'] | 'none';
  /** manual boundary overrides, epoch ms */
  overrides?: Partial<Record<'planningStart' | 'planCreated' | 'implEnd', number>>;
  /** which plan episode the phase model describes */
  episode?: number;
  /** exclude subagent work from the operations table */
  mainThreadOnly?: boolean;
  calibration?: Record<string, number>;
}

export const DEFAULT_OPTIONS: MetricOptions = { idleThresholdMs: 15 * 60_000 };
