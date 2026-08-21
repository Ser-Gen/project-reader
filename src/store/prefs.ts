/**
 * Preferences — `localStorage`, nothing else.
 *
 * Only settings live here: window geometry, thresholds, the fitted estimator
 * factors, and manual plan/phase overrides keyed by file identity. No transcript
 * content is ever written anywhere (SPEC §9.1).
 */

import type { Calibration } from '../metrics/estimate.js';
import { CLASSES, clampFactor } from '../metrics/estimate.js';
import type { MetricOptions } from '../model/metrics.js';

const KEY = 'project-reader.prefs.v1';

export interface Overrides {
  planningStart?: number;
  planCreated?: number;
  implEnd?: number;
  planSource?: MetricOptions['planSource'];
  episode?: number;
}

export interface Prefs {
  dockOpen: boolean;
  dockWidth: number;
  idleThresholdMs: number;
  mainThreadOnly: boolean;
  cacheEnabled: boolean;
  redactExports: boolean;
  calibration: Calibration;
  /** per session identity (`name|size|mtime`) */
  overrides: Record<string, Overrides>;
}

const DEFAULTS: Prefs = {
  dockOpen: false,
  dockWidth: 460,
  idleThresholdMs: 15 * 60_000,
  mainThreadOnly: false,
  cacheEnabled: true,
  redactExports: false,
  calibration: {},
  overrides: {},
};

let cached: Prefs | null = null;

export function prefs(): Prefs {
  if (cached) return cached;
  let next: Prefs;
  try {
    const raw = localStorage.getItem(KEY);
    next = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    next = { ...DEFAULTS };
  }
  // A corrupted or hand-edited calibration must not silently distort every number.
  const cal: Calibration = {};
  for (const c of CLASSES) {
    const v = next.calibration?.[c];
    if (typeof v === 'number') cal[c] = clampFactor(v);
  }
  next.calibration = cal;
  cached = next;
  return next;
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...prefs(), ...patch };
  cached = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode, quota, or storage disabled — settings just do not persist */
  }
  return next;
}

export function overridesFor(key: string): Overrides {
  return prefs().overrides[key] ?? {};
}

export function saveOverrides(key: string, patch: Overrides): Overrides {
  const all = { ...prefs().overrides };
  const next = { ...(all[key] ?? {}), ...patch };
  for (const k of Object.keys(next) as (keyof Overrides)[]) {
    if (next[k] === undefined) delete next[k];
  }
  if (Object.keys(next).length) all[key] = next;
  else delete all[key];
  savePrefs({ overrides: all });
  return next;
}

/** Build the worker's metric options from prefs plus this session's overrides. */
export function optionsFor(key: string): MetricOptions {
  const p = prefs();
  const o = overridesFor(key);
  return {
    idleThresholdMs: p.idleThresholdMs,
    mainThreadOnly: p.mainThreadOnly,
    calibration: p.calibration,
    planSource: o.planSource,
    episode: o.episode,
    overrides: {
      planningStart: o.planningStart,
      planCreated: o.planCreated,
      implEnd: o.implEnd,
    },
  };
}
