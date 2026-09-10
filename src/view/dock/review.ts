/**
 * The review tab: what a thread that judges another agent actually decided.
 *
 * It replaces the operations story for these files, because there are no
 * operations — the thread reads a planned action and answers. Every row links
 * back to the verdict in the timeline, where the action it judged sits directly
 * above it.
 */

import type { ReviewStats, SessionMetrics } from '../../model/metrics.js';
import { escapeHtml } from '../markdown.js';
import { empty, msHuman, plain, section, stat } from './fmt.js';

const DECISION_LABEL: Record<string, string> = {
  allow: 'allowed',
  block: 'blocked',
  ask: 'sent back to a human',
  other: 'other',
};

export function renderReview(m: SessionMetrics): string {
  const r = m.review;
  if (!r.detected) {
    return section(
      'review',
      empty('This conversation contains no reviewed decisions — it is an ordinary session.'),
    );
  }

  const thread = m.thread;
  const head = section(
    'what this thread is',
    plain('role', thread ? thread.label : 'review') +
      (thread?.parentId ? plain('reviews session', thread.parentId) : '') +
      plain('model', m.model ?? '—') +
      `<div class="dnote">Every prompt here was written by the runtime, not by a person: each one quotes the ` +
      `session above and asks for one decision. The work being judged is in that other file.</div>`,
  );

  const counts = section(
    'decisions',
    stat('assessments', r.assessments) +
      stat('allowed', r.allowed) +
      stat('blocked', r.blocked) +
      stat('sent back to a human', r.escalated) +
      stat('never answered', r.unanswered) +
      stat('median time to a verdict', r.medianMs, 'ms'),
  );

  const risk = r.byRisk.length
    ? section(
        'risk as the reviewer rated it',
        r.byRisk.map((b) => plain(b.key, `${b.n}`)).join(''),
      )
    : '';

  const rows = r.verdicts
    .map(
      (v) =>
        `<tr class="rrow" data-ev="${v.idx}" title="show this verdict in the timeline">` +
        `<td class="d-${escapeHtml(v.decision)}">${escapeHtml(v.outcome)}</td>` +
        `<td>${escapeHtml(v.risk ?? '—')}</td>` +
        `<td>${escapeHtml(v.authorization ?? '—')}</td>` +
        `<td class="n">${v.ms === null ? '—' : escapeHtml(msHuman(v.ms))}</td>` +
        `<td class="rw">${escapeHtml(v.subject ?? v.rationale)}</td>` +
        `</tr>`,
    )
    .join('');

  const table = section(
    'every assessment',
    `<table class="rtab"><thead><tr>` +
      `<th>outcome</th><th>risk</th><th>authorization</th><th class="n">took</th><th>action judged</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`,
  );

  return head + counts + risk + table;
}

/** The one line the overview owes a reader who opened a file like this. */
export function reviewNote(r: ReviewStats): string {
  if (!r.detected) return '';
  const parts = [`${r.assessments.value} assessments`];
  if (r.allowed.value) parts.push(`${r.allowed.value} ${DECISION_LABEL.allow}`);
  if (r.blocked.value) parts.push(`${r.blocked.value} ${DECISION_LABEL.block}`);
  if (r.escalated.value) parts.push(`${r.escalated.value} ${DECISION_LABEL.ask}`);
  return parts.join(' · ');
}
