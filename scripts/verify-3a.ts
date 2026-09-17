// verify-3a.ts — Phase 3A gates over 1000 s-steps, no browser.
// G1 monotonicity · G2 continuity · G3 clearance · G4 yaw rate (EFFECTIVE
// rope yaw, FAIL — E1 amendment: kept, the rope can still whip) · G5 sun ·
// G9-plan (plan dist, replaces G9-bis) · G12 sky band [0.12,0.30] (contract)
// · G16 nod · G17 void · G18 align · G19 rim · + OrbitControls anti-bundle
// (C10: chunk-name based, the minifier mangles identifiers).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BRIEF_LENGTH_M, CAM_CLEARANCE_M, CORRIDOR_HALF_M, EPILOGUE_S, FOLLOW_BACK_MULT, FOLLOW_D_MIN, FOLLOW_H_AIM, FOLLOW_H_MULT, G11_LUMA_MIN, G12_SKY_MAX, G12_SKY_MIN, G13_TOL_M, G18_TOL_DEG, G31_LUMA_SHADOW_MIN, G32_CHROMA_SHADOW_MAX, G33_JS_LABELS_MAX_MS, G4_EXEMPT, G4_MAX_DEG, G9_PLAN_COVERAGE, G9_PLAN_FRAC, HEMI_DAY, HEMI_GRAY_MIX, HEMI_LUMA_FLOOR, LUMA_GRID, PITCH_MAX_HARD, RIM_ABOVE_CAM_M, RIM_CORRIDOR_HALF_M, RIM_HALF_ANGLE_DEG, RIM_MARGIN_M, RIM_RADIUS_M, ROUTE_DIVERGE_PCT, SHADOW_INTENSITY, SLOPE_WINDOW_M, SUNSET_ELEV_DEG, WALKER_NDC_Y } from "../src/narrative/choreography.ts";
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
// Second case pins the composePose signs: yaw=0,pitch=30 must look north-down
// dir ≈ (0,-0.5,-0.87). If either fails, the sign in composePose is flipped —
// fix it in the rig, never in this test.
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
  // composePose direction convention (world +X east, +Y up, north = -Z):
  // dir = R_y(-yawR)·R_x(-pitchR)·(0,0,-1)
  //     = (+sin(yawR)·cos(pitchR), -sin(pitchR), -cos(yawR)·cos(pitchR)).
  const yawR2 = 0;
  const pitchR2 = (30 * Math.PI) / 180;
  const dirX = Math.sin(yawR2) * Math.cos(pitchR2);
  const dirY = -Math.sin(pitchR2);
  const dirZ = -Math.cos(yawR2) * Math.cos(pitchR2);
  const dirOk = Math.abs(dirX) < 0.01 && Math.abs(dirY + 0.5) < 0.01 && Math.abs(dirZ + 0.866) < 0.01;
  gate(
    "axis-convention-pitch",
    dirOk,
    `yaw=0,pitch=30 -> dir=(${dirX.toFixed(3)},${dirY.toFixed(3)},${dirZ.toFixed(3)}) (need (0,-0.5,-0.87))`,
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
// G16 input: WANT H-correction per step (safety hCam - rope hCam), before
// any damping. The gate watches its oscillation with a 15 m deadband.
const corrWant: number[] = new Array(STEPS + 1);
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
  // §4: D_MIN DUAL to aim AND walker (same as the rig), along aim→cam
  // (yaw-preserving, one-shot quadratic capped at 3x — never iterate or
  // project onto another ray). dp below stays the camera→aim plan distance
  // G9 measures.
  const pW = trackAt(r, Math.min(r.lengthM, d));
  const wx = pW.x - cx;
  const wz = -(pW.y - cy);
  {
    let ux = cam[0] - aim[0];
    let uz = cam[2] - aim[2];
    let dpAim = Math.hypot(ux, uz);
    if (dpAim < 1e-6) {
      const q0 = trackAt(r, Math.max(0, d - 5));
      ux = q0.x - pW.x;
      uz = -((q0.y - pW.y));
      dpAim = Math.hypot(ux, uz) || 1;
    }
    ux /= dpAim;
    uz /= dpAim;
    const dAim = Math.max(0, FOLLOW_D_MIN - dpAim);
    let dWalk = 0;
    const ex = cam[0] - wx;
    const ez = cam[2] - wz;
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
  // G16 input: WANT correction (safety decision, pre-damping).
  corrWant[i] = Math.max(0, (safe.hCam as number) - (rope.hCam as number));
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
// is measured in-browser at s=0.18 y s=0.80 con ?debug=1&skyfrac=1&luma=1&t=12:00,
// §4b FASE 5: umbral 0.15). ---
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasProbe = src.includes("__luma") && src.includes('has("luma")');
  gate("G11-luma-probe", hasProbe && G11_LUMA_MIN === 0.15 && LUMA_GRID >= 16,
    hasProbe ? `probe in viewer (?luma=1 -> window.__luma), threshold ${G11_LUMA_MIN}, grid ${LUMA_GRID}x${LUMA_GRID} — measure at s=0.18/0.80, ?t=12:00` : "no __luma probe in viewer.ts");
}

// --- G31/G32/G33 (§4b FASE 5: sombras + métrica de etiquetas). Node checks
// the CONTRACT (constantes + sonda + crono); the NUMBERS come from prod
// (?debug=1&skyfrac=1&luma=1&t=12:00, s=0.18 y s=0.80):
// G31: __lumaShadow >= 0.045 (luma lineal media del cuartil más oscuro de
//   píxeles de terreno) en ambos s.
// G32: __chromaShadow <= 0.35 a las 12:00 (media de (max-min)/max en el
//   cuartil; 0 = gris, 1 = saturado).
// G33: js etiq <= 1 ms en 10 lecturas consecutivas, sin flags (el crono
//   envuelve SOLO updateLabels).
{
  const viewerSrcG31 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrcG31 = readFileSync("src/engine/debug.ts", "utf8");
  const shadowProbe =
    viewerSrcG31.includes("__lumaShadow") &&
    viewerSrcG31.includes("__chromaShadow") &&
    viewerSrcG31.includes("__litOver") &&
    viewerSrcG31.includes("occNeeded");
  const shadowHud =
    debugSrcG31.includes("lumaShadow") &&
    debugSrcG31.includes("chromaShadow") &&
    debugSrcG31.includes("sombra L");
  const jsChrono =
    viewerSrcG31.includes("const tl = performance.now();") &&
    viewerSrcG31.includes("metrics.jsLabels = performance.now() - tl;");
  gate("G31-shadow-luma", shadowProbe && shadowHud && G31_LUMA_SHADOW_MIN === 0.045,
    shadowProbe && shadowHud
      ? `shadow probe (?luma=1 -> __lumaShadow/__chromaShadow/__litOver, HUD "sombra L C"), threshold ${G31_LUMA_SHADOW_MIN} — measure at s=0.18/0.80, ?t=12:00`
      : "no shadow probe in viewer.ts (needs __lumaShadow/__chromaShadow/__litOver + occNeeded mask)");
  gate("G32-shadow-chroma", shadowProbe && G32_CHROMA_SHADOW_MAX === 0.35,
    `chroma threshold ${G32_CHROMA_SHADOW_MAX} at 12:00 (probe=${shadowProbe}) — shadow cool-grey, not navy`);
  gate("G33-js-labels", jsChrono && G33_JS_LABELS_MAX_MS === 1,
    jsChrono
      ? `js etiq wraps updateLabels only (tl -> metrics.jsLabels), threshold ${G33_JS_LABELS_MAX_MS} ms x10, no flags — measure 10 consecutive reads in prod`
      : "jsLabels chrono still spans the render (needs tl around updateLabels only)");
  // FASE 5 pasos a-d (una variable por paso, valores publicados):
  // HEMI_GRAY_MIX 0.6 (tinte) · HEMI_LUMA_FLOOR 0.20 (nivel) ·
  // HEMI_DAY 1.08 (+20 %, paso c) · SHADOW_INTENSITY 0.55 (paso d).
  const hemiOk =
    HEMI_GRAY_MIX === 0.6 && HEMI_LUMA_FLOOR === 0.2 &&
    HEMI_DAY === 1.08 && SHADOW_INTENSITY === 0.55 &&
    viewerSrcG31.includes("sun.shadow.intensity = SHADOW_INTENSITY");
  gate("fase5-hemi", hemiOk,
    hemiOk
      ? `HEMI_GRAY_MIX=${HEMI_GRAY_MIX} HEMI_LUMA_FLOOR=${HEMI_LUMA_FLOOR} HEMI_DAY=${HEMI_DAY} SHADOW_INTENSITY=${SHADOW_INTENSITY} (sun.shadow.intensity applied) — measure luma/__lumaShadow/__chromaShadow per step`
      : `hemi steps drifted (mix=${HEMI_GRAY_MIX} floor=${HEMI_LUMA_FLOOR} day=${HEMI_DAY} shadow=${SHADOW_INTENSITY}, applied=${viewerSrcG31.includes("sun.shadow.intensity = SHADOW_INTENSITY")})`);
}

// --- G12 sky band contract (FOLLOW, píxeles): [0.12, 0.30] por pase de
// oclusores (?skyfrac=1 -> window.__skyFrac = negros/total; solo el terreno
// tapa — ni cúpula, ni nubes, ni trazado). Node verifica el contrato; la
// fracción vive en navegador sobre las siete capturas.
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasSky = src.includes("__skyFrac") && src.includes("skyfrac") && src.includes("occTarget");
  gate("G12-sky-probe", hasSky && G12_SKY_MIN === 0.12 && G12_SKY_MAX === 0.3,
    hasSky ? `occluder pass in viewer (?skyfrac=1 -> window.__skyFrac + __voidPx), band [${G12_SKY_MIN}, ${G12_SKY_MAX}] — measure on the seven act captures` : "no occluder sampler in viewer.ts");
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

// --- G16 nod count (pasada rig puro): the DAMPED H-CORRECTION series must
// not oscillate. G16 measures corrHSm (what the camera flies with), with a
// 15 m deadband — NOT the plan-dist series (its flips at follow knots are
// choreography inflexions nobody sees). What the user would see on failure:
// the camera nodding fore/aft while scrolling. Static sweep has no damping
// state, so this replays the WANT correction (resolveFollowSafety hCam -
// rope hCam) as the corrSm input with deadband 15 m.
{
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i <= STEPS; i++) {
    if (i / STEPS >= EPILOGUE_S) continue;
    const dd = (corrWant[i] as number) - (corrWant[i - 1] as number);
    const sign = dd > 15 ? 1 : dd < -15 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  gate("G16-nod", flips <= 12,
    `H-correction sign flips (±15 m deadband) ${flips} over pre-epilogue steps (need <=12) — more means the camera is nodding`);
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

// --- G23 walker-frame (RASTRO): P(d) projects at y in [-0.6,-0.3] NDC.
// Minimal composePose arithmetic (no three in Node): rope yaw + walker
// pitch, same numbers the rig flies (fov 50 = camera.fov). The sign
// convention is pinned by axis-convention above: the forward vector is
// verified byte-for-byte against three's YXZ Euler in the browser check
// below (axis-convention-pitch), so this mirror cannot drift silently.
{
  const fovDeg = 50;
  const tanHalf = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  let worstY = -Infinity;
  let worstS = 0;
  let outside = 0;
  // Per-step ledger for the failure message (worst 5 only, no flood).
  const bad: { s: number; y: number; pitch: number; pitchW: number; distW: number }[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    const d = pchipSD(s);
    const rope = ropeAt(s);
    const safe = resolveFollowSafety(sampleGrid, cx, cy, { camPos: rope.cam, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.dp }, r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 });
    let camY = safe.camPos[1];
    const floor = sampleGrid(safe.camPos[0] + cx, cy - safe.camPos[2]) + CAM_CLEARANCE_M;
    if (camY < floor) camY = floor;
    const cam: [number, number, number] = [safe.camPos[0], camY, safe.camPos[2]];
    const pW = trackAt(r, Math.min(r.lengthM, d));
    const walker: [number, number, number] = [pW.x - cx, pW.z + FOLLOW_H_AIM, -(pW.y - cy)];
    // composePose mirror: rope yaw + walker pitch, capped like the rig.
    // Yaw via ropeHeadingDeg (anchors.ts) — the SAME rope segment the rig
    // flies (anchor->aim), never the raw atan2 of a possibly D_MIN-shifted
    // vector. bearingDeg(dx,dz) = atan2(dx,-dz) by definition.
    // §4: absolute PITCH_MAX_HARD cap, same as composePose.
    const prof = followAt(follow, s);
    const yaw = ropeHeadingDeg(r, d, prof.lookM, prof.backM);
    const distPlanW = Math.max(1e-6, Math.hypot(walker[0] - cam[0], walker[2] - cam[2]));
    const pitchWalker = (Math.atan2(cam[1] - walker[1], distPlanW) * 180) / Math.PI;
    const pitch = Math.min(pitchWalker - WALKER_NDC_Y * (fovDeg / 2), PITCH_MAX_HARD);
    // view: YXZ (yaw about world Y, then pitch about camera X). Forward is
    // R_y(-yawR)·R_x(-pitchR)·(0,0,-1) — verified against three above.
    const yawR = (yaw * Math.PI) / 180;
    const pitchR = (pitch * Math.PI) / 180;
    const fx = Math.sin(yawR) * Math.cos(pitchR);
    const fy = -Math.sin(pitchR);
    const fz = -Math.cos(yawR) * Math.cos(pitchR);
    // camera basis: fwd, right = camera's +X axis under YXZ
    // (three: (1,0,0) rotated by the pose quaternion; NOT cross(fwd, up),
    // which flips the sign). Verified against three's matrixWorld axes.
    // YXZ yaw-then-pitch: right = R_y(-yawR)·(1,0,0) = (cos(yawR), 0, sin(yawR)).
    const rX = Math.cos(yawR);
    const rY = 0;
    const rZ = Math.sin(yawR);
    // up = cross(right, fwd).
    const uX = rY * fz - rZ * fy;
    const uY = rZ * fx - rX * fz;
    const uZ = rX * fy - rY * fx;
    // walker in view space, then perspective divide. Calibrated against
    // three (PerspectiveCamera + YXZ quaternion + real projection matrix,
    // in-front point: three ndcY == mirror ndcY to 3 decimals): the basis
    // (fwd/up) matches three exactly, and three's clipW for a YXZ-posed
    // camera equals v·fwd (positive in front — the view matrix carries
    // +Z = -fwd and P[11] = -1 negates Z again, the minuses cancelling
    // into clipW = +v·fwd). NDC y = yV / (clipW·tanHalf).
    // Behind-camera (clipW<=0) counts as outside.
    const vx = walker[0] - cam[0];
    const vy = walker[1] - cam[1];
    const vz = walker[2] - cam[2];
    const clipW = vx * fx + vy * fy + vz * fz;
    const yV = vx * uX + vy * uY + vz * uZ;
    const ndcY = clipW > 0 ? yV / (clipW * tanHalf) : -Infinity;
    if (!(ndcY >= -0.6 && ndcY <= -0.3)) {
      outside++;
      bad.push({ s, y: ndcY, pitch, pitchW: pitchWalker, distW: distPlanW });
    }
    if (Math.abs(ndcY + WALKER_NDC_Y) > Math.abs(worstY + WALKER_NDC_Y)) {
      worstY = ndcY;
      worstS = s;
    }
  }
  const worst5 = bad
    .sort((a, b) => Math.abs(a.y + WALKER_NDC_Y) - Math.abs(b.y + WALKER_NDC_Y))
    .slice(-5)
    .map((b) => `s=${b.s.toFixed(3)} y=${Number.isFinite(b.y) ? b.y.toFixed(2) : "BEHIND"} pitch=${b.pitch.toFixed(1)} pitchW=${b.pitchW.toFixed(1)} distW=${b.distW.toFixed(0)}`)
    .join(" | ");
  // Diagnostic histogram: is the walker systematically high, low, or split?
  // (behind-camera counts as its own bucket — it means yaw points away.)
  let nBehind = 0;
  let nHigh = 0;
  let nLow = 0;
  let sumY = 0;
  let nFin = 0;
  let nExempt = 0; // act-I hairpins [0.19,0.24]: rope folds inside the
  // zigzags (same window G4 exempts) — the walker is off-axis there by
  // construction and projects low; counted separately, not as failure.
  for (const b of bad) {
    if (!Number.isFinite(b.y)) { nBehind++; continue; }
    if (b.s >= 0.19 && b.s < 0.24) { nExempt++; continue; }
    if (b.y > -0.3) nHigh++;
    else nLow++;
    sumY += b.y;
    nFin++;
  }
  const meanY = nFin > 0 ? (sumY / nFin).toFixed(2) : "n/a";
  const realOutside = nBehind + nHigh + nLow;
  gate("G23-walker-frame", realOutside === 0,
    realOutside === 0
      ? `P(d) at y in [-0.6,-0.3] NDC on all non-hairpin steps (centre -${WALKER_NDC_Y}; ${nExempt} hairpin [0.19,0.24] steps exempt like G4)`
      : `${realOutside}/${STEPS + 1} outside [-0.6,-0.3] excl. hairpins (behind=${nBehind} high=${nHigh} low=${nLow} meanY=${meanY}; ${nExempt} hairpin exempt), worst y=${Number.isFinite(worstY) ? worstY.toFixed(2) : "BEHIND"} at s=${worstS.toFixed(4)} — worst5: ${worst5}`);
}

// --- G17 void (FOLLOW): píxeles negros en la MITAD INFERIOR del pase de
// oclusores (?skyfrac=1 -> window.__voidPx). Exacta y gratis con G12 —
// sustituye la aproximación color-bajo-horizonte. Necesidad: 0.
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasProbe = src.includes("__voidPx");
  gate("G17-void-probe", hasProbe,
    hasProbe ? "void = black pixels in lower half of occluder pass (?skyfrac=1 -> __voidPx), need = 0" : "no __voidPx probe in viewer.ts");
}

// --- G15 track (auditoría rastro): el pase ID comparte el corte
// (idMat parcheado con uProgressDist). Contrato: __trackpx >= 40 px en
// 20 valores s >= 0.05 (?trackpx=1). Con idMat sin parche daba 97 con el
// recorrido invisible — ese PASS de chiripa ya no puede repetirse.
{
  const src = readFileSync("src/engine/route-line.ts", "utf8");
  const idPatched = src.includes("patchLine(idMat)");
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const hasPx = viewerSrc.includes("__trackpx") && viewerSrc.includes("countIdPixels");
  gate("G15-track", idPatched && hasPx,
    idPatched && hasPx ? "ID pass shares uProgressDist cut (?trackpx=1 -> __trackpx >= 40 px, 20 values s>=0.05)" : "idMat unpatched or no __trackpx probe — G15 would PASS with the trail invisible");
}

// --- uGlow == 0 fuera de hitos (auditoría halo): la rampa glowNear(s, c)
// con GLOW_S_WINDOW = 0.02 vale exactamente 0 en s = 0 y s = 0.14 (lejos de
// A3/A7/A8). Aritmética pura, sin DOM. (§1 cinta: halo apagado, no borrado.)
{
  const { GLOW_S_WINDOW } = await import("../src/narrative/choreography.ts");
  const glowNear = (s: number, c: number): number =>
    Math.min(1, Math.max(0, (GLOW_S_WINDOW - Math.abs(s - c)) / GLOW_S_WINDOW));
  const samples: [number, number][] = [[0, 0.3], [0, 0.745], [0, 0.86], [0.14, 0.3], [0.14, 0.745], [0.14, 0.86], [0.3, 0.3], [0.745, 0.745], [0.86, 0.86]];
  const offOk = samples.slice(0, 6).every(([s, c]) => glowNear(s, c) === 0);
  const onOk = samples.slice(6).every(([s, c]) => glowNear(s, c) === 1);
  gate("uGlow-gate", offOk && onOk,
    offOk && onOk ? `uGlow 0 at s=0/0.14 (non-milestones), 1 at A3/A7/A8 (window ${GLOW_S_WINDOW})` : "uGlow leaks outside milestone windows");
}

// --- G24 sky (§4b FASE 2: display-space probe). Node checks the CONTRACT:
// equirect capture (no dome clone, shared uniforms, own ortho cam),
// readZenith returning DISPLAY (ACES+sRGB, what the user sees) + raw audit
// trail, published on the 30-frame probe cadence DEBUG-ONLY (no per-frame
// readPixels in production), ?skymap=1 independent flag, blit compositing
// (autoClear=false + clearDepth, z=-0.5). The NUMBERS (zenith band +
// horizon/zenith ratio) are measured in-browser at ?debug=1&t=12:00:
// zenithHex in [G24_ZEN_MIN, G24_ZEN_MAX] per channel (±12/255) — DISPLAY
// values, no separate conversion at the gate —, __skyHzRatio in [1.2, 2.2]
// (G24b), __zenithLinear kept as audit trail.
{
  const capSrc = readFileSync("src/engine/sky-capture.ts", "utf8");
  const viewerSrcG24 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrc = readFileSync("src/engine/debug.ts", "utf8");
  const hasProbe = capSrc.includes("readZenith") && viewerSrcG24.includes("__skyHzRatio");
  const readbackOk = capSrc.includes("UnsignedByteType") && !capSrc.includes("HalfFloatType");
  // FASE 1 (intacta): equirect by construction, never a dome clone.
  const noClone = !capSrc.includes("domeClone") && !capSrc.includes("skyDome.geometry");
  const equirect = capSrc.includes("( vUv.x - 0.5 ) * 6.2831853") && capSrc.includes("( vUv.y - 0.5 ) * 3.1415927");
  const sharedU = capSrc.includes('sunPosition: domeU["sunPosition"]') && capSrc.includes('turbidity: domeU["turbidity"]');
  const ownCam = capSrc.includes("OrthographicCamera") && !capSrc.includes("renderer.render(skyScene, camera)");
  // FASE 2: display-space conversion lives in the capture (RRTAndODTFit +
  // sRGB), audit trail published, hot-loop readback gone.
  const dispSpace = capSrc.includes("rrtAndODTFit") && capSrc.includes("ACESInputMat") && capSrc.includes("linToSrgb");
  const auditTrail = viewerSrcG24.includes("__zenithLinear");
  const hotLoopGone = !viewerSrcG24.includes("if (skyCap && boot.skycap)");
  const cadence30 = viewerSrcG24.includes("frames % 30 === 5") && viewerSrcG24.includes("boot.debug && skyCap && boot.skycap");
  // FASE 2: ?skymap=1 independent (combinable with ?debug=1), blit composites.
  const skyFlag = debugSrc.includes('q.get("skymap") === "1"') && !debugSrc.includes('q.get("debug") === "skymap"');
  // FASE 2b: NDC blit (camera -1..1 fixed, mesh sized in NDC, depth off,
  // order 999) — pixel camera + z=-0.5 checks retired.
  const blitOk = viewerSrcG24.includes("OrthographicCamera(-1, 1, 1, -1, -1, 1)")
    && viewerSrcG24.includes("renderer.autoClear = false")
    && viewerSrcG24.includes("renderOrder = 999");
  const { G24_ZEN_MIN, G24_ZEN_MAX, G24_HZ_RATIO, SKY_TURBIDITY, SKY_RAYLEIGH, SKY_MIE, SKY_G, SKY_SCALE, SKY_SAT, HEMI_GRAY_MIX } =
    await import("../src/narrative/choreography.ts");
  const { CLOUD_COUNT, CLOUD_ATLAS_TILES, CLOUD_TOTAL } = await import("../src/engine/clouds.ts");
  const { CLOUD_MAX_INSTANCES } = await import("../src/narrative/choreography.ts");
  const constsOk =
    SKY_TURBIDITY === 1.7 && SKY_RAYLEIGH === 1.6 && SKY_MIE === 0.004 && SKY_G === 0.8 &&
    SKY_SCALE === 0.22 && SKY_SAT === 2.0 && HEMI_GRAY_MIX === 0.6 && CLOUD_COUNT === 148 &&
    CLOUD_ATLAS_TILES.length === 6 && CLOUD_TOTAL === CLOUD_MAX_INSTANCES &&
    CLOUD_MAX_INSTANCES === 192 + 40 + 6 + 60 &&
    G24_HZ_RATIO === 2.2 && G24_ZEN_MIN === "#2a68b8" && G24_ZEN_MAX === "#3e86d2";
  const ok = hasProbe && readbackOk && noClone && equirect && sharedU && ownCam && constsOk
    && dispSpace && auditTrail && hotLoopGone && cadence30 && skyFlag && blitOk;
  gate("G24-sky", ok,
    ok
      ? `equirect capture + display-space probe (ACES+sRGB, raw audit) @30f debug-only + ?skymap=1 blit; band [${G24_ZEN_MIN},${G24_ZEN_MAX}], hz/z <= ${G24_HZ_RATIO} — measure at ?t=12:00`
      : `contract broken (probe=${hasProbe} readback=${readbackOk} noClone=${noClone} equirect=${equirect} sharedU=${sharedU} ownCam=${ownCam} consts=${constsOk} disp=${dispSpace} audit=${auditTrail} hotGone=${hotLoopGone} cad30=${cadence30} skyFlag=${skyFlag} blit=${blitOk})`);
}

// --- G34 atlas (N2 Everest-style): lienzos 2D 512×256, 70-150 gradientes,
// base plana, panza source-atop, sin agujeros ni bordes duros a ×2.
// Node checks the ACCEPTANCE ran (script + thresholds + meta hash wiring);
// the PICTURE (audit PNG + ?debug=atlas) is eyeballed once per regeneration.
{
  const mkSrc = existsSync("scripts/make-cloud-atlas.ts") ? readFileSync("scripts/make-cloud-atlas.ts", "utf8") : "";
  const metaAssets = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    assets: Record<string, string>;
  };
  const atlasAsset = metaAssets.assets["clouds-atlas"] ?? "";
  const atlasFile = `public/${atlasAsset}`;
  const atlasExists = atlasAsset !== "" && existsSync(atlasFile);
  const ok = mkSrc.includes("coreHole >= 144") && mkSrc.includes("edgeStep > 0.25")
    && mkSrc.includes("source-atop") && mkSrc.includes("ATLAS_SLOTS")
    && atlasExists;
  gate("G34-atlas", ok,
    ok
      ? `make-cloud-atlas.ts (canvas gradients, blue-grey belly, acceptance holes/edges) → ${atlasAsset} — eyeball the audit PNG at ×2 once`
      : "no atlas script/acceptance or hashed asset missing from meta");
}

// --- G35 continuity (N2): amount(h) continuo — sin gate de sol, solo la
// luz (dayF) depende del sol. Node checks statically: cloudAmount con las
// dos rampas + dayF plumbing (sun → viewer → shader); la tabla de 6
// muestras se mide en prod (<0,04).
{
  const sunSrc35 = readFileSync("src/engine/sun.ts", "utf8");
  const viewerSrc35 = readFileSync("src/engine/viewer.ts", "utf8");
  const cloudSrc35 = readFileSync("src/engine/clouds.ts", "utf8");
  const noGate = !sunSrc35.includes("cloudDensity: e <=") && !sunSrc35.includes("cloudDensity = e <=");
  const amount = sunSrc35.includes("cloudAmount") && sunSrc35.includes("7.2, 13.0")
    && sunSrc35.includes("18.0, 21.0") && viewerSrc35.includes("cloudAmount");
  const dayF = sunSrc35.includes("cloudDayF") && viewerSrc35.includes("cloudDayF")
    && cloudSrc35.includes("uDayF");
  const ok = noGate && amount && dayF;
  gate("G35-continuity", ok,
    ok
      ? "amount(h) continuous (no e-gate) + dayF light path (sun→viewer→shader) — measure 6-sample table in prod (<0.04 steps)"
      : `continuity broken (noGate=${noGate} amount=${amount} dayF=${dayF})`);
}

// --- G36 band (N2-fix): barrido s ∈ [0, 0,97] SIN epílogo; base =
// máx(camYmax + 300, 2900) ∈ [2900, 3100]; cúmulos con los gates N2
// (≥1500 m plan de TODA pose del barrido, ≥900 m del rastro, ≥500 m sobre
// el terreno) + bruma/cirros/anillo con sus propios gates. Node RECOMPUTA
// con el production cloudLayout y audita por familia.
{
  const cloudSrc36 = readFileSync("src/engine/clouds.ts", "utf8");
  const viewerSrc36 = readFileSync("src/engine/viewer.ts", "utf8");
  const hasBand = cloudSrc36.includes("CLOUD_BASE_LIFT_M") && cloudSrc36.includes("CLOUD_CLEAR_CAM_M")
    && cloudSrc36.includes("CLOUD_CLEAR_ROUTE_M") && cloudSrc36.includes("CLOUD_GROUP_COUNT");
  // N2-fix: el viewer barrea s ∈ [0, 0,97] (sin epílogo) + camYEpi aparte.
  const noEpi = viewerSrc36.includes("s <= 0.97") && viewerSrc36.includes("camYEpi");
  // recompute: pose sweep (verify ropeAt + safety + floor) in EPSG frame,
  // N2-fix: s ∈ [0, 0,97] SIN epílogo (como el viewer).
  const { cloudLayout: cl36 } = await import("../src/engine/clouds.ts");
  const poses36: { x: number; y: number; z: number }[] = [];
  for (let s = 0; s <= 0.97; s += 0.005) {
    const sc = Math.min(1, Math.max(0, s));
    const d = pchipSD(sc);
    const prof = followAt(follow, sc);
    const pAim = trackAt(r, Math.min(r.lengthM, d + prof.lookM));
    const pA = anchorPlan(r, d, prof.backM);
    const aim: [number, number, number] = [pAim.x - cx, pAim.z + FOLLOW_H_AIM, -(pAim.y - cy)];
    const cam: [number, number, number] = [pA.x - cx, pA.z + prof.hCam, -(pA.y - cy)];
    const pW = trackAt(r, Math.min(r.lengthM, d));
    const wx = pW.x - cx;
    const wz = -(pW.y - cy);
    {
      let ux = cam[0] - aim[0];
      let uz = cam[2] - aim[2];
      let dpAim = Math.hypot(ux, uz);
      if (dpAim < 1e-6) {
        const q0 = trackAt(r, Math.max(0, d - 5));
        ux = q0.x - pW.x;
        uz = -((q0.y - pW.y));
        dpAim = Math.hypot(ux, uz) || 1;
      }
      ux /= dpAim;
      uz /= dpAim;
      const dAim = Math.max(0, FOLLOW_D_MIN - dpAim);
      let dWalk = 0;
      const ex = cam[0] - wx;
      const ez = cam[2] - wz;
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
    const safe = resolveFollowSafety(sampleGrid, cx, cy,
      { camPos: cam, aim, hCam: prof.hCam, lookM: prof.lookM, backM: prof.backM, distPlan: Math.hypot(cam[0] - aim[0], cam[2] - aim[2]) },
      r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 });
    let camY = safe.camPos[1];
    const floor = sampleGrid(safe.camPos[0] + cx, cy - safe.camPos[2]) + CAM_CLEARANCE_M;
    if (camY < floor) camY = floor;
    poses36.push({ x: safe.camPos[0] + cx, y: cy - safe.camPos[2], z: camY, s: sc });
  }
  let camYmax = -Infinity;
  let camYmin = Infinity;
  for (const c of poses36) {
    if (c.z > camYmax) camYmax = c.z;
    if (c.z < camYmin) camYmin = c.z;
  }
  const lay36 = cl36(meta as unknown as Parameters<typeof cl36>[0], elevFull36(), { n: r.n, x: r.x, y: r.y }, poses36);
  // N2b: audita por familia — cúmulos (gates N2 estrictos) por un lado;
  // bruma (valle <1900 m, suelo+60..220), cirros (7000-9000) y anillo
  // (fuera del bbox, 3000-3800) con sus propios gates.
  const { CLOUD_GROUP_COUNT } = await import("../src/narrative/choreography.ts");
  const {
    CLOUD_MIST_GROUND_MAX_M,
    CLOUD_MIST_LIFT_LO_M,
    CLOUD_MIST_LIFT_HI_M,
    CLOUD_CIRRUS_LO_M,
    CLOUD_CIRRUS_HI_M,
    CLOUD_FAR_LO_M,
    CLOUD_FAR_HI_M,
  } = await import("../src/narrative/choreography.ts");
  const boards36 = lay36.boards;
  const band36 = lay36.band;
  const expBase = Math.max(camYmax + 300, 2900);
  const expTop = expBase + 600;
  const baseOk = Math.abs(band36.base - expBase) < 1 && Math.abs(band36.top - expTop) < 1
    && Math.abs(band36.camYmax - camYmax) < 1;
  // Solo los grupos de CÚMULOS (familia N2, groups[0:accepted]) pasan los
  // gates estrictos; band36.groups mezcla bruma/cirros/anillo detrás.
  // N2b: el TOTAL de instancias (medido con semilla fija) debe ser ≤ 260.
  const cumGroups = band36.groups.slice(0, band36.accepted);
  let minCamPlan = Infinity;
  for (const g of cumGroups) {
    for (const c of poses36) {
      const dp = Math.hypot(g.cx - (c.x as number), g.cy - (c.y as number));
      if (dp < minCamPlan) minCamPlan = dp;
    }
  }
  // distancia mínima centro→rastro (muestreo ×4) + centro→terreno (cúmulos)
  const elev36 = elevFull36();
  const sample36 = (x: number, y: number): number => {
    const col = (x - meta.originX) / meta.resX - 0.5;
    const row = (meta.originY - y) / meta.resY - 0.5;
    const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
    const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
    const fx = Math.min(1, Math.max(0, col - c0));
    const fy = Math.min(1, Math.max(0, row - r0));
    const W = meta.width;
    const at = (cc: number, rr: number): number => elev36[rr * W + cc] as number;
    const a = at(c0, r0);
    const b = at(c0 + 1, r0);
    const c = at(c0, r0 + 1);
    const d = at(c0 + 1, r0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  };
  let minRoute = Infinity;
  let minGround = Infinity;
  for (const g of cumGroups) {
    for (let i = 0; i < r.n; i += 4) {
      const d = Math.hypot(g.cx - (r.x[i] as number), g.cy - (r.y[i] as number));
      if (d < minRoute) minRoute = d;
    }
    const gr = sample36(g.cx, g.cy);
    if (g.cz - gr < minGround) minGround = g.cz - gr;
  }
  const cumInBand = cumGroups.every((g) => g.cz >= band36.base - 1 && g.cz <= band36.top + 1);
  // N2b por familia (sobre boards, con sus gates propios):
  const mistB = boards36.filter((b) => b.family === 1);
  const cirrB = boards36.filter((b) => b.family === 2);
  const farB = boards36.filter((b) => b.family === 3);
  const mistOk = mistB.length === 40 && mistB.every((b) => {
    const gr = sample36(b.x, b.y);
    return gr < CLOUD_MIST_GROUND_MAX_M && b.z - gr >= CLOUD_MIST_LIFT_LO_M - 1 && b.z - gr <= CLOUD_MIST_LIFT_HI_M + 1;
  });
  const cirrOk = cirrB.length === 6 && cirrB.every((b) => b.z >= CLOUD_CIRRUS_LO_M - 1 && b.z <= CLOUD_CIRRUS_HI_M + 1);
  const farOk = farB.length >= 36 && band36.families.far === 12 && farB.every((b) =>
    b.z >= CLOUD_FAR_LO_M - 1 && b.z <= CLOUD_FAR_HI_M + 1);
  const famCountOk = band36.families.cumulus === CLOUD_GROUP_COUNT && band36.families.mist === 40
    && band36.families.cirrus === 6 && band36.families.far === 12 && boards36.length <= 260;
  // N2-fix: la base vive a ~2900 (nunca a 5 km) + fade del epílogo por
  // familia en draw y probe (mismo smoothstep, misma uCamY).
  const cloudSrcEpi = readFileSync("src/engine/clouds.ts", "utf8");
  const viewerSrcEpi = readFileSync("src/engine/viewer.ts", "utf8");
  const epiDraw = cloudSrcEpi.includes("smoothstep(300.0, 900.0, relH)")
    && cloudSrcEpi.includes("smoothstep(600.0, 1400.0, relH)") && cloudSrcEpi.includes("setCamY");
  const epiProbe = viewerSrcEpi.includes("uniform float uCamY") && viewerSrcEpi.includes("epiFade")
    && viewerSrcEpi.includes("setCamY(camera.position.y)");
  const ok = hasBand && noEpi && baseOk && band36.base >= 2900 && band36.base <= 3100
    && cumInBand && minCamPlan >= 1500 && minRoute >= 900
    && minGround >= 500 && band36.accepted === CLOUD_GROUP_COUNT
    && mistOk && cirrOk && farOk && famCountOk && epiDraw && epiProbe;
  gate("G36-band", ok,
    ok
      ? `base ${band36.base.toFixed(0)} top ${band36.top.toFixed(0)} camYmax ${band36.camYmax.toFixed(0)} (poses ${poses36.length}), cúmulos ${band36.accepted}/${CLOUD_GROUP_COUNT} minCam ${(minCamPlan).toFixed(0)} (≥1500) minRoute ${(minRoute).toFixed(0)} (≥900) minGround ${(minGround).toFixed(0)} (≥500) rej=${band36.rejected.cam}/${band36.rejected.route}/${band36.rejected.ground}/${band36.rejected.attempts}, bruma ${mistB.length}/40, cirros ${cirrB.length}/6, anillo ${farB.length} boards/${band36.families.far} grupos, total ${boards36.length}≤260`
      : `band broken (base=${band36.base.toFixed(0)} exp=${expBase.toFixed(0)} camYmax=${band36.camYmax.toFixed(0)} exp=${camYmax.toFixed(0)} cum=${band36.accepted}/${CLOUD_GROUP_COUNT} minCam=${minCamPlan.toFixed(0)} ≥1500 minRoute=${minRoute.toFixed(0)} ≥900 minGround=${minGround.toFixed(0)} ≥500 rej=${band36.rejected.cam}/${band36.rejected.route}/${band36.rejected.ground}/${band36.rejected.attempts} mist=${mistB.length}/40 ok=${mistOk} cirr=${cirrB.length}/6 ok=${cirrOk} far=${farB.length} ok=${farOk} fam=${famCountOk})`);
}

// --- heightfield array for the G36 layout recompute (same RG decode) ---
function elevFull36(): Float32Array {
  const W = meta.width;
  const out = new Float32Array(W * meta.height);
  for (let rr = 0; rr < meta.height; rr++) {
    for (let cc = 0; cc < W; cc++) {
      out[rr * W + cc] = pngMeta.minZ + (pngRaw[(rr * W + cc) * 3] as number) * 256 + (pngRaw[(rr * W + cc) * 3 + 1] as number);
    }
  }
  return out;
}

// --- G24c cloud cover (N2b: PIXEL meter + family filter, no try/catch).
// __cloudCoverPx in [0.20,0.40] at 12:00 in s=0.18/0.50/0.80, ≥0.12 at
// 8:30 and 20:30. Node checks the CONTRACT (flat probe pass + sky-mask
// count + G41/G43/G44 readers + family filter + per-family table + loud
// failure path); the NUMBERS come from prod.
{
  const viewerSrcC = readFileSync("src/engine/viewer.ts", "utf8");
  const cloudSrcC = readFileSync("src/engine/clouds.ts", "utf8");
  const flatPass = viewerSrcC.includes("cloudPxMat") && viewerSrcC.includes("cloudPxTarget")
    && viewerSrcC.includes("probeUniforms");
  const skyMask = viewerSrcC.includes("__cloudCoverPx") && viewerSrcC.includes("occBuf[mo]");
  const loud = viewerSrcC.includes("__cloudCoverPxErr");
  const parentBack = viewerSrcC.includes("prevParent");
  const g414243 = viewerSrcC.includes("__cloudDense") && viewerSrcC.includes("__cloudOnTerr")
    && viewerSrcC.includes("__cloudLuma") && viewerSrcC.includes("publishCloudColor");
  const g44 = viewerSrcC.includes("__cloudComps");
  const famFilter = viewerSrcC.includes("uFamFilter") && viewerSrcC.includes("__cloudCoverPxFam");
  const layoutOk = cloudSrcC.includes("CLOUD_BASE_LIFT_M") && cloudSrcC.includes("CLOUD_CLEAR_CAM_M");
  const ok = flatPass && skyMask && loud && parentBack && g414243 && g44 && famFilter && layoutOk;
  gate("G24c-cover", ok,
    ok
      ? "flat probe (live uniforms, loud errors, parent restore) + sky-mask → __cloudCoverPx (+epiFade uCamY draw=probe) + G41/G43/G44 + ?family=N → __cloudCoverPxFam — measure [0.20,0.40] @12:00, ≥0.12 @8:30/20:30, epi ≤0.35"
      : `cover contract broken (flat=${flatPass} mask=${skyMask} loud=${loud} parent=${parentBack} g414243=${g414243} g44=${g44} fam=${famFilter} layout=${layoutOk})`);
}

// --- G49 mist (N2b + N2-fix: bruma de valle). ?family=1 sobre TERRENO:
// [0,08,0,25] @07:30 s=0,05; 0 @12:00; [0,04,0,15] @20:00 s=0,90.
// N2-fix: croma de bruma ≤ 0,15 (gris-azul, 50 % haze de la captura).
// Node checks the CONTRACT; prod da los NÚMEROS.
{
  const viewerSrc49 = readFileSync("src/engine/viewer.ts", "utf8");
  const sunSrc49 = readFileSync("src/engine/sun.ts", "utf8");
  const cloudSrc49 = readFileSync("src/engine/clouds.ts", "utf8");
  const filt = viewerSrc49.includes("uFamFilter") && viewerSrc49.includes("__cloudMistTerr")
    && viewerSrc49.includes("__cloudMistChroma");
  const amt = sunSrc49.includes("mistAmount") && sunSrc49.includes("8.0) / 2.5")
    && sunSrc49.includes("18.5, 20.5") && viewerSrc49.includes("mistAmount(");
  const lay = cloudSrc49.includes("CLOUD_MIST_GROUND_MAX_M") && cloudSrc49.includes("CLOUD_MIST_CLEAR_PLAN_M");
  const haze50 = cloudSrc49.includes("isMist * 0.5") && cloudSrc49.includes("setSkyMap");
  const ok = filt && amt && lay && haze50;
  gate("G49-mist", ok,
    ok
      ? "?family=1 → __cloudMistTerr + __cloudMistChroma (50 % haze captura) — measure [0.08,0.25] @07:30 s=0.05 chroma≤0.15, 0 @12:00, [0.04,0.15] @20:00 s=0.90"
      : `mist contract broken (filter=${filt} amount=${amt} layout=${lay} haze50=${haze50})`);
}

// --- G50 far ring (N2b: anillo lejano). Familia 3 en la franja inferior
// del cielo (15 % junto al horizonte) ≥ 0,25 @12:00 s=0,18/0,80; resto del
// cielo ≤ 0,05. Node checks (__cloudLowSky/__cloudHighSky + layout en
// anillo cuadrado a 2-4 km); prod da los NÚMEROS.
{
  const viewerSrc50 = readFileSync("src/engine/viewer.ts", "utf8");
  const cloudSrc50 = readFileSync("src/engine/clouds.ts", "utf8");
  const readers = viewerSrc50.includes("__cloudLowSky") && viewerSrc50.includes("__cloudHighSky");
  const lay = cloudSrc50.includes("CLOUD_FAR_OUT_LO_M") && cloudSrc50.includes("CLOUD_FAR_LO_M");
  const ok = readers && lay;
  gate("G50-farring", ok,
    ok
      ? "__cloudLowSky/__cloudHighSky (franja 15 % vs resto) + anillo 2-4 km 3000-3800 m — measure low≥0.25, high≤0.05 @12:00 s=0.18/0.80"
      : `far-ring contract broken (readers=${readers} layout=${lay})`);
}

// --- G51 cirrus (N2b). Familia 2 ≤ 0,20 del cielo y alfa máxima ≤ 0,15.
// Node checks (uAmtCirrus + __cloudMaxAlpha + cirrus 7000-9000 m sin niebla);
// prod da los NÚMEROS.
{
  const viewerSrc51 = readFileSync("src/engine/viewer.ts", "utf8");
  const cloudSrc51 = readFileSync("src/engine/clouds.ts", "utf8");
  const readers = viewerSrc51.includes("__cloudMaxAlpha") && viewerSrc51.includes("uAmtCirrus");
  const lay = cloudSrc51.includes("CLOUD_CIRRUS_LO_M") && cloudSrc51.includes("vNoFog");
  const ok = readers && lay;
  gate("G51-cirrus", ok,
    ok
      ? "__cloudMaxAlpha + uAmtCirrus (7000-9000 m, sin niebla) — measure cover≤0.20, maxAlpha≤0.15 @12:00"
      : `cirrus contract broken (readers=${readers} layout=${lay})`);
}

// --- G52 mist-vs-track (N2b: bruma y rastro). s=0,03 @07:30: rastro con
// bruma ≥ 80 % de sin bruma (?family=off). Node checks (?family=off →
// probe en cero + __trackOcc con cover de píxeles); prod da los NÚMEROS.
{
  const debugSrc52 = readFileSync("src/engine/debug.ts", "utf8");
  const viewerSrc52 = readFileSync("src/engine/viewer.ts", "utf8");
  const flag = debugSrc52.includes('"off"') && debugSrc52.includes("family");
  const probe = viewerSrc52.includes("famFilter") && viewerSrc52.includes("__trackOcc");
  const ok = flag && probe;
  gate("G52-misttrack", ok,
    ok
      ? "?family=off (probe en cero) + __trackOcc — measure on≥0.80×off @07:30 s=0.03"
      : `mist-track contract broken (flag=${flag} probe=${probe})`);
}

// --- G42 cloud colour (§4b FASE 4c): mean canvas colour of cloud pixels —
// luma ≥ 0.72, chroma ≤ 0.10. Node checks the reader exists; prod decides.
{
  const viewerSrc42 = readFileSync("src/engine/viewer.ts", "utf8");
  const ok = viewerSrc42.includes("__cloudLuma") && viewerSrc42.includes("__cloudChroma");
  gate("G42-colour", ok,
    ok
      ? "__cloudLuma/__cloudChroma published — measure luma≥0.72 chroma≤0.10 @12:00"
      : "no __cloudLuma/__cloudChroma probe in viewer.ts");
}

// --- G53 shadow presence (N2c). ?debug=cloudshadow: terreno en gris =
// factor de sombra; __cloudShadowFrac = fracción de píxeles de terreno con
// luma < 0,8 ([0,10,0,35] @12:00 s=0,18/0,80; ≤mitad @08:30; 0 @20:30).
// Node checks the CONTRACT (flag + GLSL antes de la niebla + probe sobre
// el frame presentado); prod da los NÚMEROS.
{
  const fogSrc53 = readFileSync("src/engine/height-fog.ts", "utf8");
  const viewerSrc53 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrc53 = readFileSync("src/engine/debug.ts", "utf8");
  const glsl = fogSrc53.includes("uniform vec4 uClouds[24]")
    && fogSrc53.indexOf("cloudShadowF") < fogSrc53.indexOf("mix(gl_FragColor.rgb, haze, f)")
    && fogSrc53.includes("uCloudDebug");
  const js = viewerSrc53.includes("uCloudK") && viewerSrc53.includes("__cloudShadowFrac")
    && viewerSrc53.includes("shadowGroups()") && viewerSrc53.includes("__cloudShadowFarLuma");
  const flag = debugSrc53.includes("cloudshadow");
  const ok = glsl && js && flag;
  gate("G53-shadow", ok,
    ok
      ? "?debug=cloudshadow → __cloudShadowFrac (gris<0.8 sobre terreno) — measure [0.10,0.35] @12:00 s=0.18/0.80, ≤mitad @08:30, 0 @20:30"
      : `shadow contract broken (glsl=${glsl} js=${js} flag=${flag})`);
}

// --- G57 asset cache (N2-fix). meta.json viaja en el bundle (import JSON
// en build) — en la pestaña de red NO aparece fetch a assets/meta.json.
// Node checks: terrain.ts importa el JSON (sin fetch), AGENTS.md lleva la
// regla, y el meta empaquetado apunta al atlas con hash vigente.
{
  const terrSrc57 = readFileSync("src/engine/terrain.ts", "utf8");
  const agents57 = readFileSync("AGENTS.md", "utf8");
  const bundled = terrSrc57.includes("public/assets/meta.json") && !terrSrc57.includes('fetch("/assets/meta.json")');
  const rule = agents57.includes("nada sin hash se pide por red");
  let hashOk = false;
  try {
    const bundledMeta = JSON.parse(readFileSync("public/assets/meta.json", "utf8")) as {
      assets: Record<string, string>;
    };
    const atlas = bundledMeta.assets["clouds-atlas"] ?? "";
    hashOk = atlas !== "" && existsSync(`public/${atlas}`);
  } catch {
    hashOk = false;
  }
  const ok = bundled && rule && hashOk;
  gate("G57-cache", ok,
    ok
      ? "meta.json bundled (no fetch, no cache) + AGENTS rule + atlas hash resolves — check network tab shows no meta.json in prod"
      : `cache contract broken (bundled=${bundled} rule=${rule} hash=${hashOk})`);
}

// --- G54 shadow coherence (N2c). Cada gaussiana viva (w>0,1) cuelga de su
// nube: offset solar off = (cy−suelo)·(sunDir.xz/max(sunDir.y,0.15)).
// Node checks (__cloudShadows publicado + fórmula del offset en el viewer);
// la COMPROBACIÓN numérica (proyectado por debajo y al NO del grupo, sol
// al SE @12:00) + captura ?debug=cloudshadow se hacen en prod.
{
  const viewerSrc54 = readFileSync("src/engine/viewer.ts", "utf8");
  const off = viewerSrc54.includes("__cloudShadows") && viewerSrc54.includes("max(sunDirV.y, 0.15)")
    && viewerSrc54.includes("sunDirV.x / sy");
  const ok = off;
  gate("G54-coherence", ok,
    ok
      ? "__cloudShadows (gaussianas vivas) + offset solar — measure projected below+NW of group @12:00 s=0.18 (JS offset + capture)"
      : "no __cloudShadows/offset in viewer.ts");
}

// --- G55 fog intact (N2c). ?cloudshadow=0 desactiva (uCloudK=0, pesos 0).
// Node checks (flag + kill-switch); la IGUALDAD (±0,01 en el cuartil
// lejano, __cloudShadowFarLuma) se mide en prod con/sin sombras.
{
  const viewerSrc55 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrc55 = readFileSync("src/engine/debug.ts", "utf8");
  const kill = viewerSrc55.includes("cloudShadowOff") && viewerSrc55.includes("__cloudShadowFarLuma");
  const flag = debugSrc55.includes('q.get("cloudshadow") === "0"');
  const agents55 = readFileSync("AGENTS.md", "utf8");
  const rule = agents55.includes("la distancia se funde con el cielo, no con la sombra");
  const ok = kill && flag && rule;
  gate("G55-fogintact", ok,
    ok
      ? "?cloudshadow=0 (uCloudK=0, pesos 0) + __cloudShadowFarLuma + AGENTS rule — measure far-quartile luma ±0.01 with/without"
      : `fog-intact contract broken (kill=${kill} flag=${flag} rule=${rule})`);
}

// --- G56 shadow drift (N2c). La gaussiana sigue la deriva de su grupo
// (centro con deriva aplicada + uDrift coherente con 3-8 m/s).
// Node checks (shadowGroups desde driftX vivo + uDrift con las constantes);
// el DESPLAZAMIENTO en pantalla (±10 % en 10 s @12:00) se mide en prod.
{
  const cloudSrc56 = readFileSync("src/engine/clouds.ts", "utf8");
  const viewerSrc56 = readFileSync("src/engine/viewer.ts", "utf8");
  const live = cloudSrc56.includes("shadowGroups") && cloudSrc56.includes("driftX[i]");
  const drift = viewerSrc56.includes("CLOUD_SHADOW_DRIFT_X_MS") && viewerSrc56.includes("CLOUD_SHADOW_DRIFT_Y_MS");
  const ok = live && drift;
  gate("G56-drift", ok,
    ok
      ? "shadowGroups() from live driftX + uDrift (3/6000, 5/6000)/frame — measure on-screen ±10 % over 10 s @12:00"
      : `drift contract broken (live=${live} drift=${drift})`);
}

// --- G43 terrain overlap (§4b FASE 4c): cloud-on-terrain ≤ 5% of terrain
// pixels at s=0.99. Node checks the reader; prod decides.
{
  const viewerSrc43 = readFileSync("src/engine/viewer.ts", "utf8");
  const ok = viewerSrc43.includes("__cloudOnTerr");
  gate("G43-overlap", ok,
    ok
      ? "__cloudOnTerr published — measure ≤0.05 @s=0.99"
      : "no __cloudOnTerr probe in viewer.ts");
}

// --- G30 blue sky (§4b FASE 4b: pixel cover). Visible blue ≥ 0.45 of total
// sky at 12:00. __blueSky = skyFrac × (1 − __cloudCoverPx).
{
  const viewerSrcG30 = readFileSync("src/engine/viewer.ts", "utf8");
  const ok = viewerSrcG30.includes("__blueSky") && viewerSrcG30.includes("__cloudCoverPx");
  gate("G30-blue", ok,
    ok
      ? "__blueSky = skyFrac × (1−__cloudCoverPx) published — measure ≥0.45 @12:00"
      : "no pixel-based __blueSky probe in viewer.ts");
}

// --- G37 epilogue loop (§4b FASE 4b): s=0.99 track pixels with clouds ≥
// 90% of clouds-off. __trackOcc.frac uses the PIXEL cover when present.
{
  const viewerSrcG19 = readFileSync("src/engine/viewer.ts", "utf8");
  const ok = viewerSrcG19.includes("__trackOcc") && viewerSrcG19.includes("__cloudCoverPx");
  gate("G37-epilogue", ok,
    ok
      ? "__trackOcc.frac from pixel cover — measure ≥0.90 @s=0.99 (?trackpx=1)"
      : "no pixel-based __trackOcc probe in viewer.ts");
}

// --- G26 skymap blit (§4b FASE 2b): with ?debug=1&skymap=1 the frame shows
// terrain + HUD + the 384×192 map bottom-left; __skymapPx ≠ black and ≈
// the capture horizon pixel; no black frames. Node checks the composite
// (NDC camera, autoClear=false, depth off, renderOrder 999, after-labels
// order, 1-px readback); the PICTURE is measured in-browser.
{
  const viewerSrcG26 = readFileSync("src/engine/viewer.ts", "utf8");
  const afterLabels = viewerSrcG26.indexOf("updateLabels(labelRts") < viewerSrcG26.indexOf("skymapBlit.scene, skymapBlit.cam");
  const ndcCam = viewerSrcG26.includes("OrthographicCamera(-1, 1, 1, -1, -1, 1)");
  const depthOff = viewerSrcG26.includes("depthTest: false") && viewerSrcG26.includes("depthWrite: false");
  const order999 = viewerSrcG26.includes("renderOrder = 999");
  const pxProbe = viewerSrcG26.includes("__skymapPx");
  const ok = viewerSrcG26.includes("renderer.autoClear = false")
    && ndcCam && depthOff && order999 && pxProbe
    && afterLabels;
  gate("G26-blit", ok,
    ok
      ? "?skymap=1 blit composites (NDC cam, autoClear=false, depth off, order 999, after labels, __skymapPx) — measure map visible + px≈horizon in-browser"
      : `blit contract broken (ndc=${ndcCam} depthOff=${depthOff} order999=${order999} px=${pxProbe} afterLabels=${afterLabels})`);
}

// --- G29 main-pass counter (§4b FASE 2b): the HUD reads calls/tris from
// the MAIN pass only (info.reset + read right after the main render;
// passes counts render() calls). Node checks the mechanism; the NUMBERS
// (calls=5/tris=1.8M/passes=1; skymap → passes=2, calls still 5) come
// from prod.
{
  const viewerSrcG29 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrcG29 = readFileSync("src/engine/debug.ts", "utf8");
  const resetFirst = viewerSrcG29.indexOf("renderer.info.reset()") < viewerSrcG29.indexOf("renderer.render(scene, camera)");
  const readAfter = viewerSrcG29.indexOf("metrics.drawCalls = renderer.info.render.calls")
    < viewerSrcG29.indexOf("updateLabels(labelRts");
  const passesField = debugSrcG29.includes("passes: number") && debugSrcG29.includes("pases ${metrics.passes}");
  const pollClean = !debugSrcG29.includes("r.info.render.calls");
  const ok = resetFirst && readAfter && passesField && pollClean;
  gate("G29-counter", ok,
    ok
      ? "HUD calls/tris = main pass (info.reset + read after main render, passes counted) — measure calls=5/passes=1 (skymap→2) in-browser"
      : `counter broken (resetFirst=${resetFirst} readAfter=${readAfter} passes=${passesField} pollClean=${pollClean})`);
}

// --- G38 twilight zenith (§4b FASE 3c): at 07:10 and 20:50 the converted
// zenith has B > R and B ≥ 90; brown (R > G > B with R − B > 40) is
// forbidden. Node checks the MACHINERY (shared uSkyScale + solar-weighted
// sat in dome AND capture + predictor sweep at 07:10/20:50 with brown
// flag); the NUMBERS come from prod.
{
  const capSrc38 = readFileSync("src/engine/sky-capture.ts", "utf8");
  const viewerSrc38 = readFileSync("src/engine/viewer.ts", "utf8");
  const predSrc38 = existsSync("scripts/predict-sky.ts") ? readFileSync("scripts/predict-sky.ts", "utf8") : "";
  const shared = viewerSrc38.includes("uSkyScaleShared") && capSrc38.includes("uSkyScale: sharedScale")
    && viewerSrc38.includes("SKY_SCALE_LOW");
  const solarSat = capSrc38.includes("uSunElev") && viewerSrc38.includes("skySunF = smoothstep( 5.0, 25.0")
    && capSrc38.includes("smoothstep( 5.0, 25.0");
  const pred = predSrc38.includes("7 + 10 / 60") && predSrc38.includes("20 + 50 / 60") && predSrc38.includes("MARRON");
  const ok = shared && solarSat && pred;
  gate("G38-dusk", ok,
    ok
      ? "shared uSkyScale (LOW→SCALE over 2°→20°) + solar-weighted sat in dome+capture; predictor flags brown — measure B>R,B≥90 @07:10/20:50"
      : `dusk machinery broken (shared=${shared} solarSat=${solarSat} pred=${pred})`);
}

// --- G39 dusk direction (§4b FASE 3c): at 20:50 __hzSunHex is warm
// (R > B, R − B ≥ 40, no 255) and __hzAntiHex is cooler (higher B/R).
// Node checks the sun/anti columns exist (azimuth-mapped, published);
// the NUMBERS come from prod.
{
  const capSrc39 = readFileSync("src/engine/sky-capture.ts", "utf8");
  const viewerSrc39 = readFileSync("src/engine/viewer.ts", "utf8");
  const cols = capSrc39.includes("sunAzimuthDeg") && capSrc39.includes("colAnti = (colSun + 32) % 64");
  const pub = viewerSrc39.includes("__hzSunHex") && viewerSrc39.includes("__hzAntiHex");
  const ok = cols && pub;
  gate("G39-direction", ok,
    ok
      ? "sun/anti horizon columns (azimuth-mapped) → __hzSunHex/__hzAntiHex — measure warm sun + cooler anti @20:50"
      : `direction probe broken (cols=${cols} pub=${pub})`);
}

// --- G28 single writer (§4b FASE 3): metrics.zenithHex is written ONLY by
// the 30-frame probe. Node checks statically: exactly one assignment in
// src + init "—". The STABILITY (10 reads, 1 s, same value) is measured
// in-browser (probe writes every 30th frame; between writes the value is
// untouched — no second writer exists to race it).
{
  const viewerSrcG28 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrcG28 = readFileSync("src/engine/debug.ts", "utf8");
  const writes = [...viewerSrcG28.matchAll(/metrics\.zenithHex\s*=/g)].length;
  const initDash = debugSrcG28.includes('zenithHex: "—"');
  const ok = writes === 1 && initDash;
  gate("G28-writer", ok,
    ok
      ? 'metrics.zenithHex: 1 writer (30f probe) + init "—" — measure 10 reads/1 s stability in-browser'
      : `zenithHex writers=${writes} (need 1), init-dash=${initDash}`);
}

// --- G45 valley fog (F1 niebla): at 07:30/20:30 in s=0.05 the far valley
// floor melts into the horizon sky (RGB dist ≤ 0.12); at 12:00 it stays
// readable (≥ 0.2). Node checks the MACHINERY (uDawnF uniform + dawn terms
// in height-fog + viewer write + valley probe publishing dist); prod gives
// the NUMBERS.
{
  const fogSrc45 = readFileSync("src/engine/height-fog.ts", "utf8");
  const viewerSrc45 = readFileSync("src/engine/viewer.ts", "utf8");
  const choreo45 = readFileSync("src/narrative/choreography.ts", "utf8");
  const uniform = fogSrc45.includes("uDawnF") && viewerSrc45.includes("fogUniforms.uDawnF");
  const terms = fogSrc45.includes("FOG_DAWN_HF_MULT") && fogSrc45.includes("FOG_DAWN_DF_ADD");
  const probe = viewerSrc45.includes("__valleyFogDist") && viewerSrc45.includes("__valleyTerr");
  const consts = choreo45.includes("G45_DUSK_MAX") && choreo45.includes("G45_NOON_MIN");
  const noonIntact = viewerSrc45.includes("(sp.elevationDeg - 2) / 18");
  const ok = uniform && terms && probe && consts && noonIntact;
  gate("G45-fog", ok,
    ok
      ? "uDawnF (1−smoothstep(2°,20°)) × valley + horizon terms; __valleyFogDist published — measure ≤0.12 @07:30/20:30, ≥0.2 @12:00"
      : `fog machinery broken (uniform=${uniform} terms=${terms} probe=${probe} consts=${consts} noon=${noonIntact})`);
}

// --- G40 linked programs (§4b FASE 3c-fix): every uniform added via
// onBeforeCompile is DECLARED in GLSL (three uploads but never declares).
// Node checks statically: the dome patch prepends `uniform float
// uSkyScale/uSunElev;` AND checkGLPrograms walks LINK_STATUS (driver
// verdict, not just three diagnostics) + publishes window.__programs.
// The VERDICT (__programs all ok, no "undeclared") is measured in prod.
{
  const viewerSrcG40 = readFileSync("src/engine/viewer.ts", "utf8");
  const agents = readFileSync("AGENTS.md", "utf8");
  const decl = viewerSrcG40.includes("uniform float uSkyScale;\\nuniform float uSunElev;\\n");
  const linkWalk = viewerSrcG40.includes("LINK_STATUS") && viewerSrcG40.includes("__programs")
    && viewerSrcG40.includes("getShaderInfoLog") && viewerSrcG40.includes("framesLive");
  const rule = agents.includes("se DECLARA en el GLSL") && agents.includes("window.__programs sin ningún ok=false");
  const ok = decl && linkWalk && rule;
  gate("G40-linked", ok,
    ok
      ? "dome declares uSkyScale/uSunElev in GLSL; P0-3 walks LINK_STATUS + publishes __programs; AGENTS.md rule in place — measure all ok in prod"
      : `linked-programs contract broken (decl=${decl} linkWalk=${linkWalk} rule=${rule})`);
}

// --- G27 probeless production (§4b FASE 2): without ?debug=1 the loop runs
// ZERO readPixels (no readZenith, no luma/skyfrac/trackpx). Node checks the
// gates: every readback sits inside the debug+30f block; refreshIfNeeded
// (render-only, no readback) is the only capture call in the hot loop.
{
  const viewerSrcG27 = readFileSync("src/engine/viewer.ts", "utf8");
  const hotStart = viewerSrcG27.indexOf("skyCap?.refreshIfNeeded(st.sunElev);");
  const probeBlock = viewerSrcG27.indexOf("if ((lumaOn || skyfracOn || trackpxOn)");
  const reads = ["readZenith", "readPixels", "readRenderTargetPixels"].map((k) => {
    let i = -1;
    let outside = false;
    while ((i = viewerSrcG27.indexOf(k, i + 1)) >= 0) {
      // comments + sky-capture re-export lines don't count; only CALLS in viewer
      if (viewerSrcG27.slice(Math.max(0, i - 80), i).includes("//")) continue;
      if (k === "readRenderTargetPixels" && viewerSrcG27.slice(i - 30, i).includes("renderer.")) {
        // the call must live inside the 30-frame probe block
        if (i < probeBlock) outside = true;
        continue;
      }
      if (i < probeBlock || (k === "readZenith" && i < hotStart)) outside = true;
    }
    return !outside;
  });
  const ok = reads.every(Boolean);
  gate("G27-noread", ok,
    ok
      ? "no readPixels/readZenith in the hot loop without ?debug=1 — production pays zero probe sync"
      : "a readback escapes the debug+30f block (production pays the probe)");
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
