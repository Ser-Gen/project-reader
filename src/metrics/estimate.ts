/**
 * Token estimation (SPEC D13, §5.4).
 *
 * A real BPE tokenizer was rejected as too heavy for a zero-dependency static
 * page, so this is a chars-per-token heuristic — but not a guessed one: Claude
 * reports actual usage, so the divisors are *fitted* against it by least squares
 * and the fitted factors then carry over to vendors that report nothing.
 *
 * Everything estimated here is rendered with a `~` and an `estimated` badge, and
 * is never added to a vendor-reported figure.
 */

export type ContentClass = 'prose' | 'code' | 'json' | 'terminal' | 'path';

export const CLASSES: ContentClass[] = ['prose', 'code', 'json', 'terminal', 'path'];

/** Characters per token, before calibration. */
export const DIVISORS: Record<ContentClass, number> = {
  prose: 4.0,
  code: 3.3,
  json: 2.9,
  terminal: 3.1,
  path: 2.4,
};

/** Multiplier applied to a class's divisor. Bounded, so a bad fit cannot run away. */
export type Calibration = Partial<Record<ContentClass, number>>;

export const CAL_MIN = 0.7;
export const CAL_MAX = 1.4;

export function estTokens(text: string, cls: ContentClass, cal?: Calibration): number {
  if (!text) return 0;
  const f = clampFactor(cal?.[cls] ?? 1);
  return Math.ceil(text.length / (DIVISORS[cls] * f));
}

export function clampFactor(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 1;
  return Math.min(CAL_MAX, Math.max(CAL_MIN, f));
}

/** Which divisor a body should use, from what produced it. */
export function classOf(format: string, hint?: string): ContentClass {
  if (format === 'diff') return 'code';
  if (hint === 'json') return 'json';
  if (hint === 'terminal') return 'terminal';
  if (hint === 'code') return 'code';
  if (hint === 'path') return 'path';
  return format === 'md' ? 'prose' : 'terminal';
}

/* ---------------- calibration ---------------- */

export interface CalSample {
  /** characters per class, in CLASSES order */
  chars: number[];
  /** tokens the vendor reported for exactly that content */
  tokens: number;
  /**
   * 'out' = generated content vs reported output tokens. The transcript holds
   * every character of it, so the ratio is meaningful.
   * 'in'  = content added to the context vs reported fresh input. The system
   * prompt and tool schemas are *not* in the transcript, so these samples are
   * biased and are kept only for reporting, never for fitting.
   */
  kind: 'in' | 'out';
}

export interface CalFit {
  factors: Calibration;
  medianError: number | null;
  samples: number;
  /** why the fit was refused, when it was */
  note?: string;
}

/**
 * Fit per-class divisors by ridge-regularized least squares over requests, then
 * clamp each one into [0.7, 1.4]. Regularization pulls sparse classes back
 * towards the default divisor instead of letting five noisy samples set them.
 */
export function fitCalibration(all: CalSample[], minSamples = 50): CalFit {
  const n = CLASSES.length;
  // Only the generated side can be fitted: it is the one whose every character
  // is in the file. Fitting against fresh input would be fitting against the
  // system prompt, which no transcript contains.
  const samples = all.filter((s) => s.kind === 'out');
  if (samples.length < minSamples) {
    return { factors: {}, medianError: medianError(samples, {}), samples: samples.length };
  }

  // normal equations: (XᵀX + λI) β = Xᵀy, with β nudged toward the default 1/divisor
  const prior = CLASSES.map((c) => 1 / DIVISORS[c]);
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  let scale = 0;
  for (const s of samples) {
    for (let i = 0; i < n; i++) {
      scale += s.chars[i] * s.chars[i];
      for (let j = 0; j < n; j++) a[i][j] += s.chars[i] * s.chars[j];
      b[i] += s.chars[i] * s.tokens;
    }
  }
  const lambda = (scale / (samples.length * n)) * 0.02 + 1;
  for (let i = 0; i < n; i++) {
    a[i][i] += lambda;
    b[i] += lambda * prior[i];
  }

  const beta = solve(a, b) ?? prior;
  const factors: Calibration = {};
  for (let i = 0; i < n; i++) {
    const coef = beta[i];
    if (!Number.isFinite(coef) || coef <= 0) continue;
    const raw = 1 / coef / DIVISORS[CLASSES[i]];
    // A factor that has to be clamped is not a calibration, it is the data
    // telling us the transcript does not contain everything the vendor billed
    // for — most often reasoning the agent generated but never wrote down.
    // Storing the clamp floor would then distort every other vendor, so the
    // whole fit is refused and the defaults stand.
    if (raw < CAL_MIN || raw > CAL_MAX) {
      return {
        factors: {},
        medianError: medianError(samples, {}),
        samples: samples.length,
        note:
          'not calibrated: the reported usage cannot be explained by the text in this transcript ' +
          '(reasoning tokens are generated but not always persisted), so the default divisors stand',
      };
    }
    if (Math.abs(raw - 1) > 0.005) factors[CLASSES[i]] = Number(raw.toFixed(3));
  }

  // Calibration has to earn its place.
  const before = medianError(samples, {});
  const after = medianError(samples, factors);
  if (before !== null && after !== null && after > before) {
    return { factors: {}, medianError: before, samples: samples.length, note: 'not calibrated: the fit was worse than the defaults' };
  }
  return { factors, medianError: after, samples: samples.length };
}

/** Median absolute relative error of the estimator against reported usage. */
export function medianError(samples: CalSample[], cal: Calibration): number | null {
  const errs: number[] = [];
  for (const s of samples) {
    if (s.tokens < 200) continue; // tiny requests are dominated by fixed overhead
    let pred = 0;
    for (let i = 0; i < CLASSES.length; i++) {
      const c = CLASSES[i];
      pred += s.chars[i] / (DIVISORS[c] * clampFactor(cal[c] ?? 1));
    }
    errs.push(Math.abs(pred - s.tokens) / s.tokens);
  }
  if (!errs.length) return null;
  errs.sort((x, y) => x - y);
  return errs[errs.length >> 1];
}

/** Merge a session's fit into the stored one by taking the per-class median. */
export function mergeCalibration(history: Calibration[], next: Calibration): Calibration {
  const out: Calibration = {};
  for (const c of CLASSES) {
    const vals = [...history, next].map((h) => h[c]).filter((v): v is number => typeof v === 'number');
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    out[c] = Number(vals[vals.length >> 1].toFixed(3));
  }
  return out;
}

/** Gaussian elimination with partial pivoting. Returns null on a singular system. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-12) return null;
    [m[col], m[piv]] = [m[piv], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (!f) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / m[i][i]);
}
