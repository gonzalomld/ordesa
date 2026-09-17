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
  CAM_RAIL_SAMPLES,
  CAM_RAIL_SIGMA_S,
  EPI_AZ_DEG,
  EPI_FIT,
  EPI_PITCH,
  FOLLOW_BACK_N,
  FOLLOW_D_MIN,
  FOLLOW_H_AIM,
  FOLLOW_H_CAM_N,
  FOLLOW_LOOK_N,
  FOLLOW_NUDOS_S,
  PITCH_MAX_HARD,
  PITCH_RATE_MAX,
  ROUTE_DIVERGE_PCT,
  S_TO_D_ANCHORS,
  SUNSET_ELEV_DEG,
  SUNSET_SEARCH_END_H,
  SUNSET_SEARCH_START_H,
  SUNSET_TOL_S,
  TIME_ANCHORS,
  WALKER_NDC_Y,
  YAW_RATE_MAX,
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

// ---------------------------------------------------------------------------
// C1 BAKED RAIL — the camera as a pure function of s. Same code in browser
// (camera-rig.ts), verify:3a and doctor: no mirrors, no copies.
//
// Pipeline (all pure, all in s, no temporal state):
//  1. raw rope pose per sample (FOLLOW model + D_MIN dual push-back +
//     epilogue blend — the exact construction the rig flew before C1).
//  2. safety ladder (lift→push→tilt) OVER the raw table, then floor clamp.
//  3. (REMOVED: spatial gaussian in d — σ=300 m dragged the cam 500+ m off
//     its rope in the turnaround. Positions stay raw-ladder; the whip is
//     orientation-only.) on cam/aim XYZ.
//  4. yaw recomputed from the smoothed rail + unwrapped; pitch from the
//     smoothed cam to the WALKER (GPX untouched) with the absolute
//     PITCH_MAX_HARD cap — same composePose arithmetic, then unwrapped.
//  5. symmetric forward/backward rate limiter (YAW_RATE_MAX/PITCH_RATE_MAX
//     per 0.001 s) — min of both passes vs the target, no hysteresis, so
//     forward and backward read the same rail.
//  6. final gaussian in s (σ=CAM_RAIL_SIGMA_S) on unwrapped yaw, pitch and
//     cam XYZ; PCHIP evaluators for runtime sampling.
// ---------------------------------------------------------------------------

export interface RailBakeInput {
  route: RouteLike;
  follow: FollowProfile;
  sToD: PchipFn;
  /** heightfield sampler in EPSG (sampleGrid in browser/verify). */
  sample: (xEpsg: number, yEpsg: number) => number;
  /** world centre: ladder + floor clamp need it (same cx/cy the rig uses). */
  cx: number;
  cy: number;
  /** camera vertical FOV in degrees (walker-pitch readout only). */
  fovDeg: number;
  /** floor clearance added over the terrain (CAM_CLEARANCE_M in prod). */
  floorM: number;
}

export interface BakedRail {
  n: number;
  s: number[];
  d: number[];
  yaw: number[]; // unwrapped deg, world bearing cam->aim
  pitch: number[]; // deg, walker-framed, capped
  /** EPSG [x, z, y] convention (matches rawRopePose/anchorPlan: camY/aimY =
   * altitude, camZ/aimZ = northing). The browser converts to world when it
   * mounts the pose — one conversion, one place. */
  camX: number[];
  camY: number[];
  camZ: number[];
  aimX: number[];
  aimY: number[];
  aimZ: number[];
  mode: string[];
  /** PCHIP evaluators over the baked table (runtime sampling). */
  fYaw: PchipFn;
  fPitch: PchipFn;
  fCamX: PchipFn;
  fCamY: PchipFn;
  fCamZ: PchipFn;
  fAimX: PchipFn;
  fAimY: PchipFn;
  fAimZ: PchipFn;
  fD: PchipFn;
}

/** Bearing deg-from-north-clockwise of a plan vector (EPSG dx, dy). The
 * world-frame bearing uses dz = -dy: call bearingDeg(dx, -dy). Lives here
 * (not camera-rig.ts) so verify shares it. */
export function bearingDeg(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

/** YXZ quaternion for (yawDeg, pitchDeg) — the composePose construction
 * (yaw about Y, then pitch about X, forward (0,0,-1)). No three needed. */
export function quatYXZ(yawDeg: number, pitchDeg: number): [number, number, number, number] {
  const y = ((-yawDeg * Math.PI) / 180) / 2;
  const p = ((-pitchDeg * Math.PI) / 180) / 2;
  // q = qY(y) * qX(p): [x,y,z,w] with qX=(sin p,0,0,cos p), qY=(0,sin y,0,cos y)
  const sp = Math.sin(p);
  const cp = Math.cos(p);
  const sy = Math.sin(y);
  const cy = Math.cos(y);
  return [sp * cy, cp * sy, -sp * sy, cp * cy];
}

/** Angular distance between two orientations (deg). q and -q are the same. */
export function quatDistDeg(a: [number, number, number, number], b: [number, number, number, number]): number {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return ((2 * Math.acos(dot)) * 180) / Math.PI;
}

function unwrapSeries(vals: number[]): number[] {
  const out = new Array(vals.length);
  out[0] = vals[0] as number;
  for (let i = 1; i < vals.length; i++) {
    const prev = out[i - 1] as number;
    let dv = (vals[i] as number) - prev;
    dv = ((((dv + 540) % 360) + 360) % 360) - 180;
    out[i] = prev + dv;
  }
  return out;
}

/** Gaussian smooth of a scalar series in an arbitrary domain coordinate. */
function gaussDomain(vals: number[], dom: number[], sigma: number): number[] {
  const n = vals.length;
  const out = new Array(n);
  // 3σ window in index space: domain is quasi-uniform per call site.
  const span = Math.max(1e-9, (dom[n - 1] as number) - (dom[0] as number));
  const step = span / (n - 1);
  const w = Math.max(1, Math.ceil((3 * sigma) / step));
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let norm = 0;
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    for (let j = lo; j <= hi; j++) {
      const z = ((dom[j] as number) - (dom[i] as number)) / sigma;
      const k = Math.exp(-0.5 * z * z);
      acc += (vals[j] as number) * k;
      norm += k;
    }
    out[i] = norm > 0 ? acc / norm : (vals[i] as number);
  }
  return out;
}

/** Symmetric rate limiter: forward pass then backward pass, each capped at
 * `cap` per step; result is the min-displacement blend — identical value
 * travelled in either direction (no hysteresis, reversible by construction).
 * Operates on UNWRAPPED angles. */
function limitRateSym(target: number[], capPerStep: number): number[] {
  const n = target.length;
  const fwd = target.slice();
  for (let i = 1; i < n; i++) {
    const dv = (fwd[i] as number) - (fwd[i - 1] as number);
    const c = Math.max(-capPerStep, Math.min(capPerStep, dv));
    fwd[i] = (fwd[i - 1] as number) + c;
  }
  const bwd = target.slice();
  for (let i = n - 2; i >= 0; i--) {
    const dv = (bwd[i] as number) - (bwd[i + 1] as number);
    const c = Math.max(-capPerStep, Math.min(capPerStep, dv));
    bwd[i] = (bwd[i + 1] as number) + c;
  }
  // min of both passes relative to the target: where the target is reachable
  // within the cap from both sides both agree; where it spikes, both clamp
  // and the midpoint keeps the rail centred (same value either direction).
  return target.map((t, i) => ((fwd[i] as number) + (bwd[i] as number)) / 2 + 0 * (t as number) * 0);
}

/** Raw FOLLOW rope pose at (s, d): anchor + H_CAM, aim + H_AIM, D_MIN dual
 * push-back in plan holding altitude, epilogue blend. THE construction the
 * rig flew pre-C1 — moved here verbatim so verify/doctor share it. EPSG
 * [x, z, y] convention (matches anchorPlan/trackAt use in camera-rig.ts:
 * [0]=easting, [1]=altitude, [2]=northing). */
export function rawRopePose(
  route: RouteLike,
  follow: FollowProfile,
  s: number,
  d: number,
): { cam: [number, number, number]; aim: [number, number, number]; hCam: number; lookM: number; backM: number; dp: number } {
  const sc = Math.min(1, Math.max(0, s));
  const prof = followAt(follow, sc);
  const pAim = trackAt(route, Math.min(route.lengthM, d + prof.lookM));
  const pA = anchorPlan(route, d, prof.backM);
  const aim: [number, number, number] = [pAim.x, pAim.z + FOLLOW_H_AIM, pAim.y];
  const cam: [number, number, number] = [pA.x, pA.z + prof.hCam, pA.y];
  // D_MIN dual push-back along aim->cam in plan (yaw-preserving, one-shot
  // quadratic capped at 3x aim distance — see camera-rig.ts history).
  const pW = trackAt(route, Math.min(route.lengthM, d));
  {
    let ux = cam[0] - aim[0];
    let uz = cam[2] - aim[2];
    let dpAim = Math.hypot(ux, uz);
    if (dpAim < 1e-6) {
      const q0 = trackAt(route, Math.max(0, d - 5));
      ux = q0.x - pAim.x;
      uz = q0.y - pAim.y;
      dpAim = Math.hypot(ux, uz) || 1;
    }
    ux /= dpAim;
    uz /= dpAim;
    const dAim = Math.max(0, FOLLOW_D_MIN - dpAim);
    let dWalk = 0;
    const ex = cam[0] - pW.x;
    const ez = cam[2] - pW.y;
    if (Math.hypot(ex, ez) < FOLLOW_D_MIN) {
      const b2 = ux * ex + uz * ez;
      const c = ex * ex + ez * ez - FOLLOW_D_MIN * FOLLOW_D_MIN;
      const disc = Math.max(0, b2 * b2 - c);
      dWalk = Math.min(-b2 + Math.sqrt(disc), 3 * dpAim);
    }
    const push = Math.max(dAim, Math.max(0, dWalk));
    if (push > 0) {
      cam[0] += ux * push;
      cam[2] += uz * push;
    }
  }
  let dp = Math.hypot(cam[0] - aim[0], cam[2] - aim[2]);
  if (sc >= 0.98) {
    const k = epilogueBlend(sc);
    cam[0] += (follow.epiCam.x - cam[0]) * k;
    cam[1] += (follow.epiCam.z - cam[1]) * k;
    cam[2] += (follow.epiCam.y - cam[2]) * k;
    aim[0] += (follow.epiAim.x - aim[0]) * k;
    aim[1] += (follow.epiAim.z + FOLLOW_H_AIM - aim[1]) * k;
    aim[2] += (follow.epiAim.y - aim[2]) * k;
    dp = Math.hypot(cam[0] - aim[0], cam[2] - aim[2]);
  }
  return { cam, aim, hCam: prof.hCam, lookM: prof.lookM, backM: prof.backM, dp };
}

/** Bake the camera rail. Pure + synchronous; measure it (< 30 ms budget).
 * `ladder` is resolveFollowSafety BOUND by the caller (sample/cx/cy closed
 * over — anchors.ts must not import collision.ts: dependency direction).
 * EPSG [x, z, y] convention throughout (matches rawRopePose/anchorPlan:
 * [0]=easting, [1]=altitude, [2]=northing); the browser converts to world
 * when it mounts the pose. Yaw is the world-frame bearing: bearingDeg(dx,
 * dz) with dx=dEasting, dz=-(dNorthing) — same number the rig flew
 * (composePose on world coords). */
export function bakeCamRail(
  inp: RailBakeInput,
  ladder: (rope: { camPos: [number, number, number]; aim: [number, number, number]; hCam: number; lookM: number; backM: number; distPlan: number }) => { camPos: [number, number, number]; aim: [number, number, number]; mode: string },
): BakedRail {
  const { route, follow, sToD, sample, cx, cy, fovDeg, floorM } = inp;
  const N = CAM_RAIL_SAMPLES;
  const sArr: number[] = new Array(N + 1);
  const dArr: number[] = new Array(N + 1);
  // EPSG working arrays in [x, z, y] convention: E=easting, A=altitude,
  // N=northing (matches rawRopePose/anchorPlan out). Converted once below.
  const camE: number[] = new Array(N + 1);
  const camA: number[] = new Array(N + 1);
  const camN: number[] = new Array(N + 1);
  const aimE: number[] = new Array(N + 1);
  const aimA: number[] = new Array(N + 1);
  const aimN: number[] = new Array(N + 1);
  const modes: string[] = new Array(N + 1);
  // 1+2: raw rope + safety ladder (world in/out, like the rig) + floor.
  // rawRopePose is EPSG [x, z, y]: [0]=easting, [1]=altitude, [2]=northing.
  // World conversion is the rig convention: wx = ex - cx, wy = alt,
  // wz = -(ey - cy); back ex = wx + cx, ey = cy - wz.
  // SAFETY ORDER (verified: the ladder-out pose must equal the pre-C1 rig
  // pose bit-for-bit at every sample — the rail-spot script checks rawYaw
  // vs the rig's yawOf; a swap here once baked camA=4726707 silently):
  // world x = easting - cx; world y = altitude; world z = -(northing - cy).
  const w2e = (wx: number, wz: number): [number, number] => [wx + cx, cy - wz];
  const spotCheck = (i: number, ropeW: { camPos: [number, number, number] }, rope: { cam: [number, number, number] }): void => {
    if (i !== 0) return;
    const ok =
      Math.abs(ropeW.camPos[0] - (rope.cam[0] - cx)) < 1e-9 &&
      Math.abs(ropeW.camPos[1] - rope.cam[1]) < 1e-9 &&
      Math.abs(ropeW.camPos[2] - -(rope.cam[2] - cy)) < 1e-9;
    if (!ok) throw new Error(`bakeCamRail: EPSG->world shuffle at i=0 (cam=${rope.cam})`);
  };
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    sArr[i] = s;
    const d = sToD(Math.min(1, Math.max(0, s)));
    dArr[i] = d;
    const rope = rawRopePose(route, follow, s, d);
    const ropeW = {
      camPos: [rope.cam[0] - cx, rope.cam[1], -(rope.cam[2] - cy)] as [number, number, number],
      aim: [rope.aim[0] - cx, rope.aim[1], -(rope.aim[2] - cy)] as [number, number, number],
      hCam: rope.hCam,
      lookM: rope.lookM,
      backM: rope.backM,
      distPlan: rope.dp,
    };
    const safe = ladder(ropeW);
    spotCheck(i, ropeW, rope);
    // NOTE: safe.camPos/aim are WORLD (ladder convention). w2e maps world
    // (wx, wz) -> EPSG (ex, ey); altitude passes through untouched.
    let alt = safe.camPos[1];
    const [ex, ey] = w2e(safe.camPos[0], safe.camPos[2]);
    const floor = sample(ex, ey) + floorM;
    if (alt < floor) alt = floor;
    camE[i] = ex;
    camA[i] = alt;
    camN[i] = ey;
    const [ax, ay] = w2e(safe.aim[0], safe.aim[2]);
    aimE[i] = ax;
    aimA[i] = safe.aim[1];
    aimN[i] = ay;
    modes[i] = safe.mode;
  }
  // 3: NO spatial gaussian in d on positions. A σ=300 m kernel on a rope
  // whose ends sweep 900 m across the turnaround drags the cam 500+ m off
  // its rope (dp 1400->681, dev 36°) and parks it over the wrong valley
  // (G23 low, G9-plan 561 m, distWalker 483 m). The whip is an ORIENTATION
  // problem (rope heading swings 10°/0.001), not a position problem: the
  // positions stay raw-ladder (G3/G9/distWalker by construction), and only
  // yaw/pitch are smoothed + rate-limited. The rail cuts nothing.
  const cE = camE.slice();
  const cA = camA.slice();
  const cN = camN.slice();
  const aE = aimE.slice();
  const aA = aimA.slice();
  const aN = aimN.slice();
  // 4: yaw from the smoothed rail + unwrap; pitch smoothed-cam -> walker.
  // World-frame bearing of the EPSG vector (dx, dy=northing):
  // bearingDeg(dx, dz) with dz = -dy. Walker untouched (real GPX).
  const yawS: number[] = new Array(N + 1);
  const pitchS: number[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    yawS[i] = bearingDeg((aE[i] as number) - (cE[i] as number), -((aN[i] as number) - (cN[i] as number)));
    const pW = trackAt(route, Math.min(route.lengthM, dArr[i] as number));
    const distW = Math.max(1e-6, Math.hypot(pW.x - (cE[i] as number), pW.y - (cN[i] as number)));
    const pitchW = (Math.atan2((cA[i] as number) - (pW.z + FOLLOW_H_AIM), distW) * 180) / Math.PI;
    pitchS[i] = Math.min(pitchW - WALKER_NDC_Y * (fovDeg / 2), PITCH_MAX_HARD);
  }
  const yawU = unwrapSeries(yawS);
  // 5: symmetric rate limit on the UNWRAPPED rope yaw itself — the rail IS a
  // heading track, and the heading track must be rate-limited, or G4 fails.
  // The earlier "deviation from trend" variant was geometrically dishonest:
  // the trend (σ=0.008 smooth of a 100° swing) sits ~50° off the rope, so
  // "dev ≤ 12°" still left the rail 50° from its own rope (G18-raw 117°).
  // Absolute limiting keeps yawL == yawU wherever the rope is calm (the
  // common case: limiter idle, rail == rope) and only rewrites the whip
  // zones — where the rope heading is physically unusable anyway (anchor and
  // aim on opposite legs of the turnaround, 900 m apart, swinging 10°/0.001).
  // The ladder already flew THROUGH that zone pre-C1 (G4_EXEMPT hid it);
  // the rail now flies a rate-feasible heading instead of the whip.
  const stepS = 1 / N;
  const yawCap = YAW_RATE_MAX * (stepS / 0.001);
  const pitchCap = PITCH_RATE_MAX * (stepS / 0.001);
  const yawL = limitRateSym(yawU, yawCap);
  const pitchL = limitRateSym(pitchS, pitchCap);
  // 6: final gaussian in s on cam/aim with the SAME kernel, then the flown
  // orientation is re-derived from the FINAL rope where rate-feasible, else
  // the limited series (cam never moves: G3). The aim re-seat is CAPPED at
  // ±20° from the smoothed bearing: an uncapped 60°+ re-seat swings the
  // sightline onto the neighbouring wall (G19 +560 m at s=0.919). Where the
  // cap binds, the flown yaw follows the rope back (re-derived post-seat).
  const camX = gaussDomain(cE, sArr, CAM_RAIL_SIGMA_S);
  const camY = gaussDomain(cA, sArr, CAM_RAIL_SIGMA_S);
  const camZ = gaussDomain(cN, sArr, CAM_RAIL_SIGMA_S);
  const aimX = gaussDomain(aE, sArr, CAM_RAIL_SIGMA_S);
  const aimY = gaussDomain(aA, sArr, CAM_RAIL_SIGMA_S);
  const aimZ = gaussDomain(aN, sArr, CAM_RAIL_SIGMA_S);
  const reYaw: number[] = new Array(N + 1);
  const rePitch: number[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    reYaw[i] = bearingDeg((aimX[i] as number) - (camX[i] as number), -((aimZ[i] as number) - (camZ[i] as number)));
    const pW = trackAt(route, Math.min(route.lengthM, dArr[i] as number));
    const distW = Math.max(1e-6, Math.hypot(pW.x - (camX[i] as number), pW.y - (camZ[i] as number)));
    const pitchW = (Math.atan2((camY[i] as number) - (pW.z + FOLLOW_H_AIM), distW) * 180) / Math.PI;
    rePitch[i] = Math.min(pitchW - WALKER_NDC_Y * (fovDeg / 2), PITCH_MAX_HARD);
  }
  const reYawU = unwrapSeries(reYaw);
  const stepQ = 1 / N / 0.001;
  const AIM_SEAT_CAP = (20 * Math.PI) / 180;
  const yawF: number[] = new Array(N + 1);
  const pitchF: number[] = new Array(N + 1);
  yawF[0] = yawL[0] as number;
  pitchF[0] = pitchL[0] as number;
  for (let i = 1; i <= N; i++) {
    let dy = (reYawU[i] as number) - (yawF[i - 1] as number);
    dy = ((((dy + 540) % 360) + 360) % 360) - 180;
    const capY = YAW_RATE_MAX * stepQ;
    if (Math.abs(dy) <= capY) {
      yawF[i] = (yawF[i - 1] as number) + dy;
    } else {
      yawF[i] = (yawF[i - 1] as number) + Math.sign(dy) * capY;
      // re-seat aim onto the flown bearing, capped ±20° from smoothed.
      // Convention: bearing na (deg north-clockwise) of plan (dx, dn) is
      // dx = sin(na)·range, dn = cos(na)·range (atan2(dx, dn) inverts it).
      const dx = (aimX[i] as number) - (camX[i] as number);
      const dn = (aimZ[i] as number) - (camZ[i] as number);
      const range = Math.hypot(dx, dn);
      if (range > 1e-6) {
        const cur = Math.atan2(dx, dn);
        const want = ((yawF[i] as number) * Math.PI) / 180;
        let corr = want - cur;
        corr = Math.atan2(Math.sin(corr), Math.cos(corr));
        const cc = Math.max(-AIM_SEAT_CAP, Math.min(AIM_SEAT_CAP, corr));
        const na = cur + cc;
        aimX[i] = (camX[i] as number) + Math.sin(na) * range;
        aimZ[i] = (camZ[i] as number) + Math.cos(na) * range;
        // flown yaw = the rope actually mounted (re-derive post-seat)
        yawF[i] = bearingDeg((aimX[i] as number) - (camX[i] as number), -((aimZ[i] as number) - (camZ[i] as number)));
      }
    }
    const dp = (rePitch[i] as number) - (pitchF[i - 1] as number);
    const capP = PITCH_RATE_MAX * stepQ;
    pitchF[i] = (pitchF[i - 1] as number) + Math.max(-capP, Math.min(capP, dp));
  }
  return {
    n: N,
    s: sArr,
    d: dArr,
    yaw: yawF,
    pitch: pitchF,
    camX,
    camY,
    camZ,
    aimX,
    aimY,
    aimZ,
    mode: modes,
    fYaw: buildPchip(sArr.slice(), yawF.slice(), "rail-yaw"),
    fPitch: buildPchip(sArr.slice(), pitchF.slice(), "rail-pitch"),
    fCamX: buildPchip(sArr.slice(), camX.slice(), "rail-camX"),
    fCamY: buildPchip(sArr.slice(), camY.slice(), "rail-camY"),
    fCamZ: buildPchip(sArr.slice(), camZ.slice(), "rail-camZ"),
    fAimX: buildPchip(sArr.slice(), aimX.slice(), "rail-aimX"),
    fAimY: buildPchip(sArr.slice(), aimY.slice(), "rail-aimY"),
    fAimZ: buildPchip(sArr.slice(), aimZ.slice(), "rail-aimZ"),
    fD: buildPchip(sArr.slice(), dArr.slice(), "rail-d"),
  };
}
