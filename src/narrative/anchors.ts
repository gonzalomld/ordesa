// anchors.ts — PURE anchor resolution. Zero three, zero DOM, runs under tsx
// for verify:3a AND in the browser via progress.ts / camera-rig.ts.
// Nobody else resolves anchors.
//
// Rules:
// - route.json always wins. kmBrief figures are descriptive/rounded.
// - Resolution moves d, NEVER s (C3): every camera magnitude lives in s.
// - Hours hook onto resolved d via TIME_ANCHORS[].via (C2): resolve all
//   distances first, then hook the hours.
// - FOLLOW replan: the yaw table (abs/tangent, unwrapped series, LOS branch
//   vote, A4b gate, A9 pin) is DELETED. Camera = rope model (followAt) +
//   epilogue blend. Nothing here votes sides anymore (E5 amendment).
import {
  BRIEF_LENGTH_M,
  EPI_AZ_DEG,
  EPI_FIT,
  EPI_PITCH,
  FOLLOW_BACK_N,
  FOLLOW_H_CAM_N,
  FOLLOW_LOOK_N,
  FOLLOW_NUDOS_S,
  ROUTE_DIVERGE_PCT,
  S_TO_D_ANCHORS,
  SUNSET_ELEV_DEG,
  SUNSET_SEARCH_END_H,
  SUNSET_SEARCH_START_H,
  SUNSET_TOL_S,
  TIME_ANCHORS,
} from "./choreography.ts";
import { buildPchip, type PchipFn } from "./curve.ts";
import { REF_POINTS } from "../../scripts/geo-constants.ts";

export interface RouteLike {
  n: number;
  lengthM: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  d: ArrayLike<number>;
  /** SINGLE climb series (R2): smoothed-Z accumulation, the published +815 m.
   * route.json writes it as cumClimb; the raw drape never had its own. */
  cumClimb: ArrayLike<number>;
  /** BLOQUEANTE NUEVO: RAW drape Z per sample (route.z is the smoothed-Z
   * drape since the S7 pipeline change — slope must run on the raw, window
   * the only smoothing). Absent in old fixtures: falls back to z. */
  zRaw?: ArrayLike<number>;
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
  /** resolved metres per anchor id (for doctor + time hookup). */
  camDById: Record<string, number>;
  /** FOLLOW profile evaluators (built once in resolveFollowProfile). */
  follow?: FollowProfile;
}

export interface FollowProfile {
  fH: PchipFn;
  fLook: PchipFn;
  fBack: PchipFn;
  /** Epilogue geometry, derived from the loop (E4 amendment, never hand-set). */
  epiAim: { x: number; y: number; z: number };
  epiCam: { x: number; y: number; z: number };
  epiDistPlan: number;
  centroid: { x: number; y: number; z: number };
  loopR: number;
}

export interface FollowEval {
  hCam: number;
  lookM: number;
  backM: number;
}

/** FOLLOW replan: three independent PCHIPs over FOLLOW_NUDOS_S (act-centre
 * knots + explicit 0 / 0.98 ends repeating first/last act values, so the
 * Pradera never extrapolates and the return arrives flat). The epilogue is
 * a MODE (epiAim/epiCam blend), never a ninth knot. */
export function resolveFollowProfile(route: RouteLike): FollowProfile {
  const fH = buildPchip(FOLLOW_NUDOS_S.slice(), FOLLOW_H_CAM_N.slice(), "follow-h");
  const fLook = buildPchip(FOLLOW_NUDOS_S.slice(), FOLLOW_LOOK_N.slice(), "follow-look");
  const fBack = buildPchip(FOLLOW_NUDOS_S.slice(), FOLLOW_BACK_N.slice(), "follow-back");
  // E3 amendment: centroid in plan over route.json, Z = MDT sample-нærmeast
  // (trackAt at the nearest d — the centroid is on the loop by construction
  // closely enough; the epilogue looks AT it from 2600-equivalent height).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < route.n; i++) {
    sx += num(route.x, i);
    sy += num(route.y, i);
  }
  sx /= route.n;
  sy /= route.n;
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < route.n; i++) {
    const q = (num(route.x, i) - sx) ** 2 + (num(route.y, i) - sy) ** 2;
    if (q < bd) {
      bd = q;
      bi = i;
    }
  }
  const zc = num(route.z, bi);
  // E4 amendment: min-enclosing-circle radius approximated by max distance
  // to the centroid (conservative: encloses by construction, margin covers
  // the slack). distPlan fits the loop + 15 % in the horizontal FOV.
  // NOTE: 16/9 aspect in the FOV below = wide-frame fit; portrait crops
  // sides, never cuts the loop vertically (height comes from EPI_PITCH).
  let loopR = 0;
  for (let i = 0; i < route.n; i++) {
    const q = Math.hypot(num(route.x, i) - sx, num(route.y, i) - sy);
    if (q > loopR) loopR = q;
  }
  const fovH = 2 * Math.atan(Math.tan(((50 * Math.PI) / 180) / 2) * (16 / 9));
  const distPlan = (loopR / Math.tan(fovH / 2)) * EPI_FIT;
  const azR = (EPI_AZ_DEG * Math.PI) / 180;
  // EPI az convention: degrees from north, clockwise (same as old yaw).
  const epiX = sx + distPlan * Math.sin(azR);
  const epiY = sy - distPlan * Math.cos(azR);
  const epiZ = zc + distPlan * Math.tan((EPI_PITCH * Math.PI) / 180);
  return {
    fH,
    fLook,
    fBack,
    epiAim: { x: sx, y: sy, z: zc },
    epiCam: { x: epiX, y: epiY, z: epiZ },
    epiDistPlan: distPlan,
    centroid: { x: sx, y: sy, z: zc },
    loopR,
  };
}

/** FOLLOW eval at s (saturate; at/above EPILOGUE_S return the 0.98 values —
 * the epilogue blend lives in the rig, not here). */
export function followAt(profile: FollowProfile, s: number): FollowEval {
  const sc = Math.min(0.98, Math.max(0, s));
  return { hCam: profile.fH(sc), lookM: profile.fLook(sc), backM: profile.fBack(sc) };
}

/** Epilogue blend factor: smoothstep(EPILOGUE_S, 1, s). Modes, not values. */
export function epilogueBlend(s: number): number {
  const k = Math.min(1, Math.max(0, (s - 0.98) / (1 - 0.98)));
  return k * k * (3 - 2 * k);
}

function num(a: ArrayLike<number>, i: number): number {
  return a[i] as number;
}

/** Linear track sample at distance d (route.json is already ~5 m: plenty).
 * climb comes from the SINGLE smoothed series (R2: the published +815 m).
 * z is the route drape as stored (see zRawAt for the raw series). */
export function trackAt(
  route: RouteLike,
  d: number,
): { x: number; y: number; z: number; climb: number } {
  const climbArr = route.cumClimb;
  const n = route.n;
  const dd = route.d;
  if (d <= (num(dd, 0) as number)) {
    return { x: num(route.x, 0), y: num(route.y, 0), z: num(route.z, 0), climb: num(climbArr, 0) };
  }
  if (d >= (num(dd, n - 1) as number)) {
    return {
      x: num(route.x, n - 1),
      y: num(route.y, n - 1),
      z: num(route.z, n - 1),
      climb: num(climbArr, n - 1),
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
    climb: num(climbArr, lo) + (num(climbArr, hi) - num(climbArr, lo)) * f,
  };
}

/** BLOQUEANTE NUEVO: raw drape Z at distance d (linear interp over zRaw,
 * falls back to z when the fixture predates the raw series). The windowed
 * slope runs on THIS — window the only smoothing, never S7-on-S7. */
export function zRawAt(route: RouteLike, d: number): number {
  const arr = route.zRaw ?? route.z;
  const n = route.n;
  const dd = route.d;
  if (d <= (num(dd, 0) as number)) return num(arr, 0);
  if (d >= (num(dd, n - 1) as number)) return num(arr, n - 1);
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
  return num(arr, lo) + (num(arr, hi) - num(arr, lo)) * f;
}

/** Rope heading at d (E5 amendment: kept for G18 + debug-path — the ONLY
 * bearing helper left; the tangent-window yaw model is deleted). Bearing
 * of P(d)->P(d+lookM) in plan, deg from north clockwise.
 * Zigzag guard: the aim can sit on a hairpin while the rope flies straight
 * (I subida: aim 500 m out whips +-100 deg between adjacent d). The heading
 * is therefore measured rope-to-AIM (anchor->aim), the same segment the
 * camera flies — never path-tangent at the aim point. */
export function ropeHeadingDeg(route: RouteLike, d: number, lookM: number, backM?: number): number {
  const a = backM !== undefined ? anchorPlan(route, d, backM) : trackAt(route, d);
  const b = trackAt(route, Math.min(route.lengthM, d + lookM));
  return ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
}

/** Rope anchor in plan (shared by the rig + G18; E2 amendment: extrapolate
 * past P(0) along the opening rope instead of saturating). */
export function anchorPlan(route: RouteLike, d: number, backM: number): { x: number; y: number; z: number; climb: number } {
  if (d >= backM) return trackAt(route, d - backM);
  const p0 = trackAt(route, 0);
  const p1 = trackAt(route, Math.min(route.lengthM, 300));
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const back = backM - d;
  return { x: p0.x - (dx / len) * back, y: p0.y - (dy / len) * back, z: p0.z, climb: p0.climb };
}

/** Along-track plan run between two distances (sums segment lengths).
 * G14: the 200 m window slope divides by THIS, not by endpoint distance —
 * endpoints foreshorten switchbacks (108 m for a 182 m walk at d=1287)
 * and inflate the number to 147 %. */
export function alongTrackRun(route: RouteLike, d0: number, d1: number): number {
  const n = route.n;
  const dd = route.d;
  if (d1 <= d0) return 0;
  // index window containing [d0, d1], found by binary search
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (d0 < (num(dd, mid) as number)) hi = mid;
    else lo = mid;
  }
  let run = 0;
  // walk forward accumulating, clamped to [d0, d1] via interpolated ends
  const atX = (d: number): number => trackAt(route, d).x;
  const atY = (d: number): number => trackAt(route, d).y;
  let prevX = atX(d0);
  let prevY = atY(d0);
  for (let i = lo + 1; i < n; i++) {
    const di = num(dd, i) as number;
    if (di > d1) break;
    if (di < d0) continue;
    const cx = num(route.x, i);
    const cy = num(route.y, i);
    run += Math.hypot(cx - prevX, cy - prevY);
    prevX = cx;
    prevY = cy;
  }
  const ex = atX(d1);
  const ey = atY(d1);
  run += Math.hypot(ex - prevX, ey - prevY);
  return run;
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

  // intermediate fractions inside their span, from brief km figures.
  // A8 is an intermediate again (audit): keeps its brief fraction inside
  // A7->A10. A9 likewise (its d comes from the same fraction rule; only
  // its s moved to A9_S and its yaw is pinned — see below).
  const fA1 = frac(0.3, 0, 2.44);
  const fA2 = frac(1.2, 0, 2.44);
  const fA4 = frac(3.0, 2.44, 9.67);
  const fA5 = frac(6.0, 2.44, 9.67);
  const fA6 = frac(9.0, 2.44, 9.67);
  const fA8 = frac(10.5, 9.67, 18.13);
  const fA9 = frac(14.0, 9.67, 18.13);
  const dA8 = dA7 + (lengthM - dA7) * fA8;
  const dA9 = dA7 + (lengthM - dA7) * fA9;
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
    A9: dA9,
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
  // A7/A8 are distinct again, so all eight rows hook 1:1 (strictly
  // increasing — PCHIP requires it; skip defensively all the same).
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

  const divergencePct = (Math.abs(lengthM - BRIEF_LENGTH_M) / BRIEF_LENGTH_M) * 100;
  void ROUTE_DIVERGE_PCT;
  // FOLLOW replan: no camera table anymore — only rhythm (s->d), hours,
  // and resolved anchor distances. The rope model evaluates followAt().
  return {
    lengthM,
    divergencePct,
    sAnchors,
    dAnchorsM,
    timeD,
    timeH,
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
