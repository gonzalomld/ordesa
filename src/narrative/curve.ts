// curve.ts — PCHIP (monotone cubic Hermite, Fritsch-Carlson) + short-arc
// angle lerp. Pure: zero three, zero DOM, runs under tsx for verify:3a.
//
// Why PCHIP: piecewise-linear breaks velocity at every border (a tug);
// per-span smoothstep brakes to zero at every anchor (seven stalls).
// PCHIP gives continuous derivative and guarantees monotonicity: d can
// never go backwards even with badly placed anchors. That guarantee is
// the reason for choosing it, not smoothing.

export type PchipFn = (x: number) => number;

/** Monotone cubic Hermite through (xs, ys). xs must be strictly increasing. */
export function buildPchip(xs: number[], ys: number[], table = "pchip"): PchipFn {
  if (xs.length !== ys.length) throw new Error(`${table}: xs/ys length mismatch`);
  if (xs.length < 2) throw new Error(`${table}: need >= 2 anchors`);
  for (let i = 1; i < xs.length; i++) {
    if (!((xs[i] as number) > (xs[i - 1] as number))) {
      throw new Error(`${table}: xs not strictly increasing at index ${i}`);
    }
  }
  const n = xs.length;
  const h: number[] = new Array(n - 1);
  const delta: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = (xs[i + 1] as number) - (xs[i] as number);
    delta[i] = ((ys[i + 1] as number) - (ys[i] as number)) / (h[i] as number);
  }
  // Fritsch-Carlson tangents: harmonic-mean-weighted where neighbours agree
  // in sign, 0 where they disagree (local extremum -> flatten, never reverse).
  const m: number[] = new Array(n);
  m[0] = delta[0] as number;
  m[n - 1] = delta[n - 2] as number;
  for (let i = 1; i < n - 1; i++) {
    const d0 = delta[i - 1] as number;
    const d1 = delta[i] as number;
    if (d0 === 0 || d1 === 0 || d0 * d1 <= 0) {
      m[i] = 0;
    } else {
      const h0 = h[i - 1] as number;
      const h1 = h[i] as number;
      const w0 = 2 * h1 + h0;
      const w1 = h1 + 2 * h0;
      m[i] = (w0 + w1) / (w0 / d0 + w1 / d1);
    }
  }
  return (x: number): number => {
    if (x <= (xs[0] as number)) return ys[0] as number;
    if (x >= (xs[n - 1] as number)) return ys[n - 1] as number;
    // binary search for the span
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x < (xs[mid] as number)) hi = mid;
      else lo = mid;
    }
    const hh = h[lo] as number;
    const t = (x - (xs[lo] as number)) / hh;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return (
      h00 * (ys[lo] as number) +
      h10 * hh * (m[lo] as number) +
      h01 * (ys[lo + 1] as number) +
      h11 * hh * (m[lo + 1] as number)
    );
  };
}

/** Unwrap nextDeg relative to prevDeg onto the short arc (-180..180). */
export function angleUnwrapDeg(prevDeg: number, nextDeg: number): number {
  return prevDeg + ((((nextDeg - prevDeg + 540) % 360 + 360) % 360) - 180);
}

/** Unwrap a whole series in place order so 350 -> 010 becomes 350 -> 370. */
export function unwrapSeriesDeg(degs: number[]): number[] {
  const out = degs.slice();
  for (let i = 1; i < out.length; i++) {
    out[i] = angleUnwrapDeg(out[i - 1] as number, out[i] as number);
  }
  return out;
}

/**
 * Short-arc lerp between two ALREADY-UNWRAPPED degree values.
 * Linearly lerping 350 -> 010 gives a 340 deg turn the wrong way;
 * unwrapped (350 -> 370) the same lerp gives the 20 deg turn. Used only for
 * unwrapping bookkeeping — per-frame yaw evaluation runs the same PCHIP as
 * dist/pitch/hTarget over the unwrapped degrees (B6).
 */
export function lerpAngleDeg(aUnwrapped: number, bUnwrapped: number, f: number): number {
  return aUnwrapped + (bUnwrapped - aUnwrapped) * f;
}
