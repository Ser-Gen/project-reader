# Project Reader

A browser tool for reading **and analyzing** the sessions you ran with Claude Code, Codex or Cursor.

Drop a transcript (or open a whole folder of them) and get the run back as a chronological, readable
timeline — prompts, replies, commands and their output, diffs, screenshots — plus an analytics dock
that answers the questions the raw file cannot: where the tokens went, which operations cost the
time, what the plan looked like before and after the work, and how two sessions compare.

Everything happens client-side. Nothing is uploaded, there is no server, and only computed numbers
are ever stored.

```bash
npm install
npm run dev      # http://localhost:5173, then drop example.jsonl on the page
npm run build    # static site in dist/
npm test         # adapters, metrics, invariants, panels, real-transcript checks
```

The design and the decisions behind it are in [SPEC.md](SPEC.md).

## What it does

### Reading

**Timeline.** One row per thing that happened. Assistant prose renders as markdown, tables included
— a pipe table becomes a real table rather than a wall of `|`; edits become coloured diffs from the
transcript's `structuredPatch`; shell calls show the command with its stdout/stderr and an
interrupted/error badge; reads show the path and line count; web calls become link lists with
timing; todo writes become checklists; plans render as markdown; a question to the human shows every
option it offered, with its description, and marks the one that was picked; screenshots appear
inline and open in a lightbox. Operation rows and reasoning start folded. Rows carrying a screenshot
start open, since the picture is the result.

**Per-row analytics.** Every operation row carries what it cost — `~1.4k` estimated context tokens —
and how long it took, with `≤` when several calls were issued in one request and only their envelope
is knowable. Rows above the session's p90 for either are weighted so expensive stretches stand out
while scrolling. A thin gutter beside the scrollbar paints cumulative operation cost down the whole
session, so you can see where the money went before you scroll to it. Phase boundaries, plan
revisions and compactions are drawn as full-width markers.

**Type filter, sidebar, search.** Colour-coded glyphs per row, filter chips with counts, one sidebar
entry per human prompt with elapsed time and what that stretch involved, full-text search across
every event. <kbd>j</kbd>/<kbd>k</kbd> move between prompts, <kbd>/</kbd> focuses search,
<kbd>a</kbd> toggles the analytics dock.

**Folders.** Open a directory (or drop one) and every transcript inside it is listed by project,
sniffed for vendor, and left alone until you open it. Nothing is parsed until you ask.

### Analyzing

The dock has six tabs. Every number in it carries provenance: **reported** by the agent, **derived**
from what it recorded, or **estimated** — estimates are prefixed `~` and never added to reported
figures. A metric that cannot be known renders `—`, never `0`.

**Overview** — fresh input, output, cache reads, peak context, the three clocks, operation counts by
category, and the before/after-the-plan token split.

**Operations** — one row per tool: calls, failures, total/median/p95 time, estimated context cost and
share. Expand a row to drill into shell command heads (`npm test`, `git commit`), file extensions and
then individual paths, or web domains. A second tab groups by canonical category, which is the only
grouping that compares fairly across agents. Clicking any row pins the timeline to exactly those
events.

**Phases** — `PRE_PLAN → PLANNING → IMPLEMENTATION → POST_PLAN`, with per-phase duration (all three
clocks), tokens, operations, files and lines. Each boundary shows the rule that produced it and
whether it was **observed** or **inferred**; any of them can be moved by hand, which recomputes every
phase metric without re-reading the file.

**Plan** — every revision of the plan with a step-level diff, split into *edits* (steps added,
removed, reworded, reordered) and *progress ticks* (a box got checked). Ticking is not editing, which
is what keeps a chatty todo list from reading as forty plan changes. If the plan changed after work
started, that is called out as scope drift. Below it: improvement rounds after implementation ended,
and unplanned work — post-plan edits to files no revision ever mentions.

**Quality** — everything that could not be trusted: unparsable lines, unknown record types, missing
or out-of-order timestamps, calls that were never answered, results with no call, per-metric coverage,
and the token estimator's current calibration and residual error.

**Compare** — two sessions side by side, absolute values only, with both sides' scale indicators
adjacent. A metric available on one side and not the other renders `— not recorded`, never `0`; a
metric estimated on one side and reported on the other is marked *not comparable*. Any session or
comparison exports as a Markdown report that carries its provenance into the text.

## The token numbers, and why there are two of them

No vendor bills per tool call — the API bills per request — so "tokens spent on this operation" has
no recorded answer. This tool reports two measures and never adds them together:

- **Billed usage**, exactly as the agent recorded it. The headline is `fresh input + output`.
  *Fresh input* is `input + cache writes`: context the model saw for the first time. Cache reads are
  the same context sent again and are reported on their own line.
- **Context cost**: the estimated tokens an operation's arguments and result pushed into the
  conversation. This is attributable per operation, comparable across agents, and independent of
  caching — and it is an estimate, so it always renders with a `~`.

The previous version of this reader added `cache_read_input_tokens` into its input total. On
`example.jsonl` that reports **39.1 M input tokens** where the honest figure is **530 k** — a 74×
inflation, growing with session length. That single line is the reason provenance is now attached to
every number in the tool.

## Measured behaviour

| | `example.jsonl` (5.7 MB, 881 lines) | synthetic (100 MB, 26 647 lines) |
|---|---|---|
| parse + normalize (worker) | **75 ms** | **423 ms** |
| metrics pass over parsed events | **~5 ms** | — |
| drop → timeline usable | **140 ms** | **633 ms** |
| scroll, p50 / p95 frame | **16.7 / 17.7 ms** | **16.7 / 17.0 ms** |
| JS heap after full scroll | **4 MB** | **91 MB** |
| DOM rows mounted | 41 | 10 |

Reader numbers from headless Chrome at 1440×900; reproduce the large case with
`tools/gen-fixture.mjs`. The metrics pass is measured by `tools/` under Node on the same file and is
about a fifth of parse time — analysis is a second pass over events already in memory, never a second
read of the file.

## How it stays fast

The transcript format has two properties that drive the design, both found by measuring
`example.jsonl` with `tools/inspect.mjs`:

1. **Human prompts are rare** — 5 of 881 records. The other 213 `user` records are tool results.
   Everything until the next human prompt is one segment; segments are the sidebar, the scroll
   anchors and the unit for the *iterations* metric, and they cost nothing to compute.
2. **The weight is a dozen screenshots** — the 12 largest lines are 111–479 KB each, all base64 PNGs;
   ~5 MB of the 5.7 MB total. Everything else is small.

So:

- **Parsing runs in a worker, streaming.** `file.stream()` is split on newline *bytes*
  (`src/worker/jsonl.ts`), never `file.text()`. Byte offsets are kept per record.
- **Images never touch the main thread.** In the worker, base64 → `Uint8Array` → `Blob` →
  `URL.createObjectURL`; the base64 string is dropped immediately and only a short `blob:` URL is
  posted across. Dimensions come from `createImageBitmap`. This is why the heap is 4 MB for a 5.7 MB
  file.
- **The UI thread holds light records only.** ~200 bytes per event, with the body clipped to 16 KB.
- **Over-sized bodies are fetched on demand** with `file.slice(start, end)` over the one line that
  holds them.
- **The list is windowed.** Row heights live in a Fenwick tree, so scroll↔index is O(log n). Only the
  viewport plus ~900 px of overscan exists in the DOM; nodes are recycled through a pool.
- **Rendering is memoized string building**, with rows `contain: layout paint style`. Markdown is a
  small local subset rather than a dependency. All transcript text is escaped before it reaches the
  DOM.
- **Analysis never re-reads the file.** Metrics are one pass over the canonical events; changing the
  idle threshold or dragging a phase boundary recomputes in the worker from what it already holds.
- **Folder scanning is lazy.** The tree costs a directory listing plus a 64 KB sniff per file. Full
  analysis of a project is an explicit *analyze all* across a worker pool, and any rollup shown while
  sessions remain unanalyzed says `12 of 47 analyzed`.

The whole app ships as ~68 KB of JS + 68 KB worker + 20 KB CSS (≈40 KB gzipped), with **no runtime
dependencies** — including the SQLite reader used for Cursor databases.

## Layout

```
src/
  main.ts                app shell: intake, worker pool, session tree, dock wiring
  intake.ts              folder pickers, drag-drop traversal, the session registry
  model/
    canon.ts             the vendor-neutral event model every adapter produces
    metrics.ts           the analyzer's output contract, with provenance on every number
    protocol.ts          worker <-> UI messages
  vendor/
    detect.ts            sniffing: bytes -> vendor + confidence, never by extension
    claude.ts            Claude Code .jsonl (reference implementation)
    codex.ts             Codex rollout .jsonl (experimental)
    cursor.ts            Cursor state.vscdb / exported chat (experimental)
    sqlite.ts            a read-only SQLite b-tree reader, no dependencies
    builder.ts           body clipping, the worker's body store, quality counters
    text.ts              shared text helpers (command heads, diffs, paths)
  metrics/
    index.ts             CanonEvent[] -> SessionMetrics; nothing here branches on vendor
    tokens.ts            billed usage and context cost, never summed together
    time.ts              wall / active / busy, idle gaps, interval union
    ops.ts               the operations table and its drill-downs
    plan.ts steps.ts     plan detection, step extraction, revision diffing
    phases.ts            phase boundaries with rules and confidence
    improve.ts           iterations after implementation, unplanned work
    estimate.ts          the token heuristic and its calibration
    quality.ts           the data-quality report
    compare.ts           A/B metric pairing
  worker/
    parse.worker.ts      owns the File; runs the adapter, the metrics and the expand path
    jsonl.ts             byte-level line splitter with exact offsets
    images.ts            base64 -> Blob object URLs
  view/
    virtualizer.ts       windowing, measurement, recycling
    fenwick.ts           O(log n) height index
    timeline.ts          filtering, folding, phase markers, the token gutter
    kinds.ts icons.ts    display categories and their glyphs
    rows.ts              event -> row HTML, including the cost and duration chips
    markdown.ts          markdown / diff / plain renderers, all escaping
    ask.ts               question rows: the options offered, and the one picked
    report.ts            the Markdown export
    dock/                overview, operations, phases, plan, quality, compare
  store/
    cache.ts             IndexedDB metrics cache — numbers only, never content
    prefs.ts             localStorage settings, calibration, manual overrides
tools/
  inspect.mjs            stream a transcript, print only aggregates (never open the file)
  gen-fixture.mjs        synthetic transcripts; --scenario emits the known-answer fixture
  scenario.mjs           a small awkward transcript plus the ground truth for every metric
test/
  parser.test.mjs        line splitting, text helpers, categories, height index, markdown
  adapters.test.mjs      all three adapters, the SQLite reader, vendor detection
  metrics.test.mjs       every metric against the scenario's known answers, plus invariants
  view.test.mjs          panels render, provenance survives, transcript text stays escaped
  example.test.mjs       the real 5.7 MB transcript: invariants and estimator calibration
```

## Notes on the formats

- **Claude Code** is the reference format: it is the only one that records per-request usage, so it
  is the only one where the estimator can be checked against something real.
- `thinking` blocks often carry only a signature — the reasoning text is not persisted. Those turns
  are excluded from estimator calibration, because their reported output tokens describe text this
  file does not contain. On `example.jsonl` this makes the estimator un-calibratable, and the tool
  says so in the quality panel rather than fitting to the gap.
- A call with no result is `unpaired`, never `ok`. A result with no call is kept as an orphan and
  counted.
- **Codex** reports *cumulative* token counters, so per-request usage is a difference. A counter that
  goes backwards means the context was reset; the delta is clamped to zero and the session is
  annotated, so those totals are low rather than wrong-high.
- **Codex runs everything through one tool.** Rollouts call `exec` with a *program* — JavaScript that
  calls `tools.exec_command({cmd})`, `apply_patch`, `view_image` or `web.search`. So the operations
  are what that program did, and Codex reports them on a second channel: `item_completed` events
  carrying the command, its `cwd`, Codex's own read/search/execute classification of it, the exit
  code, the duration and the output. Reading operations from there is what gives a Codex session the
  same shape a Claude session has — one row per command, patched file, search or image — instead of
  fifty identical `exec` rows. Which channel wins is decided **per call**, so older rollouts that have
  no item stream keep the script-parsing path: their shell commands are still lifted out of the script
  for the row head, and a patch envelope is still decoded and shown as a diff.
- **One call is usually one row.** Most calls emit exactly one item. A program that did several
  different things becomes several rows and is shown once above the first, the way parallel tool calls
  already work; the cost of the one envelope that carried the results back is shared between them
  rather than charged to whichever row came first.
- **A command's row shows what the model was given** — Codex truncates long output before the model
  sees it — and the full `stdout` is one expand away, marked with a chip.
- **Codex file edits, plans, web searches and questions all arrive as items.** Each patched file is
  its own edit row with its diff; plans become plan revisions (in the newer format there is no plan
  *tool* at all, so without this the Plan tab would stay empty); `web.search` becomes a link list; and
  `request_user_input` becomes the same question row Claude's `AskUserQuestion` gets — every option
  with its description, the chosen one marked, and free-typed answers kept verbatim. Codex keys its
  answers by question id and returns them as lists, which is the only evidence that a question took
  more than one.
- **Codex times its own turns.** `time_to_first_token_ms` makes think time *reported* rather than
  inferred from record stamps, and the last usage record's rate limits become a line in the quality
  panel. Per-command durations under a millisecond are treated as bookkeeping, not measurements: the
  call's own wall time stands in.
- **Codex reasoning carries no readable text** — encrypted in one format, empty in the other. The
  session says so rather than looking as though it never thought.
- **Cursor** records no token usage at all and often no per-message timestamps, so its token figures
  are estimated, its durations are mostly unavailable, and its busy clock does not exist. Its schema
  is undocumented and moves between versions; both adapters are labelled experimental until they have
  been validated against more real samples.

## Not built (deliberately)

- No cost estimation and no pricing table. Tokens only.
- No normalization in comparison — absolute values, with both sides' scale shown so the difference in
  size is at least visible.
- No merged multi-session timeline; sessions are switched, not interleaved.
- Full-text search covers bodies retained in the worker's store; a body over 256 KB is searched only
  through its 8 KB preview.
