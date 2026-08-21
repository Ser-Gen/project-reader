/**
 * The data-quality report (SPEC D16, §8.1).
 *
 * Bad data is surfaced, never hidden. Every session can say what it could not
 * read, what it had to guess, and how much of itself each metric actually saw.
 */

import type { CanonSession } from '../model/canon.js';
import type { CalibrationReport, QualityReport } from '../model/metrics.js';
import type { RawQuality } from '../vendor/builder.js';
import type { CalFit } from './estimate.js';

function topCounts(m: Map<string, number>, key: 'type' | 'name'): any[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([k, count]) => ({ [key]: k, count }));
}

export function computeQuality(session: CanonSession, raw: RawQuality, fit?: CalFit): QualityReport {
  const { events, info } = session;
  let stamped = 0;
  let ops = 0;
  let timed = 0;
  let unpaired = 0;
  let requests = 0;
  for (const ev of events) {
    if (ev.tsSource === 'record' && ev.ts) stamped++;
    if (ev.tokens.reported) requests++;
    if (ev.kind !== 'op' || !ev.op) continue;
    ops++;
    if (ev.durationMs !== undefined && ev.durationSource !== 'unknown') timed++;
    if (ev.op.status === 'unpaired') unpaired++;
  }

  const notes = [...raw.notes];
  if (info.confidence < 0.5) {
    notes.push(`Format detection was uncertain (${Math.round(info.confidence * 100)}%): ${info.vendor} was the best match.`);
  }
  if (raw.clockAnomalies.length) {
    notes.push(`${raw.clockAnomalies.length} records arrive out of chronological order; negative gaps are clamped to zero.`);
  }
  if (info.badLines) {
    notes.push(`${info.badLines} lines could not be parsed as JSON and were skipped.`);
  }

  const cal: CalibrationReport | undefined = fit && {
    fitted: Object.keys(fit.factors).length > 0,
    samples: fit.samples,
    factors: fit.factors as Record<string, number>,
    medianError: fit.medianError,
    note: fit.note,
  };
  if (fit?.note) notes.push(`Token estimator ${fit.note}.`);

  return {
    vendor: info.vendor,
    confidence: info.confidence,
    lines: info.lines,
    badLines: info.badLines,
    badLineOffsets: raw.badLineOffsets.slice(0, 200),
    events: events.length,
    unknownTypes: topCounts(raw.unknownTypes, 'type'),
    unknownTools: topCounts(raw.unknownTools, 'name'),
    missingTs: raw.missingTs,
    interpolatedTs: raw.interpolatedTs,
    clockAnomalies: raw.clockAnomalies.slice(0, 100),
    unpairedCalls: unpaired,
    orphanResults: raw.orphanResults,
    duplicateIds: raw.duplicateIds,
    notes,
    coverage: {
      timestamps: events.length ? stamped / events.length : 0,
      durations: ops ? timed / ops : 0,
      tokens: requests > 0 ? 1 : 0,
    },
    calibration: cal,
  };
}
