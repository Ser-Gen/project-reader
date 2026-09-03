# CLAUDE.md

Browser tool that reads **and analyzes** agent session transcripts (Claude Code, Codex, Cursor):
a chronological timeline plus an analytics dock — tokens, operation time, plan history, A/B compare.
Vite + TypeScript, **zero runtime dependencies**, entirely client-side. Design: [SPEC.md](SPEC.md).

## Commands

```bash
npm run dev      # http://localhost:5173, drop example.jsonl on the page
npm run build    # tsc --noEmit && vite build
npm run check    # types only
npm test         # 85 tests: adapters, metrics, invariants, panels, real transcript
npm run inspect example.jsonl   # aggregates from a transcript, never its content
```

## Structure

```
src/vendor/    adapters: detect → claude | codex | cursor (+ own read-only sqlite.ts)
src/model/     canon.ts (vendor-neutral events), metrics.ts (output contract), protocol.ts
src/metrics/   canon events → SessionMetrics: tokens, time, ops, plan, phases, improve, estimate
src/worker/    owns the File: streaming JSONL by byte offset, images → blob URLs
src/view/      virtualizer + fenwick, rows, markdown, ask, timeline, dock/
src/store/     IndexedDB metrics cache, localStorage prefs
tools/         inspect.mjs, gen-fixture.mjs, scenario.mjs (known-answer fixture)
```

## Things that will bite you

- **Never open `example.jsonl` (5.7 MB) in full** — read it with `tools/inspect.mjs` or a streaming
  script that prints only aggregates. Same for files under `~/.claude/projects`.
- **Nothing in `src/metrics/` may branch on vendor.** Adapters produce `CanonEvent`; metrics only
  ever see that. Adding a vendor means adding an adapter, never an `if`.
- **Two token measures, never summed.** *Billed usage* is vendor-reported (`freshInput = input +
  cacheWrite`; cache reads are their own line — adding them into input inflated the old reader 74×).
  *Context cost* is estimated per operation and always renders `~`.
- **Every number carries provenance** (`reported | derived | estimated | unavailable`). `null` renders
  `—`, never `0`. If a number cannot be known, say so rather than defaulting.
- **Cost is charged where it was paid.** A tool call's arguments count as `payloadIn`; only what
  re-entered the context counts as `payloadOut` (`ToolBody.costText` when the row shows something
  else). Rendering a reconstruction and charging it double is the easy mistake here.
- **The estimator refuses to fit** when the required factor leaves `[0.7, 1.4]` — reasoning tokens are
  billed but not persisted, so a real Claude transcript cannot calibrate it. That refusal is a
  feature; do not tune the divisors to close the gap (SPEC §14 A2).
- **Codex has two rollout formats and the newer one hides its operations.** Everything runs through a
  single `exec` tool whose argument is a script; the real operations arrive as `item_completed`
  events. `codex.ts` prefers those *per call* — if items appeared between a call and its output they
  win, otherwise the script-parsing path runs. Never read content from both channels: messages and
  reasoning arrive on each, and counting them twice doubles every token figure.
- **The `ask` body format is a line protocol split across two files** — `encodeAsk` in
  `vendor/text.ts`, `decodeAsk`/`renderAsk` in `view/ask.ts`. They must stay in step; a round-trip
  test in `test/parser.test.mjs` is the guard. `encodeAsk` takes either an answers map keyed by
  question text (Claude) or a lookup (Codex, which keys by question id and answers with lists).
- **One global stylesheet, short class names.** Grep `src/styles/app.css` before inventing a class —
  `.mk` already meant "phase marker" and silently wrecked a new component.
- **All transcript text is untrusted**: escape at the point of rendering (`escapeHtml`), never
  interpolate raw into HTML.
- **Tests import `.ts` sources directly** through `test/ts-resolve.mjs` (Node 24 type stripping plus a
  `.js` → `.ts` resolve hook). Keep source imports written with `.js` specifiers.
- **`tools/scenario.mjs` holds a known-answer fixture and its ground truth.** Changing what it emits
  changes asserted metric values in `test/metrics.test.mjs` — update both, deliberately.
