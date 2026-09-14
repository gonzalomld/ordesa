// verify-3a.ts — Phase 3A gates over 1000 s-steps, no browser.
// G1 monotonicity · G2 continuity · G3 clearance · G4 yaw rate ·
// G5 sun-window · + OrbitControls anti-bundle check (C10: chunk-name based,
// the minifier mangles identifiers so grepping "OrbitControls" is useless).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { A8_EXEMPT_S0, A8_EXEMPT_S1, BRIEF_LENGTH_M, CAM_CLEARANCE_M, G11_LUMA_MIN, LUMA_GRID, ROUTE_DIVERGE_PCT, SUNSET_ELEV_DEG } from "../src/narrative/choreography.ts";
import { bisectSunset, resolveAnchors, trackAt } from "../src/narrative/anchors.ts";
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
};
const res = resolveAnchors(r);
const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
const pchipTD = buildPchip(res.timeD, res.timeH, "time");
const pchipDist = buildPchip(res.camS, res.camDistM, "cam-dist");
const pchipPitch = buildPchip(res.camS, res.camPitch, "cam-pitch");
const pchipYaw = buildPchip(res.camS, res.camYawUnwrapped, "cam-yaw");
const pchipH = buildPchip(res.camS, res.camHTarget, "cam-h");

// ocaso: same NOAA algorithm as the browser (scripts/lib/sun.ts here,
// src/engine/sun.ts there — keep formulas in sync)
const sunset = bisectSunset((h) => sunPosition(42.645, -0.055, 2026, 8, 16, h, 120).elevationDeg);
const epilogueBase = pchipTD(res.dAnchorsM[res.dAnchorsM.length - 2] as number);
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

// --- sweep ---
const D2R = Math.PI / 180;
const ds: number[] = new Array(STEPS + 1);
const hs: number[] = new Array(STEPS + 1);
const yaws: number[] = new Array(STEPS + 1);
const climbs: number[] = new Array(STEPS + 1);
let minClear = Infinity;
let minClearS = 0;
let clampSteps = 0;
let maxClampRun = 0;
let curClampRun = 0;
for (let i = 0; i <= STEPS; i++) {
  const s = i / STEPS;
  const d = pchipSD(s);
  ds[i] = d;
  hs[i] = hourAt(s, d);
  climbs[i] = trackAt(r, d).climb;
  const yaw = pchipYaw(s);
  yaws[i] = yaw;
  const pitch = pchipPitch(s);
  const dist = pchipDist(s);
  const hT = pchipH(s);
  const p = trackAt(r, d);
  const tx = p.x - cx;
  const tz = -(p.y - cy);
  const ty = p.z + hT;
  const yawR = (yaw * Math.PI) / 180;
  const pitchR = (pitch * Math.PI) / 180;
  const cp = Math.cos(pitchR);
  let camX = tx + dist * cp * Math.sin(yawR);
  let camY = ty + dist * Math.sin(pitchR);
  let camZ = tz - dist * cp * Math.cos(yawR);
  // collision mirrors camera-rig.collide (grid march + 25 m floor,
  // no asymmetric smoothing: static pose)
  const steps = Math.min(240, Math.max(8, Math.floor(dist / 20)));
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    const px = tx + (camX - tx) * f;
    const py = ty + (camY - ty) * f;
    const pz = tz + (camZ - tz) * f;
    if (sampleGrid(px + cx, cy - pz) > py + 3) {
      const fSafe = Math.max(60, dist * ((k - 1) / steps) * 0.9);
      camX = tx + (camX - tx) * (fSafe / dist);
      camY = ty + (camY - ty) * (fSafe / dist);
      camZ = tz + (camZ - tz) * (fSafe / dist);
      break;
    }
  }
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
void D2R;

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

// --- G2 continuity ---
{
  let max = 0;
  let sum = 0;
  let at = 0;
  for (let i = 0; i < STEPS; i++) {
    const dd = Math.abs((ds[i + 1] as number) - (ds[i] as number));
    sum += dd;
    if (dd > max) {
      max = dd;
      at = i;
    }
  }
  const mean = sum / STEPS;
  gate("G2-continuity", max <= 3 * mean,
    `max|dD|=${max.toFixed(1)} m mean=${mean.toFixed(1)} m ratio=${(max / mean).toFixed(2)} (need <=3) at s=${(at / STEPS).toFixed(3)}`);
}

// --- G3 clearance (prints minimum + s, pass or fail) ---
// Rig lifts to terrain + 25 by construction; allow 1 cm of float noise.
gate("G3-clearance", minClear >= CAM_CLEARANCE_M - 0.01,
  `min clearance ${minClear.toFixed(2)} m at s=${minClearS.toFixed(4)} (need >=${CAM_CLEARANCE_M})`);

// --- G4 yaw rate (A8 window exempt, declared in the test itself) ---
{
  let max = 0;
  let at = 0;
  for (let i = 0; i < STEPS; i++) {
    const s = (i + 0.5) / STEPS;
    if (s >= A8_EXEMPT_S0 && s <= A8_EXEMPT_S1) continue; // A8 deliberate turnaround
    const dy = Math.abs((yaws[i + 1] as number) - (yaws[i] as number));
    if (dy > max) {
      max = dy;
      at = i;
    }
  }
  gate("G4-yaw-rate", max <= 1.5,
    `max|dYaw|=${max.toFixed(2)} deg/step (need <=1.5) at s=${(at / STEPS).toFixed(4)}, A8 window [${A8_EXEMPT_S0},${A8_EXEMPT_S1}] exempt`);
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
