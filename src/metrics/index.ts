/**
 * The one entry point: CanonEvent[] in, SessionMetrics out.
 *
 * Nothing in here — or in anything it calls — may branch on vendor. That single
 * rule is what makes comparing a Claude session with a Codex one mean something.
 */

import type { CanonSession } from '../model/canon.js';
import { METRICS_SCHEMA_VERSION, type MetricOptions, type SessionMetrics } from '../model/metrics.js';
import type { RawQuality } from '../vendor/builder.js';
import { fitCalibration, type CalSample } from './estimate.js';
import { computeImprovements } from './improve.js';
import { computeOps } from './ops.js';
import { computePhases } from './phases.js';
import { computePlan } from './plan.js';
import { computeQuality } from './quality.js';
import { computeTime } from './time.js';
import { computeTokens } from './tokens.js';

export interface MetricsInput {
  session: CanonSession;
  raw: RawQuality;
  samples: CalSample[];
  options: MetricOptions;
}

export function computeMetrics({ session, raw, samples, options }: MetricsInput): SessionMetrics {
  const { events, segments, info } = session;
  const fit = fitCalibration(samples);
  const plan = computePlan(events, options);
  const phases = computePhases(events, segments, plan, options);

  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    vendor: info.vendor,
    key: info.id,
    title: info.title,
    model: info.model,
    cwd: info.cwd,
    startTs: info.startTs,
    endTs: info.endTs,
    events: events.length,
    prompts: segments.filter((s) => s.promptIdx >= 0).length,
    segments: segments.length,
    bytes: info.bytes,
    tokens: computeTokens(events),
    time: computeTime(events, options.idleThresholdMs, session.segments),
    ops: computeOps(events, options.mainThreadOnly ?? false),
    plan,
    phases,
    improvements: computeImprovements(events, segments, plan, phases),
    quality: computeQuality(session, raw, fit),
  };
}

export { fitCalibration };
