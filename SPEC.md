# Project Reader — Specification

**Status:** implemented — see §14 for where the build departed from this design.
**Supersedes:** the analysis-related parts of `PLAN.md` (which described the reader only).
**Date:** 2026-08-03

---

## 0. What this is

Project Reader today is a *reader*: drop a Claude Code `.jsonl` transcript, get a fast, virtualized,
richly rendered timeline. That engine stays.

This spec adds the second half of the product: an **analyzer**. It answers, for any agent session —
Claude Code, Cursor, or Codex — questions the raw transcript cannot:

1. How many tokens went into each operation, and where did the budget actually go?
2. Which operations ran, how often, how long did they take, how often did they fail?
3. How many tokens were spent **before** the plan existed versus **after** it?
4. How much work happened **after** the plan was implemented, and was any of it unplanned?
5. How many times was the plan itself **edited** — and did it change *after* implementation started?
6. How do two sessions compare on all of the above?

Everything runs client-side. No server, no upload, no telemetry.

---

## 1. Decisions taken (and their costs)

These were settled during design. Each is recorded with the cost it carries, because several of them
constrain what the tool can ever say.

| # | Decision | Cost accepted |
|---|---|---|
| D1 | **Browser-only.** No Node backend, no Electron. `dist/` stays a static site. | Cursor's SQLite must be read with sql.js WASM in-memory; no file watching; File System Access API is Chromium-only, so other browsers get a re-pick-the-folder experience. |
| D2 | **Claude Code is the reference format.** Cursor and Codex adapters are written against known layout and shipped as *experimental*. | Cursor/Codex numbers may be incomplete until real samples are available. Unknown fields are surfaced, never silently dropped. |
| D3 | **Two token models, always labelled separately:** *context cost* (payload tokens an operation injects) and *billed usage* (vendor-reported per-request usage). They are never added together. | Two numbers to explain instead of one. This is deliberate: any single number here would be a fiction. |
| D4 | **Reader stays the front door**; analytics live in a collapsible right dock. | Analytics are one click away rather than the landing view. |
| D5 | **Plan = whichever plan artifact exists**, unified across vendors, with a manual override. | Detection is heuristic; the override exists precisely because it will sometimes be wrong. |
| D6 | **Plan edits = structural revisions only** (steps added/removed/reworded/reordered). Status ticks counted separately. | Requires step-level diffing; a badly formatted plan may diff noisily. |
| D7 | **"Improvements" = post-implementation iterations + unplanned work.** | Ignores subjective quality; an "improvement" here is a measurable change cycle, not a judgement. |
| D8 | **Implementation ends when the last plan step completes** (with documented fallbacks). | On sessions with no step tracking, the boundary is inferred and marked as such. |
| D9 | **Three clocks:** wall-clock, active (idle-trimmed), busy (union of tool intervals). | Three numbers where users expect one; the panel explains each inline. |
| D10 | **Sessions stitch into conversations** across `--resume` and compaction. | Stitching is heuristic; a wrong link merges two conversations. Always inspectable and breakable by hand. |
| D11 | **Tokens only. No cost estimation, no pricing table.** | The tool never answers "what did this cost in dollars". |
| D12 | **Comparison is two sessions, absolute values.** No normalization, no cohort baselines. | "But B was a bigger task" is left entirely to the reader's judgement. The spec keeps the metric schema normalization-ready (§9.3) without shipping it. |
| D13 | **Token estimation uses a cheap heuristic** (chars-per-token, per content class), not a real BPE tokenizer. | ±10–15% on absolutes. Mitigated by self-calibration against Claude's reported usage (§5.4). |
| D14 | **Folder scanning is fully lazy.** A session is parsed only when opened. | Project-wide rollups only cover sessions you have opened. An explicit *Analyze all* action exists as the opt-in escape hatch (§7.3). |
| D15 | **Subagent work is counted**, attributed to the call that spawned it, with an "of which N in subagents" breakdown. Compaction is a marked boundary. | Totals are larger than a naive main-thread-only reading. |
| D16 | **Bad data is surfaced, never hidden.** Every session has a data-quality report; every metric carries provenance. | More UI, and some sessions will visibly admit their numbers are partial. |
| D17 | **Cache metrics, never content.** IndexedDB holds computed metrics + event index only. | Reopening a *session body* still needs the file; only the numbers come back instantly. |
| D18 | **Refactor, don't rewrite.** Keep virtualizer / Fenwick / streaming / renderers; replace `normalize.ts` with adapters → canonical model → metrics. | A significant one-time refactor of the worker pipeline and `model/types.ts`. |
| D19 | **Export = Markdown report only.** | No JSON/CSV/share-link in v1. The metric object has a stable versioned schema (§9.4) so those are additive later. |

---

## 2. Architecture

```
index.html
 └─ main thread
     ├─ intake        folder/file pickers, vendor sniffing, session registry
     ├─ reader        (existing) virtualized timeline, sidebar, search, lightbox
     └─ analyzer      right dock: overview, operations, phases, plan, quality, compare
        ⇅ postMessage (light structured-clone only)
 └─ worker pool  (N = hardwareConcurrency, capped 8)
     ├─ vendor adapter   raw records ──▶ CanonEvent[]
     ├─ metrics core     CanonEvent[] ──▶ SessionMetrics
     └─ body store       on-demand file.slice() re-reads for expansion
 └─ IndexedDB   metrics + event index cache, keyed by file identity
```

### 2.1 Module layout after the refactor

```
src/
  main.ts                    app shell, intake, dock wiring
  model/
    canon.ts                 CanonEvent, CanonSession, PlanRevision — the vendor-neutral contract
    metrics.ts               SessionMetrics / OpStats / PhaseStats / PlanStats types
    protocol.ts              worker message types (was part of types.ts)
  vendor/
    detect.ts                sniffing: bytes ──▶ vendor id + confidence
    claude.ts                Claude Code .jsonl adapter          (reference impl)
    codex.ts                 Codex rollout .jsonl adapter        (experimental)
    cursor.ts                Cursor state.vscdb / export adapter (experimental)
    sqlite.ts                lazy sql.js loader + Cursor query layer
  metrics/
    tokens.ts                token accounting, both models, calibration
    ops.ts                   operation table, grouping, sub-command extraction
    time.ts                  three clocks, idle detection, interval union
    plan.ts                  plan detection, step extraction, revision diffing
    phases.ts                phase segmentation and boundary provenance
    quality.ts               data-quality report
    compare.ts               A/B metric pairing
  worker/
    parse.worker.ts          owns the File; runs adapter + metrics; serves expands
    jsonl.ts                 (unchanged) byte-level line splitter
    images.ts                (unchanged) base64 ──▶ Blob object URL
  view/
    virtualizer.ts fenwick.ts markdown.ts rows.ts icons.ts   (unchanged)
    timeline.ts              + phase markers, per-row chips, token gutter
    dock/
      overview.ts ops.ts phases.ts plan.ts quality.ts compare.ts
  store/
    cache.ts                 IndexedDB metrics cache
    prefs.ts                 localStorage: dock width, thresholds, overrides
```

**Deleted:** `src/worker/normalize.ts` (707 lines of Claude-shaped logic) — its tool-specific body
rendering moves to `vendor/claude.ts`, its segmenting moves to `metrics/phases.ts`.

---

## 3. Canonical event model

Every vendor collapses into this. **Metrics are computed from `CanonEvent[]` only** — no metric code
may ever branch on vendor. That rule is what keeps cross-agent comparison honest.

```ts
type Vendor = 'claude' | 'codex' | 'cursor';

type CanonKind =
  | 'prompt'      // human message
  | 'text'        // assistant prose
  | 'reasoning'   // thinking / reasoning block
  | 'op'          // a tool/command invocation paired with its result
  | 'plan'        // a plan revision was emitted
  | 'compaction'  // context was compacted
  | 'error'       // api error, refusal, aborted turn
  | 'notice'      // attachments, mode switches, user-edited-file notices
  | 'system';     // bookkeeping, hidden by default

/** Vendor-neutral operation categories. Used for cross-agent grouping. */
type OpCategory = 'read' | 'edit' | 'execute' | 'search' | 'web' | 'plan' | 'ask' | 'agent' | 'other';

interface CanonEvent {
  idx: number;
  id: string;                 // vendor uuid, or synthesized
  parentId?: string;
  kind: CanonKind;

  ts: number;                 // epoch ms, 0 if unknown
  tsSource: 'record' | 'inherited' | 'interpolated' | 'missing';
  endTs?: number;             // result timestamp for ops
  durationMs?: number;
  durationSource: 'reported' | 'derived' | 'shared' | 'unknown';
                              // 'shared' = parallel fan-out; duration is an upper bound

  seg: number;                // index into segments (human-prompt-delimited)
  phase: PhaseId;             // assigned by metrics/phases.ts

  // operation payload
  op?: {
    name: string;             // vendor tool name, verbatim: "Bash", "shell", "edit_file"
    category: OpCategory;     // normalized
    subgroup?: string;        // "npm", "git", ".ts", "docs.anthropic.com"
    target?: string;          // file path, url, command, query
    status: 'ok' | 'error' | 'interrupted' | 'unpaired';
    exitCode?: number;
    linesAdded?: number;
    linesRemoved?: number;
  };

  tokens: TokenFacts;         // §5
  sidechain: number;          // 0 = main thread, ≥1 = subagent nesting depth
  spawnedBy?: number;         // idx of the op that launched this subagent's work

  // rendering (existing reader contract, preserved)
  title: string;
  subtitle?: string;
  body: string;
  format: 'md' | 'text' | 'diff' | 'ask';   // 'ask' added in §14 A6
  more: boolean;
  fullLen: number;
  images?: ImageRef[];
  collapsed?: boolean;
  est: number;
}
```

### 3.1 Conversations, sessions, segments

- **Session** — one transcript file.
- **Conversation** — one or more sessions stitched together (§8.2). The unit for plan/phase analysis.
- **Segment** — a stretch of a conversation opened by one human prompt. Already implemented; it stays
  the sidebar and scroll-anchor unit, and becomes the unit for the *iterations* metric.
- **Project** — a directory grouping conversations (from the history root's layout, or from the `cwd`
  recorded inside transcripts).

---

## 4. Vendor adapters

### 4.1 Detection

`vendor/detect.ts` reads the first 64 KB (and, for SQLite, the 16-byte magic header) and returns
`{ vendor, confidence, reason }`. Never by file extension alone.

| Vendor | Signature |
|---|---|
| Claude Code | JSONL; records carry `uuid` + `sessionId` and `type` in `assistant\|user\|system\|attachment\|mode\|file-history-*`; assistant records have `message.content[]` |
| Codex | JSONL; records shaped `{ timestamp, type: "response_item" \| "event_msg" \| "session_meta", payload }` |
| Cursor | SQLite (`SQLite format 3\0` magic) containing `ItemTable` / `cursorDiskKV`; **or** an exported chat JSON/Markdown |

Unrecognized files are listed in the intake UI as *unrecognized*, with the sniffed first line shown,
rather than being silently ignored.

### 4.2 Claude Code (reference)

The existing `normalize.ts` logic, moved and generalized:

- Pair `tool_use` ↔ `tool_result` by `tool_use_id`; unpaired `tool_use` → `status: 'unpaired'`.
- `toolUseResult` supplies structured detail: Bash `{stdout,stderr,interrupted}`, Edit/Write
  `{structuredPatch}` → `linesAdded/linesRemoved`, Read `{file}`, WebSearch `{durationSeconds}` →
  `durationSource: 'reported'`, WebFetch `{code,bytes}`, TodoWrite `{oldTodos,newTodos}`,
  AskUserQuestion `{questions,answers}`.
- `message.usage` → `TokenFacts.reported` (§5.1).
- `isSidechain: true` → `sidechain: 1+`; linked to the spawning `Task`/`Agent` op by nearest
  preceding unmatched agent call.
- `isCompactSummary` → `kind: 'compaction'`.
- Human prompt = `type: "user"` **and** `origin.kind === "human"` (or `promptSource: "sdk"`), a `text`
  block, and no `tool_result`.

**Category mapping:** Read/Glob/Grep→`read`·`search`, Edit/Write/NotebookEdit→`edit`, Bash→`execute`,
WebSearch/WebFetch→`web`, EnterPlanMode/ExitPlanMode/TodoWrite→`plan`, AskUserQuestion→`ask`,
Task/Agent→`agent`, everything else→`other`.

### 4.3 Codex (experimental)

- Sessions live under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- `session_meta` → session header (cwd, model, instructions).
- `response_item` with `type: "function_call"` / `"function_call_output"` → op pairing by `call_id`.
- `event_msg` with `type: "token_count"` carries **cumulative** totals — the adapter must **diff
  consecutive values** to get per-request usage, and clamp negatives (a reset means a new context).
- `update_plan` calls → plan revisions with structured `{step, status}` items.
- Reasoning items → `kind: 'reasoning'`; reasoning tokens recorded separately in `TokenFacts`.
- Category mapping: `shell`→`execute`, `apply_patch`→`edit`, `read_file`→`read`, `update_plan`→`plan`,
  web tools→`web`.

### 4.4 Cursor (experimental)

Two intake paths, in priority order:

1. **`state.vscdb`** — SQLite, opened with sql.js. Chat bubbles live as JSON blobs under
   `cursorDiskKV` / `ItemTable` keys (`composerData:*`, `bubbleId:*`, `aiService.prompts`).
   Rows are decoded to `CanonEvent`s; tool calls appear as structured blobs where present.
2. **Exported chat** (JSON or Markdown) — a fallback when the DB is too large or the schema has moved.

**Known gaps, surfaced in the quality panel, not papered over:**
- No token usage is recorded → all token figures for Cursor are **estimated** (§5.4).
- Per-message timestamps are often absent → `tsSource: 'interpolated'`; durations mostly `'unknown'`,
  and the *busy* clock is unavailable.
- Tool results may be stored post-rendered → `linesAdded/Removed` may be underived.

**Memory guard (D1's cost):** sql.js loads the whole DB into WASM memory. Files above **512 MB** are
refused with an explicit message pointing at the export path; above **128 MB** the user gets a
warning and an explicit confirm. The sql.js bundle is `import()`-ed only when a SQLite file is opened,
so no Cursor code costs anything to Claude/Codex users.

---

## 5. Token accounting

The current implementation has one line of token logic and it is wrong: it adds
`cache_read_input_tokens` into `tokensIn`, which counts the entire re-sent context on every request
and inflates totals by an order of magnitude on long sessions. This section replaces it.

```ts
interface TokenFacts {
  reported?: {              // vendor-recorded, per API request
    input: number;          // fresh input tokens
    cacheWrite: number;     // cache_creation_input_tokens
    cacheRead: number;      // cache_read_input_tokens
    output: number;
    reasoning?: number;     // Codex; subset of output where the vendor separates it
  };
  payloadIn?: number;       // estimated tokens of the op's arguments
  payloadOut?: number;      // estimated tokens of the op's result
  estimated: boolean;       // true if any figure above came from the heuristic
}
```

### 5.1 Billed usage (vendor-reported)

Per session, computed over API requests (assistant records carrying `usage`):

| Metric | Formula | Meaning shown in UI |
|---|---|---|
| `output` | Σ `output.tokens` | Tokens the model generated. The only unambiguous total. |
| `freshInput` | Σ (`input` + `cacheWrite`) | Context the model saw **for the first time**. The honest "input" number. |
| `cacheRead` | Σ `cacheRead` | Context re-sent and served from cache. Reported, never added to `freshInput`. |
| `billedInput` | `freshInput + cacheRead` | Total input across all requests — labelled *"includes re-sent context"*. |
| `contextPeak` | max over requests of (`input`+`cacheWrite`+`cacheRead`) | Largest context ever sent. The number that predicts compaction. |
| `requests` | count | Denominator for every per-request average. |

**The headline token figure is `freshInput + output`.** `billedInput` and `cacheRead` are secondary
rows. Every one of these is badged `vendor-reported`.

### 5.2 Context cost (per operation)

For every `op` event:

- `payloadIn` = estimated tokens of the serialized tool arguments.
- `payloadOut` = estimated tokens of the tool result as it entered the conversation (stdout+stderr,
  file content, search results, diff), *after* the agent's own truncation, since that is what was
  actually sent.
- `contextCost = payloadIn + payloadOut`.

This is what "tokens spent on an operation" means in this tool, and the UI says so on hover. It is
attributable, comparable across vendors, and independent of caching. It is **not** money, and it does
not account for a result being re-sent on every later request — that amortized model was considered
and rejected (D3) because it produces numbers no one recognizes.

### 5.3 Turn attribution of billed usage

Billed usage is attached to the assistant request that produced it and rolls up to:
`segment → phase → conversation`. Where a turn emitted several parallel ops, the turn's `output`
tokens are attributed to the turn, **never split** across its ops — the split is not observable, and
inventing one would be the exact kind of fiction D3 rules out.

### 5.4 Estimation heuristic and self-calibration

Default divisors (characters per token), by content class:

| Class | Divisor | Applies to |
|---|---|---|
| prose | 4.0 | human prompts, assistant text, reasoning |
| code | 3.3 | file contents, diffs, patches |
| json | 2.9 | tool arguments, structured results |
| terminal | 3.1 | stdout/stderr |
| path/id | 2.4 | file paths, uuids, hashes |

**Self-calibration.** Claude reports real usage, so the divisors can be fitted rather than guessed:
for each Claude session with ≥50 requests, the tool computes the ratio between reported `freshInput`
and the heuristic estimate over the same content, and stores per-class correction factors (bounded to
[0.7, 1.4], median across sessions, persisted in `prefs`). Those factors then apply to Cursor and
Codex estimates. The quality panel shows the current calibration and the residual error.

**Accuracy target:** ≤10% median absolute error against reported usage on Claude sessions, after
calibration. This is asserted by a test (§11).

Every estimated figure renders with a `~` prefix and an `estimated` badge. Estimated and reported
numbers are never summed into a single displayed total.

---

## 6. Metrics

### 6.1 Operation statistics

Default table, one row per **tool name**, sortable by any column:

| Column | Definition |
|---|---|
| calls | count of `op` events |
| ok / error / interrupted / unpaired | status breakdown; failure rate = non-ok ÷ calls |
| total time | Σ `durationMs`, excluding `durationSource: 'unknown'` |
| median / p95 | over the same population |
| tokens in / out | Σ `payloadIn` / Σ `payloadOut` |
| share | % of the session's total operation context cost |

**Drill-down** (expanding a row groups by `op.subgroup`):

- **Bash / shell** → the effective command head. Extraction strips leading env assignments
  (`FOO=1 cmd`), `sudo`, `time`, and `cd … &&` prefixes, then takes the binary; for `npm`/`git`/`cargo`
  the subcommand is kept (`npm test`, `git commit`). Pipelines group by the **first** command.
- **Read / Edit / Write** → by file extension, then by path (so "we edited `main.ts` 14 times" is one
  click away).
- **WebSearch / WebFetch** → by domain.
- **Task / Agent** → by subagent type.

Every row and sub-row deep-links: clicking scrolls the timeline to the first matching event and
filters the timeline to that set.

A second tab shows the same table grouped by `OpCategory` — the only view that compares fairly
between vendors, since tool *names* differ but categories don't.

### 6.2 Time

Three clocks, always labelled, never collapsed into one "duration":

- **Wall clock** = `lastTs − firstTs`.
- **Active** = wall clock minus every inter-event gap longer than the idle threshold
  (default **15 min**, adjustable in prefs; the trimmed gaps are listed with their timestamps so the
  subtraction is auditable).
- **Busy** = length of the *union* of `[ts, endTs]` intervals over all ops. Parallel fan-out counts
  once. This is the only sound answer to "how much time did operations take".

Per-operation duration = `endTs − ts`. When several ops share one request timestamp (parallel calls),
each is marked `durationSource: 'shared'` and rendered with a `≤` prefix, because the individual
durations are not recoverable — only their envelope is.

Additional derived timings: time-to-first-token per turn (where reported), model think time
(turn start → first op), and human latency (result → next human prompt) which feeds idle detection.

### 6.3 Plans

**Detection** (priority order, first match wins, manual override beats all):

1. Plan-mode payload — Claude `ExitPlanMode` (the plan text) and `EnterPlanMode` (planning start).
2. Structured plan tool — Codex `update_plan`, Claude `TodoWrite`, Cursor todos.
3. Agent-written plan file — a `Write`/`Edit` whose path matches
   `/(^|\/)(PLAN|SPEC|DESIGN|TODO|ROADMAP)(\.[\w-]+)?\.md$/i` or `*.plan.md`.

Each detected artifact produces a **`PlanRevision`**:

```ts
interface PlanRevision {
  idx: number;            // event index that emitted it
  ts: number;
  source: 'plan-mode' | 'plan-tool' | 'file';
  approved: boolean;      // plan-mode: the exit was accepted; file: n/a
  text: string;           // full plan text
  steps: PlanStep[];      // ordered
}
interface PlanStep { id: string; text: string; status: 'pending' | 'active' | 'done' | 'unknown'; }
```

**Step extraction.** From structured tools, directly. From markdown: top-level ordered/unordered list
items and `##`-level headings, whichever yields ≥3 items; nested items attach to their parent and are
not counted as separate steps.

**Revision diffing.** Steps are matched between consecutive revisions by id where available, otherwise
by normalized text (lowercased, punctuation and leading numbering stripped, whitespace collapsed) with
a similarity threshold of **0.85** (token-set Dice coefficient). Classification per revision:

| Change | Counted as |
|---|---|
| step added / removed | **structural edit** |
| step text changed above threshold (reworded) | **structural edit** |
| step order changed | **structural edit** |
| status only (`pending → active → done`) | **progress tick** |

Metrics:

- `planRevisions` — total emissions.
- `planEdits` — revisions containing ≥1 structural change. **This is "how many edits were made to the plan".**
- `progressTicks` — revisions with status changes only.
- `planEditsDuringPlanning` / `planEditsAfterImplStart` — the split that answers **"were there edits
  after work on the plan started"**; `planEditsAfterImplStart > 0` renders as an explicit
  *scope drift: yes (N edits)* line, with each edit's step-level diff inspectable.
- `stepsAdded` / `stepsRemoved` / `stepsReworded` / `stepsReordered` — totals across all edits.
- `planTextGrowth` — characters, first revision → last.

### 6.4 Phases

```
PRE_PLAN ──▶ PLANNING ──▶ IMPLEMENTATION ──▶ POST_PLAN
```

| Boundary | Rule | Fallbacks |
|---|---|---|
| `planningStart` | first `EnterPlanMode` | else the start of the turn containing the first plan revision |
| `planCreated` | first **approved** plan revision (`ExitPlanMode` accepted / first `update_plan` / first write of a plan file) | if no approval signal exists, the first revision |
| `implEnd` | timestamp at which the **last plan step flips to `done`** | ① last edit touching a file named by a plan step; ② last edit before the first idle gap > threshold after `planCreated`; ③ end of conversation |
| `end` | last event | — |

Every boundary carries `{ ts, rule, confidence: 'observed' | 'inferred' }`, is drawn as a marker in
the timeline, and is draggable — moving a marker sets a manual override, persisted per conversation,
and recomputes all phase metrics live. Sessions with no plan are `NO_PLAN` and show phase metrics as
unavailable rather than as zeros.

Per phase: duration (all three clocks), `freshInput`/`output`/`cacheRead`, context cost, operation
counts by category, files touched, lines added/removed, human prompts.

**The headline answer to requirement 3** is a single stacked bar: tokens before `planCreated` vs
after, split by fresh-input / output, with the planning phase called out in the middle.

### 6.5 Improvements after implementation

Both requested measures, reported side by side:

- **Iterations** — each human prompt occurring after `implEnd` whose segment contains ≥1 `edit` op
  counts as one improvement round. Reported as a count plus a per-iteration table (prompt excerpt,
  ops, files touched, tokens, duration). Human prompts producing no edits are counted separately as
  *questions*, not improvements.
- **Unplanned work** — post-`planCreated` edits whose file is **not** referenced in any plan revision.
  Matching is by, in order: exact path, path suffix, basename, and basename-without-extension against
  the plan text (with a code-span-aware scan so a path mentioned inside a fenced block still counts).
  Reported as: unplanned files (list), unplanned edit count, and **unplanned share** = unplanned edits
  ÷ all post-plan edits. Every match and non-match is inspectable, because false negatives here are
  the difference between "the plan missed half the work" and "the plan didn't spell out a filename".

Supporting figures shown alongside: post-plan edit count and lines ±, and per-file edit counts
(so repeated churn on one file is visible even though "rework" was not selected as a headline metric).

### 6.6 Subagents and compaction

- Subagent events (`sidechain ≥ 1`) roll into all totals and are attributed to their spawning op.
  Every total that includes subagent work shows `of which N in subagents`. The ops table has a
  main-thread-only toggle.
- Compaction events are markers on the timeline and rows in the phase table: at each one, the panel
  shows `contextPeak` before, the summary's own token size, and the context size after — making the
  reset visible instead of letting it distort the input curve.

---

## 7. Intake and navigation

### 7.1 Folder modes

Both selected modes are supported, chosen automatically by what's found:

- **Agent history root** — `~/.claude/projects/<slug>/*.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,
  Cursor's `globalStorage`/`workspaceStorage`. Recognized by layout; the tool derives projects from
  directory structure and shows a project → conversation → session tree.
- **Arbitrary folder, recursive sniff** — walk everything, sniff each file (§4.1), ignore non-matches,
  group by the `cwd`/project recorded inside the transcripts rather than by directory. Handles
  exported, archived and hand-moved transcripts.

**Mechanism, by capability:**

| Capability | Used for |
|---|---|
| `showDirectoryPicker()` (Chromium) | folder pick **with persistent handle** stored in IndexedDB → reopening the tool restores the tree with one permission click, and changed files are re-read |
| `<input webkitdirectory>` | folder pick everywhere else (Firefox, Safari) — works, but the handle cannot be persisted, so the folder must be re-picked each visit |
| drag-and-drop `webkitGetAsEntry()` | dropping a folder, all browsers |
| single/multi file drop | unchanged from today |

The capability difference is stated in the UI once, not silently endured.

### 7.2 Lazy loading (D14)

The folder tree lists files immediately using filesystem metadata only (name, size, mtime, derived
project, vendor from a 64 KB sniff). **No parsing happens until a session is opened.** Sessions with a
valid cache entry show their headline metrics in the tree immediately, marked as cached.

### 7.3 Analyze all

Because fully-lazy means project rollups are only as complete as what you've opened, the project row
carries an explicit **Analyze all (N sessions, ~M MB)** action. It runs the parse across the worker
pool with a progress bar and a cancel button, filling the cache. Any project rollup shown while
sessions remain unanalyzed is labelled `12 of 47 sessions analyzed` — never presented as complete.

### 7.4 Comparison (D12)

Two sessions or conversations, picked from the tree or via *Compare with…* on the current session.
Output is a single table: metric, A, B, difference. Sections mirror §6 — tokens, operations, time,
phases, plan, improvements. Rules:

- Absolute values only. No normalization, no percentages of a baseline.
- A metric unavailable on one side renders `— not recorded (Cursor)`, **never `0`**.
- A metric estimated on one side and reported on the other is flagged as not directly comparable.
- Each row expands into the same drill-down as the single-session view, for both sides at once.

The metric schema keeps denominators (`requests`, `edits`, `activeMs`, `prompts`) as first-class
fields so normalization can be added later without a schema change.

---

## 8. Edge cases and how each is handled

### 8.1 Malformed and hostile data

| Case | Handling |
|---|---|
| Truncated final line | Kept as a `badLine`, reported; parse succeeds |
| Invalid JSON mid-file | Line skipped, counted, byte offset recorded; the raw text is viewable in the quality panel |
| Record with no timestamp | `tsSource: 'inherited'` from the previous event; if none, `'missing'` — excluded from all duration math |
| Clock going backwards | Negative delta clamped to 0, counted as an anomaly, listed with both timestamps |
| `tool_use` with no result | `status: 'unpaired'`; contributes `payloadIn` but no duration and no `payloadOut` |
| `tool_result` with no `tool_use` | Kept as an orphan event, counted, excluded from op stats |
| Unknown record type | Preserved as `kind: 'system'`, type name listed in the quality panel with a count |
| Unknown tool name | `category: 'other'`, name preserved verbatim, listed |
| Enormous single line (>32 MB) | Body not retained; row expands via `file.slice()`; token estimate computed by streaming the slice |
| Duplicate `uuid`s | First wins; duplicates counted |
| Empty file / zero events | Listed as `empty`, not an error |

### 8.2 Conversation stitching

Sessions are linked into one conversation when **any** of:

- identical `sessionId` across files (a resume writes a new file);
- a compaction summary in file B references a leaf uuid present in file A;
- same `cwd` **and** B's first event is within 5 minutes of A's last **and** B opens with a
  compaction/summary record.

Stitching is heuristic, so: links are shown in the conversation header with their reason, and a
**Split here** control breaks a wrong link. Metrics recompute on split. Files are ordered by first
timestamp; overlapping ranges are flagged in the quality panel.

### 8.3 Ambiguity in the plan model

| Case | Handling |
|---|---|
| Multiple plan cycles (plan → build → re-plan → build) | Each approved plan opens a **plan episode**; phases repeat per episode. Headline metrics use the **first** episode; a selector switches episodes, and an *all episodes* aggregate is offered. |
| Plan mode entered and abandoned (no approval) | `PLANNING` exists, `planCreated` is null; the session counts as `NO_PLAN` for phase metrics but the abandoned planning cost is still reported. |
| Plan written to a file and also emitted in plan mode | Plan-mode wins (higher priority); file edits to the same document are additionally counted as plan edits and merged into the revision list by timestamp. |
| Human writes the plan, not the agent | Not auto-detected. The manual override exists for exactly this; documented in the panel's empty state. |
| TodoWrite used as a task tracker with no real plan | Structural-edit filtering (D6) keeps pure tick-offs out of `planEdits`. A plan with ≥80% status-only revisions is annotated *used as a checklist*. |
| Plan steps that never complete | `implEnd` falls to the documented fallbacks and is marked `inferred`. |

### 8.4 Attribution ambiguity

| Case | Handling |
|---|---|
| Parallel tool calls in one turn | Durations marked `shared` (upper bound); busy time uses interval union; output tokens stay on the turn, unsplit |
| Interleaved subagent output | Attributed by `sidechain` depth and the spawning op; a subagent whose parent cannot be identified is attributed to the conversation with an `unattributed` flag |
| A retried operation after an error | Both attempts counted; the ops table shows a `retries` column derived from identical `(name, target)` pairs within one segment |
| Cache read spikes after compaction | Excluded from `freshInput` by construction; compaction markers explain the discontinuity |

### 8.5 Scale

| Case | Handling |
|---|---|
| 10 GB folder | Never fully parsed unless *Analyze all* is invoked; tree is metadata-only |
| Single 100 MB transcript | Existing streaming path already handles it (measured 423 ms); metrics add one pass over already-parsed events |
| 5 000 files in a folder | Tree virtualized with the existing virtualizer; sniffing capped at 64 KB per file and run in the worker pool |
| Memory pressure from many open sessions | LRU of at most 4 fully parsed sessions in memory; the rest keep metrics only and re-parse on demand |
| Cursor DB > 512 MB | Refused with the export fallback path (§4.4) |

---

## 9. Storage, privacy, provenance

### 9.1 Cache (D17)

IndexedDB database `project-reader`, store `sessions`, key `${path}|${size}|${lastModified}`:

```ts
{ key, schemaVersion, vendor, metrics: SessionMetrics, index: EventIndexEntry[], quality: QualityReport, computedAt }
```

`EventIndexEntry` is `{ idx, kind, ts, byteStart, byteEnd, opName?, category? }` — enough to render the
tree, the ops table and all metrics without the file. **No message bodies, prompts, file contents, code,
diffs or images are ever persisted.** Cache entries are invalidated by key mismatch and by
`schemaVersion` bump. A **Clear cached data** control in settings shows the current size and empties
the store; a **Don't cache** toggle disables writes entirely.

`localStorage` holds only preferences: dock width, idle threshold, calibration factors, manual phase
and plan overrides (keyed by session id + file identity), collapsed states.

### 9.2 Privacy posture

No network requests at runtime beyond loading the app's own assets. The sql.js WASM binary is bundled
locally, not fetched from a CDN. Object URLs for images are revoked when a session closes. The
Markdown export (§9.4) includes prompt excerpts and file paths by default, with a **redact paths and
excerpts** switch for sharing.

### 9.3 Metric schema

`SessionMetrics` is versioned (`schemaVersion`) and every numeric field carries provenance:

```ts
type Provenance = 'reported' | 'derived' | 'estimated' | 'unavailable';
interface Metric { value: number | null; provenance: Provenance; coverage?: number; note?: string; }
```

`coverage` is the fraction of relevant events that contributed (e.g. 0.62 when 38% of events lacked
timestamps). Any metric with `coverage < 0.9` renders with a warning marker in the UI. A `null` value
with `provenance: 'unavailable'` renders as `—` and never as `0`.

### 9.4 Export (D19)

One Markdown report per session, conversation, or comparison: header (vendor, model, dates, clocks),
headline tokens, phase table, before/after-plan split, plan history with revision diffs, improvements,
top-20 operations table, and a data-quality footer listing every caveat that applied. Provenance is
carried into the text (`~` for estimates, explicit `not recorded` rows) so a pasted report cannot be
mistaken for exact measurement.

---

## 10. UI

### 10.1 Right dock (D4)

Resizable, collapsible, width persisted, **collapsed by default** so the reader's first paint is
unchanged. Tabs:

1. **Overview** — headline tokens (fresh input / output / cache read / peak context), three clocks,
   op counts by category, before/after-plan stacked bar, plan summary line, quality badge.
2. **Operations** — the §6.1 table with drill-down and category tab.
3. **Phases** — timeline strip plus the per-phase table; boundaries editable here and in the timeline.
4. **Plan** — revision list with step-level diffs, edit/tick counts, scope-drift verdict, improvements
   and unplanned-work lists.
5. **Quality** — the §8.1 report: bad lines, unknown types, missing timestamps, clock anomalies,
   unpaired calls, coverage per metric, current calibration.
6. **Compare** — the A/B table (§7.4).

Selection is bidirectional throughout: clicking any metric row filters and scrolls the timeline;
scrolling the timeline highlights the current phase and segment in the dock.

### 10.2 Timeline additions (all three selected)

- **Per-row chips** — context cost and duration on every op row, using the existing chip mechanism.
  Rows above the session's p90 for either get a subtle weight so expensive operations are visible
  while scrolling. Chips are suppressed when the value is unavailable rather than showing `0`.
- **Phase markers** — full-width dividers at `planningStart`, `planCreated`, `implEnd`, and at every
  compaction; plan revisions get a small inline marker. Markers are draggable to correct detection.
- **Token gutter** — a thin strip beside the scrollbar showing cumulative context cost down the
  session, so expensive stretches are visible as a shape before scrolling. Rendered once per session
  into a canvas from the Fenwick offsets; repainted only on filter change.

### 10.3 Performance budget

Unchanged for the reader (measured: 75 ms parse, 140 ms to usable, 16.7 ms p50 frame on
`example.jsonl`). Added budgets:

| Stage | Budget |
|---|---|
| metrics pass over an already-parsed session | < 15% of parse time (≈ 60 ms on 100 MB) |
| dock first render | < 50 ms |
| ops table sort / regroup (10k ops) | < 16 ms |
| folder tree, 5 000 files, metadata + sniff | < 2 s across the worker pool |
| cached session open (metrics only) | < 30 ms |
| bundle | ≤ 60 KB JS + worker, excluding the lazily-loaded sql.js |

Regressions are caught by the existing headless-Chrome measurement harness, extended with the new
stages.

---

## 11. Testing

- **Golden fixtures** — small hand-trimmed transcripts per vendor under `test/fixtures/`, with an
  expected `SessionMetrics` JSON checked in. Any metric change must update a golden file, which makes
  metric drift a reviewable diff.
- **Synthetic generator** — `tools/gen-fixture.mjs` extended to emit plan cycles, parallel ops,
  subagents, compactions, clock skew, unpaired calls and truncated lines, with *known* ground truth,
  so metric correctness is asserted against constructed answers rather than against itself.
- **Invariants** (property tests over both real and synthetic input):
  `busy ≤ active ≤ wall`; `Σ phase durations = wall`; `Σ per-phase tokens = session tokens`;
  `freshInput + cacheRead = billedInput`; `planEdits + progressTicks ≤ planRevisions`;
  every op is in exactly one phase; no metric is `NaN`, and `null` never renders as `0`.
- **Calibration test** — heuristic estimate vs reported usage on Claude fixtures; asserts ≤10% median
  absolute error (§5.4) and fails the build if the divisors drift out of the bounded range.
- **Adapter conformance** — one shared suite run against all three adapters, asserting the canonical
  invariants (ordering, pairing, category coverage, no vendor leakage into metric code).
- **Cross-vendor equivalence** — the same logical session expressed in all three formats must produce
  matching category-level counts; this is the test that proves the canonical model actually normalizes.
- Existing parser, Fenwick and markdown-escaping tests stay.

---

## 12. Delivery phases

1. **Canonical model + Claude adapter.** Replace `normalize.ts`; `CanonEvent` everywhere; reader
   works exactly as before on top of it; conformance and golden tests in place. *No visible change —
   this is the load-bearing step.*
2. **Token accounting.** Fix the input/cache conflation, both models, estimator + calibration,
   overview tab with the before/after-plan split. **Requirements 1 and 3 land here.**
3. **Operations and time.** Ops table with drill-down, three clocks, per-row chips.
   **Requirement 2 lands here.**
4. **Plan and phases.** Detection, revision diffing, phase segmentation, markers and overrides,
   improvements and unplanned work. **Requirements 4 and 5 land here.**
5. **Folder intake + cache.** Directory pickers, sniffing, project tree, IndexedDB cache,
   *Analyze all*, quality panel.
6. **Compare + export.** A/B table, Markdown report. **Requirement 6 lands here.**
7. **Cursor and Codex adapters.** Shipped behind an *experimental* label; sql.js lazy path; gaps
   surfaced in the quality panel. Promoted to supported once validated against real samples (D2).

Phases 1–4 deliver the whole analytical value on Claude sessions; 5–7 add breadth.

---

## 13. Open risks

1. **Cursor's schema is undocumented and moves between versions.** Highest risk in the plan.
   Mitigation: adapter isolated behind detection with a version probe, experimental label, export
   fallback, and no metric code depending on Cursor specifics. Until real samples exist (D2), treat
   every Cursor number as unverified.
2. **Codex's cumulative token counters.** Diffing them is correct only if no reset is missed; a missed
   reset shows as a negative delta, which is clamped and counted as an anomaly — visible, but it means
   some Codex token totals will be low rather than wrong-high.
3. **Plan detection false positives.** A `TodoWrite`-heavy session with no real plan could produce
   plan phases. Mitigated by structural-edit filtering, the *used as a checklist* annotation, and the
   manual override — but the first release will misclassify some sessions.
4. **`implEnd` is inferred more often than observed.** Sessions without step tracking rely on
   fallbacks; the confidence flag is not decoration, and the post-plan metrics inherit that
   uncertainty. Every metric derived from `implEnd` shows the boundary's confidence.
5. **Fully lazy scanning (D14) makes project-level views partial by default.** *Analyze all* and the
   explicit `N of M analyzed` labelling are the mitigation; the risk is that a partial rollup is read
   as a complete one.
6. **Absolute-only comparison (D12) invites unlike-for-unlike conclusions.** The tool cannot prevent
   this; it will show both sides' scale indicators (duration, prompts, edits) adjacent to every
   comparison so the size difference is at least visible.
7. **Estimation on Cursor is unverifiable** — there is no reported usage to calibrate against, so the
   Claude-fitted divisors are assumed to transfer. Stated in the UI wherever Cursor tokens appear.
8. **Browser-only (D1) forecloses live watching and large Cursor DBs.** Accepted; if either becomes
   necessary, the adapter/metrics split means a Node host could reuse everything except intake.

---

## 14. Implementation notes and amendments

**Status: implemented.** Phases 1–7 of §12 are built; what follows records where the implementation
departs from this document and why. Everything here was found while building, not decided in advance.

### 14.1 Changed on contact with the data

**A1. No sql.js — a 200-line read-only SQLite reader instead.** (§4.4, D1)
Cursor needs full table scans of two key/value tables, which does not justify a ~1 MB WASM blob and a
second heap holding the whole database. `vendor/sqlite.ts` walks the b-tree directly: page header,
cell pointers, record format, overflow chains. It keeps the *no runtime dependencies* property the
rest of the project has. Costs: no WAL replay (a `-wal` sidecar is invisible, so very recent writes
may be missing) and no index or query support. The 512 MB refusal and the 128 MB warning stay.

**A2. The estimator cannot be calibrated against a real Claude transcript, and now says so.** (§5.4)
The spec assumed reported usage could be regressed against transcript text. Two things break that:
- fresh input includes the system prompt and tool schemas, which are *not* in the file;
- reported output includes reasoning the agent generated but did not persist — on `example.jsonl`
  the visible generated text implies ~2.5 chars/token where prose is ~4.

So the fit uses **output samples only** (the side whose every character is in the file), skips any
request whose reasoning was dropped, and — critically — **refuses the fit entirely** when the factor
needed would fall outside `[0.7, 1.4]`, because a clamped factor is not a calibration, it is the file
admitting it is incomplete. Storing that clamp would then distort Cursor, which is the one vendor it
was supposed to help. Measured residual on `example.jsonl`: **38.7% median**, reported verbatim in the
quality panel with the reason. The ≤10% target is asserted where it is meaningful: against synthetic
samples whose text really is everything the tokenizer saw (`test/metrics.test.mjs`).

**A3. Boundaries move by button, not by drag.** (§6.4, §10.2)
Markers are drawn in the timeline for `planningStart`, `planCreated`, `implEnd`, every plan edit and
every compaction. Moving one is a *move here* button in the Phases panel, which sets the boundary to
the event at the top of the timeline, plus *reset*. Same capability, same persistence, without a drag
interaction inside a virtualized list that recycles its rows.

**A4. Plan episodes require a re-plan, not just another revision.** (§8.3)
The spec said each approved plan opens an episode. With a structured todo tool *every* revision is
"approved", so that rule made a five-update todo list into five episodes and truncated `implEnd`.
An episode now needs intervening edit work **and** either a plan-mode payload or a revision that
replaced ≥60% of its steps.

**A5. The cache holds metrics, not an event index.** (§9.1)
`EventIndexEntry[]` had no consumer: every view that needs event indices is looking at a session that
is already open, and `OpRow.idxs` already carries the deep-link targets. Dropping it means less data
at rest for the same behaviour. Key, invalidation and the *clear cached data* control are unchanged.

**A6. A fourth body format, `ask`, for question rows.** (§3, §10.2)
`AskUserQuestion` is the one operation whose *input* is the interesting part: the options offered and
what each one claimed. Rendering only the question and the chosen label throws away the alternatives
the decision was made against. Adapters now encode the whole exchange as a tab-separated line
protocol (`vendor/text.ts`) that the reader draws as marked options (`view/ask.ts`); a body cut by
the clamp still parses into everything before the cut, which JSON would not. Two consequences worth
recording: the row clamp is 8 KB for `ask` bodies rather than 1.2 KB, because a decision shown half
way is not a decision (measured: 94 real asks, median 2.6 KB, largest 5.0 KB); and `ResultSpec`
gained `payloadOut`, since the options travel in the *call* and echoing them into the result's
context cost would count them twice.

**A7. Codex operations are read from the item stream, decided per call.** (§4.3)
Codex gives the model one tool, `exec`, whose argument is a program; the operations are what the
program did, and the runtime reports them separately as `item_completed` events. Taking operations
from there reproduces Claude's granularity — one command, patched file, search or image per row — and
the data cooperates: 43 of 51 calls in the sample emit exactly one item, so one call is still one row.
The switch is per call rather than per file, so a rollout with no item stream keeps the older
script-parsing path and nothing has to sniff the format up front. Three consequences: a call that did
several *different* things shows its script once above the first row and shares the cost of the single
result envelope between them by text length; a sub-millisecond `duration` is treated as bookkeeping
rather than a measurement (two independent fields agree on 0 ms for commands that plainly took
longer), with the call's wall time standing in; and `ResultSpec` gained `fullText`, so a row can show
the truncated output the model was given while expand serves the whole of `stdout`.

### 14.2 Not implemented

- **Conversation stitching (§8.2).** Sessions are still one file each. Compactions are marked and
  `compactRefs`/`sessionId`/`firstUuid`/`lastUuid` are captured in `SessionInfo` for it, but nothing
  links two files yet. This is the largest remaining gap: a `--resume`d session currently reads as two
  unrelated sessions.
- **Persistent directory handles (§7.1).** `showDirectoryPicker()` is used where available, but the
  handle is not stored in IndexedDB, so every browser needs the folder re-picked after a reload.
- **The redaction switch (§9.2).** Export honours `prefs.redactExports` and the report generator
  implements it; there is no UI toggle for it yet.

### 14.3 Budgets missed

| Budget | Target | Actual |
|---|---|---|
| bundle | ≤ 60 KB JS + worker | 68 KB + 68 KB (≈ 40 KB gzipped, still no dependencies) |
| metrics pass | < 15% of parse time | ≈ 19% (5 ms against a 26 ms in-memory parse) |

Both are the cost of the analyzer being a real second product rather than a panel. Reader
performance itself is unchanged: the parse path, the virtualizer and the row renderer are the same
code, and analysis is one extra pass over events already in memory.

### 14.4 What the tests actually assert

`tools/scenario.mjs` builds a small transcript containing a plan that gets edited after work starts,
two calls issued in parallel, a subagent, a compaction, a clock that runs backwards, a call nobody
answered, a result with no call, and an improvement round after implementation — together with the
ground truth for every metric. `test/metrics.test.mjs` asserts each number against that truth, plus
the invariants: `busy ≤ active ≤ wall`, phase durations tile the session, per-phase tokens tile the
session, every operation is in exactly one phase, `planEdits + progressTicks ≤ planRevisions`, no
metric is `NaN`, and a `null` never renders as `0`. `test/example.test.mjs` runs the same invariants
over the real 5.7 MB transcript. 73 tests, no runtime dependencies.
