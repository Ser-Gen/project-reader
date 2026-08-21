/**
 * The data-quality report (SPEC D16): everything the parse could not read, had
 * to guess, or found contradictory — with the estimator's current calibration
 * and its residual error against reported usage.
 */

import type { QualityReport } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { empty, plain, section } from './fmt.js';

function counts(title: string, items: { count: number }[], key: 'type' | 'name'): string {
  if (!items.length) return '';
  return section(
    title,
    `<ul class="files">${items
      .map((i) => `<li><b>${i.count}×</b> ${escapeHtml(String((i as any)[key]))}</li>`)
      .join('')}</ul>`,
  );
}

export function renderQuality(q: QualityReport): string {
  const notes = q.notes.length
    ? `<ul class="notes">${q.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
    : empty('Nothing to flag: every record parsed, every event is timestamped.');

  const cal = q.calibration;
  const calBlock = cal
    ? plain('calibration samples', String(cal.samples)) +
      plain(
        'estimator error',
        cal.medianError === null ? 'not measurable here' : `${(cal.medianError * 100).toFixed(1)}% median`,
        'median absolute error of the token estimator against reported usage',
      ) +
      plain(
        'fitted factors',
        cal.fitted
          ? Object.entries(cal.factors)
              .map(([k, v]) => `${k} ×${v}`)
              .join('  ')
          : cal.note
            ? 'defaults'
            : 'defaults (too few samples to fit)',
        cal.note ?? '',
      )
    : '';

  return (
    section('caveats', notes) +
    section(
      'parse',
      plain('vendor', `${q.vendor} — ${Math.round(q.confidence * 100)}% confident`) +
        plain('records', q.lines.toLocaleString()) +
        plain('events', q.events.toLocaleString()) +
        plain('unparsable lines', q.badLines.toLocaleString()) +
        plain('duplicate ids', q.duplicateIds.toLocaleString()),
    ) +
    section(
      'timestamps',
      plain('missing', q.missingTs.toLocaleString()) +
        plain('inherited from the previous event', q.interpolatedTs.toLocaleString()) +
        plain('out of order', q.clockAnomalies.length.toLocaleString()) +
        (q.clockAnomalies.length
          ? `<ul class="files">${q.clockAnomalies
              .slice(0, 10)
              .map(
                (a) =>
                  `<li>event ${a.idx}: ${escapeHtml(new Date(a.from).toLocaleTimeString())} → ${escapeHtml(
                    new Date(a.to).toLocaleTimeString(),
                  )}</li>`,
              )
              .join('')}</ul>`
          : ''),
    ) +
    section(
      'operations',
      plain('calls never answered', q.unpairedCalls.toLocaleString()) +
        plain('results with no call', q.orphanResults.toLocaleString()),
    ) +
    section(
      'coverage',
      plain('timestamps', `${Math.round(q.coverage.timestamps * 100)}%`) +
        plain('durations', `${Math.round(q.coverage.durations * 100)}%`) +
        plain('token usage', q.coverage.tokens ? 'reported' : 'not recorded — estimated') +
        calBlock,
    ) +
    counts('unknown record types', q.unknownTypes, 'type') +
    counts('tools with no category', q.unknownTools, 'name')
  );
}
