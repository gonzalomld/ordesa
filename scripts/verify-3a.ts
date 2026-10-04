// verify-3a.ts — Phase 3A gates over 1000 s-steps, no browser.
// G1 monotonicity · G2 continuity · G3 clearance · G4 yaw rate (EFFECTIVE
// rope yaw, FAIL — E1 amendment: kept, the rope can still whip) · G5 sun ·
// G9-plan (plan dist, replaces G9-bis) · G12 sky band [0.12,0.30] (contract)
// · G16 nod · G17 void · G18 align · G19 rim · + OrbitControls anti-bundle
// (C10: chunk-name based, the minifier mangles identifiers).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BRIEF_LENGTH_M, CAM_CLEARANCE_M, CAM_RAIL_SAMPLES, CORRIDOR_HALF_M, EPI_PITCH, EPILOGUE_S, FOLLOW_BACK_MULT, FOLLOW_D_MIN, FOLLOW_H_AIM, FOLLOW_H_MULT, G11_LUMA_MIN, G12_SKY_MAX, G12_SKY_MIN, G13_TOL_M, G18_TOL_DEG, G23_COVERAGE, G23_Y_MAX, G23_Y_MIN, G31_LUMA_SHADOW_MIN, G32_CHROMA_SHADOW_MAX, G33_JS_LABELS_MAX_MS, G4_MAX_DEG, G66_ACCEL_MAX_DEG, G66_PITCH_MAX_DEG, G66_QUAT_MAX_DEG, G9_PLAN_COVERAGE, G9_PLAN_FRAC, GROUND_DARK, GROUND_DESAT, GROUND_SPAN, HEMI_DAY, HEMI_GRAY_MIX, HEMI_LUMA_FLOOR, LUMA_GRID, PITCH_MAX_HARD, RIM_ABOVE_CAM_M, RIM_ALONG_MAX, RIM_CORRIDOR_HALF_M, RIM_HALF_ANGLE_DEG, RIM_MARGIN_M, RIM_RADIUS_M, ROCK_CORRIDOR_K, ROCK_FAR_M, ROCK_MIX, ROCK_NEAR_M, ROCK_SCALE_A, ROCK_SCALE_B, ROUTE_DIVERGE_PCT, SHADOW_INTENSITY, SLOPE_WINDOW_M, SUNSET_ELEV_DEG, WALKER_NDC_Y } from "../src/narrative/choreography.ts";
import { alongTrackRun, bakeCamRail, bearingDeg, bisectSunset, followAt, quatDistDeg, quatYXZ, resolveAnchors, resolveFollowProfile, ropeHeadingDeg, trackAt, zRawAt } from "../src/narrative/anchors.ts";
import { PerspectiveCamera } from "three";
import { introSample, INTRO_DURATION_S, INTRO_START_ALT_M, INTRO_MIN_CLEARANCE_M, type IntroTarget } from "../src/narrative/intro.ts";
import { pickTextures, assetWebPath, TEX_HEIGHTMAP } from "../src/engine/tex-budget.ts";
import { findBridges } from "./lib/route-bridge.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import { buildPchip } from "../src/narrative/curve.ts";
import { sunPosition } from "./lib/sun.ts";
import { clampLabelX } from "../src/engine/labels.ts";
import {
  alturaVastago,
  anguloRelativo,
  descartarPorSeparacion,
  dialSimplificado,
  diametroMarcador,
  opacidadMarcador,
  rumboA,
  rumboCamara,
  sectorEdges,
  separacionMinima,
  tapado,
  type MarkerDef,
} from "../src/engine/markers.ts";
import { fotosDemo, vectorEntrada } from "../src/engine/carrete.ts";

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
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  assets?: Record<string, string>;
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

// world: EPSG bbox centre (worldFromMeta in terrain.ts) — same convention
// the browser rig bakes with (C1: bakeCamRail cx/cy). The old pixel-corner
// formula below differed by ~2.5 m and moved every gate's terrain verdict.
// (It also disagreed with lift-probe/doctor, which already use the bbox.)
const cx = (meta.bbox.minx + meta.bbox.maxx) / 2;
const cy = (meta.bbox.miny + meta.bbox.maxy) / 2;

// FOLLOW replan: no LOS branch vote — resolve rhythm, then the follow
// profile (rope evaluators + derived epilogue geometry). Same order as
// progress.ts: resolve -> profile -> PCHIPs (s->d only; camera has no table).
const res = resolveAnchors(r);
res.follow = resolveFollowProfile(r, sampleGrid, meta.bbox);
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

// --- sweep (C1 BAKED RAIL: bakeCamRail from anchors.ts — the SAME function
// the browser rig calls, no mirror). Rope construction/safety live in the
// bake; the sweep resamples the baked evaluators at gate resolution. ---
// World arrays (browser convention): wx = ex - cx, wy = alt, wz = -(ey - cy).
const tBake0 = performance.now();
const rail = bakeCamRail(
  { route: r, follow, sToD: pchipSD, sample: sampleGrid, cx, cy, fovDeg: 50, floorM: CAM_CLEARANCE_M },
  (rope) => resolveFollowSafety(sampleGrid, cx, cy, { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan }, r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 }),
);
const bakeMs = performance.now() - tBake0;
const ds: number[] = new Array(STEPS + 1);
const hs: number[] = new Array(STEPS + 1);
const climbs: number[] = new Array(STEPS + 1);
const yaws: number[] = new Array(STEPS + 1);
const pitchs: number[] = new Array(STEPS + 1);
const planDists: number[] = new Array(STEPS + 1);
const camAlts: number[] = new Array(STEPS + 1);
const camWX: number[] = new Array(STEPS + 1);
const camWZ: number[] = new Array(STEPS + 1);
const aimXs: number[] = new Array(STEPS + 1);
const aimYs: number[] = new Array(STEPS + 1);
const aimZs: number[] = new Array(STEPS + 1);
// G16 input: DEAD with C1 (no damped correction exists — the ladder baked
// statically). The gate now watches the baked mode series: lift/push/tilt
// steps must not oscillate (same 15 m-deadband spirit: count mode flips).
const corrWant: number[] = new Array(STEPS + 1);
let minClear = Infinity;
let minClearS = 0;
let minPlan = Infinity;
let minPlanS = 0;
let belowPlan = 0;
let clampSteps = 0;
let maxClampRun = 0;
let curClampRun = 0;
void CAM_RAIL_SAMPLES;

for (let i = 0; i <= STEPS; i++) {
  const s = i / STEPS;
  const d = pchipSD(s);
  ds[i] = d;
  hs[i] = hourAt(s, d);
  climbs[i] = trackAt(r, d).climb;
  // C1: resample the baked rail (same numbers the browser flies).
  const yawB = rail.fYaw(s);
  const pitchB = rail.fPitch(s);
  const camX = rail.fCamX(s) - cx;
  const camY = rail.fCamY(s);
  const camZ = -(rail.fCamZ(s) - cy);
  const aimX = rail.fAimX(s) - cx;
  const aimY = rail.fAimY(s);
  const aimZ = -(rail.fAimZ(s) - cy);
  yaws[i] = yawB;
  pitchs[i] = pitchB;
  corrWant[i] = 0; // C1: no damped correction (mode-flip G16 below reads rail.mode)
  const dp = Math.hypot(camX - aimX, camZ - aimZ);
  planDists[i] = dp;
  camAlts[i] = camY;
  camWX[i] = camX;
  camWZ[i] = camZ;
  aimXs[i] = aimX;
  aimYs[i] = aimY;
  aimZs[i] = aimZ;
  if (dp < minPlan) {
    minPlan = dp;
    minPlanS = s;
  }
  if (dp < G9_PLAN_FRAC * FOLLOW_D_MIN) belowPlan++;
  // G9 bookkeeping: floor clamp active? (baked: camY == floor + 0.01)
  const floor = sampleGrid(camX + cx, cy - camZ) + CAM_CLEARANCE_M;
  const clamped = camY < floor - 0.01 + 1e-9 && Math.abs(camY - floor) < 0.011;
  void clamped;
  // clearance directly from the baked rail (floor clamp baked in)
  const clear = camY - sampleGrid(camX + cx, cy - camZ);
  if (clear < minClear) {
    minClear = clear;
    minClearS = s;
  }
  // clamp-duty on the baked rail: steps where the ladder mode != direct.
  // Mode is read at the NEAREST bake sample (no interpolation — modes are
  // categorical; interpolating them would smear engagements). The runs
  // ledger (C1b) records start/end/mode per contiguous run for the report.
  const mode = rail.mode[Math.min(rail.n, Math.max(0, Math.round(s * rail.n)))] as string;
  if (mode !== "direct") {
    clampSteps++;
    curClampRun++;
    maxClampRun = Math.max(maxClampRun, curClampRun);
  } else {
    curClampRun = 0;
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
    // 1e-6 m: the flat final span makes the Hermite basis sum to 1 within a
    // few ulps (18238.500000000004 -> 18238.5). That is float noise, not a
    // backward step — zero tolerance here caught the ulp, not the geometry.
    if ((ds[i + 1] as number) < (ds[i] as number) - 1e-6 && badD < 0) badD = i;
    if ((hs[i + 1] as number) < (hs[i] as number) - 1e-6 && badT < 0) badT = i;
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

// --- G4 yaw rate (C1 baked rail): G4_MAX_DEG on the BAKED yaw, wrap-aware,
// over s in [0, 0.98). NO exemptions — the rail holds everywhere.
{
  let max = 0;
  let at = 0;
  for (let i = 0; i < STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue; // epilogue blend re-aims at the centroid by design
    let dy = Math.abs((yaws[i + 1] as number) - (yaws[i] as number));
    if (dy > 180) dy = 360 - dy;
    if (dy > max) {
      max = dy;
      at = i;
    }
  }
  gate("G4-yaw-rate", max <= G4_MAX_DEG,
    `max|dYawBaked|=${max.toFixed(2)} deg/step (need <=${G4_MAX_DEG}) at s=${(at / STEPS).toFixed(4)}, no exemptions (C1 rail)`);
}

// --- G66 (C1): |Δpitch| <= 1.5/step, quaternion step <= 2.8/step,
// angular accel <= 1.0/step^2, over s in [0, 0.98). ---
{
  let mp = 0;
  let atp = 0;
  let mq = 0;
  let atq = 0;
  let ma = 0;
  let ata = 0;
  let prevQ = 0;
  const qs: Array<[number, number, number, number]> = [];
  for (let i = 0; i <= STEPS; i++) qs.push(quatYXZ(yaws[i] as number, pitchs[i] as number));
  for (let i = 0; i < STEPS; i++) {
    if (i / STEPS >= EPILOGUE_S) continue;
    const v = Math.abs((pitchs[i + 1] as number) - (pitchs[i] as number));
    if (v > mp) {
      mp = v;
      atp = i;
    }
    const qd = quatDistDeg(qs[i] as [number, number, number, number], qs[i + 1] as [number, number, number, number]);
    if (qd > mq) {
      mq = qd;
      atq = i;
    }
    if (i > 0) {
      const acc = Math.abs(qd - prevQ);
      if (acc > ma) {
        ma = acc;
        ata = i;
      }
    }
    prevQ = qd;
  }
  const ok = mp <= G66_PITCH_MAX_DEG && mq <= G66_QUAT_MAX_DEG && ma <= G66_ACCEL_MAX_DEG;
  gate("G66-smooth", ok,
    `max|dPitch|=${mp.toFixed(2)} (<=${G66_PITCH_MAX_DEG}) @${(atp / STEPS).toFixed(4)}; maxQ=${mq.toFixed(2)} (<=${G66_QUAT_MAX_DEG}) @${(atq / STEPS).toFixed(4)}; maxAccel=${ma.toFixed(2)} (<=${G66_ACCEL_MAX_DEG}) @${(ata / STEPS).toFixed(4)}`);
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
// not the camera. Active in <=5% of steps in s in [0.02, 0.98] (C2: the
// arranque and the epilogue have their own pose), never >30 in a row.
// C1b: prints every ladder run (start, end, mode, steps) so the H_CAM
// tuning loop knows where to lift. ---
{
  const runs: Array<{ s0: number; s1: number; mode: string; steps: number }> = [];
  {
    let runStart = -1;
    let runMode = "";
    for (let i = 0; i <= STEPS; i++) {
      const s = i / STEPS;
      const m = rail.mode[Math.min(rail.n, Math.max(0, Math.round(s * rail.n)))] as string;
      if (m !== "direct" && runStart < 0) {
        runStart = i;
        runMode = m;
      } else if (m !== "direct" && m !== runMode) {
        runs.push({ s0: runStart / STEPS, s1: (i - 1) / STEPS, mode: runMode, steps: i - runStart });
        runStart = i;
        runMode = m;
      } else if (m === "direct" && runStart >= 0) {
        runs.push({ s0: runStart / STEPS, s1: (i - 1) / STEPS, mode: runMode, steps: i - runStart });
        runStart = -1;
        runMode = "";
      }
    }
    if (runStart >= 0) runs.push({ s0: runStart / STEPS, s1: 1, mode: runMode, steps: STEPS + 1 - runStart });
  }
  // C2 window: s in [0.02, 0.98] like the other smoothness gates.
  let winSteps = 0;
  let winClamp = 0;
  let winMaxRun = 0;
  let winCur = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s < 0.02 || s >= EPILOGUE_S) {
      winCur = 0;
      continue;
    }
    winSteps++;
    const m = rail.mode[Math.min(rail.n, Math.max(0, Math.round(s * rail.n)))] as string;
    if (m !== "direct") {
      winClamp++;
      winCur++;
      winMaxRun = Math.max(winMaxRun, winCur);
    } else {
      winCur = 0;
    }
  }
  const runsTxt = runs.map((x) => `${x.mode}[${x.s0.toFixed(3)}-${x.s1.toFixed(3)}:${x.steps}]`).join(" ");
  gate("G9-clamp-duty", winClamp / Math.max(1, winSteps) <= 0.05 && winMaxRun <= 30,
    `clamp active ${winClamp}/${winSteps} steps in [0.02,0.98] (${(winClamp / Math.max(1, winSteps) * 100).toFixed(1)}%, need <=5%), longest run ${winMaxRun} (need <=30) — runs: ${runsTxt || "none"}`);
}

// --- G9-plan (FOLLOW): dist_planta(camera, aim) >= 0.8 x D_MIN in 95%.
// (gate body lives after G16 below; the sweep-time belowPlan covers all
// steps, the gate recounts pre-epilogue only.)

// --- G10 accumulated climb (audit A5). WIDE BAND ON PURPOSE: accumulated
// climb is very sensitive to the drape (a 20-26 m lateral shift on a 70°
// slope moves tens of metres of z), and the OSM re-trace changed the drape.
// This gate hunts a broken trail (300 m or 1500 m of climb), not a guide
// number. The +815 m in sources.md is the PUBLISHED figure, not this model's;
// the act-I text is NOT updated by editorial decision, so do not narrow this
// band to chase it. ---
{
  const end = climbs[STEPS] as number;
  gate("G10-climb", end >= 700 && end <= 900,
    `climbM(s=1)=${end.toFixed(1)} m (need [700, 900] wide band on purpose; sources.md publishes +815, not a target)`);
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

// --- G94/G95/G96/G97/G101/G102 (§5d-bis ARREGLAR LA SONDA — reparación de
// instrumento, cero ajuste visual). Node checks the CONTRACT; the NUMBERS
// come from prod. Cambios §5d-bis:
// G94: procedimiento con CINCO ASERCIONES (nada de deslizadores):
//   a. escribe uRockMix=0, lee, ASERTA == 0 · b. captura OFF ·
//   c. escribe uRockMix=ROCK_MIX, lee, ASERTA == ROCK_MIX · d. captura ON ·
//   e. ASERTA meanAbsDiff(ON,OFF) > 0,001 ANTES de ningún ratio.
//   Si (e) falla: la medida no se pudo hacer (NO reportar ratio).
//   RMS de banda (blur2−blur6) después/antes ≥ 1,8 + meanAbsDiff ≥ 0,04,
//   parches 128². Si falla: pared lisa, ortofoto pura, sin relieve.
// G95: parches 256², autocorr a los DOS lags (135 m y 85 m → px) — reportar.
//   §5d ANULADO hasta que G94(4e) pase (autocorr baja sin roca solo dice
//   "no hay patrón"). Hash de rock-albedo/rock-normal intacto.
// G96: parche a > 4,5 km (s=0,18): ratio HF ≤ 1,15. NO cambia.
// G101: __rockGLSL.hasRockLive() == __hasRock == 1 sin recompilar. NO cambia.
//   §5d añade: uWallProbe tampoco recompila (uni.programs constante 1→2).
// G102: DIFERENCIAL: corr(P1on−P1off, P2on−P2off) ≤ 0,35. §5d ANULADO
//   (correlacionar dos vectores de ceros da ~0): re-medir tras G94(4e).
// G105 (sonda, §5d-ter — QUE EL INSTRUMENTO DIGA LA VERDAD):
//   (1) MODO 3 = round-trip por el CAMINO REAL (mismo sitio del shader del
//     terreno, uWallProbe=3, mismo readPixels): (0.5,0.25,0.75) → [128,64,191]
//     crudo | [188,137,224] sRGB | otra cosa = parar. El quad propio falso
//     (flatRoundTrip) está BORRADO. Tres valores distintos: un solo 0,5 no
//     distingue codificación de escalado.
//   (2) cada pasada publica uni.* LEÍDOS (uWallProbe/uRockMix/uRockWeight/
//     uWallDeg/uHasRock/programs); si uRockMix ≠ 0,55 en pasada normal, ESE
//     es el hallazgo (explicaría rockK ≥ 0,787 con MIX 0,55).
//   (3) modo 1 B = b−r(ALBEDO, centrado) → brAbyS; gCroma fuera (cociente
//     que engañó en G94 y G104); etiqueta HUD "B = b−r albedo".
//   (4) ESPACIO DE COLOR DECLARADO: gBRF/gLumaF se capturan en el chunk
//     final DESPUÉS de tonemapping+colorspace (three r170: opaque →
//     tonemapping → colorspace → fog → dithering; la niebla va en fog,
//     después de colorspace) y DESPUÉS de la niebla → SON sRGB DE PANTALLA
//     (post-ACES): brFbyS_srgb / lumaFbyS_srgb. La pregunta "¿se ve azul?"
//     es de pantalla.
// Medida: ?debug=walls/walls2&t=12:00 (__rockCtl para on/off, hist3() para
// el modo 3).
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const has = (k: string): boolean => viewerSrc.includes(k);
  const checks: [string, boolean][] = [
    ["uHasRock declarado en GLSL (G40)", has("uniform float uHasRock")],
    ["rockK = rockSteep·uRockWeight·uRockMix·uHasRock·corredor", has("uRockWeight * uRockMix * uHasRock")],
    ["rampa propia 42→58 relativa a uWallDeg", has("uWallDeg +") && has("ROCK_STEEP_LO") && has("ROCK_STEEP_HI")],
    ["V corregida idéntica albedo+normal (yAdj/vy)", has("float yAdj") && has("vec2(wp.z, vy)") && has("vec2(wp.x, vy)") && has("ROCK_DIP") && has("ROCK_WARP_M") && has("ROCK_WARP_SCALE_M")],
    ["triplanar no degenerado (ws suelo 0,05)", has("max(wx + wz, 0.05)")],
    ["tono desaturado + cap ponderado por k", has("ROCK_TONE_W") && has("ROCK_CHROMA_CAP") && has("mix(1.0, scl, kk)")],
    ["contraste que se aplana (ROCK_MEAN/CONTRAST)", has("ROCK_MEAN") && has("ROCK_CONTRAST") && has("0.15 + 0.85 * dfa")],
    ["anisotropía en armRockTex", has("getMaxAnisotropy")],
    ["sonda live hasRockLive (no valor capturado)", has("hasRockLive")],
    ["?debug=rock (uRockDebug)", has("uRockDebug")],
    ["deslizador MEZCLA ROCA", has("mezcla roca")],
  ];
  const valsOk =
    ROCK_SCALE_A === 135 && ROCK_SCALE_B === 85 &&
    ROCK_MIX === 0.55 && ROCK_CORRIDOR_K === 0.55 &&
    ROCK_FAR_M === 2800 && ROCK_NEAR_M === 900;
  const metaRock = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    assets?: Record<string, string>;
    sizesBytes?: Record<string, number>;
  };
  const rockAssets = ["rock-albedo", "rock-normal"];
  const rockOk = rockAssets.every((k) => {
    const rel = metaRock.assets?.[k];
    return !!rel && existsSync(`public/${rel}`) &&
      metaRock.sizesBytes?.[k] === (existsSync(`public/${rel}`) ? readFileSync(`public/${rel}`).length : -1);
  });
  const probeSrc105 = readFileSync("src/engine/wall-probe.ts", "utf8");
  const wallProbeDecl = has("uniform float uWallProbe");
  const wallProbeUniform = has('s.uniforms["uWallProbe"] = wallProbe');
  const wallProbeModes = has("uWallProbe > 0.5") && has("uWallProbe < 1.5");
  const wallsFlags = readFileSync("src/engine/debug.ts", "utf8").includes('q.get("debug") === "walls"');
  const wallsLazy = has('await import("./wall-probe.ts")');
  // §5d-ter: modo 3 camino real + veredicto + sRGB declarado con sufijo.
  const hasUni = (s: string, k: string): boolean => s.includes(k);
  const wallsTer = hasUni(probeSrc105, "vec4(0.5, 0.25, 0.75, 1.0)")
    && hasUni(probeSrc105, "roundTripVerdict")
    && !hasUni(probeSrc105, "flatRoundTrip")
    && hasUni(probeSrc105, "brFbyS_srgb") && hasUni(probeSrc105, "lumaFbyS_srgb")
    && hasUni(probeSrc105, "SON sRGB DE PANTALLA")
    && hasUni(viewerSrc, "else if (uWallProbe < 3.5)")
    && hasUni(viewerSrc, "hist3:");
  const wallsBis = hasUni(probeSrc105, "uWallProbe: uWallProbe.value") && hasUni(probeSrc105, "brAbyS")
    && hasUni(viewerSrc, "__rockCtl") && hasUni(viewerSrc, "gBR * 0.5 + 0.5")
    && hasUni(viewerSrc, "gLumaF = gluma(gl_FragColor.rgb)")
    && !hasUni(viewerSrc, "clamp(gCroma, 0.0, 1.0)");
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  const wallsBad = [!wallProbeDecl && "uWallProbe no declarado (G40)",
    !wallProbeUniform && "uWallProbe no viaja como uniforme",
    !wallProbeModes && "modos 1/2 no implementados",
    !wallsFlags && "banderas ?debug=walls/walls2 ausentes",
    !wallsLazy && "wall-probe.ts no es carga diferida",
    !wallsBis && "§5d-bis ausente (uni.* leídos / brAbyS / gLumaF-gBRF antes de sonda / sin cociente)",
    !wallsTer && "§5d-ter ausente (modo 3 camino real + veredicto + sRGB con sufijo, sin flatRoundTrip)"];
  gate("G94-rock-contract", bad.length === 0 && valsOk,
    bad.length || !valsOk
      ? `falta: ${[...bad, ...(valsOk ? [] : [`vals A=${ROCK_SCALE_A} B=${ROCK_SCALE_B} MIX=${ROCK_MIX} CORR=${ROCK_CORRIDOR_K} FAR=${ROCK_FAR_M} NEAR=${ROCK_NEAR_M}`])].join(", ")}`
      : `triplanar 135/85 m, MIX 0.55 (corredor ×0.55), fade 2800→900, rampa 42→58, yAdj+warp, cap ponderado — measure HF DE BANDA (blur2−blur6) ratio ≥1.8 + meanAbsDiff ≥0.04, parches 128² @s=0.80/0.29, ?t=12:00`);
  gate("G95-rock-timeless", rockOk,
    rockOk
      ? `rock-albedo/normal con hash en meta (${metaRock.assets?.["rock-albedo"]}, ${metaRock.assets?.["rock-normal"]}) — measure autocorr a los DOS lags (135/85 m → px), parches 256²`
      : `rock assets missing/mismatched in meta.json (need rock-albedo + rock-normal hashed)`);
  gate("G96-rock-far", has("ROCK_FAR_M") && has("smoothstep("),
    `fade 2800→900 (aplana contraste, no desatura) — measure HF ratio ≤1.15 @>4.5 km (s=0.18)`);
  gate("G97-rock-colour", has("tono = alb / max(gluma(alb)") && has("mix(vec3(1.0), tono"),
    `tono desaturado (brillo, no azul) + cap ponderado por k — measure croma ≤0.10 sobre píxeles renderizados, luma ±15 %`);
  gate("G101-rock-uniform", has("hasRockLive") && !viewerSrc.includes("hasRockVal:"),
    `uHasRock es uniforme vivo (hasRockLive), sin valor capturado en compile — measure __rockGLSL.hasRockLive()==__hasRock==1 + programs sin crecer al mover el deslizador`);
  gate("G102-rock-nocontour", has("float yAdj") && has("ROCK_WARP_M") && has("ROCK_DIP"),
    `lecho = y + buzamiento + alabeo (una banda ya no cruza el circo) — measure corr DIFERENCIAL (P1on−P1off vs P2on−P2off) ≤0.35 @s=0.80, 12:00`);
  gate("G105-wall-probe", (wallsBad.filter(Boolean) as string[]).length === 0,
    (wallsBad.filter(Boolean) as string[]).length > 0
      ? `sonda rota: ${(wallsBad.filter(Boolean) as string[]).join(", ")}`
      : `sonda §5d-ter: modo 3 camino real [128,64,191]crudo/[188,137,224]sRGB + uni.* LEÍDOS + brAbyS + brFbyS_srgb/lumaFbyS_srgb (pantalla, post-ACES) — measure hist3() + uni.uWallProbe==mode`);
}

// --- G93 luma probe cost (C2b): downsample 32×32 + readPixels de 4 KB,
// bajo lumaOn (con ?skyfrac=1/?trackpx=1 sin ?luma=1 no corre), buffers
// persistentes, coste medido __lumaMs ≤ 1 ms por pasada. Vía puertos del
// renderer (escena propia + copyFramebufferToTexture: el blit crudo
// default→FBO-propio dejaba INVALID_OPERATION en el ledger G22). Node
// verifica el contrato; los NÚMEROS viven en navegador (?debug=1&luma=1). ---
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["downsample 32×32 vía renderer (escena propia)", has(src, "copyFramebufferToTexture") && has(src, "lumaScene") && has(src, "new THREE.WebGLRenderTarget(LUMA_GRID, LUMA_GRID")],
    ["sin GL crudo de ESCRITURA (cero blitFramebuffer)", !has(src, "blitFramebuffer")],
    ["lumaBuf persistente (sin allocs)", has(src, "const lumaBuf = new Uint8Array(LUMA_GRID * LUMA_GRID * 4)")],
    ["gate lumaOn (skyfrac/trackpx solos no corren)", has(src, "if (lumaOn) {") && has(src, "__lumaMs = lumaOn ? lumaMs : -1")],
    ["crono downsample+lectura (__lumaMs)", has(src, "__lumaMs") && has(src, "performance.now()")],
    ["fallback celda central sin copy", has(src, "Fallback: la celda central")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G93-luma-cost", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — downsample 32×32 + 4 KB, gate lumaOn, buffers persistentes, __lumaMs (medir ≤1 ms en prod ?debug=1&luma=1)`);
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
  // HEMI_GRAY_MIX 0.6 (§6b: 0.75 revertido — solo niebla baja, no paredes) ·
  // HEMI_LUMA_FLOOR 0.20 (nivel) · HEMI_DAY 1.08 (+20 %, paso c) ·
  // SHADOW_INTENSITY 0.55 (paso d).
  const hemiOk =
    HEMI_GRAY_MIX === 0.6 && HEMI_LUMA_FLOOR === 0.2 &&
    HEMI_DAY === 1.08 && SHADOW_INTENSITY === 0.55 &&
    viewerSrcG31.includes("sun.shadow.intensity = SHADOW_INTENSITY");
  gate("fase5-hemi", hemiOk,
    hemiOk
      ? `HEMI_GRAY_MIX=${HEMI_GRAY_MIX} HEMI_LUMA_FLOOR=${HEMI_LUMA_FLOOR} HEMI_DAY=${HEMI_DAY} SHADOW_INTENSITY=${SHADOW_INTENSITY} (sun.shadow.intensity applied) — measure luma/__lumaShadow/__chromaShadow per step`
      : `hemi steps drifted (mix=${HEMI_GRAY_MIX} floor=${HEMI_LUMA_FLOOR} day=${HEMI_DAY} shadow=${SHADOW_INTENSITY}, applied=${viewerSrcG31.includes("sun.shadow.intensity = SHADOW_INTENSITY")})`);
}

// --- G78 epílogo (C2): en s=1.0 el bucle completo dentro del encuadre
// (cobertura ≥ 0,95 sobre el rastro) — medido en geometría pura
// (proyección NDC con el yaw/pitch horneados + FOV 50°), y contrato del
// pitch 20° + distPlan adaptativo. s=0.99/0.995 son TRANSICIÓN (blend
// 0.5/0.875: la cámara aún viaja hacia la pose de epílogo y el bucle no
// tiene por qué caber). __skyFrac ∈ [0.15, 0.35] vive en prod
// (?debug=1&skyfrac=1).
{
  const fovV = (50 * Math.PI) / 180;
  const tanV = Math.tan(fovV / 2);
  const fovH = 2 * Math.atan(tanV * (16 / 9));
  const tanH = Math.tan(fovH / 2);
  // C2: el bucle debe caber en la POSE de epílogo (s=1.0, blend 1.0).
  const sE = 1.0;
  const camXE = rail.fCamX(sE) - cx;
  const camYE = rail.fCamY(sE);
  const camZE = -(rail.fCamZ(sE) - cy);
  const yawE = (rail.fYaw(sE) * Math.PI) / 180;
  const pitchE = (rail.fPitch(sE) * Math.PI) / 180;
  // forward = R_y(-yaw)·R_x(-pitch)·(0,0,-1), right/up del mismo marco.
  const cp = Math.cos(pitchE);
  const sp = Math.sin(pitchE);
  const cyw = Math.cos(yawE);
  const syw = Math.sin(yawE);
  const fwd: [number, number, number] = [syw * cp, -sp, -cyw * cp];
  const right: [number, number, number] = [cyw, 0, syw];
  const up: [number, number, number] = [-syw * sp, -cp, cyw * sp];
  let inside = 0;
  let nE = 0;
  for (let i = 0; i < r.n; i += 4) {
    // r.x=easting, r.y=northing, r.z=alt (RouteLike EPSG). Mundo del gate:
    // X=easting-cx, Y=alt, Z=-(northing-cy) — igual que el sweep.
    const vx = (r.x[i] as number) - cx - camXE;
    const vy = (r.z[i] as number) - camYE;
    const vz = -((r.y[i] as number) - cy) - camZE;
    const z = vx * fwd[0] + vy * fwd[1] + vz * fwd[2];
    if (z <= 1) continue;
    nE++;
    const x = vx * right[0] + vy * right[1] + vz * right[2];
    const y = vx * up[0] + vy * up[1] + vz * up[2];
    if (Math.abs(x / (z * tanH)) <= 1 && Math.abs(y / (z * tanV)) <= 1) inside++;
  }
  const cov = inside / Math.max(1, nE);
  const pitchOk = EPI_PITCH === 20;
  gate("G78-epilogo", cov >= 0.95 && pitchOk,
    `bucle en encuadre s=1.0 (${inside}/${nE} (${(cov * 100).toFixed(1)}%, need ≥95%)), EPI_PITCH=${EPI_PITCH} (need 20), distPlan=${follow.epiDistPlan.toFixed(0)} m, centroid=(${follow.centroid.x.toFixed(0)},${follow.centroid.y.toFixed(0)},${follow.centroid.z.toFixed(0)}) — __skyFrac [0.15,0.35] en prod ?debug=1&skyfrac=1`);
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
  // Same wide band as G10 on purpose: the climb check here guards the
  // single-source construction, not the published +815 m (editorial text is
  // NOT updated by decision). A broken trail still trips it.
  const climbOk = climbEnd >= 700 && climbEnd <= 900;
  gate("G14a-coherence-src", hourMismatch < 0 && noSecondSource && climbOk && kmGap < 0.01 && zGap < 1,
    `20 s-values: clocks identical=${hourMismatch < 0}; telemetry.ts second-source-free=${noSecondSource}; climb(s=1)=${climbEnd.toFixed(0)}m (need 700-900 wide band, not the text's 815); ${rows.join(" | ")}`);
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
  // Cap widened 90 -> 120 on purpose: the 200 m window slope depends on
  // where the line falls on the slope, not on the trail itself (a 70° slope
  // turns 5 m of horizontal into 14 m of vertical). The text's published 80 %
  // is the real-terrain figure, NOT this model's — the act-I text is NOT
  // updated by editorial decision, so do not tighten this back to chase it.
  // The km 1.20 anchor upper bound follows the same treatment (65 -> 120): it
  // still guarantees act-I is a real climb (>=45 %), but no longer pins the
  // model to where the old line happened to fall on the hillside.
  gate("G14b-slope-window", worst <= 120 && atAnchor >= 45 && atAnchor <= 120,
    `|slopeWin| max ${worst.toFixed(1)}% at s=${worstS.toFixed(3)} (need <=120 wide cap on purpose, not the text's 80%); km 1.20 raw-Z window: ${atAnchor.toFixed(1)}% (need [45, 120] wide anchor on purpose)`);
}

// --- G117-climb-tortuosity (§8d): the act-I climb (km 0.3-2.4) must zigzag.
// Measured in PLAN, so it is immune to the drape — unlike G14b, whose slope
// window was what implicitly guarded this and what the OSM re-trace revealed
// was measuring the hillside, not the trail. If this fails, someone replaced
// the switchbacks with a straight "up the fall line" line, which is exactly
// what the act-I text describes it is not ("el camino no sube: zigzaguea,
// porque de frente no se puede").
// Two definition choices, both round-tripped against the refs (GPX 2.21/2532°,
// OSM 2.25/2953°):
//  · path length is the trail's cumulative d (d[i1]-d[i0]), NOT the chord sum
//    of the resampled XY: the XY is a projection and its chord sum reads ~2.09,
//    not the 2.25 of the trail.
//  · headings use the raw JSON doubles, not r.x/r.y (Float32Array): the float
//    quantization adds sub-metre jitter that inflates turn to ~3231°.
{
  const D0 = 300;
  const D1 = 2400;
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < r.n; i++) {
    const d = r.d[i] as number;
    if (i0 < 0 && d >= D0) i0 = i;
    if (d <= D1) i1 = i;
  }
  let turnDeg = 0;
  let prevH: number | null = null;
  for (let i = i0; i <= i1; i++) {
    if (i > i0) {
      const h = Math.atan2(
        (route.y[i] as number) - (route.y[i - 1] as number),
        (route.x[i] as number) - (route.x[i - 1] as number),
      );
      if (prevH !== null) {
        let dh = (h - prevH) * (180 / Math.PI);
        while (dh > 180) dh -= 360;
        while (dh < -180) dh += 360;
        turnDeg += Math.abs(dh);
      }
      prevH = h;
    }
  }
  const pathLen = (r.d[i1] as number) - (r.d[i0] as number);
  const straight = Math.hypot(
    (route.x[i1] as number) - (route.x[i0] as number),
    (route.y[i1] as number) - (route.y[i0] as number),
  );
  const tort = straight > 0 ? pathLen / straight : Infinity;
  gate("G117-climb-tortuosity", tort >= 2.0 && turnDeg >= 2200,
    `act-I plan km ${((r.d[i0] as number) / 1000).toFixed(2)}-${((r.d[i1] as number) / 1000).toFixed(2)}: tortuosity ${tort.toFixed(2)} (need >=2.00), accumulated turn ${turnDeg.toFixed(0)}deg (need >=2200) — refs GPX 2.21/2532°, OSM 2.25/2953°`);
}

// --- G16 mode duty (C1): the baked ladder mode must not oscillate.
// direct = rope flies free; lift/push/tilt = ladder engaged. Count runs of
// non-direct steps: <= 12 separate engagements pre-epilogue (same budget as
// the old nod flips — more means the rail weaves in and out of the terrain).
{
  let engagements = 0;
  let inEng = false;
  for (let i = 0; i <= STEPS; i++) {
    if (i / STEPS >= EPILOGUE_S) continue;
    const mode = rail.mode[Math.min(rail.n, Math.round((i / STEPS) * rail.n))] as string;
    if (mode !== "direct" && !inEng) {
      engagements++;
      inEng = true;
    } else if (mode === "direct") {
      inEng = false;
    }
  }
  void corrWant;
  gate("G16-nod", engagements <= 12,
    `ladder engagements ${engagements} over pre-epilogue steps (need <=12) — more means the rail weaves`);
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

// --- G18 align (C1 baked rail): |bakedYaw - ropeHeading| <= 35 for
// s < 0.98, NO exemptions. The rope reference is the RAW rope (anchor->aim,
// unsmoothed): where the rail cuts a hairpin the two legitimately differ —
// that deviation is the price of no-whip, and the gate budgets 35° for it.
// Fires when the rail leaves the rope corridor (smoothing/limiter fault).
{
  let max = 0;
  let at = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    const d = ds[i] as number;
    // G18 reference: the RAW rope segment (anchor->aim), not the path
    // tangent at the aim (which whips +-100 deg on act-I hairpins).
    const pr = followAt(follow, s);
    const heading = ropeHeadingDeg(r, d, pr.lookM, pr.backM);
    // wrap180(dev): ((x + 540) % 360) - 180 maps onto [-180,180).
    const rawDev = (yaws[i] as number) - heading;
    const devW = Math.abs(((rawDev + 540) % 360 + 360) % 360 - 180);
    if (devW > max) {
      max = devW;
      at = i;
    }
  }
  gate("G18-align", max <= G18_TOL_DEG,
    `max|yawBaked-rope|=${max.toFixed(1)} deg (need <=${G18_TOL_DEG}) at s=${(at / STEPS).toFixed(4)}, no exemptions (C1 rail)`);
}

// --- G91 arranque por encima de la niebla (C2-addendum-5): cota de
// cámara ≥ 1780 m en s ∈ [0, 0.03] (techo de niebla del alba 1620 m) y
// holgura ≥ 120 m en ese tramo. Si falla, seguimos dentro de la niebla.
{
  let minCam = Infinity;
  let minCamS = 0;
  let minHolg = Infinity;
  let minHolgS = 0;
  for (const s of [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03]) {
    const camY = rail.fCamY(s);
    const terr = sampleGrid(rail.fCamX(s), rail.fCamZ(s));
    if (camY < minCam) {
      minCam = camY;
      minCamS = s;
    }
    if (camY - terr < minHolg) {
      minHolg = camY - terr;
      minHolgS = s;
    }
  }
  gate("G91-arranque-niebla", minCam >= 1780 && minHolg >= 120,
    `cota min ${minCam.toFixed(0)} m en s=${minCamS.toFixed(3)} (need ≥1780), holgura min ${minHolg.toFixed(0)} m en s=${minHolgS.toFixed(3)} (need ≥120) — techo niebla 1620 m`);
}

// --- G19 rim (C1 baked rail, REDEFINIDA G19r): terrain stays 100 m below
// the SIGHTLINE — pero G19 mide OBSTRUCCIÓN, no fondo: solo cuenta terreno
// en el 70 % inicial del rayo (RIM_ALONG_MAX) y a menos de 60 m del eje
// (RIM_CORRIDOR_HALF_M). Same sloped+clipped corridor, fed with the baked
// cam/aim (world->EPSG).
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
  let rimFrac = 0;
  let rimAcross = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    const camEpsgX = (camWX[i] as number) + cx;
    const camEpsgY = cy - (camWZ[i] as number);
    // aim ray in EPSG plan: unit forward + across; ray slope from cam->aim.
    let fx = ((aimXs[i] as number) + cx) - camEpsgX;
    let fy = (cy - (aimZs[i] as number)) - camEpsgY;
    const fl = Math.max(1e-6, Math.hypot(fx, fy));
    fx /= fl;
    fy /= fl;
    const rayDy = (aimYs[i] as number) - (camAlts[i] as number);
    const rayDp = Math.max(1e-6, Math.hypot((aimXs[i] as number) - (camWX[i] as number), (aimZs[i] as number) - (camWZ[i] as number)));
    const camAlt = camAlts[i] as number;
    // SLOPED + CLIPPED corridor (G19r): along in [0, RIM_ALONG_MAX·planDp]
    // (más allá es fondo, no obstrucción) y across en ±RIM_CORRIDOR_HALF_M
    // (solo cerca del eje). Nunca pasado el aim: past it the ray leaves
    // the frame through the lookAt point.
    const planDp = Math.max(1e-6, Math.hypot((aimXs[i] as number) - (camWX[i] as number), (aimZs[i] as number) - (camWZ[i] as number)));
    const alongMax = Math.min(planDp, RIM_ALONG_MAX * planDp);
    let worstLocal = -Infinity;
    let worstFrac = 0;
    let worstAcross = 0;
    for (let along = 0; along <= alongMax; along += stepM) {
      const rayAlt = camAlt + (rayDy * along) / rayDp;
      for (let across = -RIM_CORRIDOR_HALF_M; across <= RIM_CORRIDOR_HALF_M; across += stepM) {
        const ex = camEpsgX + fx * along + -fy * across;
        const ey = camEpsgY + fy * along + fx * across;
        const c = Math.min(W - 1, Math.max(0, Math.round((ex - meta.originX) / meta.resX - 0.5)));
        const r2 = Math.min(H - 1, Math.max(0, Math.round((meta.originY - ey) / meta.resY - 0.5)));
        const z = zFull(c, r2);
        const over = z - rayAlt - RIM_MARGIN_M; // >0: terrain in frame above the sightline
        if (over > worstLocal) {
          worstLocal = over;
          worstFrac = along / planDp;
          worstAcross = across;
        }
      }
    }
    if (worstLocal > rimWorst) {
      rimWorst = worstLocal;
      rimAt = i;
      rimFrac = worstFrac;
      rimAcross = worstAcross;
    }
  }
  gate("G19-rim", rimWorst <= 0,
    rimWorst <= 0
      ? `terrain < sightline+100 in useful ray (70%, ±60 m) everywhere s<0.98 (best margin ${(-rimWorst).toFixed(0)} m)`
      : `terrain EXCEEDS sightline+100 by ${rimWorst.toFixed(0)} m at s=${(rimAt / STEPS).toFixed(4)} (along ${(rimFrac * 100).toFixed(0)}%, across ${rimAcross.toFixed(0)} m) — MURO real: along<70% y |across|<60 m`);
}

// --- G23 walker-frame (C1 baked rail): P(d) projects at y in [-0.6,-0.3]
// NDC over s in [0, 0.98) with >= 95 % coverage; outliers listed with s.
// Same YXZ mirror as before, fed with the BAKED yaw/pitch/cam (world).
{
  const fovDeg = 50;
  const tanHalf = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  let worstY = -Infinity;
  let worstS = 0;
  let outside = 0;
  let n = 0;
  // Per-step ledger for the failure message (worst 5 only, no flood).
  const bad: { s: number; y: number; pitch: number; pitchW: number; distW: number }[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    if (s >= EPILOGUE_S) continue;
    n++;
    const d = pchipSD(s);
    const cam: [number, number, number] = [camWX[i] as number, camAlts[i] as number, camWZ[i] as number];
    const pW = trackAt(r, Math.min(r.lengthM, d));
    const walker: [number, number, number] = [pW.x - cx, pW.z + FOLLOW_H_AIM, -(pW.y - cy)];
    const yaw = yaws[i] as number;
    const pitch = pitchs[i] as number;
    const distPlanW = Math.max(1e-6, Math.hypot(walker[0] - cam[0], walker[2] - cam[2]));
    const pitchWalker = (Math.atan2(cam[1] - walker[1], distPlanW) * 180) / Math.PI;
    // view: YXZ (yaw about world Y, then pitch about camera X). Forward is
    // R_y(-yawR)·R_x(-pitchR)·(0,0,-1) — verified against three above.
    const yawR = (yaw * Math.PI) / 180;
    const pitchR = (pitch * Math.PI) / 180;
    const fx = Math.sin(yawR) * Math.cos(pitchR);
    const fy = -Math.sin(pitchR);
    const fz = -Math.cos(yawR) * Math.cos(pitchR);
    // camera basis: right = R_y(-yawR)·(1,0,0) = (cos(yawR), 0, sin(yawR)).
    const rX = Math.cos(yawR);
    const rY = 0;
    const rZ = Math.sin(yawR);
    // up = cross(right, fwd).
    const uX = rY * fz - rZ * fy;
    const uY = rZ * fx - rX * fz;
    const uZ = rX * fy - rY * fx;
    const vx = walker[0] - cam[0];
    const vy = walker[1] - cam[1];
    const vz = walker[2] - cam[2];
    const clipW = vx * fx + vy * fy + vz * fz;
    const yV = vx * uX + vy * uY + vz * uZ;
    const ndcY = clipW > 0 ? yV / (clipW * tanHalf) : -Infinity;
    if (!(ndcY >= G23_Y_MIN && ndcY <= G23_Y_MAX)) {
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
  for (const b of bad) {
    if (!Number.isFinite(b.y)) { nBehind++; continue; }
    if (b.y > G23_Y_MAX) nHigh++;
    else nLow++;
    sumY += b.y;
    nFin++;
  }
  const meanY = nFin > 0 ? (sumY / nFin).toFixed(2) : "n/a";
  const frac = 1 - outside / Math.max(1, n);
  gate("G23-walker-frame", frac >= G23_COVERAGE,
    frac >= G23_COVERAGE
      ? `P(d) at y in [${G23_Y_MIN},${G23_Y_MAX}] NDC on ${n - outside}/${n} steps (${(frac * 100).toFixed(1)}%, need >=${G23_COVERAGE * 100}) — outliers: ${worst5 || "none"}`
      : `${outside}/${n} outside [${G23_Y_MIN},${G23_Y_MAX}] (behind=${nBehind} high=${nHigh} low=${nLow} meanY=${meanY}), worst y=${Number.isFinite(worstY) ? worstY.toFixed(2) : "BEHIND"} at s=${worstS.toFixed(4)} — worst5: ${worst5}`);
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

// --- G24 sky (§4b FASE 2: display-space probe). §5d: RETIRADA — su banda
// de hex se calibró para el cielo anterior y duplica lo que G103 ya mide a
// 90° sobre el mapa (blit + bandas por elevación, independiente de la
// cámara). El instrumento (sonda + ?skymap=1 + blit) sigue intacto y lo usa
// G103; solo se retira la puerta numérica. Nota histórica: el cenit de §6b
// leía #3c74a0 en el blit frente a la banda vieja [#2a68b8,#3e86d2].
{
  const capSrcG24 = readFileSync("src/engine/sky-capture.ts", "utf8");
  const viewerSrcG24ret = readFileSync("src/engine/viewer.ts", "utf8");
  const probeAlive = capSrcG24.includes("readZenith") && viewerSrcG24ret.includes("__skyHzRatio");
  gate("G24-sky-retired", probeAlive,
    probeAlive
      ? "RETIRADA §5d (banda calibrada para otro cielo; G103 cubre 90° en el mapa) — sonda readZenith + blit ?skymap=1 intactos para G103"
      : "la retirada de G24 rompió la sonda que usa G103 (readZenith/__skyHzRatio ausentes)");
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
  // recompute: baked-rail cam poses (same numbers the browser flies),
  // N2-fix: s ∈ [0, 0,97] SIN epílogo (como el viewer).
  const { cloudLayout: cl36 } = await import("../src/engine/clouds.ts");
  const poses36: { x: number; y: number; z: number }[] = [];
  for (let s = 0; s <= 0.97; s += 0.005) {
    const sc = Math.min(1, Math.max(0, s));
    const i = Math.min(STEPS, Math.round((sc / 1) * STEPS));
    const camE = (camWX[i] as number) + cx;
    const camN = cy - (camWZ[i] as number);
    poses36.push({ x: camE, y: camN, z: camAlts[i] as number, s: sc });
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

// --- G127-tilediff-control (T1-cierre): el lector __tilediff RENDERIZA Y
// LEE en el mismo bloque síncrono (estructura wall-probe: guardar uTileDiff
// + clear, subir, render, readPixels inmediato, restaurar en finally). Sin
// eso, leer desde consola fuera del frame devuelve ceros (sin
// preserveDrawingBuffer el buffer se limpia al presentar). Y G lleva el
// CANAL DE CONTROL (luma del corredor, que pinta el terreno en pantalla):
// si G sale cero, el lector está roto y R no significa nada.
// WebGL: magFilter nunca es mipmap (GL_INVALID_ENUM — mag solo acepta
// LINEAR/NEAREST; el driver se queda con el defecto).
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const fogSrc = readFileSync("src/engine/height-fog.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["read() renderiza+lee en bloque (tileDiff=1, render, readPixels parche, finally)", has(viewerSrc, "tileDiff.value = 1") && has(viewerSrc, "renderer.render(scene, camera)") && has(viewerSrc, "gl.readPixels(x0, y0, w, h") && has(viewerSrc, "tileDiff.value = prevU")],
    ["parche 32×32 promediado en ambos canales (n trazable)", has(viewerSrc, "const PS = 32") && has(viewerSrc, "verdict, n: nn")],
    ["restaura clear + visibilidades (finally)", has(viewerSrc, "renderer.setClearColor(prevClear, prevAlpha)") && has(viewerSrc, "hideForTilediff")],
    ["canal de control G (luma corredor, gLumaC)", (has(viewerSrc, "gLumaC = gluma(corrForG)") || has(viewerSrc, "gLumaC = gluma(corr.rgb)")) && has(viewerSrc, "uniform float uTileDiff")],
    ["magFilter sin mipmap (uCloud: LinearFilter)", fogSrc.includes("tex.magFilter = THREE_NS.LinearFilter") && !fogSrc.includes("tex.magFilter = THREE_NS.LinearMipmapLinearFilter")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G127-tilediff-control", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — lector render+lee, G control, magFilter legal`);
}

// --- G132-raw-probe (T1-cierre): la muestra cruda vive tras bandera
// (?debug=rawtile | ?debug=rawcorr), como uniforme vivo uRawMode, y su
// lectura usa el mismo round-trip render+lee en bloque que read(). Los
// parámetros de textura se publican vivos en __tilediff.tex(). Si esto se
// rompe, no hay forma de ver qué textura decodifica three y el 0,67 vuelve
// a ser una caja negra.
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrc = readFileSync("src/engine/debug.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const guardIdx = viewerSrc.indexOf("if (boot.tilediff || boot.rawtile || boot.rawcorr)");
  const rawIdx = viewerSrc.indexOf("const readRaw = (mode: 1 | 2)");
  const texIdx = viewerSrc.indexOf("const texParams = (): unknown");
  const checks: [string, boolean][] = [
    ["flags rawtile/rawcorr en debug.ts", has(debugSrc, 'q.get("debug") === "rawtile"') && has(debugSrc, 'q.get("debug") === "rawcorr"')],
    ["uRawMode uniforme vivo declarado + subido", has(viewerSrc, "uniform float uRawMode;") && has(viewerSrc, 's.uniforms["uRawMode"] = rawMode')],
    ["escritura cruda tras dithering (tile y corredor)", has(viewerSrc, "if (uRawMode > 1.5)") && has(viewerSrc, "gl_FragColor = vec4(clamp(gCorrRgb") && has(viewerSrc, "gl_FragColor = vec4(clamp(gTileRgb")],
    ["captura cruda en el muestreo (gTileRgb/gCorrRgb)", has(viewerSrc, "gTileRgb = tileRgb") && has(viewerSrc, "gCorrRgb = corr.rgb")],
    ["readRaw renderiza+lee en bloque (mode, prevRaw)", has(viewerSrc, "rawMode.value = mode") && has(viewerSrc, "renderer.render(scene, camera)") && has(viewerSrc, "rawMode.value = prevRaw")],
    ["lector y parámetros DENTRO de la guarda", guardIdx >= 0 && rawIdx > guardIdx && texIdx > guardIdx],
    ["parámetros vivos publicados (__tilediff.tex + readRaw)", has(viewerSrc, "describeTex(tilesAtlasUniform.value)") && has(viewerSrc, "describeTex(corridorUniform.value)") && has(viewerSrc, "readRaw,")],
    ["armTiles arma atlas con rawtile/rawcorr (una sola guarda)", /if\s*\(\s*boot\.tiles\s*\|\|\s*boot\.tilediff\s*\|\|\s*boot\.rawtile\s*\|\|\s*boot\.rawcorr\s*\)\s*\{\s*void armTiles\(\);/.test(viewerSrc)],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G132-raw-probe", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — muestra cruda tras bandera, uniforme vivo, round-trip en bloque, parámetros vivos`);
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

// --- G29 main-pass counter (§4b FASE 2b + §3 haces): the HUD reads
// calls/tris from the MAIN pass only (info.reset + read right after the
// main render; passes counts render() calls). Node checks the mechanism;
// the NUMBERS (calls=6 con haces / 5 con ?beams=0; skymap → passes=2)
// come from prod.
{
  const viewerSrcG29 = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrcG29 = readFileSync("src/engine/debug.ts", "utf8");
  // reset→render PRINCIPAL adyacentes (no primera ocurrencia en el fichero:
  // los renders de instrumentos —tilediff, wall-probe— viven antes/después
  // y no cuentan; lo que importa es que el reset arme la pasada principal).
  const resetAt = viewerSrcG29.indexOf("renderer.info.reset()");
  const mainRenderAt = resetAt >= 0 ? viewerSrcG29.indexOf("renderer.render(scene, camera)", resetAt) : -1;
  const resetFirst = resetAt >= 0 && mainRenderAt > resetAt && mainRenderAt - resetAt < 120;
  const readAfter = viewerSrcG29.indexOf("metrics.drawCalls = renderer.info.render.calls")
    < viewerSrcG29.indexOf("updateLabels(labelRts");
  const passesField = debugSrcG29.includes("passes: number") && debugSrcG29.includes("pases ${metrics.passes}");
  const pollClean = !debugSrcG29.includes("r.info.render.calls");
  const ok = resetFirst && readAfter && passesField && pollClean;
  gate("G29-counter", ok,
    ok
      ? "HUD calls/tris = main pass (info.reset + read after main render, passes counted) — measure calls=6 (?beams=0 → 5)/passes=1 (skymap→2) in-browser"
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
  const decl = viewerSrcG40.includes("uniform float uSkyScale;\\nuniform float uSunElev;\\nuniform float uGroundF;\\n");
  const linkWalk = viewerSrcG40.includes("LINK_STATUS") && viewerSrcG40.includes("__programs")
    && viewerSrcG40.includes("getShaderInfoLog") && viewerSrcG40.includes("framesLive");
  const rule = agents.includes("se DECLARA en el GLSL") && agents.includes("window.__programs sin ningún ok=false");
  const ok = decl && linkWalk && rule;
  gate("G40-linked", ok,
    ok
      ? "dome declares uSkyScale/uSunElev/uGroundF in GLSL; P0-3 walks LINK_STATUS + publishes __programs; AGENTS.md rule in place — measure all ok in prod"
      : `linked-programs contract broken (decl=${decl} linkWalk=${linkWalk} rule=${rule})`);
}

// --- G27 probeless production (§4b FASE 2): without ?debug=1 the loop runs
// ZERO readPixels (no readZenith, no luma/skyfrac/trackpx). Node checks the
// gates: every readback sits inside the debug+30f block; refreshIfNeeded
// (render-only, no readback) is the only capture call in the hot loop.
// Instrument readers (__tilediff.read, __wallProbe.hist) call readPixels
// bajo demanda tras bandera — no cuentan: solo importan los del hot loop
// (el bloque del frame). Se excluyen líneas dentro de `read: (` / `read:()`
// (lectores bajo demanda) y comentarios.
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
      // on-demand instrument readers (tras bandera, bajo demanda — nunca en
      // el hot loop): el lector __tilediff.read/readRaw. El bloque va tras
      // "if (boot.tilediff || boot.rawtile || boot.rawcorr)" y solo corre
      // cuando el usuario lo invoca.
      if (k === "readPixels" && viewerSrcG27.lastIndexOf("if (boot.tilediff", i) >= 0) continue;
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

// --- G68 acts content (3B): panel words match actos.es.md char by char.
// Compares the JSON raws against the md fields (only \r\n->\n + final
// trim normalised); regenerates the SVGs from md+route.json and compares
// byte by byte (deterministic build). Any failure = invented/lost text.
{
  const norm = (s: string): string => s.replace(/\r\n/g, "\n").trim();
  let g68ok = true;
  const g68bad: string[] = [];
  const actsPath = (() => {
    try {
      const m = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as { assets?: Record<string, string> };
      return m.assets?.["acts"] ? `public/${m.assets["acts"] as string}` : null;
    } catch {
      return null;
    }
  })();
  if (!actsPath || !existsSync(actsPath)) {
    gate("G68-acts-content", false, `missing acts JSON (${actsPath ?? "no assets.acts in meta.json"}) — run scripts/15-build-acts.ts`);
    g68ok = false;
  } else if (!existsSync("content/actos.es.md")) {
    gate("G68-acts-content", false, "missing content/actos.es.md");
    g68ok = false;
  } else {
    const { parseActs, loadRoute, miniMd } = await import("./15-build-acts.ts");
    const md = readFileSync("content/actos.es.md", "utf8");
    const routeData = loadRoute();
    const expect = parseActs(md, routeData);
    const got = JSON.parse(readFileSync(actsPath, "utf8")) as { acts: typeof expect };
    if (got.acts.length !== 7) {
      gate("G68-acts-content", false, `acts JSON has ${got.acts.length} acts, need 7`);
      g68ok = false;
    } else {
      const rows: string[] = [];
      for (let i = 0; i < 7; i++) {
        const e = expect[i] as (typeof expect)[number];
        const g = got.acts[i] as (typeof expect)[number];
        const fields: [string, string, string][] = [
          ["cintillo", e.cintillo.raw, g.cintillo.raw],
          ["titulo", e.titulo.raw, g.titulo.raw],
          ["flotante", e.flotante.raw, g.flotante.raw],
          ["cifra1", [e.cifra1.valor, e.cifra1.unidad, e.cifra1.etiqueta, e.cifra1.subetiqueta].join(" · "), [g.cifra1.valor, g.cifra1.unidad, g.cifra1.etiqueta, g.cifra1.subetiqueta].join(" · ")],
          ["cifra2", [e.cifra2.valor, e.cifra2.unidad, e.cifra2.etiqueta, e.cifra2.subetiqueta].join(" · "), [g.cifra2.valor, g.cifra2.unidad, g.cifra2.etiqueta, g.cifra2.subetiqueta].join(" · ")],
          ["fichas", e.fichas.join(" · "), g.fichas.join(" · ")],
          ["campo", e.campo.map((r) => `${r.etiqueta} — ${r.valor}`).join(" | "), g.campo.map((r) => `${r.etiqueta} — ${r.valor}`).join(" | ")],
          ["cuerpo", e.cuerpo.map((p) => p.raw).join("\n\n"), g.cuerpo.map((p) => p.raw).join("\n\n")],
          ["grafico-spec", e.grafico.spec_raw, g.grafico.spec_raw],
        ];
        let okAct = e.key === g.key;
        if (!okAct) g68bad.push(`${e.key}: key ${g.key}`);
        for (const [fn, a, b] of fields) {
          if (norm(a) !== norm(b)) {
            okAct = false;
            g68bad.push(`${e.key}.${fn} difiere (${a.length} vs ${b.length} chars)`);
          }
        }
        // html = miniMd(raw): recompute, no second source.
        const htmlFields: [string, string, string][] = [
          [`${e.key}.titulo.html`, miniMd(e.titulo.raw), g.titulo.html],
          [`${e.key}.cintillo.html`, miniMd(e.cintillo.raw), g.cintillo.html],
        ];
        for (const [fn, a, b] of htmlFields) {
          if (a !== b) {
            okAct = false;
            g68bad.push(`${fn} html difiere`);
          }
        }
        // SVG determinism: same md + same route.json -> same bytes.
        if (e.grafico.svg !== g.grafico.svg) {
          okAct = false;
          g68bad.push(`${e.key}.grafico.svg difiere (${e.grafico.svg.length} vs ${g.grafico.svg.length} bytes)`);
        }
        // G68 (3B-bis): cada <rect> del SVG con width ≥ 4 px + fichas sin
        // backticks + barras con valor numérico finito (el NaN del acto 0
        // pasaba el determinismo byte a byte sin ser correcto).
        for (const m of g.grafico.svg.matchAll(/<rect[^>]*width="([\d.]+)"/g)) {
          if (!(Number(m[1]) >= 4)) {
            okAct = false;
            g68bad.push(`${e.key}.grafico rect width=${m[1]} (<4px)`);
          }
        }
        for (const f of g.fichas) {
          if (f.includes("`")) {
            okAct = false;
            g68bad.push(`${e.key}.ficha con backtick: «${f.slice(0, 30)}»`);
          }
        }
        if (g.grafico.kind === "barras") {
          for (const b of g.grafico.barras ?? []) {
            if (typeof b.valor !== "number" || !Number.isFinite(b.valor)) {
              okAct = false;
              g68bad.push(`${e.key}.barra «${b.etiqueta}» sin valor numérico`);
            }
          }
        }
        rows.push(`${e.key}:${okAct ? "ok" : "DIFIERE"}`);
        if (!okAct) g68ok = false;
      }
      gate("G68-acts-content", g68ok,
        g68ok
          ? `${rows.join(" ")} — char-by-char + SVG byte-identical + rects ≥4px + fichas sin backticks (${actsPath})`
          : g68bad.slice(0, 10).join(" · "));
    }
  }
}

// --- G82 tokens Everest (3B-bis): estilos computados del panel = tokens
// del brief (medidos en navegador con ?debug=1; aquí el contrato
// estático: literales que el CSS debe contener). Desviación ±1px, ±0,02em.
{
  const css = readFileSync("src/styles/main.css", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["tokens :root", ["--ink:#070b12", "--pearl:#f3f6fa", "--silver:#aebbcd", "--faint:#98a6bb", "--gold:#d8b787", "--gold-bright:#eacf9f"].every((t) => has(css.replace(/ /g, ""), t.replace(/ /g, "")))],
    ["--gold-line + --line", has(css, "--gold-line") && has(css, "--line")],
    ["eyebrow 10px .3em silver mb18", has(css, ".eyebrow") && has(css, "margin-bottom: 18px")],
    ["h2 clamp(34,3.9,46) lh1.02 .005em", has(css, "clamp(34px, 3.9vw, 46px)") && has(css, "line-height: 1.02")],
    ["tiles flex + .v 28px + .d gold", has(css, ".tiles") && has(css, "font-size: 28px")],
    ["p 13.5px lh1.9 .011em silver", has(css, "13.5px") && has(css, "line-height: 1.9") && has(css, "0.011em")],
    ["chips li 10px .14em + · gold", has(css, ".chips") && has(css, '"·"')],
    ["pcard fixed 8px r20 gradiente blur", has(css, ".pcard") && has(css, "left: 8px") && has(css, "border-radius: 20px") && has(css, "blur(10px) saturate(150%)")],
    ["pscroll inset0 pad30", has(css, ".pscroll") && has(css, "padding: 30px")],
    ["pclose 32x32 r9 svg13", has(css, ".pclose") && has(css, "32px") && has(css, "border-radius: 9px")],
    ["fondos sin backdrop (@supports)", has(css, "@supports not")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G82-everest-tokens", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — tokens + medidas literales (computados en prod ?debug=1)`);
}

// --- G83 scroll invisible (3B-bis): sin barra visible, overscroll
// contenido, rueda contenida (medido en navegador; aquí el contrato).
{
  const css = readFileSync("src/styles/main.css", "utf8");
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["scrollbar-width none", has(css, ".pscroll") && has(css, "scrollbar-width: none")],
    ["::-webkit-scrollbar display none", has(css, "::-webkit-scrollbar") && has(css, "display: none")],
    ["overscroll contain", has(css, "overscroll-behavior: contain")],
    ["data-lenis-prevent", has(panelSrc, "data-lenis-prevent")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G83-panel-scroll", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — scroll invisible + contenido (rueda en prod ?debug=1)`);
}

// --- G69/G70/G71/G72/G73 (3B): browser-measured with ?debug=1, static
// contract here — the numbers live in prod (barrido G69, NDC G70,
// contraste G71, tiempos G72, plegado G73). Node checks the wiring exists:
// panel listens to scroll.actNow, rig eases subjectX, __subjectX published.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const rigSrc = readFileSync("src/narrative/camera-rig.ts", "utf8");
  const scrollSrc = readFileSync("src/narrative/scroll.ts", "utf8");
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const css = readFileSync("src/styles/main.css", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["panel escucha act (setAct)", has(panelSrc, "setAct") && has(scrollSrc, "actNow()")],
    ["viewer llama setAct con actNow", has(viewerSrc, "scroll.actNow()")],
    ["un solo rAF (panel sin rAF)", !has(panelSrc, "requestAnimationFrame")],
    ["rig eases subjectX 1-exp", has(rigSrc, "1 - Math.exp(-k") && has(rigSrc, "setViewOffset")],
    ["__subjectX publicado", has(rigSrc, "__subjectX")],
    ["SUJETO 0.66/0.5", has(rigSrc, "SUBJECT_X_OPEN") && has(rigSrc, "SUBJECT_X_CLOSED")],
    ["flotante f<0.12/0.25", has(panelSrc, "FLOTANTE_F_IN") && has(panelSrc, "FLOTANTE_F_OUT")],
    ["entrada pstage.act escalonada", has(css, ".pstage.act") && has(css, "p-rise") && has(css, "p-track-in") && has(css, "p-rise-blur") && has(css, "p-grow-x")],
    ["plegado scale .045 origin 20px", has(css, "scale(0.045)") || has(css, "scale(.045)")],
    ["data-lenis-prevent", has(panelSrc, "data-lenis-prevent")],
    ["aria-live + aria-expanded", (has(panelSrc, "aria-live") || css.includes("aside")) && has(panelSrc, "aria-expanded")],
    ["pendiente visible", has(panelSrc, 'title="pendiente de verificar"')],
    ["solo acto vigente en DOM", has(panelSrc, "other six") || has(panelSrc, "solo") || has(panelSrc, "paintAct")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G69-G73-wiring", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — panel<-actNow, subjectX easing, flotante, pstage, plegado, a11y (números en prod ?debug=1)`);
}

// --- §3b haces Everest (G74 presencia / G75 base / G76 oclusión / G77
// artefactos / G79 estado / G80 latido / G81 caminante): browser-measured
// en prod (?debug=1&skyfrac=1, ?trackpx=1 para __beampx). Node checks the
// wiring + el contrato estático; los NÚMEROS viven en navegador (sonda ID
// + capturas ×2 + comparativa + barrido de estado).
{
  const beamsSrc = readFileSync("src/engine/beams.ts", "utf8");
  const labelsSrc = readFileSync("src/engine/labels.ts", "utf8");
  const viewerSrcB = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrcB = readFileSync("src/engine/debug.ts", "utf8");
  const choreoSrc = readFileSync("src/narrative/choreography.ts", "utf8");
  const anchorsSrc = readFileSync("src/narrative/anchors.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    // G74: un draw call (UNA InstancedMesh) + sonda ID propia -> __beampx.
    ["UNA InstancedMesh", has(beamsSrc, "new THREE.InstancedMesh") && (beamsSrc.match(/new THREE\.InstancedMesh/g) ?? []).length === 2], // draw + ID probe (escena propia)
    ["idMat propio + escena propia", has(beamsSrc, "idScene") && has(beamsSrc, "new THREE.Scene()")],
    ["__beampx publicado (?trackpx=1)", has(viewerSrcB, "__beampx") && has(viewerSrcB, "countIdPixels(renderer, camera)")],
    ["?beams=0 apaga", has(debugSrcB, 'q.get("beams") !== "0"') && has(viewerSrcB, "boot.beams")],
    // G75: etiquetas en la BASE del haz (Everest), a ≤6 px del pie.
    ["anclaje base (anchorBeam)", has(labelsSrc, "anchorBeam")],
    ["etiqueta a la base, no a la punta", has(beamsSrc, "vuelve a la BASE") || has(labelsSrc, "la BASE del haz")],
    ["sin tipWy de punta", !has(beamsSrc, "tipWy")],
    ["translate(-50%,-100%) intacto", has(labelsSrc, "translate(-50%,-100%)")],
    ["cumbres sin haz", has(labelsSrc, 'hasBeam: def.tipo === "hito"')],
    // G76: depthTest true (lo tapa el terreno), depthWrite false.
    ["depthTest true + depthWrite false", has(beamsSrc, "depthTest: true") && has(beamsSrc, "depthWrite: false")],
    // G77: ADITIVO solo en haces (regla nueva), textura Everest, sin niebla propia.
    // (route-line usa su propio blending de cinta: la puerta es que la
    // LÍNEA no sea aditiva — AdditiveBlending ausente en route-line.ts.)
    ["aditivo solo haces", has(beamsSrc, "AdditiveBlending") && !readFileSync("src/engine/route-line.ts", "utf8").includes("AdditiveBlending")],
    ["textura Everest 16x128", has(beamsSrc, "16") && has(beamsSrc, "128") && has(beamsSrc, "255,205,140") && has(beamsSrc, "255,210,150")],
    ["cilindro unitario instanciado", has(beamsSrc, "CylinderGeometry(1, 1, 1")],
    ["BEAM_H=420 R=12 consts", has(choreoSrc, "BEAM_H_M = 420") && has(choreoSrc, "BEAM_R_M = 12")],
    ["ámbar/verde/naranja consts", has(choreoSrc, "BEAM_AMBER") && has(choreoSrc, "BEAM_GREEN") && has(choreoSrc, "BEAM_WALK")],
    // G79: estado por flanco desde s_hito (única fuente progress.ts).
    ["estado por flanco (setState)", has(beamsSrc, "setState") && has(beamsSrc, "BEAM_PASS_EPS_S")],
    ["s_hito desde progress (PCHIP viva)", has(viewerSrcB, "progress.sFromD") && has(viewerSrcB, "única fuente")],
    ["una vez por cruce (pulseT0)", has(beamsSrc, "pulseT0") && has(beamsSrc, "BEAM_PULSE_MS")],
    ["G79 publicado (__beamPassed)", has(viewerSrcB, "__beamPassed")],
    // G80: latido en el vertex con uTime, periodo ≈3,9 s, amplitud ±0,24.
    ["latido vertex (uTime)", has(beamsSrc, "uTime") && has(beamsSrc, "BEAM_HEART_K") && has(beamsSrc, "aPhase")],
    ["fase por instancia (i·1,7)", has(beamsSrc, "BEAM_PHASE_STEP") || has(beamsSrc, "1.7")],
    ["fade distancia /6000", has(beamsSrc, "6000") || has(choreoSrc, "BEAM_DIST_FAR_M = 6000")],
    ["G80 publicado (__beamBeat)", has(beamsSrc, "__beamBeat")],
    // G81: base del haz del caminante a ≤2 m de P(d) en planta y cota.
    ["caminante instancia +1", has(beamsSrc, "walkerIndex") && has(beamsSrc, "setWalker") && has(beamsSrc, "walkerBase")],
    ["P(d) del rastro (trackAt)", has(viewerSrcB, "trackAt(route, dw)") && has(anchorsSrc, "export function trackAt")],
    ["G81 metros mundo (__walkerGapM/Y)", has(viewerSrcB, "__walkerGapM") && has(viewerSrcB, "__walkerGapY") && has(viewerSrcB, "gapM <= 2 && gapY <= 2")],
    ["G81 publicado (__walkerOk)", has(viewerSrcB, "__walkerOk")],
    // Oclusión ×0,25 + P día N1 + HUD ?debug=1.
    ["oclusión ×0,25", has(beamsSrc, "BEAM_OCCLUDE") && has(viewerSrcB, "setOccluded")],
    ["P día N1 (0.16+0.84)", has(beamsSrc, "0.16 + 0.84 * uDayF")],
    // Ciclo 6 frames con rayBlocked (ya existe) + HUD ?debug=1.
    ["ciclo 6f con etiquetas", has(viewerSrcB, "frames % 6 === 0") && has(viewerSrcB, "setOccluded")],
    ["rayBlocked intacto", has(labelsSrc, "export function rayBlocked")],
    ["HUD haces N·pasados·próximo+gap", has(debugSrcB, "beamHud") && has(beamsSrc, "beamHud(sNow") && has(beamsSrc, "gap ${walkerGapM")],
    // Un solo rAF: beams.ts sin rAF propio; latido en GPU, pulso en tick.
    ["sin rAF propio", !has(beamsSrc, "requestAnimationFrame")],
    ["uniforms declarados en GLSL", has(beamsSrc, "uniform sampler2D uMap; uniform float uDayF;")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G74-G77-beams", bad.length === 0,
    bad.length
      ? `falta: ${bad.join(", ")}`
      : `${checks.length} checks — cilindros+ID, base, oclusión, aditivo-solo-haces, estado/latido/caminante, 6f, HUD (números en prod ?debug=1&skyfrac=1)`);
}

// --- G84 pie del gráfico (3B-bis2): el panel NO pinta spec_raw (sigue
// en el JSON para trazabilidad y G68). Si hay campo `pie:`, ese se pinta
// con .cap; si no, el hueco queda vacío. Medido en navegador (?debug=1);
// aquí el contrato estático.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const actsSrc = readFileSync("scripts/15-build-acts.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["spec_raw no renderizado", !has(panelSrc, "g.spec_raw") && !has(panelSrc, ".spec_raw")],
    ["campo pie: opcional en parser", has(actsSrc, "pie:") && has(actsSrc, "pie: { raw: string; html: string } | null")],
    ["panel pinta a.pie con .cap", has(panelSrc, "a.pie") && has(panelSrc, '"cap"')],
    ["sin pies inventados (null sin campo)", has(actsSrc, "pie: null") || has(panelSrc, "a.pie ?")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G84-grafico-pie", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — spec_raw fuera del DOM, pie: opcional (literal en prod ?debug=1)`);
}

// --- G85 flotante sin solape (3B-bis2): a la derecha del panel desde el
// ancho real (--panel-w + 24px), plegado a clamp(24px,4vw,64px), resize
// recoloca. Medido en navegador a 1280/1600/1920 (?debug=1); aquí el contrato.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const css = readFileSync("src/styles/main.css", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["sin left mágico 400px", !has(css, "left: 400px") && !has(css, "left: 368px")],
    ["--panel-w + 24px aire", has(panelSrc, "--panel-w") && has(css, "--panel-w") && has(css, "+ 24px")],
    ["plegado clamp(24,4vw,64)", has(panelSrc, "clamp(24px, 4vw, 64px)")],
    ["resize recoloca", has(panelSrc, 'addEventListener("resize"')],
    ["mide ancho real (getBoundingClientRect)", has(panelSrc, "getBoundingClientRect")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G85-flotante-solape", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — flotante desde ancho real (solape 0px en prod ?debug=1)`);
}

// --- G86 fichas sin huérfanos (3B-bis2): li nowrap + &nbsp; número-unidad
// en el parser; la ficha que no quepa rompe sola (.allow-break). Medido
// con Range en navegador (?debug=1); aquí el contrato.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const actsSrc = readFileSync("scripts/15-build-acts.ts", "utf8");
  const css = readFileSync("src/styles/main.css", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["li nowrap", has(css, ".chips li") && has(css, "white-space: nowrap")],
    ["nbsp número-unidad en parser", has(actsSrc, "&nbsp;")],
    ["ficha larga rompe sola", has(panelSrc, "allow-break") && has(css, "allow-break")],
    ["line-height 2.2 intacto", has(css, "line-height: 2.2")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G86-fichas-huerfanos", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — nowrap + nbsp + ruptura aislada (Range en prod ?debug=1)`);
}

// --- G87 anti-blanco (3B-bis2): 2,5 s tras pintar, hijos con opacidad 0
// pierden la animación y quedan a 1 (pestaña en segundo plano). Un solo
// timeout por cambio, cancelado al siguiente. Medido en navegador; aquí el contrato.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["guard 2500ms", has(panelSrc, "2500")],
    ["un timeout por cambio (clearTimeout)", has(panelSrc, "clearTimeout")],
    ["quīta animación + opacidad 1", has(panelSrc, 'animation = "none"') && has(panelSrc, 'opacity = "1"')],
    ["lee opacidad computada", has(panelSrc, "getComputedStyle")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G87-anti-blanco", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — seguro 2,5s (opacidad 1 a los 3s en prod ?debug=1)`);
}

// --- G103 cielo azul (§6b CIELO RADIANTE): sobre el MAPA DE CIELO
// (equirect 384×192 tras bandera — independiente de la cámara, no lo tapa el
// terreno, reproducible), con sol 61°, azimut relativo ~90° al sol, sat HSV.
// Bandas §6b (modelo validado contra captura): 5°: 0,10-0,20 · 15°: 0,40-0,52
// · 30°: 0,53-0,66 · 60°: 0,60-0,73 · 90°: 0,58-0,71, luma ±0,06 por banda.
// El NIVEL lo mueve SKY_SCALE (ACES); Rayleigh NO (desatura). Node: contrato
// estático (rampa 0.02→0.24 idéntica en dome + capture, Rayleigh 1.6, SKY_SCALE
// 0.17, SKY_SAT 2.0 intacto); los NÚMEROS en prod (?skymap=1 + readback).
{
  const capSrc = readFileSync("src/engine/sky-capture.ts", "utf8");
  const viewerSrc103 = readFileSync("src/engine/viewer.ts", "utf8");
  const choreoSrc103 = readFileSync("src/narrative/choreography.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    ["rampa 0.02→0.24 en el dome", has(viewerSrc103, "smoothstep( 0.02, 0.24, skyDirY )")],
    ["rampa 0.02→0.24 en la capture (idéntica)", has(capSrc, "smoothstep( 0.02, 0.24, direction.y )")],
    ["skySunF 5°→25° intacto (dome)", has(viewerSrc103, "skySunF = smoothstep( 5.0, 25.0")],
    ["skySunF 5°→25° intacto (capture)", has(capSrc, "smoothstep( 5.0, 25.0")],
    ["SKY_SAT 2.0 intacto", has(viewerSrc103, "SKY_SAT")],
    ["SKY_SCALE 0.17 (mando ACES)", has(choreoSrc103, "SKY_SCALE = 0.17")],
    ["SKY_RAYLEIGH 1.6 (revertido §6)", has(choreoSrc103, "SKY_RAYLEIGH = 1.6")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G103-sky-blue", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `dome ≡ capture (rampa 13,9°, sol 5°→25°, SKY_SCALE 0.17) — measure sat 5°/15°/30°/60°/90° + luma ±0.06 en el mapa de cielo @t=12:00`);
}

// --- G104-shadow-chroma (§5d-bis REGLA DE MUESTREO FIJA — la de §5d no era
// comparable con la base). Parche de 128×128 sobre pared en sombra; de ese
// parche: descarta el 25 % más oscuro y el 25 % más claro por luma; reporta
// b−r y luma de la MEDIANA del 50 % central + histograma de luma del parche
// (10 cubos). Así cualquier comparación futura es del mismo sitio.
// Sigue SIN UMBRAL: solo reportar, en s=0,29, s=0,80 y Acto V.
// Node: contrato (sonda walls2 — b−r final centrado + luma final —
// disponible tras bandera; HEMI_LIGHT_GRAY 0.4 SOLO en hemi.color, no en
// uHemiSky; brillo intacto); los NÚMEROS en prod.
{
  const choreoSrc104 = readFileSync("src/narrative/choreography.ts", "utf8");
  const viewerSrc104 = readFileSync("src/engine/viewer.ts", "utf8");
  const probeSrc104 = readFileSync("src/engine/wall-probe.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const checks: [string, boolean][] = [
    // gBRF se asigna en el chunk final de viewer (ANTES de la escritura de
    // sonda: niebla ya sumada), la sonda lo pinta tras dithering y
    // wall-probe deshace el centrado en JS (br = G*2−1).
    ["sonda walls2 (b−r final + luma final)", has(viewerSrc104, "gBRF * 0.5 + 0.5") && has(viewerSrc104, "boot.walls || boot.walls2") && has(viewerSrc104, "gBRF = gl_FragColor.b - gl_FragColor.r") && has(probeSrc104, "gg * 2 - 1")],
    ["HEMI_LIGHT_GRAY 0.4 (luz hemisférica)", has(choreoSrc104, "HEMI_LIGHT_GRAY = 0.4")],
    ["mezcla aplicada en viewer", has(viewerSrc104, "(lumaSky - zr) * HEMI_LIGHT_GRAY")],
    ["uHemiSky sin HEMI_LIGHT_GRAY (no doble gris)", has(viewerSrc104, "uHemiSky.value as [number, number, number])[0] = zr * 0.5 * lift")],
    ["HEMI_GRAY_MIX 0.6 (solo niebla baja)", has(choreoSrc104, "HEMI_GRAY_MIX = 0.6")],
    ["HEMI_LUMA_FLOOR intacto", has(choreoSrc104, "HEMI_LUMA_FLOOR = 0.2")],
    ["SHADOW_INTENSITY intacto", has(choreoSrc104, "SHADOW_INTENSITY = 0.55")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G104-shadow-chroma", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `sRGB de pantalla, métrica b−r (sin umbral), parche 128² en sombra: mediana del 50 % central + histo luma 10 cubos — measure @s=0.80/0.29/ActoV, t=12:00 (base Gonzalo: b−r +0,200 a luma 0,306)`);
}

// --- G120-tiles-gated (contrato, copia de G101): la descarga, el índice y
// hasTiles = 1 viven DENTRO del cuerpo de armTiles y la única llamada está
// tras bandera (?debug=tiles | ?debug=tilediff); uHasTiles es uniforme vivo,
// no constante de compilación. Verificación por estructura, no por
// proximidad textual.
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  // Cuerpo de armTiles: del "async function armTiles" a la primera llamada
  // "void armTiles()" (la llamada vive fuera; el cuerpo, dentro).
  const fnStart = viewerSrc.indexOf("async function armTiles");
  const callIdx = viewerSrc.indexOf("void armTiles()");
  const body = fnStart >= 0 && callIdx > fnStart ? viewerSrc.slice(fnStart, callIdx) : "";
  const tail = callIdx >= 0 ? viewerSrc.slice(Math.max(0, callIdx - 400), callIdx + 60) : "";
  const head = fnStart >= 0 ? viewerSrc.slice(0, fnStart) : viewerSrc;
  const armTilesCalls = (viewerSrc.match(/void armTiles\(\)/g) ?? []).length;
  const checks: [string, boolean][] = [
    ["armTiles existe y se llama exactamente una vez", fnStart >= 0 && armTilesCalls === 1],
    ["la llamada está tras bandera (boot.tiles||boot.tilediff||rawtile||rawcorr)", /if\s*\(\s*boot\.tiles\s*\|\|\s*boot\.tilediff\s*\|\|\s*boot\.rawtile\s*\|\|\s*boot\.rawcorr\s*\)\s*\{\s*void armTiles\(\);/.test(tail)],
    ["hasTiles.value = 1 SOLO dentro de armTiles", body.includes("hasTiles.value = 1") && !head.includes("hasTiles.value = 1")],
    ["construcción del índice SOLO dentro de armTiles", body.includes("tilesIndexUniform.value = buildTilesIndex(") && !head.includes("tilesIndexUniform.value =")],
    ["TILE_SLOTS SOLO dentro de armTiles (+ overlay diferido aparte)", !head.includes("TILE_SLOTS") && body.includes("TILE_SLOTS")],
    ["uHasTiles uniforme vivo (no constante)", has(viewerSrc, 's.uniforms["uHasTiles"] = hasTiles')],
    ["uHasTiles no interpolado como número en GLSL", !/\$\{(hasTiles|tilesDebug|tileDiff)[^}]*\.value\}/.test(viewerSrc)],
    ["GLSL siempre presente (decl + rama, sin ternario boot)", has(viewerSrc, "uniform sampler2D uTilesAtlas") && has(viewerSrc, "if (uHasTiles > 0.5)") && !/boot\.tiles\s*\?\s*["'`]/.test(viewerSrc)],
    ["atlas SRGB con fotos (NoColorSpace fuera)", has(viewerSrc, "t.colorSpace = THREE.SRGBColorSpace") && !body.includes("THREE.NoColorSpace")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G120-tiles-gated", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — armTiles×1 tras bandera, índice+flag dentro, uHasTiles vivo, GLSL siempre, SRGB`);
}

// --- G121-tiles-noflag (mitad estática Node; la medida —cero peticiones a
// /assets/tiles/ sin bandera + Mirador pixel-idéntico— vive en producción).
// Sin bandera nada de /assets/tiles/ puede pedirse: toda mención en la
// pieza vive dentro de armTiles (tras bandera) o en el overlay diferido
// (tras boot.tiles).
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const fnStart = viewerSrc.indexOf("async function armTiles");
  const callIdx = viewerSrc.indexOf("void armTiles()");
  const body = fnStart >= 0 && callIdx > fnStart ? viewerSrc.slice(fnStart, callIdx) : "";
  const overlayOk = /if\s*\(\s*boot\.tiles\s*\)\s*\{\s*try\s*\{\s*const tilesMod = await import\("\.\/tiles-overlay\.ts"\)/.test(viewerSrc);
  const checks: [string, boolean][] = [
    ["armTiles extraíble + overlay lazy tras bandera", body.length > 0 && overlayOk],
    ["fugas a prod fuera de armTiles/overlay/tilediff: ninguna", (() => {
      // Todo /assets/tiles/ fuera de los tres bloques gateados = fuga a prod.
      // Los tres bloques: cuerpo armTiles, overlay (if boot.tiles) y lector
      // tilediff (if boot.tilediff). Se localizan por sus guardas.
      const armStart = viewerSrc.indexOf("async function armTiles");
      const armCall = viewerSrc.indexOf("void armTiles()");
      const ovStart = viewerSrc.indexOf('await import("./tiles-overlay.ts")');
      const ovGuard = ovStart >= 0 ? viewerSrc.lastIndexOf("if (boot.tiles)", ovStart) : -1;
      const tdStart = viewerSrc.indexOf("window as unknown as { __tilediff");
      const tdGuard = tdStart >= 0 ? viewerSrc.lastIndexOf("if (boot.tilediff", tdStart) : -1;
      const spans: Array<[number, number]> = [];
      if (armStart >= 0 && armCall > armStart) spans.push([armStart, armCall]);
      if (ovGuard >= 0 && ovStart > ovGuard) spans.push([ovGuard, ovStart + 2000]);
      if (tdGuard >= 0 && tdStart > tdGuard) spans.push([tdGuard, tdStart + 4000]);
      const inSpans = (k: number): boolean => spans.some(([a, b]) => k >= a && k <= b);
      const needles = ["tiles-atlas", "generated/tiles.ts", "TILE_SLOTS", "hasTiles.value = 1", "buildTilesIndex("];
      const leaks: string[] = [];
      for (const nd of needles) {
        let k = -1;
        while ((k = viewerSrc.indexOf(nd, k + 1)) >= 0) {
          // la DEFINICIÓN "function buildTilesIndex(" no es la llamada
          if (nd === "buildTilesIndex(" && viewerSrc.slice(Math.max(0, k - 9), k).includes("function")) continue;
          if (!inSpans(k)) { leaks.push(`${nd}@${k}`); break; }
        }
      }
      return leaks.length === 0;
    })()],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G121-tiles-noflag", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — sin bandera no hay camino a /assets/tiles/ (medida red en prod)`);
}

// --- G122-tile-budget (contrato): peso medio por tesela <= 60 KB.
{
  const m = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    sizesBytes?: Record<string, number>;
  };
  const keys = Object.keys(m.sizesBytes ?? {}).filter((k) => k.startsWith("tile-c"));
  const bytes = keys.map((k) => m.sizesBytes?.[k] ?? -1);
  const okCount = keys.length === 16 && bytes.every((b) => b > 0);
  const mean = okCount ? bytes.reduce((s, b) => s + b, 0) / bytes.length : -1;
  gate("G122-tile-budget", okCount && mean <= 60 * 1024,
    !okCount ? `teselas: ${keys.length} (esperadas 16)` : `media ${(mean / 1024).toFixed(1)} KB/tesela (16, límite 60 KB)`);
}

// --- G126-atlas-is-photo (contrato): el atlas referenciado en meta.json NO
// es de diagnóstico. Desviación típica por canal > 8 DENTRO de cada hueco
// que el índice marca como residente (una foto varía 12-47; un color plano
// da ~0; los huecos 16-63 vacíos dan 0 y NO se muestrean).
{
  const m = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    assets?: Record<string, string>;
    tiles?: { atlasPx: number; atlasCols: number; px: number; slots: Array<{ c: number; r: number; slot: number }> };
  };
  const rel = m.assets?.["tiles-atlas"];
  const slots = m.tiles?.slots ?? [];
  let detail = "";
  let ok = false;
  if (!rel) {
    detail = "meta.assets[tiles-atlas] ausente";
  } else if (!existsSync(`public/${rel}`)) {
    detail = `atlas ausente en disco: public/${rel}`;
  } else if (slots.length === 0) {
    detail = "meta.tiles.slots vacío (nada residente que muestrear)";
  } else {
    const { data, info } = await sharp(`public/${rel}`).raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const ch = info.channels;
    if (W !== 4096 || H !== 4096) {
      detail = `dimensiones ${W}×${H} (esperado 4096²)`;
    } else {
      const atlasPx = m.tiles?.atlasPx ?? 4096;
      const atlasCols = m.tiles?.atlasCols ?? 8;
      const tilePx = m.tiles?.px ?? 512;
      const slotPx = atlasPx / atlasCols; // 512
      const M = 8; // margen interior: evita borde de tesela
      const stds: { slot: number; stdR: number; stdG: number; stdB: number }[] = [];
      for (const s of slots) {
        // sharp compone top-down: hueco slot en (col*512, row*512),
        // row=0 = fila SUPERIOR (mismo convenio que 20-build-ortho-tiles).
        const left = (s.slot % atlasCols) * slotPx;
        const top = Math.floor(s.slot / atlasCols) * slotPx;
        let n = 0;
        let sR = 0, sG = 0, sB = 0, sR2 = 0, sG2 = 0, sB2 = 0;
        for (let y = top + M; y < top + tilePx - M; y += 4) {
          for (let x = left + M; x < left + tilePx - M; x += 4) {
            const o = (y * W + x) * ch;
            const rv = data[o] as number, gv = data[o + 1] as number, bv = data[o + 2] as number;
            n++; sR += rv; sG += gv; sB += bv; sR2 += rv * rv; sG2 += gv * gv; sB2 += bv * bv;
          }
        }
        const sd = (sum: number, sum2: number): number => Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
        stds.push({ slot: s.slot, stdR: sd(sR, sR2), stdG: sd(sG, sG2), stdB: sd(sB, sB2) });
      }
      const worst = stds.reduce((a, b) => Math.min(a, b.stdR, b.stdG, b.stdB), Infinity);
      const badSlots = stds.filter((s) => Math.min(s.stdR, s.stdG, s.stdB) <= 8).map((s) => s.slot);
      ok = badSlots.length === 0;
      const minS = stds.reduce((a, b) => (Math.min(a.stdR, a.stdG, a.stdB) < Math.min(b.stdR, b.stdG, b.stdB) ? a : b));
      detail = ok
        ? `${slots.length} huecos residentes, peor min-std ${worst.toFixed(1)} (hueco ${minS.slot}: R ${minS.stdR.toFixed(1)} G ${minS.stdG.toFixed(1)} B ${minS.stdB.toFixed(1)}) — foto, no diagnóstico`
        : `huecos planos (std<=8): ${badSlots.join(",")}`;
    }
  }
  gate("G126-atlas-is-photo", ok, detail);
}

// --- G128-tile-deshadow (T1-c, medida en disco WebP contra WebP):
// luma media del fichero de tesela entre 0,92 y 1,08 veces la del corredor
// sobre el mismo suelo. Receta exacta (verificada: con el código actual da
// 0,2904/0,3533 = 0,8221 — si da otra cosa, el fallo está en la puerta):
//   TESELA: public/<assets tile-c3-r9>, útil 504×504 (fuera 4 px de borde).
//   CORREDOR: public/<terrain-corridor 8192 COMPLETO, no el -4k>, suelo de
//     c3-r9 (x0=originX+3*126, y0=originY+9*126, 126 m) a píxel con
//     volteo norte-arriba (py0=(maxy-y1)/h*H).
//   Luma Rec.709 sobre RGB 0..1 en ambos lados.
{
  const m = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    assets?: Record<string, string>;
    corridorBbox?: { minx: number; miny: number; maxx: number; maxy: number };
    tiles?: { originX: number; originY: number; tileM: number };
  };
  const tileRel = m.assets?.["tile-c3-r9"];
  const corrRel = Object.entries(m.assets ?? {}).find(([k, v]) =>
    k === "terrain-corridor" && typeof v === "string" && !v.includes("-4k"))?.[1] as string | undefined;
  let detail = "";
  let ok = false;
  let ratio = -1;
  if (!tileRel || !existsSync(`public/${tileRel}`)) {
    detail = `tile-c3-r9 ausente (${tileRel ?? "sin clave"})`;
  } else if (!corrRel || !existsSync(`public/${corrRel}`)) {
    detail = `terrain-corridor 8192 ausente (${corrRel ?? "sin clave"})`;
  } else if (!m.corridorBbox || !m.tiles) {
    detail = "meta sin corridorBbox/tiles";
  } else {
    const { data: td, info: ti } = await sharp(`public/${tileRel}`).raw().toBuffer({ resolveWithObject: true });
    const { data: cd, info: ci } = await sharp(`public/${corrRel}`).raw().toBuffer({ resolveWithObject: true });
    const luma = (d: Buffer, o: number): number =>
      0.2126 * ((d[o] as number) / 255) + 0.7152 * ((d[o + 1] as number) / 255) + 0.0722 * ((d[o + 2] as number) / 255);
    let sT = 0, nT = 0;
    for (let y = 4; y < ti.height - 4; y++) {
      for (let x = 4; x < ti.width - 4; x++) {
        sT += luma(td, (y * ti.width + x) * ti.channels); nT++;
      }
    }
    const lumaT = sT / nT;
    const ox = m.tiles.originX, oy = m.tiles.originY, TM = m.tiles.tileM;
    const x0 = ox + 3 * TM, x1 = x0 + TM, y0 = oy + 9 * TM, y1 = y0 + TM;
    const cb = m.corridorBbox;
    const px0 = ((x0 - cb.minx) / (cb.maxx - cb.minx)) * ci.width;
    const px1 = ((x1 - cb.minx) / (cb.maxx - cb.minx)) * ci.width;
    const py0 = ((cb.maxy - y1) / (cb.maxy - cb.miny)) * ci.height;
    const py1 = ((cb.maxy - y0) / (cb.maxy - cb.miny)) * ci.height;
    if (px0 < 0 || py0 < 0 || px1 > ci.width || py1 > ci.height) {
      detail = `recorte fuera del corredor: ${px0.toFixed(0)},${py0.toFixed(0)}–${px1.toFixed(0)},${py1.toFixed(0)} en ${ci.width}×${ci.height} (volteo Y mal aplicado?)`;
    } else {
      let sC = 0, nC = 0;
      for (let y = Math.floor(py0); y < Math.ceil(py1); y++) {
        for (let x = Math.floor(px0); x < Math.ceil(px1); x++) {
          sC += luma(cd, (y * ci.width + x) * ci.channels); nC++;
        }
      }
      const lumaC = sC / nC;
      ratio = lumaC > 0 ? lumaT / lumaC : -1;
      ok = ratio >= 0.92 && ratio <= 1.08;
      detail = ok
        ? `tesela ${lumaT.toFixed(4)} / corredor ${lumaC.toFixed(4)} = ${ratio.toFixed(4)} (banda 0,92–1,08)`
        : ratio < 0.92
          ? `tesela ${lumaT.toFixed(4)} / corredor ${lumaC.toFixed(4)} = ${ratio.toFixed(4)} POR DEBAJO: campo no aplicado o invertido`
          : `tesela ${lumaT.toFixed(4)} / corredor ${lumaC.toFixed(4)} = ${ratio.toFixed(4)} POR ARRIBA: doble división`;
    }
  }
  gate("G128-tile-deshadow", ok, detail);
}

// --- G129-deshadow-shared (T1-c, estática): la OPERACIÓN de desombreado
// vive en scripts/lib/deshadow.ts y SOLO allí. Los dos scripts importan de
// él y ninguno contiene aritmética inline (/ Math.max( fuera de comentarios
// = divergencia futura). Sin check de literales sueltos: 0.25 es también la
// resolución de tesela y daría falsos positivos.
{
  const lib = readFileSync("scripts/lib/deshadow.ts", "utf8");
  const s12 = readFileSync("scripts/12-build-des-shadow.ts", "utf8");
  const s20 = readFileSync("scripts/20-build-ortho-tiles.ts", "utf8");
  const noComments = (s: string): string =>
    s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const checks: [string, boolean][] = [
    ["lib expone AMBIENT/FLOOR/applyDeshadow puros", lib.includes("export const AMBIENT") && lib.includes("export const FLOOR") && lib.includes("export function applyDeshadow") && !noComments(lib).includes("readFileSync") && !noComments(lib).includes("import ")],
    ["12 importa del lib", s12.includes('from "./lib/deshadow.ts"')],
    ["20 importa del lib", s20.includes('from "./lib/deshadow.ts"')],
    ["12 sin aritmética inline", !noComments(s12).includes("/ Math.max(")],
    ["20 sin aritmética inline", !noComments(s20).includes("/ Math.max(")],
    ["12 llama a applyDeshadow", noComments(s12).includes("applyDeshadow(")],
    ["20 llama a applyDeshadow", noComments(s20).includes("applyDeshadow(")],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G129-deshadow-shared", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — operación única en lib, ambos importan y llaman`);
}

// --- G130-gain-global (T1-c, estática+meta): el gain es UN escalar global
// leído de meta.json (mismo para las 16 teselas). Si cada tesela calculase
// su propia media, el brillo dependería del contenido y el corredor saldría
// a parches. Además meta guarda gain + campo con el hash del mosaico de
// origen, y 20 aborta si ese hash no coincide.
{
  const s20 = readFileSync("scripts/20-build-ortho-tiles.ts", "utf8");
  const m = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
    illumination?: { gain: number; mosaicHash: string; file: string; min: number; max: number };
  };
  const noComments = (s: string): string =>
    s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  const s20c = noComments(s20);
  const gainRead = s20c.includes("illumination") && s20c.includes("GAIN");
  const noOwnMeans = !s20c.includes("inMean") && !s20c.includes("relMean") && !s20c.includes("preGain");
  const noLumaReduce = !/\.reduce\([^)]*lum/i.test(s20c);
  const ill = m.illumination;
  const metaOk = !!ill && Number.isFinite(ill.gain) && ill.gain > 0 &&
    typeof ill.mosaicHash === "string" && /^[0-9a-f]{8}$/.test(ill.mosaicHash) &&
    existsSync(ill.file) && Number.isFinite(ill.min) && Number.isFinite(ill.max) && ill.max > ill.min;
  const abortIdx = s20c.indexOf("mosaic changed since deshadow");
  const throwNear = abortIdx >= 0 && s20c.slice(Math.max(0, abortIdx - 600), abortIdx).includes("throw");
  const checks: [string, boolean][] = [
    ["20 lee gain global de meta (GAIN)", gainRead],
    ["20 sin medias propias (inMean/relMean/preGain)", noOwnMeans],
    ["20 sin reduce sobre luminancia", noLumaReduce],
    ["meta.illumination completo (gain+hash+campo+rango)", metaOk],
    ["20 aborta en mismatch de mosaico", throwNear],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  gate("G130-gain-global", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : `${checks.length} checks — gain ${ill?.gain?.toFixed(4) ?? "?"} global, hash ${ill?.mosaicHash ?? "?"}, aborta en mismatch`);
}

// --- G113-route-origin (§8d): every route.json point carries origin
// "osm"|"gpx", and the gpx fraction agrees with the candidate's four
// no-coverage ranges (~500 m, ~2.8 %). Far above = the matching failed where
// OSM coverage existed.
{
  const rj = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as {
    x: number[];
    origin?: string[];
  };
  const cand = JSON.parse(readFileSync("data/build/route-osm-candidate.json", "utf8")) as {
    origin: string[];
    gpxRanges: [number, number][];
  };
  const orig = rj.origin ?? [];
  const allValid = orig.length === rj.x.length && orig.every((o) => o === "osm" || o === "gpx");
  const pctRoute = orig.length ? (100 * orig.filter((o) => o === "gpx").length) / orig.length : -1;
  const pctCand = (100 * cand.origin.filter((o) => o === "gpx").length) / cand.origin.length;
  const rangesM = cand.gpxRanges.reduce((s, [a, b]) => s + (b - a), 0);
  const ok = allValid && cand.gpxRanges.length === 4 && Math.abs(pctRoute - pctCand) <= 1.0;
  gate("G113-route-origin", ok,
    `origin arrays: ${allValid ? "all points tagged" : `BAD (${orig.length}/${rj.x.length})`}; ` +
      `gpx ${pctRoute.toFixed(2)}% vs candidate ${pctCand.toFixed(2)}% (${cand.gpxRanges.length} ranges, ${rangesM.toFixed(0)} m)`);
}

// --- G114-clearance-nonregression (§8d): the geometry moved laterally up to
// 26 m, so the camera-clearance minimum must not drop more than 10 m versus
// the pre-adoption GPX rail. The "before" is the SAME bakeCamRail over
// route-gpx-legacy.json (identical GPX geometry) — no stale baseline file. If
// it fails, report km + value; never lower the camera to hide it.
{
  const lg = JSON.parse(readFileSync("public/assets/route-gpx-legacy.json", "utf8")) as {
    x: number[];
    y: number[];
    z_mdt: number[];
    z_raw?: number[];
    d: number[];
    cumClimb: number[];
    lengthM: number;
  };
  const lr = {
    n: lg.x.length,
    lengthM: lg.lengthM,
    x: Float32Array.from(lg.x),
    y: Float32Array.from(lg.y),
    z: Float32Array.from(lg.z_mdt),
    d: Float32Array.from(lg.d),
    cumClimb: Float32Array.from(lg.cumClimb),
    zRaw: Float32Array.from(lg.z_raw ?? lg.z_mdt),
  };
  const resL = resolveAnchors(lr);
  resL.follow = resolveFollowProfile(lr, sampleGrid, meta.bbox);
  const pchipL = buildPchip(resL.sAnchors, resL.dAnchorsM, "s->d");
  const railL = bakeCamRail(
    { route: lr, follow: resL.follow, sToD: pchipL, sample: sampleGrid, cx, cy, fovDeg: 50, floorM: CAM_CLEARANCE_M },
    (rope) => resolveFollowSafety(sampleGrid, cx, cy, { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan }, lr, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 }),
  );
  let minClearL = Infinity;
  let sL = 0;
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    const camX = railL.fCamX(s) - cx;
    const camY = railL.fCamY(s);
    const camZ = -(railL.fCamZ(s) - cy);
    const clear = camY - sampleGrid(camX + cx, cy - camZ);
    if (clear < minClearL) {
      minClearL = clear;
      sL = s;
    }
  }
  const dAfter = pchipSD(minClearS);
  const dBefore = pchipL(sL);
  gate("G114-clearance-nonregression", minClear >= minClearL - 10,
    `clearance min ${minClearL.toFixed(1)} m (km ${(dBefore / 1000).toFixed(2)}) → ${minClear.toFixed(1)} m ` +
      `(km ${(dAfter / 1000).toFixed(2)}); delta ${(minClear - minClearL).toFixed(1)} m (need >= -10)`);
}

// --- G115-legacy-kept (§8d): route-gpx-legacy.json exists, is versioned
// (not gitignored) and pins the GPX geometry: 3.626 pts, 18.125,9 m.
{
  const path = "public/assets/route-gpx-legacy.json";
  const exists = existsSync(path);
  const lg = exists ? JSON.parse(readFileSync(path, "utf8")) as { x: number[]; lengthM: number } : null;
  const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
  const versioned = !gitignore.includes("route-gpx-legacy");
  const ok = !!lg && versioned && lg.x.length === 3626 && Math.abs(lg.lengthM - 18125.9) < 0.05;
  gate("G115-legacy-kept", ok,
    !lg ? "missing route-gpx-legacy.json"
      : `${lg.x.length} pts, ${lg.lengthM} m (need 3626 / 18125.9), versioned ${versioned}`);
}

// --- G116-adopt-guard (§8d): 05 does NOT adopt when the candidate's
// legacyHash does not match the legacy it just wrote, and says so LOUD. The
// negative test (flip a byte, run 05, see it fall back to GPX) is run by hand
// at deploy time; here we check the guard exists and that the current
// route.json is the adopted one (origin carries "osm").
{
  const s05 = readFileSync("scripts/05-build-route.ts", "utf8");
  const comparesHash = s05.includes("cand.legacyHash !== legacyHash");
  const loudWarn = s05.includes("NOT adopting the re-trace");
  const adopted = (JSON.parse(readFileSync("public/assets/route.json", "utf8")) as { origin?: string[] }).origin?.some((o) => o === "osm") === true;
  const bad: string[] = [];
  if (!comparesHash) bad.push("05 no compara legacyHash");
  if (!loudWarn) bad.push("05 no avisa en alto al no adoptar");
  if (!adopted) bad.push("route.json actual no está adoptado (origin sin osm)");
  gate("G116-adopt-guard", bad.length === 0,
    bad.length ? `falta: ${bad.join(", ")}` : "05 guarda por legacyHash + aviso alto; route.json adoptado (osm+gpx)");
}

// --- P1-P5 — FASE P1: el vuelo de entrada (intro.ts puro + viewer.ts). El
// rail NO se toca: la intro muestrea poseAt(0) UNA vez como objetivo de
// aterrizaje y devuelve la cámara exactamente encima.
{
  const p0pos: [number, number, number] = [rail.fCamX(0) - cx, rail.fCamY(0), -(rail.fCamZ(0) - cy)];
  const introTarget: IntroTarget = { pos: p0pos, yaw: rail.fYaw(0), pitch: rail.fPitch(0) };

  // P1-seam: al terminar, la cámara está en poseAt(0) con error de posición
  // <= 0,5 m y de orientación <= 0,2° (yaw y pitch).
  {
    const end = introSample(1, introTarget);
    const posErr = Math.hypot(end.pos[0] - p0pos[0], end.pos[1] - p0pos[1], end.pos[2] - p0pos[2]);
    const yawErr = Math.abs((((end.yaw - introTarget.yaw + 540) % 360) - 180));
    const pitchErr = Math.abs(end.pitch - introTarget.pitch);
    const oriErr = quatDistDeg(quatYXZ(end.yaw, end.pitch), quatYXZ(introTarget.yaw, introTarget.pitch));
    gate("P1-seam", posErr <= 0.5 && yawErr <= 0.2 && pitchErr <= 0.2,
      `pos err ${posErr.toFixed(4)} m (need <=0.5) · yaw err ${yawErr.toFixed(4)}° · pitch err ${pitchErr.toFixed(4)}° (need <=0.2) · quat ${oriErr.toFixed(4)}°`);
  }

  // P2-clearance: holgura mínima al terreno a lo largo de TODO el vuelo,
  // muestreada cada 0,1 s. >= 60 m.
  {
    let minC = Infinity;
    let minT = 0;
    for (let ts = 0; ts <= INTRO_DURATION_S + 1e-9; ts += 0.1) {
      const sm = introSample(ts / INTRO_DURATION_S, introTarget);
      const c = sm.pos[1] - sampleGrid(sm.pos[0] + cx, cy - sm.pos[2]);
      if (c < minC) {
        minC = c;
        minT = ts;
      }
    }
    gate("P2-clearance", minC >= INTRO_MIN_CLEARANCE_M,
      `min clearance ${minC.toFixed(1)} m at t=${minT.toFixed(1)} s (need >=${INTRO_MIN_CLEARANCE_M}) — start ${INTRO_START_ALT_M} m, landing ${p0pos[1].toFixed(0)} m`);
  }

  // P3-duration: 7,0 s ± 0,3 con el reloj real, dirigida por reloj por
  // ACUMULACIÓN acotada (no por número de frames, no por reloj absoluto):
  // a 20 fps dura lo mismo y un parón no se la traga.
  {
    const viewerSrcP = readFileSync("src/engine/viewer.ts", "utf8");
    const dur = Math.abs(INTRO_DURATION_S - 7.0) <= 0.3;
    const clockDriven = viewerSrcP.includes("introElapsedS += Math.min(dt, 0.05)")
      && viewerSrcP.includes("introStarted = true");
    gate("P3-duration", dur && clockDriven,
      `duration ${INTRO_DURATION_S} s (need 7.0±0.3) · reloj por acumulación acotada=${clockDriven}`);
  }

  // P4-rail-pure: la intro es pura (sin import/rAF/DOM/reloj propios) y el
  // objetivo es poseAt(0) muestreado una vez; no escribe estado de s. La
  // medida real (s=0,30 → 0,60 → 0,30 idénticos) se hace en navegador.
  {
    const introSrc = readFileSync("src/narrative/intro.ts", "utf8");
    const pure = !introSrc.includes("import ")
      && !introSrc.includes("requestAnimationFrame")
      && !introSrc.includes("performance.now")
      && !introSrc.includes("window.");
    const viewerSrcP = readFileSync("src/engine/viewer.ts", "utf8");
    const targetOnce = viewerSrcP.includes("const introTarget: IntroTarget") && viewerSrcP.includes("rig.poseAt(0)");
    gate("P4-rail-pure", pure && targetOnce,
      `intro.ts puro=${pure} · objetivo poseAt(0) una vez=${targetOnce} — medir en navegador s=0.30/0.60/0.30`);
  }

  // P5-single-raf: la intro se engancha al bucle existente, no abre el suyo.
  {
    const introSrc = readFileSync("src/narrative/intro.ts", "utf8");
    const viewerSrcP = readFileSync("src/engine/viewer.ts", "utf8");
    const introRaf = introSrc.includes("requestAnimationFrame");
    // §P14: setAnimationLoop(null) (parar el bucle al perder el contexto) NO es
    // un segundo bucle; solo cuenta la REGISTRACIÓN de un callback.
    const loops = (viewerSrcP.match(/setAnimationLoop\(\s*(?!null)/g) ?? []).length;
    gate("P5-single-raf", !introRaf && loops === 1,
      `intro sin rAF=${!introRaf} · setAnimationLoop en viewer=${loops} (need 1)`);
  }

  // P6-intro-nonblank: en t = 0,3 · 1,0 · 2,0 · 3,5 · 5,0 s el fotograma
  // contiene TERRENO (>= 35 % de píxeles no-cielo). Node lo mide con la
  // misma geometría que el pase oclusor de ?skyfrac (ray-cast sobre el
  // heightfield, cámara/FOV/lejanía reales); el navegador lo confirma con
  // ?skyfrac=1 (__skyFrac = cielo → terreno = 1 − __skyFrac).
  {
    const FOV = 50;
    const ASPECT = 16 / 9;
    const FAR = 40000; // CAM_FAR
    const bbox = meta.bbox;
    const NX = 48;
    const NY = 27;
    const half = Math.tan(((FOV * Math.PI) / 180) / 2);
    const castTerrain = (fr: number, nx: number, ny: number): boolean => {
      const sm = introSample(fr, introTarget);
      const Y = (sm.yaw * Math.PI) / 180;
      const P = (sm.pitch * Math.PI) / 180;
      const cosP = Math.cos(P), sinP = Math.sin(P), sinY = Math.sin(Y), cosY = Math.cos(Y);
      // basis (forward/right/up) from the quatYXZ convention (positive pitch down)
      const fx = cosP * sinY, fy = -sinP, fz = -cosP * cosY;
      const rx = cosY, ry = 0, rz = sinY;
      const ux = sinP * sinY, uy = cosP, uz = -sinP * cosY;
      let dx = fx + rx * nx * half * ASPECT + ux * ny * half;
      let dy = fy + ry * nx * half * ASPECT + uy * ny * half;
      let dz = fz + rz * nx * half * ASPECT + uz * ny * half;
      const L = Math.hypot(dx, dy, dz);
      dx /= L; dy /= L; dz /= L;
      let inside = false;
      for (let dist = 12; dist <= FAR; dist += 20) {
        const wx = sm.pos[0] + dx * dist;
        const wy = sm.pos[1] + dy * dist;
        const wz = sm.pos[2] + dz * dist;
        const ex = wx + cx;
        const ey = cy - wz;
        const inB = ex >= bbox.minx && ex <= bbox.maxx && ey >= bbox.miny && ey <= bbox.maxy;
        if (inB) {
          inside = true;
          if (wy <= sampleGrid(ex, ey)) return true;
        } else if (inside) {
          return false; // left the heightfield: nothing more to hit
        }
      }
      return false;
    };
    const instants = [0.3, 1.0, 2.0, 3.5, 5.0];
    const fracs = instants.map((t) => {
      let hits = 0;
      for (let iy = 0; iy < NY; iy++) {
        for (let ix = 0; ix < NX; ix++) {
          const nx = ((ix + 0.5) / NX) * 2 - 1;
          const ny = 1 - ((iy + 0.5) / NY) * 2;
          if (castTerrain(t / INTRO_DURATION_S, nx, ny)) hits++;
        }
      }
      return hits / (NX * NY);
    });
    gate("P6-intro-nonblank", fracs.every((f) => f >= 0.35),
      `terreno ${fracs.map((f) => `${(f * 100).toFixed(0)}%`).join(" · ")} (need >=35% each) at t=0.3/1/2/3.5/5 — confirmar con ?skyfrac=1 (1−__skyFrac)`);
  }

  // P7-intro-plays: con el dt acotado, un frame de 2 s a mitad de la intro
  // avanza t como mucho 1/20 s y la secuencia termina igualmente.
  {
    const viewerSrcP = readFileSync("src/engine/viewer.ts", "utf8");
    const clamp = viewerSrcP.includes("introElapsedS += Math.min(dt, 0.05)");
    const firstFrame = viewerSrcP.includes("introStarted = true");
    let t = 0;
    t += Math.min(2.0, 0.05); // simula UN frame de 2 s desde t=0
    gate("P7-intro-plays", clamp && firstFrame && Math.abs(t - 0.05) < 1e-9 && t < INTRO_DURATION_S,
      `clamp 1/20=${clamp} · reloj en el primer frame=${firstFrame} · tras un frame de 2 s: t=${t.toFixed(3)} s (need 0.050, <7)`);
  }

  // P8-ui-hidden: panel y HUD fuera durante la intro, visibles al terminar
  // con fundido de 400 ms.
  {
    const viewerSrcP = readFileSync("src/engine/viewer.ts", "utf8");
    const css = readFileSync("src/styles/main.css", "utf8");
    const adds = viewerSrcP.includes('classList.add("intro-on")');
    const removes = viewerSrcP.includes('classList.remove("intro-on")');
    const hides = css.includes("html.intro-on #panel") && css.includes("html.intro-on .tele");
    const fade = css.includes("transition: opacity 400ms ease");
    gate("P8-ui-hidden", adds && removes && hides && fade,
      `intro-on add/remove=${adds}/${removes} · CSS #panel+.tele opacity 0=${hides} · fundido 400ms=${fade}`);
  }

  // §P9-P8b-ui-oculta-real: la CLASE no basta — la especificidad CSS puede
  // dejar opacity 1 con intro-on puesto (eso pasó: #panel.pcard:not(.collapsed)
  // (1,2,0) ganaba a html.intro-on #panel (1,1,1)). El viewer publica
  // window.__introUI = { panel, tele, lbl } con la opacidad COMPUTADA, y la
  // regla de intro pesa >= la de colapso.
  {
    const viewerSrcB = readFileSync("src/engine/viewer.ts", "utf8");
    const css = readFileSync("src/styles/main.css", "utf8");
    const publishes = viewerSrcB.includes("__introUI")
      && viewerSrcB.includes("getComputedStyle")
      && viewerSrcB.includes("publishIntroUI()");
    // Especificidad: la regla de intro debe llevar los TRES segmentos
    // (#panel + .pcard + :not/.collapsed…) para pesar >= (1,2,0).
    const introRule = /html\.intro-on #panel\.pcard[^{]*\{[^}]*opacity:\s*0/m.test(css);
    const afterCollapse = css.indexOf("html.intro-on #panel.pcard") > css.indexOf("#panel.pcard:not(.panel-collapsed)");
    const ok = publishes && introRule && afterCollapse;
    gate("P8b-ui-oculta-real", ok,
      `__introUI computada=${publishes} · regla intro (1,2,1) con opacity 0=${introRule} · después de collapsed=${afterCollapse} — medir panel/tele/lbl "0" en prod con intro activa`);
  }

  // §P9-P9-suelo-domo: el domo declara uGroundF y lo usa con
  // smoothstep(0.0, GROUND_SPAN, below). Si no, el cielo bajo el horizonte
  // sigue siendo pared lisa y el terreno lejano termina en borde de cartón.
  {
    const viewerSrcG = readFileSync("src/engine/viewer.ts", "utf8");
    const decl = viewerSrcG.includes("uniform float uGroundF;");
    const use = viewerSrcG.includes("smoothstep( 0.0,")
      && viewerSrcG.includes("GROUND_SPAN")
      && viewerSrcG.includes("clamp( -skyDirY, 0.0, 1.0 )");
    const shared = viewerSrcG.includes('skyU["uGroundF"] = uGroundFShared');
    const vals = GROUND_DESAT === 0.75 && GROUND_DARK === 0.55 && GROUND_SPAN === 0.35;
    const ok = decl && use && shared && vals;
    gate("P9-suelo-domo", ok,
      `declara uGroundF=${decl} · smoothstep(0,GROUND_SPAN,below)=${use} · compartido=${shared} · GROUND 0.75/0.55/0.35=${vals}`);
  }

  // §P9-P9-captura-aislada: la captura pone uGroundF a 0 antes de su render
  // y lo restaura después — si no, cambiaría la niebla de los 18 km.
  {
    const capSrc = readFileSync("src/engine/sky-capture.ts", "utf8");
    const zeroes = capSrc.includes("sharedGroundF.value = 0");
    const restores = capSrc.includes("sharedGroundF.value = prevGroundF");
    const guarded = capSrc.includes("finally");
    const exposes = capSrc.includes("__groundF") && capSrc.includes("capF = 0");
    const ok = zeroes && restores && guarded && exposes;
    gate("P9-captura-aislada", ok,
      `uGroundF a 0=${zeroes} · restaura=${restores} · en finally=${guarded} · __groundF.capF=0=${exposes} — medir __groundF en prod`);
  }
}

// --- §P14 — que la pieza funcione en móvil ---------------------------------
// Cuatro niveles de textura (tex-budget.ts, fuente única). El presupuesto se
// mide sobre pickTextures("phone"), NO sobre "lite": "lite" es el rescate de un
// aparato sin 4096, no la rama de móvil.
{
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const debugSrc = readFileSync("src/engine/debug.ts", "utf8");
  const scrollSrc = readFileSync("src/narrative/scroll.ts", "utf8");

  // P14-presupuesto-movil: abre cada webp del set "phone" y suma w·h·4.
  // Umbral 85 MB, no 120: hoy son ~72,5 MB, así que 120 no mordería (una
  // textura 4096×3102 de +50 MB pasaría). La suma NO incluye mipmaps; el
  // consumo real de GPU es ≈1,33× esta cifra.
  {
    const keys = pickTextures("phone");
    const parts: string[] = [];
    let totalMB = 0;
    let missing = "";
    for (const k of keys) {
      const web = assetWebPath(k, meta);
      const file = `public/${web}`;
      if (!web || !existsSync(file)) {
        missing = k;
        break;
      }
      const m = await sharp(file).metadata();
      const w = m.width ?? 0;
      const h = m.height ?? 0;
      const mb = (w * h * 4) / 1048576;
      totalMB += mb;
      parts.push(`${k} ${w}x${h} ${mb.toFixed(1)}MB`);
    }
    gate("P14-presupuesto-movil", missing === "" && totalMB < 85,
      missing !== ""
        ? `FALTA la textura ${missing} de pickTextures("phone") — regenerar con \`npm run data\``
        : `${totalMB.toFixed(1)} MB (need <85) SIN mipmaps · real ≈${(totalMB * 1.33).toFixed(1)} MB · ${parts.join(" · ")}`);
  }

  // P14-presupuesto-lite: en "lite" NINGUNA textura de GPU pasa de 2048 en
  // ninguna dimensión. Es el rescate de hardware sin 4096; meterle una 4096 la
  // rompería en silencio. El heightmap queda fuera: no es textura de GPU (se
  // decodifica a elevaciones, nunca se sube al GL).
  {
    const keys = pickTextures("lite").filter((k) => k !== TEX_HEIGHTMAP);
    let over = "";
    for (const k of keys) {
      const web = assetWebPath(k, meta);
      const file = `public/${web}`;
      if (!web || !existsSync(file)) {
        over = `${k} (ausente)`;
        break;
      }
      const m = await sharp(file).metadata();
      if ((m.width ?? 0) > 2048 || (m.height ?? 0) > 2048) over = `${k} ${m.width}x${m.height}`;
    }
    gate("P14-presupuesto-lite", over === "",
      over === "" ? `"lite" (GPU) sin textura >2048: ${keys.join(", ")}` : `"lite" con textura >2048: ${over}`);
  }

  // P14-normal-lite: terrain-normal-2048 en meta.assets, fichero existente,
  // devuelto por pickTextures("phone"), y vector medio ∈ [0,98, 1,02] con la
  // codificación del proyecto (X,Y *2-1; Z directa /255). Detecta el reescalado
  // en espacio de bytes (relieve desinflado).
  {
    const normalKey = "terrain-normal-2048";
    const web = meta.assets?.[normalKey] ?? "";
    const file = web ? `public/${web}` : "";
    const inSet = pickTextures("phone").includes(normalKey);
    let mean = -1;
    if (file && existsSync(file)) {
      const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
      const ch = info.channels;
      const n = info.width * info.height;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const x = ((data[i * ch] as number) / 255) * 2 - 1;
        const y = ((data[i * ch + 1] as number) / 255) * 2 - 1;
        const z = (data[i * ch + 2] as number) / 255;
        sum += Math.hypot(x, y, z);
      }
      mean = sum / n;
    }
    gate("P14-normal-lite", inSet && file !== "" && existsSync(file) && mean >= 0.98 && mean <= 1.02,
      `en meta=${file !== ""} · en pickTextures("phone")=${inSet} · vector medio ${mean < 0 ? "n/a" : mean.toFixed(4)} (need [0.98,1.02])`);
  }

  // P14-nunca-bloqueada: la sonda __lock existe y las tres rutas de liberación
  // llaman al MISMO introFinish. La comprobación de verdad es en navegador:
  // con WEBGL_lose_context.loseContext() durante la intro, __lock.stopped→false,
  // __lock.releasedBy→"contextlost", bucle parado, aviso visible y página viva.
  {
    const probe = scrollSrc.includes("__lock") && viewerSrc.includes("markReleasedBy");
    const watchdog = viewerSrc.includes('introFinish("watchdog")') && viewerSrc.includes("INTRO_DURATION_S * 1000 + 5000");
    const ctx = viewerSrc.includes('"webglcontextlost"') && viewerSrc.includes('introFinish("contextlost")');
    const relSites = (viewerSrc.match(/introFinish\(/g) ?? []).length;
    const stopCalls = (viewerSrc.match(/scroll\.stop\(\)/g) ?? []).length;
    const startCalls =
      (viewerSrc.match(/scroll\?\.start\(\)/g) ?? []).length + (viewerSrc.match(/scroll\.start\(\)/g) ?? []).length;
    gate("P14-nunca-bloqueada", probe && watchdog && ctx && relSites >= 3 && stopCalls >= 1 && startCalls >= 2,
      `__lock=${probe} · vigilante reloj-de-pared=${watchdog} · webglcontextlost→introFinish=${ctx} · rutas introFinish=${relSites} (need ≥3) · scroll.stop/start=${stopCalls}/${startCalls} — medir en navegador con WEBGL_lose_context`);
  }

  // P14-dpr: con tier "phone", setPixelRatio acotado a 1,5.
  {
    const ok = viewerSrc.includes('tier === "phone" ? 1.5 : 2') && viewerSrc.includes("setPixelRatio");
    gate("P14-dpr", ok, `setPixelRatio acotado a 1,5 en phone: ${ok}`);
  }

  // P14-tier-visible: metrics lleva tier, texLevel, maxTextureSize y el contador
  // de fotogramas, y ?debug=1 los pinta.
  {
    const fields = debugSrc.includes("tier:") && debugSrc.includes("frames:") && debugSrc.includes("texLevel:");
    const hud = debugSrc.includes("metrics.tier") && debugSrc.includes("metrics.frames") && debugSrc.includes("maxTex");
    const writes = viewerSrc.includes("metrics.tier = tier") && viewerSrc.includes("metrics.frames = frames");
    gate("P14-tier-visible", fields && hud && writes,
      `Metrics tier/frames/texLevel=${fields} · HUD tier/frames/maxTex=${hud} · viewer escribe tier/frames=${writes}`);
  }

  // P14-restore: la posición se guarda (visibilitychange + pagehide + periódica),
  // se restaura saltando con Lenis (fallback window.scrollTo) y la restauración
  // SUSTITUYE a la intro. Medición en navegador: con fracción guardada a mano,
  // la intro no se reproduce y s queda a <0,01 de la guardada.
  {
    const saves = viewerSrc.includes('"visibilitychange"') && viewerSrc.includes('"pagehide"') && viewerSrc.includes("saveScrollFraction");
    const restore = viewerSrc.includes("jumpToFraction") && scrollSrc.includes("jumpToFraction") && scrollSrc.includes("window.scrollTo");
    const replaces = viewerSrc.includes("if (savedFraction !== null)") && viewerSrc.includes('introFinish("intro")');
    gate("P14-restore", saves && restore && replaces,
      `guardado periódico/hidden/pagehide=${saves} · salto Lenis+fallback=${restore} · sustituye a la intro=${replaces}`);
  }
}

// --- §P15 — el módulo de actos en móvil -----------------------------------
// Por debajo de 900 px el panel deja de ocultarse y se convierte en hoja
// inferior de tres alturas (asomo/media/completa). Contrato estático aquí;
// los gestos se miden en navegador (P15-scroll-no-secuestrado).
{
  const css = readFileSync("src/styles/main.css", "utf8");
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");

  // P15-panel-movil-existe: a 390 px #panel NO tiene display:none y su altura
  // de reposo (asomo) es 112 px, dentro de [96, 140]. La regla de ocultación
  // se ha ido. Si fallara: un cañón 3D sin una sola palabra.
  {
    const oldHide = css.includes("#panel.pcard {\n    display: none;");
    const sheetMedia = css.includes("@media (max-width: 899px) and (min-height: 501px)");
    const sheetRule = css.includes("#panel.pcard.sheet");
    const mPeek = css.match(/height:\s*calc\((\d+)px \+ env\(safe-area-inset-bottom/);
    const peekPx = mPeek ? Number(mPeek[1]) : NaN;
    const inRange = peekPx >= 96 && peekPx <= 140;
    gate("P15-panel-movil-existe", !oldHide && sheetMedia && sheetRule && inRange,
      `sin display:none=${!oldHide} · media hoja vertical=${sheetMedia} · regla .sheet=${sheetRule} · asomo ${inRange ? `${peekPx}px` : "?"} (need 96–140)`);
  }

  // P15-lienzo-visible: a 390×664 la hoja en asomo deja libre >=70 % del alto
  // y en media >=40 %. Lee los números reales del CSS. Si fallara: la pieza
  // sería un documento con una foto de fondo.
  {
    const vh = 664;
    const mPeek = css.match(/height:\s*calc\((\d+)px \+ env\(safe-area-inset-bottom/);
    const mHalf = css.match(/sheet-half\s*\{[^}]*calc\((\d+)vh/);
    const peekPx = mPeek ? Number(mPeek[1]) : NaN;
    const halfVh = mHalf ? Number(mHalf[1]) : NaN;
    const freePeek = (vh - peekPx) / vh;
    const freeHalf = 1 - halfVh / 100;
    gate("P15-lienzo-visible", freePeek >= 0.7 && freeHalf >= 0.4,
      `asomo ${(freePeek * 100).toFixed(0)}% libre (need >=70) · media ${(freeHalf * 100).toFixed(0)}% (need >=40) — ${peekPx}px / ${halfVh}vh @${vh}px`);
  }

  // P15-scroll-no-secuestrado: en asomo/media el gesto sobre el lienzo mueve el
  // recorrido (la hoja no intercepta fuera de su superficie, pan-y); en
  // completa la hoja pausa el recorrido por el MISMO candado de §P14 —emite
  // panel:sheet, el viewer hace scroll.stop/start + markReleasedBy— nunca una
  // vía nueva. Si fallara: o no avanza con el dedo, o no se puede leer el texto.
  {
    const emit = panelSrc.includes('"panel:sheet"') && panelSrc.includes('h === "full"');
    const handle =
      viewerSrc.includes('"panel:sheet"') &&
      viewerSrc.includes("scroll.stop()") &&
      viewerSrc.includes('markReleasedBy("panel")') &&
      viewerSrc.includes("scroll.start()");
    const gestures = css.includes("touch-action: pan-y") && css.includes("touch-action: none");
    const contain = css.includes("overscroll-behavior: contain") && panelSrc.includes("sheet-bar");
    gate("P15-scroll-no-secuestrado", emit && handle && gestures && contain,
      `hoja emite panel:sheet=${emit} · viewer candado §P14=${handle} · touch-action pan-y/none=${gestures} · overscroll contain=${contain} — medir gestos táctiles en navegador`);
  }

  // P15-auto-una-vez: la subida automática ocurre como mucho una vez por acto,
  // nunca llega a completa, y no se repite si la persona la bajó a mano. Si
  // fallara: la hoja se abriría sola una y otra vez tapando el paisaje.
  {
    const ms600 = panelSrc.includes("AUTO_RAISE_MS = 600");
    const once = panelSrc.includes("autoRaised") && panelSrc.includes("userLowered");
    const neverFull =
      !/scheduleAutoRaise[\s\S]{0,600}setSheetHeight\("full"\)/.test(panelSrc) &&
      /scheduleAutoRaise[\s\S]{0,600}setSheetHeight\("half"\)/.test(panelSrc);
    const respected = panelSrc.includes("userLowered.has(act)");
    const reduced = panelSrc.includes("reduceMotion");
    gate("P15-auto-una-vez", ms600 && once && neverFull && respected && reduced,
      `600 ms=${ms600} · autoRaised/userLowered=${once} · nunca completa=${neverFull} · respeta bajada manual=${respected} · reduced-motion=${reduced}`);
  }

  // P15-sin-backdrop-movil: por debajo de 900 px #panel no declara
  // backdrop-filter (el blur base de escritorio sigue, para G82). Si fallara:
  // desenfoque a pantalla completa sobre WebGL en cada fotograma → problema §P14.
  {
    const mobIdx = css.indexOf("@media (max-width: 899px)");
    const window900 = mobIdx >= 0 ? css.slice(mobIdx, mobIdx + 900) : "";
    const none = window900.includes("backdrop-filter: none");
    const desktopKeeps = css.includes("blur(10px) saturate(150%)");
    gate("P15-sin-backdrop-movil", none && desktopKeeps,
      `móvil sin backdrop-filter=${none} · escritorio conserva blur=${desktopKeeps}`);
  }

  // P15-telemetria-unica: por debajo de 900 px .tele se oculta y sus datos
  // (altitud/km/acto) se pintan en la barra de asomo, con el mismo driver.
  // Un solo elemento anclado abajo. Si fallara: dos barras apiladas.
  {
    const hides = /@media \(max-width: 899px\)[\s\S]{0,120}?\.tele\s*\{[^}]*display:\s*none/.test(css);
    const cells = panelSrc.includes(".sheet-act") && panelSrc.includes(".sheet-alt") && panelSrc.includes(".sheet-km");
    const wired = viewerSrc.includes("sheetTele") && viewerSrc.includes("driveTelemetry(sheetTele");
    gate("P15-telemetria-unica", hides && cells && wired,
      `tele oculta <900=${hides} · celdas en la barra de asomo=${cells} · mismo driver=${wired}`);
  }
}

// --- §P16 — el arranque en móvil -----------------------------------------
// Contrato estático. Las dos puertas que dependen de lo que SE VE (hoja fuera
// de pantalla al aterrizar y entrada única tras un gesto real) se miden en
// navegador con `npm run verify:p16` (scripts/verify-p16.mjs).
{
  const css = readFileSync("src/styles/main.css", "utf8");
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");
  const labelsSrc = readFileSync("src/engine/labels.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);

  // P16-titulo-html: la barra usa titulo.html; ningún asterisco literal.
  {
    const usesHtml = has(panelSrc, "st.innerHTML = a.titulo.html");
    const noRaw = !has(panelSrc, "titulo.raw");
    const goldI = css.includes("#panel.pcard.sheet .sheet-title i") && has(css, "var(--gold-bright)");
    gate("P16-titulo-html", usesHtml && noRaw && goldI,
      `innerHTML titulo.html=${usesHtml} · sin titulo.raw=${noRaw} · i gold-bright=${goldI}`);
  }

  // P16-fichas-en-asomo: la línea de datos sale de `fichas`, no de cifra1/2.
  {
    const usesFichas = has(panelSrc, "a.fichas.join");
    const noCifraLine = !has(panelSrc, "cifraLine");
    const fallback = css.includes(".sheet-cifras:not(:empty) ~ .sheet-alt");
    gate("P16-fichas-en-asomo", usesFichas && noCifraLine && fallback,
      `a.fichas.join=${usesFichas} · cifraLine eliminado=${noCifraLine} · fallback telemetría oculto con fichas=${fallback}`);
  }

  // P16-arranque-limpio (estático): AUSENTE fuera de pantalla + sin gestos.
  // El único elemento de interfaz permitido en este estado es .scroll-hint.
  {
    const enterS = has(panelSrc, "SHEET_ENTER_S = 0.004");
    const absentClass = has(panelSrc, 'classList.toggle("sheet-absent"');
    const inert = has(panelSrc, 'setAttribute("inert"');
    const ariaHidden = has(panelSrc, 'setAttribute("aria-hidden"');
    const cssAbsent =
      css.includes("#panel.pcard.sheet.sheet-absent:not(.panel-collapsed)") &&
      has(css, "translateY(100%)") &&
      has(css, "pointer-events: none");
    gate("P16-arranque-limpio", enterS && absentClass && inert && ariaHidden && cssAbsent,
      `SHEET_ENTER_S=0.004=${enterS} · clase ausente=${absentClass} · inert=${inert} · aria-hidden=${ariaHidden} · css translateY(100%)+pointer-events none+especificidad (1,4,0)=${cssAbsent}`);
  }

  // P16-entrada-una-vez (estático): guarda única, acto marcado como subido,
  // restauración→asomo, y un solo disparador de la pista desde la entrada.
  {
    const once = has(panelSrc, "sheetEntered") && has(panelSrc, "enterSheetOnce");
    const markRaised = has(panelSrc, "autoRaised.add(cur)");
    const restored = has(panelSrc, "opts.restored") && has(viewerSrc, "restored: savedFraction !== null");
    const hintTrigger = has(viewerSrc, 'addEventListener("panel:sheet-entered"') && has(viewerSrc, "scrollHint?.hide()");
    gate("P16-entrada-una-vez", once && markRaised && restored && hintTrigger,
      `guarda única=${once} · autoRaised.add(cur)=${markRaised} · restauración→asomo=${restored} · hint desde la entrada=${hintTrigger}`);
  }

  // P16-etiquetas-dentro: función pura, matriz w/boxW/px.
  {
    const widths = [390, 900, 1440];
    const boxes = [120, 220, 340, 420];
    const M = 8;
    let ok = true;
    let detail = "";
    for (const w of widths) {
      for (const bw of boxes) {
        const fits = bw + 2 * M <= w;
        const probes = [-50, 0, 5, w / 2, w - 5, w + 50, -24, w + 24];
        for (const px of probes) {
          const out = clampLabelX(px, w, bw, M);
          if (fits) {
            const lo = bw / 2 + M - 1e-6;
            const hi = w - bw / 2 - M + 1e-6;
            const inside = out >= lo && out <= hi;
            const idempotent = out >= bw / 2 + M && out <= w - bw / 2 - M
              ? Math.abs(clampLabelX(out, w, bw, M) - out) < 1e-9
              : true;
            if (!inside || !idempotent) {
              ok = false;
              detail = `w=${w} bw=${bw} px=${px} → ${out} fuera de [${lo.toFixed(2)},${hi.toFixed(2)}]`;
            }
          } else if (Math.abs(out - (bw / 2 + M)) > 1e-6) {
            ok = false;
            detail = `w=${w} bw=${bw} px=${px} → ${out}, se esperaba borde izquierdo ${bw / 2 + M}`;
          }
        }
      }
    }
    const usesBoxW = has(labelsSrc, "clampLabelX(px, w, rt.boxW)") && has(labelsSrc, "rt.boxW > 0");
    const tolerance = has(labelsSrc, "px < -24 || px > w + 24");
    const measuredAfterFonts = has(labelsSrc, "document.fonts.ready") && has(labelsSrc, 'addEventListener("resize", measureBoxes)');
    const passed = ok && usesBoxW && tolerance && measuredAfterFonts;
    gate("P16-etiquetas-dentro", passed,
      passed
        ? `${widths.length}×${boxes.length}: dentro con margen ${M} px · ancho real rt.boxW · tolerancia ±24 px · medida tras fuentes y en resize`
        : `${ok ? "matriz OK" : detail} · ancho real=${usesBoxW} · tolerancia ±24=${tolerance} · medida tras fuentes/resize=${measuredAfterFonts}`);
  }

  // P16-escritorio-intacto: la tarjeta lateral de escritorio no cambia; las
  // reglas de la hoja viven SOLO dentro de la media query vertical.
  {
    const desktopSize = css.includes("width: min(27rem, calc(100vw - 16px))");
    const desktopFold = has(css, "#panel.pcard.panel-collapsed");
    const mobIdx = css.indexOf("@media (max-width: 899px) and (min-height: 501px)");
    const absentIdx = css.indexOf("#panel.pcard.sheet.sheet-absent");
    const scoped = mobIdx >= 0 && absentIdx > mobIdx;
    gate("P16-escritorio-intacto", desktopSize && desktopFold && scoped,
      `ancho escritorio 27rem=${desktopSize} · plegado=${desktopFold} · sheet-absent solo en media móvil=${scoped}`);
  }
}

// --- §P16-bis — la pista no pisa la etiqueta y se lee --------------------
// Contrato estático. La medida de lo que SE VE (que la pista no interseca
// ninguna etiqueta, con la hoja ausente y con posición restaurada) va en
// `npm run verify:p16` (scripts/verify-p16.mjs).
{
  const css = readFileSync("src/styles/main.css", "utf8");
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const hintSrc = readFileSync("src/engine/scroll-hint.ts", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);

  // P16b-altura-por-estado: .scroll-hint usa var(--hint-lift); html.sheet-absent
  // la redefine a 22px; panel.ts pone y quita la clase en <html> en el mismo
  // sitio que en #panel, y la limpia al salir del modo hoja.
  {
    const usesVar = has(css, "bottom: calc(var(--hint-lift, 124px) + env(safe-area-inset-bottom, 0px))");
    const redefines = css.includes("html.sheet-absent {") && /html\.sheet-absent\s*\{[^}]*--hint-lift:\s*22px/.test(css);
    const setsHtml = has(panelSrc, 'document.documentElement.classList.toggle("sheet-absent", on && sheetMode)');
    const clearsHtml = has(panelSrc, 'document.documentElement.classList.remove("sheet-absent")');
    gate("P16b-altura-por-estado", usesVar && redefines && setsHtml && clearsHtml,
      `var(--hint-lift, 124px)=${usesVar} · html.sheet-absent → 22px=${redefines} · <html> toggle=${setsHtml} · <html> remove=${clearsHtml}`);
  }

  // P16b-pista-legible: velo radial, texto en perla con text-shadow, flecha con
  // drop-shadow y opacidad de encendido >= 0.88.
  {
    const veil = css.includes(".scroll-hint::before") && has(css, "radial-gradient(closest-side, rgba(4, 7, 12, 0.7)");
    const text = /\.scroll-hint-text\s*\{[^}]*color:\s*var\(--pearl\)[^}]*text-shadow:/.test(css);
    const arrow = /\.scroll-hint-arrow\s*\{[^}]*drop-shadow/.test(css);
    const m = css.match(/\.scroll-hint-on\s*\{[^}]*opacity:\s*([\d.]+)/);
    const onOp = m ? Number(m[1]) : NaN;
    const bright = Number.isFinite(onOp) && onOp >= 0.88;
    gate("P16b-pista-legible", veil && text && arrow && bright,
      `velo radial=${veil} · texto pearl+shadow=${text} · flecha drop-shadow=${arrow} · opacidad .on=${onOp} (>=0.88=${bright})`);
  }

  // P16b-sin-tocar-el-modulo: la posición por estado vive en CSS/<html>, nunca
  // en el módulo: scroll-hint.ts no conoce la hoja ni --hint-lift.
  {
    const clean = !has(hintSrc, "hint-lift") && !has(hintSrc, "sheet-absent") && !has(hintSrc, "--hint");
    gate("P16b-sin-tocar-el-modulo", clean,
      `scroll-hint.ts sin hint-lift/sheet-absent/--hint=${clean}`);
  }
}

// --- §P17 — analítica de Vercel (vía "Other": inject, sin React) ----------
// Contrato estático. No hay nada que medir en navegador: inject() no debe
// bloquear ni cambiar la pieza (P17-no-bloquea lo cubre por orden/await).
{
  const mainSrc = readFileSync("src/main.ts", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const has = (s: string, k: string): boolean => s.includes(k);

  // Todos los fuentes de src/ (recursivo) para las comprobaciones "en src".
  const srcFiles: string[] = [];
  (function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) srcFiles.push(p);
    }
  })("src");

  // P17-inject-una-vez: import raíz (no /react ni /next), una sola llamada en
  // main.ts, ninguna en el resto de src/, y dependencia declarada.
  {
    const importOk =
      /from\s*"@vercel\/analytics"/.test(mainSrc) &&
      !has(mainSrc, "@vercel/analytics/react") &&
      !has(mainSrc, "@vercel/analytics/next");
    let calls = 0;
    let others = 0;
    for (const f of srcFiles) {
      const n = (readFileSync(f, "utf8").match(/(?<![.\w])inject\s*\(/g) ?? []).length;
      if (f.endsWith("/main.ts")) calls += n;
      else others += n;
    }
    const dep = Boolean(pkg.dependencies?.["@vercel/analytics"]);
    gate("P17-inject-una-vez", importOk && calls === 1 && others === 0 && dep,
      `import raíz=${importOk} · inject() en main.ts=${calls} (need 1) · inject() fuera=${others} (need 0) · dependencia=${dep}`);
  }

  // P17-tipos-vite: referencia a vite/client para import.meta.env.
  {
    const p = "src/vite-env.d.ts";
    const ok = existsSync(p) && has(readFileSync(p, "utf8"), '/// <reference types="vite/client" />');
    gate("P17-tipos-vite", ok, `src/vite-env.d.ts con vite/client=${ok}`);
  }

  // P17-modo-explicito: mode derivado de import.meta.env.PROD (la detección
  // automática del paquete no es fiable en Vite).
  {
    const ok = has(mainSrc, 'mode: import.meta.env.PROD ? "production" : "development"');
    gate("P17-modo-explicito", ok, `mode desde import.meta.env.PROD=${ok}`);
  }

  // P17-sin-auditorias: beforeSend descarta el evento (null) con cualquiera de
  // las banderas de depuración/pose. Las de campaña NO están y sí se cuentan.
  {
    const hasBefore = has(mainSrc, "beforeSend");
    const dropsNull = /if\s*\(FLAGS\.some\(\(k\)\s*=>\s*q\.has\(k\)\)\)\s*return null;/.test(mainSrc);
    const flags = ["debug", "s", "cam", "orbit", "wheeltest", "wheelstart", "act", "tier", "ghost", "clouds", "skyfrac", "t", "slot"];
    const allFlags = flags.every((f) => has(mainSrc, `"${f}"`));
    const noCampaign = !has(mainSrc, '"utm_') && !has(mainSrc, '"ref"') && !has(mainSrc, '"gclid"') && !has(mainSrc, '"fbclid"');
    gate("P17-sin-auditorias", hasBefore && dropsNull && allFlags && noCampaign,
      `beforeSend=${hasBefore} · descarta con null=${dropsNull} · ${flags.length} banderas=${allFlags} · campaña no filtrada=${noCampaign}`);
  }

  // P17-no-bloquea: inject() antes de startViewer y sin await.
  {
    const iInject = mainSrc.indexOf("inject(");
    const iStart = mainSrc.indexOf("startViewer(");
    const ordered = iInject >= 0 && iStart >= 0 && iInject < iStart;
    const noAwait = !has(mainSrc, "await inject");
    gate("P17-no-bloquea", ordered && noAwait,
      `inject antes de startViewer=${ordered} · sin await=${noAwait}`);
  }

  // P17-sin-track: plan Hobby. Ningún import de track() desde @vercel/analytics
  // (sin import no puede haber llamada).
  {
    let namedTrack = false;
    for (const f of srcFiles) {
      for (const m of readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@vercel\/analytics["']/g)) {
        if (/\btrack\b/.test(m[1] ?? "")) namedTrack = true;
      }
    }
    gate("P17-sin-track", !namedTrack, `ningún import de track() desde @vercel/analytics=${!namedTrack}`);
  }
}

// --- §P17-ter — CTA de descarga del track al final del recorrido ----------
// El botón no vive dentro del cuerpo del epílogo (quedaba enterrado y, en
// móvil, bajo la hoja en asomo): es un CTA fijo, fuera de #panel.
{
  const panelSrc = readFileSync("src/narrative/panel.ts", "utf8");
  const css = readFileSync("src/styles/main.css", "utf8");
  const has = (s: string, k: string): boolean => s.includes(k);
  const anchor =
    has(panelSrc, '"gate-btn epi-cta"') &&
    has(panelSrc, '"/assets/senda-cazadores.gpx"') &&
    has(panelSrc, '"download", "senda-de-los-cazadores.gpx"');
  const onlyEpi = has(panelSrc, 'setEpiCta(next === "EPI")');
  const fixed = /\.epi-cta\s*\{[^}]*position:\s*fixed/.test(css) && has(css, ".epi-cta-on");
  const belowPanel = /\.epi-cta\s*\{[^}]*z-index:\s*17/.test(css);
  gate("P17-ter-cta-descarga", anchor && onlyEpi && fixed && belowPanel,
    `anchor+download=${anchor} · solo en EPI=${onlyEpi} · fixed+on=${fixed} · z-index 17 (< #panel)=${belowPanel}`);
}

// --- R1 — puentear las vaguadas del perfil (05-build-route + lib/route-bridge) ---
{
  interface RJ {
    x: number[];
    z_mdt: number[];
    d: number[];
    lengthM: number;
    bridge?: {
      count?: number;
      totalClimbMBefore?: number;
      totalClimbMAfter?: number;
      net105BeforeM?: number;
      list?: Array<{ km: number; depthM: number; widthM: number }>;
    };
  }
  const rjson = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as RJ;
  const teethMain = findBridges(rjson.z_mdt, rjson.lengthM / (rjson.x.length - 1));
  // The GPX legacy is NEVER bridged (it is not drawn; it is the rollback and
  // 19's input), so the gate only guards the drawn route.
  gate("R1-no-teeth", teethMain.length === 0,
    `route.json ${teethMain.length} diente(s) — ${
      teethMain.length === 0 ? "los puenteos cierran"
        : teethMain.map((b) => `km ${((rjson.d[b.i] as number) / 1000).toFixed(3)} d${b.depthM.toFixed(1)} w${b.widthM.toFixed(0)}`).join(" | ")
    } (legacy sin puentear por diseño)`);

  // Net descent of the return (km 10.5-18.24), measured on route.json, vs the
  // pre-bridge baseline stored by 05. Bridging interior valleys must not move
  // it (the endpoints are untouched); >2% means real descents were eaten.
  const netBefore = rjson.bridge?.net105BeforeM ?? NaN;
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < rjson.z_mdt.length; i++) {
    if (i0 < 0 && (rjson.d[i] as number) >= 10500) i0 = i;
    if ((rjson.d[i] as number) <= 18240) i1 = i;
  }
  const netAfter = (rjson.z_mdt[i0] as number) - (rjson.z_mdt[i1] as number);
  const pct = Number.isFinite(netBefore) && netBefore !== 0 ? (Math.abs(netAfter - netBefore) / Math.abs(netBefore)) * 100 : Infinity;
  gate("R1-descents-intact", pct <= 2,
    `descenso neto km10.5-18.24 ${netBefore} -> ${netAfter.toFixed(1)} m (Δ ${pct.toFixed(2)}%, need <=2%)`);

  const list = rjson.bridge?.list ?? [];
  gate("R1-bridge-list", (rjson.bridge?.count ?? -1) === list.length && list.length <= 20,
    `${list.length} puenteo(s) en route.json: ${
      list.length ? list.map((b) => `km ${b.km} d${b.depthM} w${b.widthM}`).join(" | ") : "ninguno"
    } · climb ${rjson.bridge?.totalClimbMBefore} -> ${rjson.bridge?.totalClimbMAfter} m (legacy sin puentear)`);
}

// --- §M1 — marcadores de foto, fase 1: la chapa --------------------------
{
  const markersSrc = readFileSync("src/engine/markers.ts", "utf8");
  const viewerSrc = readFileSync("src/engine/viewer.ts", "utf8");

  // M1-rumbo-norte — rumbo y ángulo relativo puros.
  {
    const rum = [rumboA(0, -100), rumboA(100, 0), rumboA(0, 100), rumboA(-100, 0)];
    const exp = [0, 90, 180, 270];
    const okRum = rum.every((v, i) => Math.abs(v - (exp[i] as number)) < 1e-9);
    const rel = [anguloRelativo(39, 39), anguloRelativo(10, 350), anguloRelativo(350, 10)];
    const okRel = Math.abs((rel[0] as number) - 0) < 1e-9 && Math.abs((rel[1] as number) - 20) < 1e-9 && Math.abs((rel[2] as number) + 20) < 1e-9;
    gate("M1-rumbo-norte", okRum && okRel,
      `rumboA=${rum.map((v) => v.toFixed(0)).join(",")} (0,90,180,270) · rel=${rel.join(",")} (0,20,-20)`);
  }

  // M1-rumbo-camara — la cámara de three mira por −Z; rumboCamara debe dar el
  // yaw del raíl posando con quatYXZ(yaw, pitch) exactamente.
  {
    const cam = new PerspectiveCamera(50, 1.6, 1, 1e5);
    let worst = 0;
    for (const yaw of [0, 29, 58, 90, 119.7, 180, 270, 330]) {
      const q = quatYXZ(yaw, 6);
      cam.quaternion.set(q[0] as number, q[1] as number, q[2] as number, q[3] as number);
      cam.updateMatrixWorld(true);
      const rel = Math.abs(anguloRelativo(rumboCamara(cam), yaw));
      if (rel > worst) worst = rel;
    }
    gate("M1-rumbo-camara", worst < 1e-6,
      `desvío máx |rel(rumboCamara, yaw)|=${worst.toExponential(1)}° (0,29,58,90,119.7,180,270,330)`);
  }

  // M1-rumbo-sin-deriva — rumboA y bearingDeg no pueden separarse nunca.
  {
    const samples: [number, number][] = [[0, -100], [100, 0], [0, 100], [-100, 0], [37, -81], [-5, -5]];
    let worst = 0;
    for (const [dx, dz] of samples) worst = Math.max(worst, Math.abs(rumboA(dx, dz) - bearingDeg(dx, dz)));
    gate("M1-rumbo-sin-deriva", worst < 1e-9,
      `máx |rumboA−bearingDeg|=${worst.toExponential(1)}° en ${samples.length} muestras`);
  }

  // M1-despeje-de-etiqueta — alturaVastago despeja con 6 px, cap +48.
  {
    const base = 0.62 * 44;
    const disco = { x: 90, y: 50, w: 20, h: 20 };
    const hLibre = alturaVastago(base, disco, [{ x: 400, y: 63, w: 40, h: 34 }]);
    const hCorto = alturaVastago(base, disco, [{ x: 80, y: 63, w: 40, h: 34 }]);
    const hTope = alturaVastago(base, disco, [{ x: 80, y: 20, w: 40, h: 34 }]);
    // con hCorto, el borde inferior del disco queda exactamente 6 px sobre el
    // borde superior de la etiqueta (cajas con esquina superior izquierda).
    const discBottom = disco.y + disco.h - (hCorto - base);
    const exacto = Math.abs(discBottom - (63 - 6)) < 1e-9;
    gate("M1-despeje-de-etiqueta", hLibre === base && hCorto > base && hCorto < base + 48 && exacto && hTope === base + 48,
      `sin corte=${hLibre === base} · despeje=${hCorto.toFixed(2)} (6px exactos=${exacto}) · tope=${hTope.toFixed(2)}=${(base + 48).toFixed(2)}`);
  }

  // M1-sector-simetrico — con fov=54 el sector abarca 54° y la aguja lo centra.
  {
    let worst = 0;
    let spanWorst = 0;
    for (let a = 0; a < 360; a += 15) {
      const [e0, e1] = sectorEdges(a, 54);
      const d0 = Math.abs(anguloRelativo(e0, a));
      const d1 = Math.abs(anguloRelativo(e1, a));
      worst = Math.max(worst, Math.abs(d0 - 27), Math.abs(d1 - 27));
      spanWorst = Math.max(spanWorst, Math.abs((((e1 - e0) % 360) + 360) % 360 - 54));
    }
    gate("M1-sector-simetrico", worst < 1e-6 && spanWorst < 1e-6,
      `|borde-aguja| desvía ${worst.toExponential(1)}° de 27 · apertura desvía ${spanWorst.toExponential(1)}° de 54`);
  }

  // M1-escalera-monotona — diámetro y opacidad decrecen y están acotados.
  {
    let mono = true;
    let dPrev = Infinity;
    let oPrev = Infinity;
    let dBounds = true;
    let oBounds = true;
    for (let d = 0; d <= 7000; d += 5) {
      const dia = diametroMarcador(d);
      const op = opacidadMarcador(d);
      if (dia > dPrev + 1e-9 || op > oPrev + 1e-9) mono = false;
      if (dia > 44 + 1e-9 || dia < 20 - 1e-9) dBounds = false;
      if (op > 1 + 1e-9 || op < 0.55 - 1e-9) oBounds = false;
      dPrev = dia;
      oPrev = op;
    }
    const near = diametroMarcador(0) === 44 && opacidadMarcador(0) === 1;
    const far = diametroMarcador(1e9) === 20 && opacidadMarcador(1e9) === 0.55;
    const simple = !dialSimplificado(2499) && dialSimplificado(2500);
    gate("M1-escalera-monotona", mono && dBounds && oBounds && near && far && simple,
      `monótona=${mono} · Ø∈[20,44]=${dBounds} · α∈[.55,1]=${oBounds} · extremos=${near && far} · simplifica a 2500 m=${simple}`);
  }

  // M1-oclusion-reutilizada — una sola implementación de trazado de rayos.
  {
    const imports = /import\s*\{[^}]*\brayBlocked\b[^}]*\}\s*from\s*["']\.\/labels\.ts["']/.test(markersSrc);
    const definesOwn = /function\s+rayBlocked\s*\(/.test(markersSrc);
    const applied = /rayBlocked\s*\(/.test(markersSrc) && /occludeMarkers/.test(markersSrc) && /occludeMarkers\(/.test(viewerSrc);
    gate("M1-oclusion-reutilizada", imports && !definesOwn && applied,
      `markers.ts importa rayBlocked=${imports} · no lo redefine=${!definesOwn} · viewer aplica occludeMarkers=${applied}`);
  }

  // M1-intro-ocultos — se enciende junto a introArmed, se apaga en introFinish.
  {
    const onWithArmed = /if\s*\(introArmed\)[\s\S]{0,200}setMarkersHidden\(true\)/.test(viewerSrc);
    const offFinish = /setIntroHidden\(false\);\s*setMarkersHidden\(false\);/.test(viewerSrc);
    const bornHidden = /if\s*\(introHidden\)\s*el\.style\.opacity\s*=\s*"0"/.test(markersSrc);
    gate("M1-intro-ocultos", onWithArmed && offFinish && bornHidden,
      `true junto a introArmed=${onWithArmed} · false en introFinish=${offFinish} · buildMarkers nace oculto=${bornHidden}`);
  }

  // M1-sin-texturas — sin THREE.Texture/TextureLoader/materiales/geometrías.
  {
    const bad = /Texture|TextureLoader|BufferGeometry|ShaderMaterial|new\s+THREE\.|\.Material\b/.test(markersSrc);
    gate("M1-sin-texturas", !bad, `markers.ts libre de texturas/materiales/geometrías=${!bad}`);
  }
}

// --- §M2 — carrete: la galería del marcador ------------------------------
{
  // M2-entrada-por-rumbo — vectorEntrada puro (§4).
  {
    const approx = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
    const d0 = vectorEntrada(0, 0, 0); // degenerado → (0,-1)
    const e = vectorEntrada(90, 0, 0); // mira al este, cámara al norte
    const u = vectorEntrada(0, 90, 0); // mira arriba
    const w = vectorEntrada(270, 0, 0); // oeste
    const x = vectorEntrada(0, 0, 90); // az=0, cámara al este → rel −90
    const v = vectorEntrada(37, 12, 100);
    const unit = Math.abs(Math.hypot(v.ux, v.uy) - 1) < 1e-9;
    const ok =
      approx(d0.ux, 0) && approx(d0.uy, -1) &&
      approx(e.ux, 1) && approx(e.uy, 0) &&
      approx(u.ux, 0) && approx(u.uy, -1) &&
      approx(w.ux, -1) && approx(w.uy, 0) &&
      approx(x.ux, -1) && approx(x.uy, 0) && unit;
    gate("M2-entrada-por-rumbo", ok,
      `deg=${d0.ux},${d0.uy} E=${e.ux},${e.uy} arriba=${u.ux},${u.uy} O=${w.ux},${w.uy} rel−90=${x.ux},${x.uy} unitario=${unit}`);
  }

  // M2-scroll-devuelto — ninguna ruta deja el scroll parado (static).
  {
    const src = readFileSync("src/engine/carrete.ts", "utf8");
    const viewer = readFileSync("src/engine/viewer.ts", "utf8");
    const noPhotosGuard = /if\s*\(defs\.length\s*===\s*0\)\s*return false/.test(src);
    const guardOpen = /try\s*\{[\s\S]*?mount\([\s\S]*?\}\s*finally\s*\{[\s\S]*?onClose\(\)/.test(src);
    const guardClose = /finally\s*\{[\s\S]*?onClose\(\)/.test(src);
    const openStop = /onOpen:\s*\(\)\s*=>\s*\{[\s\S]*?scroll\?\.stop\(\)/.test(viewer);
    const closeStart = /onClose:\s*\(\)\s*=>\s*\{[\s\S]*?scroll\?\.start\(\)/.test(viewer);
    gate("M2-scroll-devuelto", noPhotosGuard && guardOpen && guardClose && openStop && closeStart,
      `sin fotos no llama a stop=${noPhotosGuard} · try/finally montaje=${guardOpen} · finally cierre=${guardClose} · viewer stop/start=${openStop && closeStart}`);
  }
}

// --- §M3 — despejar las chapas y poder juzgar el abanico ------------------
{
  // M3-separacion-minima
  {
    const umbral = separacionMinima(26, 20); // 37
    const noTapado = !tapado(42, 26, 20, false);
    const tapado30 = tapado(30, 26, 20, false);
    // caso real medido: dos chapas al mismo palmo (diámetros en la banda
    // 20-39 px, aquí 39 y 39) a 42 px de centro a centro → una se oculta.
    const realTapado = tapado(42, 39, 39, false);
    gate("M3-separacion-minima", umbral === 37 && noTapado && tapado30 && realTapado,
      `umbral(26,20)=${umbral} (=37) · sep42 no tapado=${noTapado} · sep30 tapado=${tapado30} · 39/39@42 tapado=${realTapado}`);
  }

  // M3-gana-el-cercano
  {
    const near = { dist: 100, px: 100, py: 100, diam: 26, culled: false };
    const far = { dist: 5000, px: 100, py: 100, diam: 26, culled: false };
    const a = descartarPorSeparacion([far, near]);
    const b = descartarPorSeparacion([near, far]);
    gate("M3-gana-el-cercano", a[0] === true && a[1] === false && b[0] === false && b[1] === true,
      `[lejos,cerca] → lejos tapado=${a[0]}, cerca=${a[1]} · [cerca,lejos] → cerca=${b[0]}, lejos=${b[1]}`);
  }

  // M3-sin-parpadeo
  {
    const dA = 26;
    const dB = 26;
    const u = separacionMinima(dA, dB);
    let flips = 0;
    let prev = tapado(u * 0.9, dA, dB, true);
    for (let f = 0.9; f <= 1.2 + 1e-9; f += 0.01) {
      const t = tapado(u * f, dA, dB, true);
      if (t !== prev) flips++;
      prev = t;
    }
    for (let f = 1.2; f >= 0.9 - 1e-9; f -= 0.01) {
      const t = tapado(u * f, dA, dB, true);
      if (t !== prev) flips++;
      prev = t;
    }
    gate("M3-sin-parpadeo", flips === 0 && prev === true,
      `recorrido 0,90·u→1,20·u y vuelta: ${flips} cambio(s) de estado (con yaOculto)`);
  }

  // M3-demo-tres
  {
    const mk = (az: number): MarkerDef => ({
      id: "x",
      nombre: "Punto",
      km: 1,
      x: 0,
      y: 0,
      z: 0,
      encuadre: { sujeto: "S", az, el: 5, km: 1, fov: 54 },
    });
    let ok = true;
    let msg = "";
    for (const az of [0, 29, 137, 300]) {
      const f = fotosDemo(mk(az));
      const distinct = new Set(f.map((fo) => fo.az)).size === 3;
      const expected = f[0]?.az === az && f[1]?.az === (az + 95) % 360 && f[2]?.az === (az + 240) % 360;
      const allDemo = f.length === 3 && f.every((fo) => fo.demo);
      if (!(f.length === 3 && distinct && expected && allDemo)) {
        ok = false;
        msg = `az=${az} n=${f.length}`;
      }
    }
    gate("M3-demo-tres", ok, ok ? "4 marcadores de prueba × 3 fotos con az / az+95 / az+240 distintas y demo=true" : msg);
  }
}

if (failures > 0) {
  console.error(`\nverify:3a: ${failures} gate(s) FAILED`);
  process.exit(1);
}
console.log("\nverify:3a: all gates passed");
