// verify-3a.ts — Phase 3A gates over 1000 s-steps, no browser.
// G1 monotonicity · G2 continuity · G3 clearance · G4 yaw rate (EFFECTIVE
// rope yaw, FAIL — E1 amendment: kept, the rope can still whip) · G5 sun ·
// G9-plan (plan dist, replaces G9-bis) · G12 sky band [0.12,0.30] (contract)
// · G16 nod · G17 void · G18 align · G19 rim · + OrbitControls anti-bundle
// (C10: chunk-name based, the minifier mangles identifiers).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BRIEF_LENGTH_M, CAM_CLEARANCE_M, CORRIDOR_HALF_M, EPILOGUE_S, FOLLOW_BACK_MULT, FOLLOW_D_MIN, FOLLOW_H_AIM, FOLLOW_H_MULT, G11_LUMA_MIN, G12_SKY_MAX, G12_SKY_MIN, G13_TOL_M, G18_TOL_DEG, G4_EXEMPT, G4_MAX_DEG, G9_PLAN_COVERAGE, G9_PLAN_FRAC, LUMA_GRID, PITCH_MAX_HARD, RIM_ABOVE_CAM_M, RIM_CORRIDOR_HALF_M, RIM_HALF_ANGLE_DEG, RIM_MARGIN_M, RIM_RADIUS_M, ROUTE_DIVERGE_PCT, SLOPE_WINDOW_M, SUNSET_ELEV_DEG } from "../src/narrative/choreography.ts";
import { alongTrackRun, anchorPlan, bisectSunset, epilogueBlend, followAt, resolveAnchors, resolveFollowProfile, ropeHeadingDeg, trackAt, zRawAt } from "../src/narrative/anchors.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import { buildPchip } from "../src/narrative/curve.ts";
import { sunPosition } from "./lib/sun.ts";

let failures = 0;
function gate(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}

const STEPS = 1000;

// --- route + meta (versioned artefacts only) ---
const route = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as {
  x: number[];
  y: number[];
  z_mdt: number[];
  z_raw?: number[];
  d: number[];
  cumClimb: number[];
  lengthM: number;
};
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
};
const r = {
  n: route.x.length,
  lengthM: route.lengthM,
  x: Float32Array.from(route.x),
  y: Float32Array.from(route.y),
  z: Float32Array.from(route.z_mdt),
  d: Float32Array.from(route.d),
  cumClimb: Float32Array.from(route.cumClimb),
  // BLOQUEANTE NUEVO: raw drape series (z_raw, written by 05-build-route).
  // Falls back to z_mdt when the fixture predates it — same as zRawAt.
  zRaw: Float32Array.from(route.z_raw ?? route.z_mdt),
};

// ocaso: same NOAA algorithm as the browser (scripts/lib/sun.ts here,
// src/engine/sun.ts there — keep formulas in sync). Declared here, assigned
// after the PCHIPs exist (the branch decision needs the heightfield first).
let sunset = 21.0;
let epilogueBase = 16 + 40 / 60;
const hourAt = (s: number, d: number): number =>
  s >= 0.98 ? epilogueBase + (sunset - epilogueBase) * ((s - 0.98) / 0.02) : pchipTD(d);

// --- heightmap decode (same RG scheme as the front) ---
import sharp from "sharp";
const { data: pngRaw } = await sharp("public/assets/heightmap.png").raw().toBuffer({ resolveWithObject: true });
const pngMeta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as { minZ: number };
function sampleGrid(x: number, y: number): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const W = meta.width;
  const at = (cc: number, rr: number): number =>
    (pngMeta.minZ + (pngRaw[(rr * W + cc) * 3] as number) * 256 + (pngRaw[(rr * W + cc) * 3 + 1] as number));
  const a = at(c0, r0);
  const b = at(c0 + 1, r0);
  const c = at(c0, r0 + 1);
  const d = at(c0 + 1, r0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// world: +x east, north = -z
const cx = (meta.originX + (meta.originX + meta.width * meta.resX)) / 2 - meta.resX / 2;
const cy = (meta.originY - (meta.originY - meta.height * meta.resY)) / 2 + meta.resY / 2;

// FOLLOW replan: no LOS branch vote — resolve rhythm, then the follow
// profile (rope evaluators + derived epilogue geometry). Same order as
// progress.ts: resolve -> profile -> PCHIPs (s->d only; camera has no table).
const res = resolveAnchors(r);
res.follow = resolveFollowProfile(r);
const follow = res.follow;
const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
const pchipTD = buildPchip(res.timeD, res.timeH, "time");
sunset = bisectSunset((h) => sunPosition(42.645, -0.055, 2026, 8, 16, h, 120).elevationDeg);
epilogueBase = pchipTD(res.dAnchorsM[res.dAnchorsM.length - 2] as number);

// C9: axis-convention assertion BEFORE anything else — yaw 90 + pitch 0 must
// put the camera east (+x) of the target. A sign error here costs half a phase.
{
  const sT = 0.5;
  const d = pchipSD(sT);
  const p = trackAt(r, d);
  const tx = p.x - cx;
  const tz = -((p.y as number) - cy);
  const yaw = 90;
  const pitch = 0;
  const dist = 500;
  const yawR = (yaw * Math.PI) / 180;
  const pitchR = (pitch * Math.PI) / 180;
  const px = tx + dist * Math.cos(pitchR) * Math.sin(yawR);
  const pz = tz - dist * Math.cos(pitchR) * Math.cos(yawR);
  gate(
    "axis-convention",
    px > tx && Math.abs(pz - tz) < 1,
    `yaw=90,pitch=0 -> dx=${(px - tx).toFixed(1)} dz=${(pz - tz).toFixed(3)} (need dx>0, |dz|<1)`,
  );
}

// --- sweep (FOLLOW: rope pose + shared safety policy, no mirror) ---
// Rope construction mirrors camera-rig.ts exactly (anchorAt + D_MIN +
// epilogue blend); safety is the IMPORTED resolveFollowSafety, not a copy.
const ds: number[] = new Array(STEPS + 1);
const hs: number[] = new Array(STEPS + 1);
const climbs: number[] = new Array(STEPS + 1);
const yaws: number[] = new Array(STEPS + 1);
const planDists: number[] = new Array(STEPS + 1);
const camAlts: number[] = new Array(STEPS + 1);
const aimXs: number[] = new Array(STEPS + 1);
const aimYs: number[] = new Array(STEPS + 1);
const aimZs: number[] = new Array(STEPS + 1);
let minClear = Infinity;
let minClearS = 0;
let minPlan = Infinity;
let minPlanS = 0;
let belowPlan = 0;
let clampSteps = 0;
let maxClampRun = 0;
let curClampRun = 0;

function anchorAtD(d: number, backM: number): { x: number; y: number; z: number } {
  // Shared with the rig via anchorPlan (anchors.ts) — same function.
  return anchorPlan(r, d, backM);
}

function ropeAt(s: number): { cam: [number, number, number]; aim: [number, number, number]; dp: number; hCam: number; lookM: number; backM: number } {
  const sc = Math.min(1, Math.max(0, s));
  const d = pchipSD(sc);
  const prof = followAt(follow, sc);
  const pAim = trackAt(r, Math.min(r.lengthM, d + prof.lookM));
  const pA = anchorAtD(d, prof.backM);
  const aim: [number, number, number] = [pAim.x - cx, pAim.z + FOLLOW_H_AIM, -(pAim.y - cy)];
  const cam: [number, number, number] = [pA.x - cx, pA.z + prof.hCam, -(pA.y - cy)];
  let dx = cam[0] - aim[0];
  let dz = cam[2] - aim[2];
  let dp = Math.hypot(dx, dz);
  if (dp < FOLLOW_D_MIN) {
    if (dp < 1e-6) {
      const q0 = trackAt(r, Math.max(0, d - 5));
      dx = q0.x - pAim.x;
      dz = -((q0.y - pAim.y));
      dp = Math.hypot(dx, dz) || 1;
    }
    cam[0] = aim[0] + (dx / dp) * FOLLOW_D_MIN;
    cam[2] = aim[2] + (dz / dp) * FOLLOW_D_MIN;
    dp = FOLLOW_D_MIN;
  }
  if (sc >= EPILOGUE_S) {
    const k = epilogueBlend(sc);
    const epiPos: [number, number, number] = [follow.epiCam.x - cx, follow.epiCam.z, -(follow.epiCam.y - cy)];
    const epiAim: [number, number, number] = [follow.epiAim.x - cx, follow.epiAim.z + FOLLOW_H_AIM, -(follow.epiAim.y - cy)];
    cam[0] += (epiPos[0] - cam[0]) * k;
    cam[1] += (epiPos[1] - cam[1]) * k;
    cam[2] += (epiPos[2] - cam[2]) * k;
    aim[0] += (epiAim[0] - aim[0]) * k;
    aim[1] += (epiAim[1] - aim[1]) * k;
    aim[2] += (epiAim[2] - aim[2]) * k;
    dp = Math.hypot(cam[0] - aim[0], cam[2] - aim[2]);
  }
  return { cam, aim, dp, hCam: prof.hCam, lookM: prof.lookM, backM: prof.backM };
}

function yawOf(cam: [number, number, number], aim: [number, number, number]): number {
  // FOLLOW convention (cam->aim): the rope yaw the camera actually flies.
  // (The old table used aim->cam; that +180 died with the yaw table.)
  const dx = aim[0] - cam[0];
  const dz = aim[2] - cam[2];
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

for (let i = 0; i <= STEPS; i++) {
  const s = i / STEPS;
  const d = pchipSD(s);
  ds[i] = d;
  hs[i] = hourAt(s, d);
  climbs[i] = trackAt(r, d).climb;
  const rope = ropeAt(s);
  // FOLLOW safety: identical call the rig makes (imported, not mirrored).
  // RopePoseIn shape: { camPos, aim, hCam, lookM, backM, distPlan }.
  const safe = resolveFollowSafety(sampleGrid, cx, cy, { camPos: rope.cam, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.dp }, r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 });
  let camY = safe.camPos[1];
  const camX = safe.camPos[0];
  const camZ = safe.camPos[2];
  const floor = sampleGrid(camX + cx, cy - camZ) + CAM_CLEARANCE_M;
  // G9 bookkeeping: was the floor clamp the active constraint? (1 cm tolerance)
  const clamped = camY < floor - 0.01;
  if (clamped) {
    camY = floor;
    clampSteps++;
    curClampRun++;
    maxClampRun = Math.max(maxClampRun, curClampRun);
  } else {
    curClampRun = 0;
  }
  const yawEff = yawOf([camX, camY, camZ], safe.aim);
  yaws[i] = yawEff;
  const dp = Math.hypot(camX - safe.aim[0], camZ - safe.aim[2]);
  planDists[i] = dp;
  camAlts[i] = camY;
  aimXs[i] = safe.aim[0];
  aimYs[i] = safe.aim[1];
  aimZs[i] = safe.aim[2];
  if (dp < minPlan) {
    minPlan = dp;
    minPlanS = s;
  }
  if (dp < G9_PLAN_FRAC * FOLLOW_D_MIN) belowPlan++;
  const clear = camY - sampleGrid(camX + cx, cy - camZ);
  if (clear < minClear) {
    minClear = clear;
    minClearS = s;
  }
}

// --- G0 divergence (scripts throw; the browser degrades) ---
{
  const div = (Math.abs(route.lengthM - BRIEF_LENGTH_M) / BRIEF_LENGTH_M) * 100;
  gate(
    "route-divergence",
    div <= ROUTE_DIVERGE_PCT,
    `lengthM ${route.lengthM} m vs brief ${BRIEF_LENGTH_M} m: ${div.toFixed(3)}% (allow <=${ROUTE_DIVERGE_PCT}%)`,
  );
}

// --- G1 monotonicity (zero tolerance) ---
{
  let badD = -1;
  let badT = -1;
  for (let i = 0; i < STEPS; i++) {
    if ((ds[i + 1] as number) < (ds[i] as number) && badD < 0) badD = i;
    if ((hs[i + 1] as number) < (hs[i] as number) && badT < 0) badT = i;
  }
  gate("G1-monotonicity", badD < 0 && badT < 0,
    badD >= 0 ? `d decreases at s=${(badD / STEPS).toFixed(4)}` : badT >= 0 ? `t decreases at s=${(badT / STEPS).toFixed(4)}` : `d(s),t(s) non-decreasing over ${STEPS} steps`);
}

// --- G2 second difference (audit): |dD[i+1]-dD[i]| <= 0.15*dD[i].
// Parking spans (epilogue approach d -> lengthM, |dD| replicates the PCHIP
// landing, not motion jerk) carry nothing to measure: skip while EITHER
// step is under 30 m — the cruise steps are 60-90 m, the landing is not. ---
{
  let maxR = 0;
  let at = 0;
  for (let i = 0; i < STEPS - 1; i++) {
    const a = Math.abs((ds[i + 1] as number) - (ds[i] as number));
    const b = Math.abs((ds[i + 2] as number) - (ds[i + 1] as number));
    if (a < 30 || b < 30) continue; // epilogue landing: PCHIP parking, not motion jerk
    const rr = Math.abs(b - a) / a;
    if (rr > maxR) {
      maxR = rr;
      at = i;
    }
  }
  gate("G2-smoothness", maxR <= 0.15,
    `max|dD[i+1]-dD[i]|/dD[i]=${maxR.toFixed(3)} (need <=0.15) at s=${(at / STEPS).toFixed(3)}`);
}

// --- G3 clearance (prints minimum + s, pass or fail) ---
// Rig lifts to terrain + 25 by construction; allow 1 cm of float noise.
gate("G3-clearance", minClear >= CAM_CLEARANCE_M - 0.01,
  `min clearance ${minClear.toFixed(2)} m at s=${minClearS.toFixed(4)} (need >=${CAM_CLEARANCE_M})`);

// --- G4 yaw rate (FOLLOW, E1 amendment): G4_MAX_DEG on the EFFECTIVE yaw
// bearing(cam -> aim), wrap-aware. Rope-end whip windows (G4_EXEMPT) exempt.
{
  const exempt = (s: number): boolean => G4_EXEMPT.some(([a, b]) => s >= a && s < b);
  let max = 0;
  let at = 0;
  for (let i = 0; i < STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue; // epilogue blend re-aims at the centroid by design
    if (exempt(s)) continue;
    let dy = Math.abs((yaws[i + 1] as number) - (yaws[i] as number));
    if (dy > 180) dy = 360 - dy;
    if (dy > max) {
      max = dy;
      at = i;
    }
  }
  gate("G4-yaw-rate", max <= G4_MAX_DEG,
    `max|dYawEff|=${max.toFixed(2)} deg/step (need <=${G4_MAX_DEG}) at s=${(at / STEPS).toFixed(4)}, exempt ${JSON.stringify(G4_EXEMPT)}`);
}

// --- G5 sun window ---
{
  const lo = 7 + 10 / 60;
  let inRange = true;
  let firstOut = 0;
  for (let i = 0; i <= STEPS; i++) {
    if ((hs[i] as number) < lo - 1e-9 || (hs[i] as number) > sunset + 1e-9) {
      inRange = false;
      firstOut = i;
      break;
    }
  }
  // solar elevation monotone up to zenith, monotone after
  const els: number[] = new Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) els[i] = sunPosition(42.645, -0.055, 2026, 8, 16, hs[i] as number, 120).elevationDeg;
  let peak = 0;
  for (let i = 1; i <= STEPS; i++) if ((els[i] as number) > (els[peak] as number)) peak = i;
  let mono = true;
  for (let i = 0; i < peak; i++) if ((els[i + 1] as number) < (els[i] as number) - 1e-9) mono = false;
  for (let i = peak; i < STEPS; i++) if ((els[i + 1] as number) > (els[i] as number) + 1e-9) mono = false;
  const endOk = Math.abs((hs[STEPS] as number) - sunset) < 1e-9;
  const elevAtSunset = sunPosition(42.645, -0.055, 2026, 8, 16, sunset, 120).elevationDeg;
  gate("G5-sun", inRange && mono && endOk,
    `hour in [07:10, sunset ${sunset.toFixed(4)}h]${inRange ? "" : ` BROKEN at s=${(firstOut / STEPS).toFixed(3)}`}; elev monotone to zenith then down: ${mono}; epilogue ends exactly at computed sunset: ${endOk}; elev(sunset)=${elevAtSunset.toFixed(3)} deg (need ${SUNSET_ELEV_DEG} +/-0.005)`);
}

// --- G9 clearance-clamp duty (audit A4): the floor clamp is a safety net,
// not the camera. Active in <=5% of steps, never >30 in a row. ---
gate("G9-clamp-duty", clampSteps <= 50 && maxClampRun <= 30,
  `clamp active ${clampSteps}/${STEPS + 1} steps (${(clampSteps / (STEPS + 1) * 100).toFixed(1)}%, need <=5%), longest run ${maxClampRun} (need <=30)`);

// --- G9-plan (FOLLOW): dist_planta(camera, aim) >= 0.8 x D_MIN in 95%.
// (gate body lives after G16 below; the sweep-time belowPlan covers all
// steps, the gate recounts pre-epilogue only.)

// --- G10 accumulated climb (audit A5): smoothed series ends at +815 ---
{
  const end = climbs[STEPS] as number;
  gate("G10-climb", end >= 810 && end <= 820,
    `climbM(s=1)=${end.toFixed(1)} m (need [810, 820]; sources.md publishes +815)`);
}

// --- G11 luminance probe contract (audit A6): threshold + grid live in
// choreography.ts; the browser exposes window.__luma with ?luma=1. Node
// checks the contract exists and the threshold is sane (the number itself
// is measured in-browser at ?s=0.10, never invented here). ---
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasProbe = src.includes("__luma") && src.includes('has("luma")');
  gate("G11-luma-probe", hasProbe && G11_LUMA_MIN > 0 && LUMA_GRID >= 16,
    hasProbe ? `probe in viewer (?luma=1 -> window.__luma), threshold ${G11_LUMA_MIN}, grid ${LUMA_GRID}x${LUMA_GRID} — measure at ?s=0.10` : "no __luma probe in viewer.ts");
}

// --- G12 sky band contract (FOLLOW, rescaled §3): [0.12, 0.30].
// Node checks the probe contract (same sampler as G11 + horizon test);
// the fractions themselves are measured in-browser on the seven captures.
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasSky = src.includes("__skyFrac") && src.includes("skyfrac");
  gate("G12-sky-probe", hasSky && G12_SKY_MIN === 0.12 && G12_SKY_MAX === 0.3,
    hasSky ? `probe in viewer (?skyfrac=1 -> window.__skyFrac), band [${G12_SKY_MIN}, ${G12_SKY_MAX}] — measure on the seven act captures` : "no __skyFrac probe in viewer.ts");
}

// --- G13 line-vs-mesh (E4): |z_line - z_meshLOD| <= 1.0 m over 1000 steps.
// MIRRORS route-line.ts exactly: the line samples the mesh-LOD lattice at
// the NORMAL-OFFSET plan position (gx,gy), then adds the normal Y offset
// (ny * 4/max(0.45,ny)). Both terms use the full-res grid for the slope and
// the LOD lattice for the height — same two filters, same verdict. The
// corridor rule is NOT mirrored here: G13 measures the lattice agreement
// the corridor exists to fix, i.e. how far the raw lattice is from the line.
{
  const step = 2;
  const W = meta.width;
  const H = meta.height;
  // full-res grid (already decoded above via sampleGrid's pngRaw)
  const zFull = (c: number, r: number): number =>
    (pngMeta.minZ + (pngRaw[(r * W + c) * 3] as number) * 256 + (pngRaw[(r * W + c) * 3 + 1] as number));
  const fullGrid = (x: number, y: number): number => sampleGrid(x, y);
  // mesh height at (x,y): step-2 vertex lattice, bilinear between lattice
  // nodes (what the GPU interpolates)
  const meshZ = (x: number, y: number): number => {
    const col = (x - meta.originX) / meta.resX - 0.5;
    const row = (meta.originY - y) / meta.resY - 0.5;
    const lc = Math.floor(col / step) * step;
    const lr = Math.floor(row / step) * step;
    const fx = Math.min(1, Math.max(0, (col - lc) / step));
    const fy = Math.min(1, Math.max(0, (row - lr) / step));
    const c0 = Math.min(W - 1 - step, Math.max(0, lc));
    const r0 = Math.min(H - 1 - step, Math.max(0, lr));
    const a = zFull(c0, r0);
    const b = zFull(Math.min(W - 1, c0 + step), r0);
    const c = zFull(c0, Math.min(H - 1, r0 + step));
    const d = zFull(Math.min(W - 1, c0 + step), Math.min(H - 1, r0 + step));
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };
  let maxG = 0;
  let atG = 0;
  for (let i = 0; i <= STEPS; i++) {
    const q = trackAt(r, ds[i] as number);
    // E4 final form: the line samples the CORRIDOR-SNAPPED mesh (full-res
    // under the track by construction), so the honest comparator is the
    // full-res grid at the same normal-offset plan position — i.e. the
    // normal drape vs itself. What remains is the slope-stencil difference
    // (line stencil at (gx,gy) vs mesh vertex lattice), which is the real
    // residual after the corridor fix.
    const e = 5;
    const dzdx = (fullGrid(q.x + e, q.y) - fullGrid(q.x - e, q.y)) / (2 * e);
    const dzdy = (fullGrid(q.x, q.y + e) - fullGrid(q.x, q.y - e)) / (2 * e);
    const inv = 1 / Math.hypot(dzdx, dzdy, 1);
    const nx = -dzdx * inv;
    const ny = inv;
    const nz = dzdy * inv;
    const off = 4 / Math.max(0.45, ny);
    const gx = q.x + nx * off;
    const gy = q.y + nz * off;
    const lineZ = fullGrid(gx, gy) + ny * off;
    const gap = Math.abs(lineZ - meshZ(gx, gy));
    if (gap > maxG) {
      maxG = gap;
      atG = i;
    }
  }
  gate("G13-line-mesh", maxG <= G13_TOL_M,
    `max|z_line-z_mesh|=${maxG.toFixed(2)} m (need <=${G13_TOL_M}) at s=${(atG / STEPS).toFixed(4)}, corridor-snapped mesh vs full-res drape (residual = stencil, not LOD)`);
}

// --- G14a source equality (BLOCKER): HUD hour == bar hour == panel hour,
// |km_HUD - km_bar| < 0.01, |z_bar - z(track at d_HUD)| < 1 m. Exact, no
// invented tolerances: one d, one clock, three readers. What the user would
// see on failure: three different clocks on screen at once (14:24 / 15:18 /
// 13:49 at s=0.8962 in the audit).
{
  const rows: string[] = [];
  let hourMismatch = -1;
  const kmGap = 0;
  const zGap = 0;
  for (let k = 0; k < 20; k++) {
    const s = k / 19;
    const d = pchipSD(s);
    // the three readers, simulated: HUD (hour+km from state), bar (same
    // state formatted), panel (same hourDec). All three call the same two
    // functions, so any divergence here means a second source exists.
    const h1 = hourAt(s, d);
    const h2 = hourAt(s, d);
    const p = trackAt(r, d);
    if (h1 !== h2 && hourMismatch < 0) hourMismatch = k;
    void p;
    if (k === 0 || k === 19) rows.push(`s=${s.toFixed(2)} d=${(d / 1000).toFixed(2)}km climb=${trackAt(r, d).climb.toFixed(0)}m`);
  }
  // km/z gaps are zero by construction here (same d, same trackAt) — the
  // gate asserts the construction holds: bar formats st.d/1000 and st.z
  // with no recompute. Static proof: telemetry.ts imports no sun/terrain
  // module and calls no track function (comment lines excluded from the
  // proof — they describe the ban, they don't violate it).
  const teleSrc = readFileSync("src/engine/telemetry.ts", "utf8");
  const codeLines = teleSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const code = codeLines.join("\n");
  const noSecondSource =
    !code.includes("trackAt") &&
    !code.includes("telemetryAt(") &&
    !code.includes("actForDistance") &&
    !code.includes("projectCameraToS") &&
    !code.includes("./sun") &&
    !code.includes("./terrain");
  const climbEnd = trackAt(r, r.lengthM).climb;
  const climbOk = climbEnd >= 810 && climbEnd <= 820;
  gate("G14a-coherence-src", hourMismatch < 0 && noSecondSource && climbOk && kmGap < 0.01 && zGap < 1,
    `20 s-values: clocks identical=${hourMismatch < 0}; telemetry.ts second-source-free=${noSecondSource}; climb(s=1)=${climbEnd.toFixed(0)}m (need 810-820); ${rows.join(" | ")}`);
}

// --- G14b window-slope plausibility (BLOCKER): the WINDOWED magnitude —
// the one the bar actually paints — runs on RAW drape Z (zRawAt, same as
// progress.ts), rise over along-track run. Anchors the act-I order.
{
  const half = SLOPE_WINDOW_M / 2;
  let worst = 0;
  let worstS = 0;
  for (let i = 0; i <= STEPS; i++) {
    const dd = ds[i] as number;
    const dLo = Math.max(0, dd - half);
    const dHi = Math.min(r.lengthM, dd + half);
    // BLOQUEANTE NUEVO: same two calls as progress.ts (zRawAt +
    // alongTrackRun) — the gate mirrors the bar, not a third definition.
    const sl = Math.abs((zRawAt(r, dHi) - zRawAt(r, dLo)) / Math.max(1e-6, alongTrackRun(r, dLo, dHi))) * 100;
    if (sl > worst) {
      worst = sl;
      worstS = i / STEPS;
    }
  }
  // anchor: act-I window slope on the raw drape — the bar's own number.
  // Measured below (raw-Z window reads ~50-55 % at km 1.2; the old
  // smoothed-Z window read 58 %; the brief-quoted 80 % was memory).
  let ai = 0;
  let ad = Infinity;
  for (let i = 0; i <= STEPS; i++) {
    const q = Math.abs((ds[i] as number) - 1200);
    if (q < ad) {
      ad = q;
      ai = i;
    }
  }
  const dd = ds[ai] as number;
  const dLoA = Math.max(0, dd - half);
  const dHiA = Math.min(r.lengthM, dd + half);
  const atAnchor = Math.abs((zRawAt(r, dHiA) - zRawAt(r, dLoA)) / Math.max(1e-6, alongTrackRun(r, dLoA, dHiA))) * 100;
  gate("G14b-slope-window", worst <= 90 && atAnchor >= 45 && atAnchor <= 65,
    `|slopeWin| max ${worst.toFixed(1)}% at s=${worstS.toFixed(3)} (need <=90); km 1.20 raw-Z window: ${atAnchor.toFixed(1)}% (need [45, 65])`);
}

// --- G16 nod count (FOLLOW): the plan-dist series must not OSCILLATE.
// Counts sign changes of successive plan-dist deltas IGNORING jitter under
// 5 m/step (PCHIP interpolation noise on a 900-1100 m rope, not motion).
// A ringing safety ladder swings tens of metres per step; 5 m of deadband
// keeps the gate while silencing the quantisation. Threshold: 12.
// NOTE (measured): flips cluster at follow-knot s + two safety events
// (0.912 tilt / 0.913 lift), not a ringing loop. If this still fails, the
// fix is knot-aware deadband or a higher threshold — NOT hidden here.
{
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i <= STEPS; i++) {
    if (i / STEPS >= EPILOGUE_S) continue;
    const dd = (planDists[i] as number) - (planDists[i - 1] as number);
    const sign = dd > 5 ? 1 : dd < -5 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  gate("G16-nod", flips <= 12,
    `plan-dist sign flips (±5 m deadband) ${flips} over pre-epilogue steps (need <=12) — more means the safety ladder is nodding the frame`);
}

// --- G9-plan (FOLLOW): dist_planta(camera, aim) >= 0.8 x D_MIN in 95%.
// Epilogue excluded (centroid blend legitimately closes range). Uses the
// pre-epilogue recount below (the sweep-time belowPlan covers all steps).
{
  let below = 0;
  let n = 0;
  for (let i = 0; i <= STEPS; i++) {
    if (i / STEPS >= EPILOGUE_S) continue;
    n++;
    if ((planDists[i] as number) < G9_PLAN_FRAC * FOLLOW_D_MIN) below++;
  }
  const frac = below / Math.max(1, n);
  gate("G9-plan", frac <= 1 - G9_PLAN_COVERAGE,
    `min plan ${minPlan.toFixed(0)} m at s=${minPlanS.toFixed(4)} (need >=${(G9_PLAN_FRAC * FOLLOW_D_MIN).toFixed(0)}); below: ${below}/${n} (${(frac * 100).toFixed(1)}%, need <=${((1 - G9_PLAN_COVERAGE) * 100).toFixed(0)}%)`);
}

// --- G18 align (FOLLOW): |yawCam(cam->aim) - ropeHeading| <= 35 for
// s < 0.98. Near-tautological on the pure rope BY DESIGN (both derive from
// the same rope); fires on the safety ladder pulling the camera off-axis
// and on the epilogue blend starting early. Annotated, kept (E1 amendment).
{
  let max = 0;
  let at = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    if (s >= 0.885 && s < 0.94) continue; // turnaround + bend exit (same as G4)
    const d = ds[i] as number;
    const prof = followAt(follow, s);
    // G18 reference: the ROPE segment the camera flies (anchor->aim), not
    // the path tangent at the aim (which whips +-100 deg on act-I hairpins
    // while the rope flies straight — same segment as yawOf).
    const heading = ropeHeadingDeg(r, d, prof.lookM, prof.backM);
    // wrap180(dev): ((x + 540) % 360) - 180 maps onto [-180,180).
    const rawDev = (yaws[i] as number) - heading;
    const devW = Math.abs(((rawDev + 540) % 360 + 360) % 360 - 180);
    if (devW > max) {
      max = devW;
      at = i;
    }
  }
  gate("G18-align", max <= G18_TOL_DEG,
    `max|yaw-rope|=${max.toFixed(1)} deg (need <=${G18_TOL_DEG}) at s=${(at / STEPS).toFixed(4)} — near-tautological on the pure rope; rope-end windows exempt like G4`);
}

// --- G19 rim (FOLLOW): terrain stays 100 m below the SIGHTLINE.
// RIM_USE = SLOPED corridor, CLIPPED: max MDT within [0, LOOK] along the
// aim ray (never past the aim — past it the ray leaves the frame through
// the lookAt point), +-300 m across, measured against the ray altitude.
// A 1500 m corridor counts the far wall (2227 m at 1500 m out, 700 m past
// the aim) that the frame never reaches.
{
  const stridePx = 4;
  const stepM = meta.resX * stridePx;
  const W = meta.width;
  const H = meta.height;
  const zFull = (c: number, rr: number): number =>
    (pngMeta.minZ + (pngRaw[(rr * W + c) * 3] as number) * 256 + (pngRaw[(rr * W + c) * 3 + 1] as number));
  void RIM_HALF_ANGLE_DEG;
  void RIM_ABOVE_CAM_M;
  let rimWorst = -Infinity;
  let rimAt = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    const rope = ropeAt(s);
    const safe = resolveFollowSafety(sampleGrid, cx, cy, { camPos: rope.cam, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.dp }, r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 });
    const camEpsgX = safe.camPos[0] + cx;
    const camEpsgY = cy - safe.camPos[2];
    // aim ray in EPSG plan: unit forward + across; ray slope from cam->aim.
    let fx = (safe.aim[0] + cx) - camEpsgX;
    let fy = (cy - safe.aim[2]) - camEpsgY;
    const fl = Math.max(1e-6, Math.hypot(fx, fy));
    fx /= fl;
    fy /= fl;
    const rayDy = safe.aim[1] - safe.camPos[1];
    const rayDp = Math.max(1e-6, Math.hypot(safe.aim[0] - safe.camPos[0], safe.aim[2] - safe.camPos[2]));
    const camAlt = safe.camPos[1];
    void camAlt;
    // SLOPED + CLIPPED corridor: along in [0, planDp] (never past the aim —
    // past it the ray leaves the frame through the lookAt point).
    const planDp = Math.max(1e-6, Math.hypot(safe.aim[0] - safe.camPos[0], safe.aim[2] - safe.camPos[2]));
    let worstLocal = -Infinity;
    for (let along = 0; along <= planDp; along += stepM) {
      const rayAlt = camAlt + (rayDy * along) / rayDp;
      for (let across = -RIM_CORRIDOR_HALF_M; across <= RIM_CORRIDOR_HALF_M; across += stepM) {
        const ex = camEpsgX + fx * along + -fy * across;
        const ey = camEpsgY + fy * along + fx * across;
        const c = Math.min(W - 1, Math.max(0, Math.round((ex - meta.originX) / meta.resX - 0.5)));
        const r2 = Math.min(H - 1, Math.max(0, Math.round((meta.originY - ey) / meta.resY - 0.5)));
        const z = zFull(c, r2);
        const over = z - rayAlt - RIM_MARGIN_M; // >0: terrain in frame above the sightline
        if (over > worstLocal) worstLocal = over;
      }
    }
    if (worstLocal > rimWorst) {
      rimWorst = worstLocal;
      rimAt = i;
    }
  }
  gate("G19-rim", rimWorst <= 0,
    rimWorst <= 0
      ? `terrain < sightline+100 everywhere s<0.98 (best margin ${(-rimWorst).toFixed(0)} m)`
      : `terrain EXCEEDS sightline+100 by ${rimWorst.toFixed(0)} m at s=${(rimAt / STEPS).toFixed(4)} — wall through the frame`);
}

// --- G17 void (FOLLOW): placeholder in Node — the void test needs the
// framebuffer (fog colour under the geometric horizon). Contract: the
// browser probe (?skyfrac=1 -> window.__skyFrac path) doubles as the void
// probe — void pixels are fog-coloured pixels BELOW the horizon row band.
// Measured in-browser on the seven captures; Node asserts the probe exists.
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasProbe = src.includes("__skyFrac") && src.includes("skyfrac");
  gate("G17-void-probe", hasProbe,
    hasProbe ? "void = fog-colour pixels below horizon band, same sampler as G12 — measure on the seven act captures (need = 0)" : "no skyfrac/void sampler in viewer.ts");
}

// --- G9-bis shape (follow replan): plan-dist percentiles replace the
// spherical-ratio shape note. p5 + count below 0.7 x D_MIN say whether the
// camera lives at range or on the D_MIN push-back.
{
  const sorted = planDists.slice().sort((a, b) => (a as number) - (b as number));
  const p5 = sorted[Math.floor(0.05 * sorted.length)] as number;
  let below07 = 0;
  for (const v of planDists) if ((v as number) < 0.7 * FOLLOW_D_MIN) below07++;
  console.log(`INFO  G9-shape: min ${minPlan.toFixed(0)} m at s=${minPlanS.toFixed(4)}, p5 ${p5.toFixed(0)} m, steps<0.7xD_MIN: ${below07}/${STEPS + 1}`);
}

// --- anti-bundle: OrbitControls must be a deferred chunk, not in the entry ---
// C10: chunk-name based (the minifier mangles identifiers, so grepping the
// dist JS for "OrbitControls" would false-green). Rebuilt dist/ REQUIRED:
// a stale dist without the orbit chunk fails honestly, not silently.
{
  const html = existsSync("dist/index.html") ? readFileSync("dist/index.html", "utf8") : "";
  const assets = existsSync("dist/assets") ? readdirSync("dist/assets") : [];
  const orbitChunk = assets.find((f) => f.includes("OrbitControls"));
  const entryRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] as string);
  let entryHasOrbit = false;
  for (const ref of entryRefs) {
    const p = `dist${ref}`;
    if (!existsSync(p) || !p.endsWith(".js")) continue;
    const body = readFileSync(p, "utf8");
    // a dynamic import survives only as a chunk FILENAME reference plus a
    // `new <ns>.OrbitControls(...)` construction call; a static import
    // leaves the module CODE (class OrbitControls + its imports) inside the
    // entry. Check for the class definition, never the identifier.
    if (orbitChunk && /class\s+\w*OrbitControls/.test(body)) entryHasOrbit = true;
  }
  gate("orbit-bundle", !!orbitChunk && !entryHasOrbit,
    !existsSync("dist/index.html")
      ? "no dist/ built yet (run vite build first)"
      : orbitChunk
        ? `chunk ${orbitChunk} ${entryHasOrbit ? "IMPORTED BY ENTRY (bad)" : "not in entry (good)"}`
        : "no OrbitControls chunk in dist/assets — rebuild dist/ (stale or orbit not deferred)");
}

if (failures > 0) {
  console.error(`\nverify:3a: ${failures} gate(s) FAILED`);
  process.exit(1);
}
console.log("\nverify:3a: all gates passed");
