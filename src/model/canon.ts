/**
 * The vendor-neutral event model.
 *
 * Every adapter (Claude, Codex, Cursor) produces exactly this shape, and every
 * metric is computed from it. No metric code may branch on vendor — that rule is
 * what makes cross-agent comparison mean anything.
 */

export type Vendor = 'claude' | 'codex' | 'cursor';

export type CanonKind =
  | 'prompt' // human message — these are what the sidebar lists
  | 'text' // assistant prose
  | 'reasoning' // thinking / reasoning block
  | 'op' // a tool/command invocation paired with its result
  | 'plan' // a plan revision was emitted
  | 'compaction' // context was compacted
  | 'error' // api error, refusal, aborted turn
  | 'notice' // attachments, mode switches, user-edited-file notices
  | 'system'; // bookkeeping, hidden by default

/** Vendor-neutral operation categories. The only fair axis for cross-agent grouping. */
export type OpCategory =
  | 'read'
  | 'edit'
  | 'execute'
  | 'search'
  | 'web'
  | 'plan'
  | 'ask'
  | 'agent'
  | 'other';

export const OP_CATEGORIES: OpCategory[] = [
  'read',
  'search',
  'edit',
  'execute',
  'web',
  'plan',
  'ask',
  'agent',
  'other',
];

/** How the body text should be painted. */
export type BodyFormat = 'md' | 'text' | 'diff' | 'ask';

export type OpStatus = 'ok' | 'error' | 'interrupted' | 'unpaired';

export interface ImageRef {
  /** blob: URL minted inside the worker — the base64 never reaches the UI thread. */
  url: string;
  w: number;
  h: number;
  bytes: number;
}

/**
 * Two token measures that are never added together (SPEC D3):
 * `reported` is what the vendor billed for a request; `payloadIn/Out` is the
 * estimated size of the content one operation pushed into the conversation.
 */
export interface TokenFacts {
  reported?: {
    input: number; // fresh input tokens
    cacheWrite: number; // cache_creation_input_tokens
    cacheRead: number; // cache_read_input_tokens
    output: number;
    reasoning?: number; // where the vendor separates it out of output
  };
  payloadIn?: number; // estimated tokens of the op's arguments
  payloadOut?: number; // estimated tokens of the op's result
  /** true when any figure above came from the heuristic rather than the vendor */
  estimated: boolean;
}

export interface OpFacts {
  /** vendor tool name, verbatim: "Bash", "shell", "edit_file" */
  name: string;
  category: OpCategory;
  /** "npm test", ".ts", "docs.anthropic.com" — the drill-down key */
  subgroup?: string;
  /** file path, url, command, query */
  target?: string;
  status: OpStatus;
  exitCode?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

/**
 * A plan signal, emitted by the adapter so that plan metrics never have to know
 * that `ExitPlanMode`, `update_plan` and a `Write` to `PLAN.md` are three ways
 * of saying the same thing.
 */
export interface PlanArtifact {
  source: 'plan-mode' | 'plan-tool' | 'file';
  /** 'start' = planning was entered; 'revision' = a plan text exists */
  role: 'start' | 'revision';
  approved: boolean;
  text: string;
  steps: PlanStep[];
  path?: string;
  /** the revision is a fragment (an edit to a plan file), not the whole plan */
  partial?: boolean;
}

export interface CanonEvent {
  idx: number;
  id: string;
  parentId?: string;
  kind: CanonKind;

  /** epoch ms; 0 when unknown */
  ts: number;
  tsSource: 'record' | 'inherited' | 'interpolated' | 'missing';
  /** result timestamp for ops */
  endTs?: number;
  durationMs?: number;
  /** 'shared' = parallel fan-out, so the duration is an upper bound, not a measurement */
  durationSource: 'reported' | 'derived' | 'shared' | 'unknown';

  /** index into CanonSession.segments */
  seg: number;

  op?: OpFacts;
  /** set by the adapter when this event emitted (or opened) a plan */
  plan?: PlanArtifact;
  tokens: TokenFacts;
  /** 0 = main thread, >=1 = subagent nesting depth */
  sidechain: number;
  /** idx of the op that launched this subagent's work */
  spawnedBy?: number;

  /* ---- rendering (the reader's contract, preserved verbatim) ---- */
  title: string;
  subtitle?: string;
  body: string;
  format: BodyFormat;
  /** true when `body` is a prefix of a longer text that must be fetched to expand */
  more: boolean;
  fullLen: number;
  /** small cheap extras rendered as chips */
  chips?: string[];
  images?: ImageRef[];
  /** pages the agent rendered for the human (see `Widget`) */
  widgets?: Widget[];
  /** default-collapsed rows (reasoning, huge tool output) */
  collapsed?: boolean;
  /** estimated height in px, refined by measurement once mounted */
  est: number;
}

/**
 * A page the agent produced *for the human* and asked its host to display —
 * Codex's `visualize` skill writes an HTML file and refers to it from the
 * message text. The bytes are in the transcript, so the reader can show what
 * the human was actually shown.
 */
export interface Widget {
  kind: string;
  title: string;
  /** the file the agent wrote, for the row head */
  path: string;
  /** the document as it stood when this event referred to it */
  html: string;
}

export interface Segment {
  idx: number;
  /** index of the prompt event that opens the segment; -1 for the preamble */
  promptIdx: number;
  title: string;
  ts: number;
  firstEvent: number;
  lastEvent: number;
  toolCount: number;
  imageCount: number;
  fileCount: number;
  /** time to first token, when the vendor reported it for this turn */
  ttftMs?: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  title: string;
  vendor: Vendor;
  /** how sure detection was, 0..1 */
  confidence: number;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  model?: string;
  bytes: number;
  lines: number;
  badLines: number;
  startTs: number;
  endTs: number;
  parseMs: number;
  /** first/last record uuid, used to stitch resumed sessions together */
  firstUuid?: string;
  lastUuid?: string;
  /** uuids referenced by compaction summaries in this file */
  compactRefs?: string[];
  /** true when the transcript opens with a compaction summary */
  startsCompacted?: boolean;
}

/**
 * One container can hold several conversations (a Cursor `state.vscdb` holds all
 * of them). The reader opens one at a time and offers the rest as parts.
 */
export interface SessionPart {
  id: string;
  title: string;
  messages: number;
  ts: number;
}

export interface CanonSession {
  info: SessionInfo;
  events: CanonEvent[];
  segments: Segment[];
  parts?: SessionPart[];
}

/** A plan artifact as it existed at one point in time. */
export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'active' | 'done' | 'unknown';
}

export interface PlanRevision {
  /** event index that emitted it */
  idx: number;
  ts: number;
  source: 'plan-mode' | 'plan-tool' | 'file';
  /** plan-mode: the exit was accepted. file: n/a */
  approved: boolean;
  /** for file-sourced plans, which document */
  path?: string;
  text: string;
  steps: PlanStep[];
}
