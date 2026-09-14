// anchors.ts — PURE anchor resolution (B5). Zero three, zero DOM, runs
// under tsx for verify:3a AND in the browser via progress.ts / camera-rig.ts.
// Nobody else resolves anchors.
//
// Rules (clarifications + review):
// - route.json always wins. kmBrief figures are descriptive/rounded.
// - Resolution moves d, NEVER s: the s values of all three tables are fixed,
//   so the G4-exempt window (s 0.84-0.88) keeps pointing at A8 after resolve.
  // pinned (derived from the track itself, never hand-written):
  // A0 = 0; A3 = d[argmax z_mdt]; A7 = d[nearest to Cola de Caballo];
  // A10 = lengthM; A11 = lengthM.
  // (Audit rectification: the old B3 pinned A8 at farthest-in-plan, which
  // collapses on A7 — the farthest point from the Pradera IS the Cola.
  // A8 is an intermediate again, fraction inside A7->A10 like the brief.)
  // - Intermediates keep their fraction INSIDE their span:
  //   A0-A3 -> A1, A2; A3-A7 -> A4, A5, A6; A7-A10 -> A8, A9.
// - Hours hook onto resolved d via TIME_ANCHORS[].via (C2): resolve all
//   distances first, then hook the hours.
import {
  A4B_S,
  A9_S,
  A9_YAW_UNWRAPPED,
  BRIEF_LENGTH_M,
  CAMERA_ANCHORS,
  COLLIDE_MARGIN_M,
  ROUTE_DIVERGE_PCT,
  S_TO_D_ANCHORS,
  SUNSET_ELEV_DEG,
  SUNSET_SEARCH_END_H,
  SUNSET_SEARCH_START_H,
  SUNSET_TOL_S,
  TANGENT_WINDOW_M,
  TIME_ANCHORS,
  YAW_BRANCH_SAMPLES,
} from "./choreography.ts";
import { angleUnwrapDeg, buildPchip } from "./curve.ts";
import { REF_POINTS } from "../../scripts/geo-constants.ts";
import type { Meta } from "../engine/terrain.ts";

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
  /** yaw PCHIP inputs (E5: branch-chosen per pair, see yawBranch below). */
  yawIds: string[];
  yawS: number[];
  yawUnwrapped: number[];
  /** E5.2 audit column: per consecutive pair, winning branch + clear count. */
  yawBranch: { from: string; to: string; branch: "direct" | "plus180"; clear: number; total: number }[];
  /** resolved metres per camera anchor id (for doctor + time hookup). */
  camDById: Record<string, number>;
}

function num(a: ArrayLike<number>, i: number): number {
  return a[i] as number;
}

/** Linear track sample at distance d (route.json is already ~5 m: plenty).
 * climb comes from the SINGLE smoothed series (R2: the published +815 m);
 * Z stays the raw drape everywhere else. */
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

  // camera series: resolve tang->abs, then unwrap the whole series (B6).
  // A4b (sentinel distM/pitchDeg/hTargetM -1) is a pure yaw gate: only yaw
  // is prescribed; dist/pitch/hT interpolate from the neighbour anchors'
  // PCHIPs after they are built.
  // The s->d anchors never include A4b, so build that PCHIP first,
  // sample it, then build the camera series.
  const camIds: string[] = [];
  const camS: number[] = [];
  const camDistM: number[] = [];
  const camPitch: number[] = [];
  const camYawRaw: number[] = [];
  const camHTarget: number[] = [];
  {
    const sA: number[] = [];
    const dA: number[] = [];
    for (const a of S_TO_D_ANCHORS) {
      sA.push(a.s);
      dA.push(camDById[hook[a.s] as string] as number);
    }
    const fSD = buildPchip(sA, dA, "s->d");
    camDById["A4b"] = fSD(A4B_S);
  }
  let lastBearing = 0;
  let haveBearing = false;
  // Raw yaw per anchor (deg 0..360; A9 pinned via `unwrapped` below).
  // A4b dist/pitch/hT stays sentinel here — interpolated after the
  // neighbour PCHIPs exist (two-pass at the end of this block).
  const yawIds: string[] = [];
  const yawS: number[] = [];
  const yawRaw: number[] = [];
  // dist/pitch/hT raw (NaN = interpolate later)
  const distRaw: number[] = [];
  const pitchRaw: number[] = [];
  const hRaw: number[] = [];
  for (const c of CAMERA_ANCHORS) {
    camIds.push(c.id);
    camS.push(c.s);
    if (c.distM < 0 || c.pitchDeg < 0 || c.hTargetM < 0) {
      distRaw.push(NaN);
      pitchRaw.push(NaN);
      hRaw.push(NaN);
      camDistM.push(NaN);
      camPitch.push(NaN);
      camHTarget.push(NaN);
    } else {
      distRaw.push(c.distM);
      pitchRaw.push(c.pitchDeg);
      hRaw.push(c.hTargetM);
      camDistM.push(c.distM);
      camPitch.push(c.pitchDeg);
      camHTarget.push(c.hTargetM);
    }
    if (c.yaw.mode === "hold") {
      camYawRaw.push(NaN);
      continue;
    }
    let raw: number;
    if (c.yaw.mode === "abs") {
      // E5 correction: explicit unwrapped pin wins over the displayed deg
      // (A9 carries unwrapped 266 so the chain holds the short-arc branch).
      raw = c.yaw.unwrapped ?? c.yaw.deg;
      // Unwrap relative to the previous RAW value (pins are absolute on the
      // already-unwrapped branch; angleUnwrapDeg would fold them back).
      if (c.yaw.unwrapped !== undefined && yawRaw.length > 0) {
        raw = c.yaw.unwrapped;
        camYawRaw.push(raw);
        yawIds.push(c.id);
        yawS.push(c.s);
        yawRaw.push(raw);
        continue;
      }
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
      raw = (lastBearing + c.yaw.off + 360) % 360;
    }
    camYawRaw.push(raw);
    yawIds.push(c.id);
    yawS.push(c.s);
    yawRaw.push(raw);
  }
  // A4b interpolation: neighbour-anchored PCHIPs over the scripted
  // values, sampled at its s. (Excluded from its own fit — it IS the sample.)
  {
    const sK: number[] = [];
    const dK: number[] = [];
    const pK: number[] = [];
    const hK: number[] = [];
    for (let i = 0; i < camS.length; i++) {
      if (Number.isNaN(distRaw[i] as number)) continue;
      sK.push(camS[i] as number);
      dK.push(distRaw[i] as number);
      pK.push(pitchRaw[i] as number);
      hK.push(hRaw[i] as number);
    }
    const fD = buildPchip(sK, dK, "cam-dist-nb");
    const fP = buildPchip(sK, pK, "cam-pitch-nb");
    const fH = buildPchip(sK, hK, "cam-h-nb");
    for (let i = 0; i < camS.length; i++) {
      if (!Number.isNaN(distRaw[i] as number)) continue;
      camDistM[i] = fD(camS[i] as number);
      camPitch[i] = fP(camS[i] as number);
      camHTarget[i] = fH(camS[i] as number);
    }
  }
  // A9 pin (E5 correction): displayed 266, unwrapped 266 — the short-arc
  // branch from A8's 125 (+141). A10/A11 ride the pin (heading HOLDS).
  // NOTE: yawUnwrappedFull is the PRE-branch series. The E5.2 decision
  // (chooseYawBranches, needs elev+meta) runs in progress.ts / verify-3a
  // via applyYawBranches() below — resolveAnchors itself stays grid-free
  // so unit callers without a heightfield keep working.
  const yawUnwrappedFull = unwrapYawSeriesPinned(yawRaw, yawIds);
  // scatter back: camYawUnwrapped aligns with camS (no NaN remains — every
  // anchor carries a yaw since the full-turn replan).
  const camYawUnwrapped: number[] = camYawRaw.map(() => NaN);
  {
    let j = 0;
    for (let i = 0; i < camYawRaw.length; i++) {
      if (Number.isNaN(camYawRaw[i] as number)) continue;
      camYawUnwrapped[i] = yawUnwrappedFull[j++] as number;
    }
  }

  const divergencePct = (Math.abs(lengthM - BRIEF_LENGTH_M) / BRIEF_LENGTH_M) * 100;
  void ROUTE_DIVERGE_PCT;
  void A9_S;
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
    /** yaw PCHIP inputs (E5 branch-chosen + A9 pinned — see yawBranch). */
    yawS,
    yawUnwrapped: yawUnwrappedFull,
    yawIds,
    yawBranch: [],
    camDById,
  };
}

function unwrapYawSeriesPinned(raw: number[], ids: string[]): number[] {
  // E5 correction: A9's unwrapped value is pinned (A9_YAW_UNWRAPPED = 266),
  // not derived — the chain unwraps up to A9, jumps to the pin, and holds
  // it through A10/A11 (same displayed 266, same branch: no phantom turn).
  const out: number[] = [raw[0] as number];
  const pinAt = ids.indexOf("A9");
  for (let i = 1; i < raw.length; i++) {
    if (pinAt >= 0 && i >= pinAt) {
      out.push(A9_YAW_UNWRAPPED);
      continue;
    }
    out.push(angleUnwrapDeg(out[i - 1] as number, raw[i] as number));
  }
  return out;
}

// --- E5.2: construction-side branch choice --------------------------------
// For one consecutive anchor pair: sample N intermediate s values, evaluate
// both heading branches (direct PCHIP interpolation vs +180 deg), march the
// target->camera segment over the grid for each. Most clear-LOS wins; ties
// (within 2) go to less total rotation. Pure over (elev, meta).
function losBlocked(
  elev: Float32Array,
  meta: Pick<Meta, "width" | "height" | "resX" | "resY" | "originX" | "originY">,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  tz: number,
  px: number,
  py: number,
  pz: number,
): boolean {
  const dx = px - tx;
  const dy = py - ty;
  const dz = pz - tz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return false;
  const steps = Math.min(120, Math.max(8, Math.floor(dist / 30)));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const ex = tx + dx * f + cx;
    const ey = cy - (tz + dz * f);
    const col = (ex - meta.originX) / meta.resX - 0.5;
    const row = (meta.originY - ey) / meta.resY - 0.5;
    const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
    const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
    const fx = Math.min(1, Math.max(0, col - c0));
    const fy = Math.min(1, Math.max(0, row - r0));
    const W = meta.width;
    const at = (cc: number, rr: number): number => elev[rr * W + cc] as number;
    const terr =
      at(c0, r0) * (1 - fx) * (1 - fy) +
      at(c0 + 1, r0) * fx * (1 - fy) +
      at(c0, r0 + 1) * (1 - fx) * fy +
      at(c0 + 1, r0 + 1) * fx * fy;
    if (terr > ty + dy * f + COLLIDE_MARGIN_M) return true;
  }
  return false;
}

export interface YawBranchInput {
  route: RouteLike;
  elev: Float32Array;
  meta: Pick<Meta, "width" | "height" | "resX" | "resY" | "originX" | "originY">;
  cx: number;
  cy: number;
}

/** E5.2 decision, once at load: per consecutive yaw-anchor pair, which
 * branch (direct vs +180) keeps line-of-sight open at more of N samples.
 * Mutates res in place (yawUnwrapped + yawBranch) and returns it — so
 * progress.ts and verify:3a share the identical series the rig consumes.
 * resolveAnchors() leaves yawBranch: [] and the pre-branch series; THIS is
 * the only place that flips. Call AFTER resolveAnchors, BEFORE first use. */
export function applyYawBranches(res: ResolvedAnchors, inp: YawBranchInput): ResolvedAnchors {
  const r = chooseYawBranches(
    inp,
    res.yawIds,
    res.yawS,
    res.yawUnwrapped,
    res.camS,
    res.camDistM,
    res.camPitch,
    res.camHTarget,
    res.sAnchors,
    res.dAnchorsM,
  );
  res.yawUnwrapped = r.yawUnwrapped;
  res.yawBranch = r.yawBranch;
  // keep the camS-aligned mirror in sync (1:1 since the full-turn replan)
  const order = res.camIds.map((id) => res.yawIds.indexOf(id));
  for (let i = 0; i < res.camYawUnwrapped.length; i++) {
    const yi = order[i] as number;
    res.camYawUnwrapped[i] = yi >= 0 ? (r.yawUnwrapped[yi] as number) : NaN;
  }
  return res;
}

/** E5.2 decision, once at load: per consecutive yaw-anchor pair, which
 * branch (direct vs +180) keeps line-of-sight open at more of 40 samples.
 * Returns the per-pair verdicts AND the (possibly flipped) unwrapped series.
 * Callers print yawBranch in doctor; the rig consumes yawS/yawUnwrapped. */
export function chooseYawBranches(
  inp: YawBranchInput,
  yawIds: string[],
  yawS: number[],
  yawUnwrapped: number[],
  camS: number[],
  camDistM: number[],
  camPitch: number[],
  camHTarget: number[],
  sAnchors: number[],
  dAnchorsM: number[],
): { yawUnwrapped: number[]; yawBranch: ResolvedAnchors["yawBranch"] } {
  const { route, elev, meta, cx, cy } = inp;
  const fSD = buildPchip(sAnchors, dAnchorsM, "s->d");
  const fD = buildPchip(camS, camDistM, "cam-dist-nb2");
  const fP = buildPchip(camS, camPitch, "cam-pitch-nb2");
  const fH = buildPchip(camS, camHTarget, "cam-h-nb2");
  const D2R = Math.PI / 180;
  const N = YAW_BRANCH_SAMPLES;
  const verdicts: ResolvedAnchors["yawBranch"] = [];
  // work on a mutable copy; flipping pair k adds +180 to yaw[k+1..] so the
  // decision compounds along the route (each pair sees prior flips).
  // A9 pin guard (E5 correction): the chain must END on the pinned 266 —
  // A9/A10/A11 hold the descent heading by hand. A flip landing A10 on 266
  // mod 360 but a different branch (e.g. 626 = 266+360) keeps the number and
  // breaks the intent: the descent would circle an extra turn. So a flip is
  // applied only if the resulting A10 stays within 90 deg of the pin.
  const yaw = yawUnwrapped.slice();
  const pinIdx = yawIds.indexOf("A9");
  const pinVal = pinIdx >= 0 ? yaw[pinIdx] : null;
  for (let k = 0; k < yawIds.length - 1; k++) {
    const s0 = yawS[k] as number;
    const s1 = yawS[k + 1] as number;
    const y0 = yaw[k] as number;
    const y1 = yaw[k + 1] as number;
    let clearDirect = 0;
    let clearFlip = 0;
    for (let j = 0; j < N; j++) {
      const s = s0 + ((j + 0.5) / N) * (s1 - s0);
      const f = (s - s0) / Math.max(1e-9, s1 - s0);
      const d = fSD(s);
      const p = trackAt(route, d);
      const tx = p.x - cx;
      const tz = -(p.y - cy);
      const hT = fH(s);
      const ty = p.z + hT;
      const dist = fD(s);
      const pitch = fP(s);
      const place = (yw: number): [number, number, number] => {
        const yr = yw * D2R;
        const pr = pitch * D2R;
        const cp = Math.cos(pr);
        return [tx + dist * cp * Math.sin(yr), ty + dist * Math.sin(pr), tz - dist * cp * Math.cos(yr)];
      };
      const yDirect = y0 + (y1 - y0) * f;
      const yFlip = yDirect + 180;
      const pd = place(yDirect);
      const pf = place(yFlip);
      if (!losBlocked(elev, meta, cx, cy, tx, ty, tz, pd[0], pd[1], pd[2])) clearDirect++;
      if (!losBlocked(elev, meta, cx, cy, tx, ty, tz, pf[0], pf[1], pf[2])) clearFlip++;
    }
    const rotDirect = Math.abs((y1 as number) - (y0 as number));
    const rotFlip = Math.abs((y1 + 180) - (y0 as number));
    // E5.2 tie-break: within 2 samples, less rotation wins.
    // Pin guard: never flip across the A9 pin — the descent heading is
    // hand-decided, not voted. Pairs at/after the pin always go direct.
    let branch: "direct" | "plus180";
    if (pinIdx >= 0 && k >= pinIdx) {
      branch = "direct";
    } else {
      branch =
        clearFlip > clearDirect + 2 ? "plus180" : clearDirect > clearFlip + 2 ? "direct" : rotFlip < rotDirect ? "plus180" : "direct";
      if (branch === "plus180" && pinVal !== null) {
        const after = (yaw[k + 1] as number) + 180;
        // A10 rides every later flip: check where the PIN would land.
        const pinWould = (yaw[pinIdx] as number) + 180;
        if (Math.abs(pinWould - (pinVal as number)) > 90) branch = "direct";
        void after;
      }
    }
    if (branch === "plus180") {
      for (let m = k + 1; m < yaw.length; m++) yaw[m] = (yaw[m] as number) + 180;
    }
    verdicts.push({ from: yawIds[k] as string, to: yawIds[k + 1] as string, branch, clear: branch === "direct" ? clearDirect : clearFlip, total: N });
  }
  return { yawUnwrapped: yaw, yawBranch: verdicts };
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
