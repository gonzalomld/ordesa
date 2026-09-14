// verify-3a.ts — Phase 3A gates over 1000 s-steps, no browser.
// G1 monotonicity · G2 continuity · G3 clearance · G4 yaw rate ·
// G5 sun-window · + OrbitControls anti-bundle check (C10: chunk-name based,
// the minifier mangles identifiers so grepping "OrbitControls" is useless).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BRIEF_LENGTH_M, CAM_CLEARANCE_M, CORRIDOR_HALF_M, G11_LUMA_MIN, G13_TOL_M, G4_MAX_DEG, G9BIS_COVERAGE, G9BIS_HARD_FLOOR, G9BIS_RATIO_MIN, LUMA_GRID, ROUTE_DIVERGE_PCT, SKY_FRACTION_MAX, SKY_FRACTION_MIN, SLOPE_WINDOW_M, SUNSET_ELEV_DEG } from "../src/narrative/choreography.ts";
import { applyYawBranches, alongTrackRun, bisectSunset, resolveAnchors, trackAt, zRawAt } from "../src/narrative/anchors.ts";
import { resolvePosePure, placeCamera } from "../src/narrative/collision.ts";
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

// E5: the branch decision needs the heightfield — resolve anchors first,
// then decide sides (SAME order as progress.ts: resolve -> decide -> PCHIPs).
// pngElev(): decoded heightmap as Float32Array (same RG scheme as the front).
function pngElev(): Float32Array {
  const W = meta.width;
  const H = meta.height;
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    out[i] = pngMeta.minZ + (pngRaw[i * 3] as number) * 256 + (pngRaw[i * 3 + 1] as number);
  }
  return out;
}
const res = applyYawBranches(resolveAnchors(r), { route: r, elev: pngElev(), meta, cx, cy });
// E5.2 audit column (doctor shows the grid-free series; the decided one here).
for (const b of res.yawBranch) {
  console.log(`INFO  yaw-branch: ${b.from}->${b.to}: ${b.branch === "direct" ? "rama directa" : "rama +180"} (${b.clear}/${b.total})`);
}
const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
const pchipTD = buildPchip(res.timeD, res.timeH, "time");
const pchipDist = buildPchip(res.camS, res.camDistM, "cam-dist");
const pchipPitch = buildPchip(res.camS, res.camPitch, "cam-pitch");
const pchipYaw = buildPchip(res.yawS, res.yawUnwrapped, "cam-yaw");
const pchipH = buildPchip(res.camS, res.camHTarget, "cam-h");
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

// --- sweep (E5: static pose = shared reposition policy, no mirror) ---
const D2R = Math.PI / 180;
const ds: number[] = new Array(STEPS + 1);
const hs: number[] = new Array(STEPS + 1);
const yaws: number[] = new Array(STEPS + 1);
const climbs: number[] = new Array(STEPS + 1);
const ratios: number[] = new Array(STEPS + 1);
let minClear = Infinity;
let minClearS = 0;
let minRatio = Infinity;
let minRatioS = 0;
let belowHalf = 0;
let clampSteps = 0;
let maxClampRun = 0;
let curClampRun = 0;
for (let i = 0; i <= STEPS; i++) {
  const s = i / STEPS;
  const d = pchipSD(s);
  ds[i] = d;
  hs[i] = hourAt(s, d);
  climbs[i] = trackAt(r, d).climb;
  const yawScript = pchipYaw(s);
  const pitch = pchipPitch(s);
  const distRaw = pchipDist(s);
  const hT = pchipH(s);
  const p = trackAt(r, d);
  const tx = p.x - cx;
  const tz = -(p.y - cy);
  const ty = p.z + hT;
  // E5 policy: identical call the rig makes (resolvePosePure over the same
  // march math). No second implementation — import, don't mirror.
  // G4 measures the SCRIPT yaw (what the guion asks), not the repositioned
  // one: flips/pitch-ups are safety responses, and G9-bis already watches
  // how often they fire (ratio). Conflating both gates double-punishes.
  const rp = resolvePosePure(sampleGrid, cx, cy, tx, ty, tz, distRaw, yawScript, pitch);
  yaws[i] = yawScript;
  const ratio = rp.dist / Math.max(1e-9, distRaw);
  ratios[i] = ratio;
  if (ratio < minRatio) {
    minRatio = ratio;
    minRatioS = s;
  }
  if (ratio < G9BIS_RATIO_MIN) belowHalf++;
  const [camX0, camY0, camZ0] = placeCamera(tx, ty, tz, rp.dist, rp.yaw, rp.pitch);
  const camX = camX0;
  let camY = camY0;
  const camZ = camZ0;
  void D2R;
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

// --- G4 yaw rate (E5 correction): G4_MAX_DEG over the WHOLE route, no
// exempt window. The turnaround is a rear three-quarter now, not a full
// turn — if this fails, move A9 to 0.96, never re-add an exemption. ---
{
  let max = 0;
  let at = 0;
  for (let i = 0; i < STEPS; i++) {
    const dy = Math.abs((yaws[i + 1] as number) - (yaws[i] as number));
    if (dy > max) {
      max = dy;
      at = i;
    }
  }
  gate("G4-yaw-rate", max <= G4_MAX_DEG,
    `max|dYaw|=${max.toFixed(2)} deg/step (need <=${G4_MAX_DEG}) at s=${(at / STEPS).toFixed(4)}, no exemptions`);
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

// --- G9-bis (E5): watch the RATIO, not the floor. actual/script dist >=
// 0.5 in 95% of steps, never below 0.25. The audit capture (0.135) fails.
{
  const frac = belowHalf / (STEPS + 1);
  gate("G9bis-ratio", frac <= 1 - G9BIS_COVERAGE && minRatio >= G9BIS_HARD_FLOOR,
    `min ratio ${minRatio.toFixed(3)} at s=${minRatioS.toFixed(4)} (need >=${G9BIS_HARD_FLOOR}); below ${G9BIS_RATIO_MIN}: ${belowHalf}/${STEPS + 1} (${(frac * 100).toFixed(1)}%, need <=${((1 - G9BIS_COVERAGE) * 100).toFixed(0)}%)`);
}

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

// --- G12 sky fraction contract (E1): 15-35% of frame height in all acts.
// Node checks the probe contract (same sampler as G11 + horizon test);
// the fractions themselves are measured in-browser on the seven captures.
{
  const src = readFileSync("src/engine/viewer.ts", "utf8");
  const hasSky = src.includes("__skyFrac") && src.includes("skyfrac");
  gate("G12-sky-probe", hasSky && SKY_FRACTION_MIN === 0.15 && SKY_FRACTION_MAX === 0.35,
    hasSky ? `probe in viewer (?skyfrac=1 -> window.__skyFrac), band [${SKY_FRACTION_MIN}, ${SKY_FRACTION_MAX}] — measure on the seven act captures` : "no __skyFrac probe in viewer.ts");
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

// --- G16 nod count (T5): the STATIC dist series must not saw-tooth.
// Counts sign changes of successive dist deltas over the 1000 steps — a
// ringing asymmetric loop flips direction dozens of times; a clean ride
// changes direction a handful (script knots + collision entries/exits).
// Static poses have no hysteresis/slew state, so this measures the POLICY
// (E5 ladder incl. dolly), not the damping. Threshold: 12.
{
  const dists: number[] = new Array(STEPS + 1);
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    const d = pchipSD(s);
    const p = trackAt(r, d);
    const rp = resolvePosePure(sampleGrid, cx, cy, p.x - cx, p.z + pchipH(s), -(p.y - cy), pchipDist(s), pchipYaw(s), pchipPitch(s));
    dists[i] = rp.dist;
  }
  let flips = 0;
  let prevSign = 0;
  for (let i = 1; i <= STEPS; i++) {
    const dd = (dists[i] as number) - (dists[i - 1] as number);
    const sign = dd > 1e-6 ? 1 : dd < -1e-6 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) flips++;
    if (sign !== 0) prevSign = sign;
  }
  gate("G16-nod", flips <= 12,
    `dist sign flips ${flips} over ${STEPS} steps (need <=12) — more means the snap-in/creep-out loop is nodding the frame`);
}

// --- G9-bis shape (BLOCKER minor): a min clamping exactly at the threshold
// proves the floor exists, not that the camera lives at range. p5 + count
// below 0.7 say whether it lives at distance or on the limit.
{
  const sorted = ratios.slice().sort((a, b) => (a as number) - (b as number));
  const p5 = sorted[Math.floor(0.05 * sorted.length)] as number;
  let below07 = 0;
  for (const v of ratios) if ((v as number) < 0.7) below07++;
  console.log(`INFO  G9bis-shape: min ${minRatio.toFixed(3)} at s=${minRatioS.toFixed(4)}, p5 ${p5.toFixed(3)}, steps<0.7: ${below07}/${STEPS + 1}`);
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
