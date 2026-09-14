// anchors.ts — PURE anchor resolution (B5). Zero three, zero DOM, runs
// under tsx for verify:3a AND in the browser via progress.ts / camera-rig.ts.
// Nobody else resolves anchors.
//
// Rules (clarifications + review):
// - route.json always wins. kmBrief figures are descriptive/rounded.
// - Resolution moves d, NEVER s: the s values of all three tables are fixed,
//   so the G4-exempt window (s 0.84-0.88) keeps pointing at A8 after resolve.
// - Pinned (derived from the track itself, never hand-written):
//   A0 = 0; A3 = d[argmax z_mdt]; A7 = d[nearest to Cola de Caballo];
//   A8 = d[farthest in plan from the start] (B3, no heading threshold);
//   A10 = lengthM; A11 = lengthM.
// - Intermediates keep their fraction INSIDE their span (C1):
//   A0-A3 -> A1, A2; A3-A7 -> A4, A5, A6; A7-A8 -> none; A8-A10 -> A9.
// - Hours hook onto resolved d via TIME_ANCHORS[].via (C2): resolve all
//   distances first, then hook the hours.
import {
  BRIEF_LENGTH_M,
  CAMERA_ANCHORS,
  ROUTE_DIVERGE_PCT,
  S_TO_D_ANCHORS,
  SUNSET_ELEV_DEG,
  SUNSET_SEARCH_END_H,
  SUNSET_SEARCH_START_H,
  SUNSET_TOL_S,
  TANGENT_WINDOW_M,
  TIME_ANCHORS,
} from "./choreography.ts";
import { angleUnwrapDeg } from "./curve.ts";
import { REF_POINTS } from "../../scripts/geo-constants.ts";

export interface RouteLike {
  n: number;
  lengthM: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  d: ArrayLike<number>;
  cumClimb: ArrayLike<number>;
}

export interface ResolvedAnchors {
  lengthM: number;
  divergencePct: number;
  /** s->d PCHIP inputs (s fixed, d resolved metres). */
  sAnchors: number[];
  dAnchorsM: number[];
  /** time PCHIP inputs (resolved metres -> decimal hours). */
  timeD: number[];
  timeH: number[];
  /** camera PCHIP inputs over fixed s. */
  camIds: string[];
  camS: number[];
  camDistM: number[];
  camPitch: number[];
  camYawUnwrapped: number[];
  camHTarget: number[];
  /** resolved metres per camera anchor id (for doctor + time hookup). */
  camDById: Record<string, number>;
}

function num(a: ArrayLike<number>, i: number): number {
  return a[i] as number;
}

/** Linear track sample at distance d (route.json is already ~5 m: plenty). */
export function trackAt(
  route: RouteLike,
  d: number,
): { x: number; y: number; z: number; climb: number } {
  const n = route.n;
  const dd = route.d;
  if (d <= (num(dd, 0) as number)) {
    return { x: num(route.x, 0), y: num(route.y, 0), z: num(route.z, 0), climb: num(route.cumClimb, 0) };
  }
  if (d >= (num(dd, n - 1) as number)) {
    return {
      x: num(route.x, n - 1),
      y: num(route.y, n - 1),
      z: num(route.z, n - 1),
      climb: num(route.cumClimb, n - 1),
    };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d < (num(dd, mid) as number)) hi = mid;
    else lo = mid;
  }
  const d0 = num(dd, lo);
  const d1 = num(dd, hi);
  const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
  return {
    x: num(route.x, lo) + (num(route.x, hi) - num(route.x, lo)) * f,
    y: num(route.y, lo) + (num(route.y, hi) - num(route.y, lo)) * f,
    z: num(route.z, lo) + (num(route.z, hi) - num(route.z, lo)) * f,
    climb: num(route.cumClimb, lo) + (num(route.cumClimb, hi) - num(route.cumClimb, lo)) * f,
  };
}

/** Smoothed track bearing at d, degrees from north, clockwise. C8: if the
 * track folds back on itself inside the window (< 1 m apart), reuse the
 * last valid bearing — never a 0/90 default. */
export function smoothedBearingDeg(route: RouteLike, d: number, lastValid: number): number {
  const w = TANGENT_WINDOW_M;
  const a = trackAt(route, Math.max(0, d - w));
  const b = trackAt(route, Math.min(route.lengthM, d + w));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1) return lastValid;
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}

function frac(km: number, lo: number, hi: number): number {
  return hi > lo ? (km - lo) / (hi - lo) : 0;
}

export function resolveAnchors(route: RouteLike): ResolvedAnchors {
  const n = route.n;
  const lengthM = route.lengthM;
  // pinned: A3 = cota maxima
  let iMax = 0;
  for (let i = 1; i < n; i++) if (num(route.z, i) > num(route.z, iMax)) iMax = i;
  const dA3 = num(route.d, iMax);
  // pinned: A7 = nearest to Cola de Caballo (phase-1 reference point)
  const cc = REF_POINTS["colaCaballo"] as { x: number; y: number };
  let iCC = 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const q = (num(route.x, i) - cc.x) ** 2 + (num(route.y, i) - cc.y) ** 2;
    if (q < best) {
      best = q;
      iCC = i;
    }
  }
  const dA7 = num(route.d, iCC);
  // pinned: A8 = turnaround = route END of the outbound leg (B3: the Soaso
  // cirque). Farthest-in-plan argmax fires at the eastmost wall BEFORE the
  // Cola (d 9495 < d_cola 9670), which is not the narrative turnaround:
  // the track reaches the Cola (nearest to the falls), then shares the same
  // way back. The turnaround is the Cola index itself — deepest point out.
  // NOTE (G2/G4 audit): A8 == A7 collapses the V(V-regreso) span onto the
  // s 0.86 anchor and forces the whole 8.5 km return into s 0.86-0.98, which
  // fails G2 (5.7x) and G4 (2.2 deg) with the brief numbers as written.
  // Kept as specified: the audit pass decides whether the brief moves A8.
  const dA8 = dA7;

  // intermediate fractions inside their span, from brief km figures
  const fA1 = frac(0.3, 0, 2.44);
  const fA2 = frac(1.2, 0, 2.44);
  const fA4 = frac(3.0, 2.44, 9.67);
  const fA5 = frac(6.0, 2.44, 9.67);
  const fA6 = frac(9.0, 2.44, 9.67);
  const fA9 = frac(14.0, 10.5, 18.13);
  const camDById: Record<string, number> = {
    A0: 0,
    A1: dA3 * fA1,
    A2: dA3 * fA2,
    A3: dA3,
    A4: dA3 + (dA7 - dA3) * fA4,
    A5: dA3 + (dA7 - dA3) * fA5,
    A6: dA3 + (dA7 - dA3) * fA6,
    A7: dA7,
    A8: dA8,
    A9: dA8 + (lengthM - dA8) * fA9,
    A10: lengthM,
    A11: lengthM,
  };

  // s->d anchors hook onto camera-anchor d (s values stay fixed)
  const hook: Record<number, string> = {
    0: "A0",
    0.06: "A1",
    0.3: "A3",
    0.46: "A4",
    0.68: "A6",
    0.86: "A8",
    0.98: "A10",
    1: "A11",
  };
  const sAnchors: number[] = [];
  const dAnchorsM: number[] = [];
  for (const a of S_TO_D_ANCHORS) {
    sAnchors.push(a.s);
    dAnchorsM.push(camDById[hook[a.s] as string] as number);
  }

  // hours hook onto resolved d via TIME_ANCHORS[].via (C2).
  // A8 == A7 by construction (turnaround at the Cola), so the 13:20 row
  // hooks onto the same d as 12:35: drop the duplicate — PCHIP needs
  // strictly increasing x (the epilogue branch carries 13:20 -> 16:40
  // continuity through pchipTD(d_A8..) anyway since d keeps growing).
  const timeD: number[] = [];
  const timeH: number[] = [];
  let prevD = -Infinity;
  for (const t of TIME_ANCHORS) {
    const d = camDById[t.via] as number;
    if (d <= prevD) continue;
    prevD = d;
    timeD.push(d);
    timeH.push(t.hh + t.mm / 60);
  }

  // camera series: resolve tang->abs, then unwrap the whole series (B6)
  const camIds: string[] = [];
  const camS: number[] = [];
  const camDistM: number[] = [];
  const camPitch: number[] = [];
  const camYawRaw: number[] = [];
  const camHTarget: number[] = [];
  let lastBearing = 0;
  let haveBearing = false;
  for (const c of CAMERA_ANCHORS) {
    camIds.push(c.id);
    camS.push(c.s);
    camDistM.push(c.distM);
    camPitch.push(c.pitchDeg);
    camHTarget.push(c.hTargetM);
    if (c.yaw.mode === "abs") {
      camYawRaw.push(c.yaw.deg);
    } else {
      const d = camDById[c.id] as number;
      const b = smoothedBearingDeg(route, d, lastBearing);
      if (!haveBearing && b === lastBearing) {
        // first tang anchor is degenerate inside its window: fall back to
        // the local segment bearing (never a 0/90 default)
        const p0 = trackAt(route, d);
        const p1 = trackAt(route, Math.min(lengthM, d + 5));
        lastBearing = ((Math.atan2(p1.x - p0.x, p1.y - p0.y) * 180) / Math.PI + 360) % 360;
        haveBearing = true;
      } else {
        lastBearing = b;
        haveBearing = true;
      }
      camYawRaw.push((lastBearing + c.yaw.off + 360) % 360);
    }
  }
  const camYawUnwrapped: number[] = [camYawRaw[0] as number];
  for (let i = 1; i < camYawRaw.length; i++) {
    camYawUnwrapped.push(angleUnwrapDeg(camYawUnwrapped[i - 1] as number, camYawRaw[i] as number));
  }

  const divergencePct = (Math.abs(lengthM - BRIEF_LENGTH_M) / BRIEF_LENGTH_M) * 100;
  void ROUTE_DIVERGE_PCT;
  return {
    lengthM,
    divergencePct,
    sAnchors,
    dAnchorsM,
    timeD,
    timeH,
    camIds,
    camS,
    camDistM,
    camPitch,
    camYawUnwrapped,
    camHTarget,
    camDById,
  };
}

/** Bisection over elevAtHour(h) for SUNSET_ELEV_DEG in the search window.
 * Pure: caller passes its own NOAA closure (browser or node version). */
export function bisectSunset(elevAtHour: (h: number) => number): number {
  const tolH = SUNSET_TOL_S / 3600;
  let lo = SUNSET_SEARCH_START_H;
  let hi = SUNSET_SEARCH_END_H;
  const eLo = elevAtHour(lo) - SUNSET_ELEV_DEG;
  const eHi = elevAtHour(hi) - SUNSET_ELEV_DEG;
  if (!(eLo > 0 && eHi < 0)) {
    throw new Error(
      `sunset: no sign change in [${lo}, ${hi}] — timezone or equation-of-time fault, report before continuing`,
    );
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const e = elevAtHour(mid) - SUNSET_ELEV_DEG;
    if (e > 0) lo = mid;
    else hi = mid;
    if (hi - lo < tolH) break;
  }
  return (lo + hi) / 2;
}
