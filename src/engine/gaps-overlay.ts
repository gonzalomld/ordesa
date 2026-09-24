// gaps-overlay.ts — §8b ?debug=gaps instrument: straight-trace overlay.
//
// Detection criterion (NOT gap length): for each RAW GPX segment, the
// perpendicular deviation of the resampled+smoothed route points from the
// straight chord between the two raw vertices. A run is painted iff every
// interior route point stays within DEV_TOL_M of the chord AND the run is
// at least MIN_RUN_M long. Turn-per-step was rejected: the route.json
// coordinates are rounded to 0.1 m, which alone injects ±1.15° of heading
// noise — it cannot distinguish. Perpendicular deviation is immune to it:
// rounding moves a point ≤0.07 m off the chord, far below the tolerance.
//
// Boundary points (the smoothed points within SMOOTH_M of either vertex)
// are EXCLUDED from the test: the XY moving average (radius 2 ≈ ±10 m)
// bends the trace toward the neighbour segment there, so endpoints always
// read a deviation that is not straightness. Endpoints never gate.
//
// Lazy chunk (imported only when ?debug=gaps): one Line2 per maximal run
// in magenta (0xff00ff — absent from the palette) using the SAME drape as
// the normal line (copies of its world positions). Draws the WHOLE runs
// regardless of progress: it measures the trace, not the walk.
// renderOrder 7 (above solid 6), depthTest on so terrain occludes honestly.
//
// Never writes a state the piece drives: no uniforms, no progress, no LOD.
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { RouteData } from "./telemetry.ts";

const MAGENTA = 0xff00ff;

/** §8b detection: max perpendicular deviation off the chord (m). Rounding
 * to 0.1 m moves a point ≤0.07 m — the tolerance sits well above that. */
export const DEV_TOL_M = 0.25;
/** §8b detection: minimum run length to paint (m). */
export const MIN_RUN_M = 100;
/** Boundary exclusion each side (m): the XY moving average (radius 2)
 * bends the trace near the raw vertices — endpoints never gate. */
const EDGE_M = 10;

/** Raw GPX vertices in work CRS (EPSG:25830, plan only). */
export interface RawVertex {
  x: number;
  y: number;
}

/** For raw segment j→j+1, test the INTERIOR route points (≥EDGE_M from
 * either vertex) against the chord. Returns the max deviation, or null
 * when the chord is degenerate. Kept for unit checks — the overlay uses
 * the single-pass straightRuns below. */
function segMaxDev(
  route: RouteData,
  raw: RawVertex[],
  cum: number[],
  j: number,
): number | null {
  const ax = raw[j]?.x ?? NaN;
  const ay = raw[j]?.y ?? NaN;
  const bx = raw[j + 1]?.x ?? NaN;
  const by = raw[j + 1]?.y ?? NaN;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  let mx = 0;
  const d0 = cum[j] as number;
  const d1 = cum[j + 1] as number;
  for (let i = 0; i < route.n; i++) {
    const d = route.d[i] as number;
    if (d < d0 + EDGE_M || d > d1 - EDGE_M) continue;
    const dev =
      Math.abs(((route.x[i] as number) - ax) * dy - ((route.y[i] as number) - ay) * dx) / len;
    if (dev > mx) mx = dev;
  }
  return mx;
}

/** Raw segments whose interior trace never leaves the chord corridor are
 * straight (pencil-straight at 25 cm). Returns [dLo, dHi] run ranges in
 * along-track metres, MERGING adjacent straight raw segments into maximal
 * runs, and dropping runs shorter than MIN_RUN_M.
 *
 * SINGLE pass over the route (O(n + m)): route.d is monotonic, so each
 * route point is tested against exactly its raw segment. The naive
 * per-segment scan is O(n·m) ≈ 800k point tests on swiftshader's first
 * paint — that blocked the ?debug=gaps capture behind the gate. */
export function straightRuns(
  route: RouteData,
  raw: RawVertex[],
  cum: number[],
  devTolM = DEV_TOL_M,
  minRunM = MIN_RUN_M,
): Array<readonly [number, number]> {
  const m = raw.length - 1;
  const maxDev = new Float64Array(Math.max(0, m));
  // chord coefficients per segment (ax, ay, dx, dy, invLen), NaN when degenerate
  const cx = new Float64Array(Math.max(0, m));
  const cy = new Float64Array(Math.max(0, m));
  const cxx = new Float64Array(Math.max(0, m));
  const cyy = new Float64Array(Math.max(0, m));
  const inv = new Float64Array(Math.max(0, m));
  for (let j = 0; j < m; j++) {
    const ax = raw[j]?.x ?? NaN;
    const ay = raw[j]?.y ?? NaN;
    const bx = raw[j + 1]?.x ?? NaN;
    const by = raw[j + 1]?.y ?? NaN;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    cx[j] = ax;
    cy[j] = ay;
    cxx[j] = dx;
    cyy[j] = dy;
    inv[j] = len > 0 ? 1 / len : NaN;
  }
  // one sweep: route point i belongs to raw segment j with cum[j] ≤ d < cum[j+1]
  let j = 0;
  for (let i = 0; i < route.n; i++) {
    const d = route.d[i] as number;
    while (j < m - 1 && d >= (cum[j + 1] as number)) j++;
    const d0 = cum[j] as number;
    const d1 = cum[j + 1] as number;
    if (d < d0 + EDGE_M || d > d1 - EDGE_M) continue;
    const iv = inv[j] as number;
    if (!Number.isFinite(iv)) continue;
    const dev =
      Math.abs(
        ((route.x[i] as number) - (cx[j] as number)) * (cyy[j] as number) -
          ((route.y[i] as number) - (cy[j] as number)) * (cxx[j] as number),
      ) * iv;
    if (dev > (maxDev[j] as number)) maxDev[j] = dev;
  }
  const straight: boolean[] = [];
  for (let k = 0; k < m; k++) {
    const len = (cum[k + 1] as number) - (cum[k] as number);
    straight.push(
      len >= minRunM &&
        Number.isFinite(inv[k] as number) &&
        (maxDev[k] as number) <= devTolM,
    );
  }
  const runs: Array<readonly [number, number]> = [];
  let lo = -1;
  for (let k = 0; k <= straight.length; k++) {
    if (straight[k] === true) {
      if (lo < 0) lo = k;
    } else {
      if (lo >= 0) {
        const dLo = cum[lo] as number;
        const dHi = cum[k] as number;
        if (dHi - dLo >= minRunM) runs.push([dLo, dHi]);
        lo = -1;
      }
    }
  }
  return runs;
}

/** One Line2 per polyline run (Line2 has no per-segment colour).
 * worldPos is a flat [x,y,z,…] array ALREADY in world frame (route-line
 * drapePoints or a copy of the line positions — same lattice, same drape).
 * distM parallels it (along-track metres, for range membership). A segment
 * paints iff BOTH endpoints sit inside a run range. renderOrder/depthTest
 * are the caller's choice via opts. Returns the group + painted metres. */
export function buildRunsOverlay(
  worldPos: number[],
  distM: ArrayLike<number>,
  ranges: Array<readonly [number, number]>,
  resolution: THREE.Vector2,
  opts: { color: number; linewidth?: number; opacity?: number; renderOrder?: number },
): { group: THREE.Group; paintedM: number; paintedRuns: number } {
  const group = new THREE.Group();
  let paintedM = 0;
  let paintedRuns = 0;
  const inside = (d: number): boolean => {
    for (const [lo, hi] of ranges) {
      if (d >= (lo as number) && d <= (hi as number)) return true;
    }
    return false;
  };
  let run: number[] = [];
  const flush = (): void => {
    if (run.length < 6) {
      run = [];
      return;
    }
    paintedRuns++;
    const geo = new LineGeometry();
    geo.setPositions(run);
    const mat = new LineMaterial({
      color: opts.color,
      linewidth: opts.linewidth ?? 4.5,
      worldUnits: false,
      alphaToCoverage: false,
      transparent: true,
      opacity: opts.opacity ?? 0.95,
      depthTest: true,
      depthWrite: false,
    });
    mat.resolution.copy(resolution);
    const l = new Line2(geo, mat);
    l.frustumCulled = false;
    l.renderOrder = opts.renderOrder ?? 7;
    group.add(l);
    run = [];
  };
  // A segment paints iff BOTH endpoints sit inside a run range (never bleed
  // past the run edge onto the other trace).
  const nSeg = Math.floor(worldPos.length / 3) - 1;
  const stepM =
    nSeg > 0 && distM.length > 1
      ? ((distM[distM.length - 1] as number) - (distM[0] as number)) / nSeg
      : 5;
  for (let i = 0; i < nSeg; i++) {
    const a = inside(distM[i] as number);
    const b = inside(distM[i + 1] as number);
    if (a && b) {
      if (run.length === 0) {
        run.push(
          worldPos[i * 3] as number,
          worldPos[i * 3 + 1] as number,
          worldPos[i * 3 + 2] as number,
        );
      }
      run.push(
        worldPos[(i + 1) * 3] as number,
        worldPos[(i + 1) * 3 + 1] as number,
        worldPos[(i + 1) * 3 + 2] as number,
      );
      paintedM += stepM;
    } else {
      flush();
    }
  }
  flush();
  return { group, paintedM, paintedRuns };
}

/** §8b ?debug=gaps: straight-run overlay over the CURRENT line. Thin
 * wrapper: copies of the line's draped positions + route.d membership. */
export function buildGapsOverlay(
  linePositions: number[],
  route: RouteData,
  ranges: Array<readonly [number, number]>,
  resolution: THREE.Vector2,
): { group: THREE.Group; inventedM: number; inventedRuns: number } {
  const r = buildRunsOverlay(linePositions, route.d, ranges, resolution, {
    color: MAGENTA,
  });
  return { group: r.group, inventedM: r.paintedM, inventedRuns: r.paintedRuns };
}
