// scripts/predict-clouds.ts — §4b FASE 4: offline coverage predictor.
// Imports the PRODUCTION layout (cloudLayout from src/engine/clouds.ts),
// the PRODUCTION curve (lightingAt from src/engine/sun.ts) and the
// PRODUCTION camera poses (same ropeAt + safety + floor code as
// verify-3a.ts) — never copies. Same coverage math as clouds.update()
// (alpha-weighted, in-frustum only WITH behind-camera rejection, mask
// kept-mass). Usage:
//   npx tsx scripts/predict-clouds.ts [puffScale] [mask]
// Defaults = current choreography values. Prints coverage at s=0.18/0.80
// × 9:00/12:00 (vw/vh = 1568×759 CSS px, like prod captures).
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { cloudLayout } from "../src/engine/clouds.ts";
import { lightingAt } from "../src/engine/sun.ts";
import {
  CAM_CLEARANCE_M,
  CLOUD_COVERAGE,
  CLOUD_MASK,
  CLOUD_PUFF_SCALE,
  FOLLOW_D_MIN,
  FOLLOW_H_AIM,
  PITCH_MAX_HARD,
  WALKER_NDC_Y,
} from "../src/narrative/choreography.ts";
import { anchorPlan, followAt, resolveAnchors, resolveFollowProfile, ropeHeadingDeg, trackAt } from "../src/narrative/anchors.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import { buildPchip } from "../src/narrative/curve.ts";

const puffScale = Number(process.argv[2] ?? CLOUD_PUFF_SCALE);
const mask = process.argv[3] !== undefined ? Number(process.argv[3]) : CLOUD_MASK;
const scaleRatio = puffScale / CLOUD_PUFF_SCALE;

// --- route + meta (same as verify-3a.ts, versioned artefacts only) ---
const route = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as {
  x: number[]; y: number[]; z_mdt: number[]; d: number[]; cumClimb: number[]; lengthM: number;
};
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
  width: number; height: number; resX: number; resY: number; originX: number; originY: number;
  minZ: number; bbox: { minx: number; maxx: number; miny: number; maxy: number };
};
const r = {
  n: route.x.length, lengthM: route.lengthM,
  x: Float32Array.from(route.x), y: Float32Array.from(route.y),
  z: Float32Array.from(route.z_mdt), d: Float32Array.from(route.d),
  cumClimb: Float32Array.from(route.cumClimb),
};
const cx = (meta.originX + (meta.originX + meta.width * meta.resX)) / 2 - meta.resX / 2;
const cy = (meta.originY - (meta.originY - meta.height * meta.resY)) / 2 + meta.resY / 2;
// world centre (viewer convention: WorldCenter = bbox midpoint — the ONLY
// frame in which camAt positions and EPSG layout points can meet).
// NOTE (F “cx/cy” below): the verify grid cx/cy is a PNG convention, NOT
// a world center — camAt/sweep math in this file uses IT consistently
// (sampleGrid adds it back), so camAt positions are grid-frame, and the
// layout comparison MUST use the same cx/cy. See dbg-view2 (validated).
const wcx = (meta.bbox.minx + meta.bbox.maxx) / 2;
const wcy = (meta.bbox.miny + meta.bbox.maxy) / 2;
void wcx;
void wcy;
const res = resolveAnchors(r);
res.follow = resolveFollowProfile(r);
const follow = res.follow;
const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");

// --- heightmap decode (same RG scheme as the front) ---
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
const elevFull = new Float32Array(meta.width * meta.height);
{
  const W = meta.width;
  for (let rr = 0; rr < meta.height; rr++) {
    for (let cc = 0; cc < meta.width; cc++) {
      elevFull[rr * W + cc] = pngMeta.minZ + (pngRaw[(rr * W + cc) * 3] as number) * 256 + (pngRaw[(rr * W + cc) * 3 + 1] as number);
    }
  }
}
// cloudLayout() bakes CLOUD_PUFF_SCALE — rescale by the predictor ratio.
// §4b FASE 4b: SAME camPoses sweep as the viewer (poseAt s ∈ [0,0.97]
// step 0.005 → band base = camYmax + 250). camAt() is defined below; the
// sweep runs after it (function hoisting covers the call order).
const camPoses: { x: number; y: number; z: number }[] = [];
const layoutBase: { x: number; y: number; z: number; scale: number; alpha: number }[] = [];

// --- camera pose at s: same construction as verify-3a ropeAt + safety +
// floor clamp (D_MIN dual one-shot quadratic, epilogue excluded: s<0.98) ---
function camAt(s: number): { pos: [number, number, number] } {
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
  return { pos: [safe.camPos[0], camY, safe.camPos[2]] };
}

// §4b FASE 4b: kept-mass of the NEW atlas (measured: 0.958 @0.12,
// 0.935 @0.16, 0.922 @0.18, 0.907 @0.20, 0.875 @0.24).
function maskKept(m: number): number {
  if (m <= 0) return 1;
  return Math.max(0.5, 0.958 - Math.max(0, m - 0.12) * 0.69);
}

// --- coverage: SAME math as clouds.update() (behind-camera rejection +
// project NDC skip + alpha weight + mask kept-mass). Camera basis mirrors
// composePose (rope yaw + walker pitch, fov 50, aspect 16/9). ---
const VW = 1568;
const VH = 759;
function coverageAt(s: number, hour: number): { cov: number; dens: number; n: number } {
  const { pos } = camAt(s);
  const d = pchipSD(Math.min(1, Math.max(0, s)));
  const prof = followAt(follow, Math.min(1, Math.max(0, s)));
  const yaw = ropeHeadingDeg(r, d, prof.lookM, prof.backM);
  const pW = trackAt(r, Math.min(r.lengthM, d));
  const walker: [number, number, number] = [pW.x - cx, pW.z + FOLLOW_H_AIM, -(pW.y - cy)];
  const distPlanW = Math.max(1e-6, Math.hypot(walker[0] - pos[0], walker[2] - pos[2]));
  const pitchWalker = (Math.atan2(pos[1] - walker[1], distPlanW) * 180) / Math.PI;
  const pitch = Math.min(pitchWalker - WALKER_NDC_Y * 25, PITCH_MAX_HARD);
  const yawR = (yaw * Math.PI) / 180;
  const pitchR = (pitch * Math.PI) / 180;
  const fx = Math.sin(yawR) * Math.cos(pitchR);
  const fy = -Math.sin(pitchR);
  const fz = -Math.cos(yawR) * Math.cos(pitchR);
  const tanHalf = Math.tan(25 * Math.PI / 180);
  const rX = Math.cos(yawR);
  const rZ = Math.sin(yawR);
  const uX = -rZ * fy;
  const uY = rZ * fx - rX * fz;
  const uZ = rX * fy;
  // §4b FASE 4c: mirror the DRAWN rule — seed alpha × on-fraction
  // (threshold 0.70+0.30·density over a 0.05 window) × texel 0.45 × mask
  // kept-mass. uDensity NEVER scales opacity (no veil).
  const rawDens = lightingAt(hour).cloudDensity;
  const hElev = lightingAt(hour).sunElevation;
  void hElev;
  const dens = Math.min(1, Math.max(0, rawDens));
  const kept = maskKept(mask);
  const onFrac = (seed: number): number => {
    const thr = 0.7 + 0.3 * dens;
    const t = Math.min(1, Math.max(0, (thr - (seed - 0.05)) / 0.1));
    return t * t * (3 - 2 * t);
  };
  let area = 0;
  let n = 0;
  // §4b FASE 4b: pixel-model approximation — project puff CENTRES to the
  // 96×54 probe grid, splat the analytic disc, count cells with a>0.15
  // inside the sky mask. Cheap, no three, same verdict family as the GL
  // pass (cell ≈ 16.3×14 CSS px — the probe's own resolution).
  const GW = 96;
  const GH = 54;
  const cellA = new Float32Array(GW * GH);
  const cellSky = new Uint8Array(GW * GH);
  if (process.env["DBGNEAR"] === "1") {
    const near = layoutBase.map((p) => {
      const vx = p.x - cx - pos[0];
      const vy = p.z - pos[1];
      const vz = -(p.y - cy) - pos[2];
      return { d: Math.hypot(vx, vy, vz), vx, vy, vz, z: p.z };
    }).sort((a, b) => a.d - b.d).slice(0, 5);
    for (const q of near) {
      const depth = q.vx * fx + q.vy * fy + q.vz * fz;
      const rX = Math.cos(yawR);
      const rZ = Math.sin(yawR);
      const uX = -rZ * fy;
      const uY = rZ * fx - rX * fz;
      const uZ = rX * fy;
      const xV = q.vx * rX + q.vz * rZ;
      const yV = q.vx * uX + q.vy * uY + q.vz * uZ;
      console.log(`  near3d=${q.d.toFixed(0)} depth=${depth.toFixed(0)} nx=${(xV / (depth * tanHalf * (16 / 9))).toFixed(2)} ny=${(yV / (depth * tanHalf)).toFixed(2)} z=${q.z.toFixed(0)}`);
    }
  }
  for (const p of layoutBase) {
    // G36-audit frame: layout stores EPSG; the sweep camera must be EPSG
    // too. camAt is grid-frame (verify cx/cy PNG convention): EPSG =
    // grid + (wcx − cx)?? NO — the clean derivation: rope.cam[0] =
    // pA.x − cx with pA.x EPSG, so gridX = epsgX − cx, i.e. epsgX =
    // gridX + cx. The “two centres” confusion came from cy≈4093 looking
    // nothing like a northing — but it never enters a position, only the
    // PNG lookup. epsgX = pos[0] + cx: camA sits ON the route. CLOSED.
    // The vz sign: view-space z must use the SAME north convention as the
    // basis (north = −z, verify G23 block): vz = −(p.y − cy) − pos[2]
    // is what dbg-view2 validated (23/95 in-frame, dist 700-1200 m).
    // The 0/160 in the last run came from a TRANSIENT slab edit, not
    // from this formula — do not “fix” it again. If in-frame reads 0,
    // suspect the LAYOUT (band), never this block.
    const vx = p.x - cx - pos[0];
    const vy = p.z - pos[1];
    const vz = -(p.y - cy) - pos[2];
    const depth = vx * fx + vy * fy + vz * fz;
    if (depth <= 0) continue;
    const xV = vx * rX + vz * rZ;
    const yV = vx * uX + vy * uY + vz * uZ;
    if (Math.abs(xV / (depth * tanHalf * (16 / 9))) > 1 || Math.abs(yV / (depth * tanHalf)) > 1) continue;
    n++;
    const dist = Math.hypot(vx, vy, vz);
    // analytic disc (legacy diagnostic only, 4c rule)
    const rPx = ((p.scale / 2 / dist) * (VH / (2 * tanHalf)));
    area += Math.PI * rPx * rPx * p.alpha * onFrac(p.alpha) * 0.45 * kept;
    // pixel splat: NDC → 96×54 cells, paint alpha there (max wins)
    const nx = (xV / (depth * tanHalf * (16 / 9))) * 0.5 + 0.5;
    const ny = (yV / (depth * tanHalf)) * 0.5 + 0.5;
    const ccx = Math.min(GW - 1, Math.max(0, Math.floor(nx * GW)));
    const ccy = Math.min(GH - 1, Math.max(0, Math.floor(ny * GH)));
    // splat radius in cells (CSS px per cell: VW/GW × VH/GH)
    const rCell = (rPx / (VW / GW) + rPx / (VH / GH)) / 2;
    const aCell = p.alpha * onFrac(p.alpha) * kept;
    const rr = Math.max(1, Math.ceil(rCell));
    for (let oy = -rr; oy <= rr; oy++) {
      for (let ox = -rr; ox <= rr; ox++) {
        if (ox * ox + oy * oy > rr * rr) continue;
        const gx = ccx + ox;
        const gy = ccy + oy;
        if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
        const gi = gy * GW + gx;
        if (aCell > (cellA[gi] as number)) cellA[gi] = aCell;
      }
    }
    void dist;
  }
  // sky mask: cells whose centre ray hits terrain are NOT sky. Cheap
  // analytic horizon: sky where the view ray at the cell centre clears the
  // far ridge — approximated by the OCCLUDER contract (terrain-only pass):
  // here: cell is sky unless its ray elevation points below the local
  // horizon. Simplification: reuse the G12 sky fraction measured in prod
  // (passed as env SKYFRAC, default 0.35) — the meter divides by it.
  const skyFrac = Number(process.env["SKYFRAC"] ?? 0.35);
  void cellSky;
  let cloudCells = 0;
  const totalCells = GW * GH;
  for (let i = 0; i < totalCells; i++) {
    if ((cellA[i] as number) > 0.15) cloudCells++;
  }
  const skyCells = totalCells * skyFrac;
  const covPx = Math.min(1, cloudCells / Math.max(1, skyCells));
  return { cov: Math.min(1, area / (VW * VH)), dens, n, covPx };
}

console.log(`params puffScale=${puffScale} mask=${mask} (choreo: scale=${CLOUD_PUFF_SCALE} mask=${CLOUD_MASK} target=${CLOUD_COVERAGE})`);
// §4b FASE 4b: build the pose sweep FIRST (same numbers as viewer boot),
// then the layout on that band — identical construction to production.
// Poses travel EPSG-plan + altitude (CloudCamPose {x, y, z}): grid→EPSG
// is x+cx / cy−z (camA audit: lands ON the route at 741783, 4726144).
for (let s = 0; s <= 0.97; s += 0.005) {
  const { pos } = camAt(Math.min(0.97, s));
  const ex = pos[0] + cx;
  const ey = cy - pos[2];
  if (!Number.isFinite(ex) || !Number.isFinite(ey) || !Number.isFinite(pos[1])) {
    throw new Error(`non-finite pose at s=${s}`);
  }
  camPoses.push({ x: ex, y: ey, z: pos[1], s: Math.min(0.97, s) });
}
if (camPoses.length < 190) throw new Error(`sweep produced ${camPoses.length} poses, need ~194`);
let camYmax = -Infinity;
let camYmin = Infinity;
for (const c of camPoses) {
  if (c.z > camYmax) camYmax = c.z;
  if (c.z < camYmin) camYmin = c.z;
}
// §4b FASE 4c: MAIN band mirrors cloudLayout (base = max(camY) + 250,
// top = base + 400) + DISTANT family [2000, 2400] ≥ 3 km plan. Printed for
// the audit; the layout itself owns the numbers (imported, never copied).
const bandBaseEff = camYmax + 250;
const bandTopEff = bandBaseEff + 400;
console.log(`camYmax=${camYmax.toFixed(0)} main=[${bandBaseEff.toFixed(0)},${bandTopEff.toFixed(0)}] far=[2000,2400]+3km`);
for (const p of cloudLayout(meta, elevFull, { n: r.n, x: r.x, y: r.y }, camPoses)) {
  layoutBase.push({ x: p.x, y: p.y, z: p.z, scale: p.scale * scaleRatio, alpha: p.alpha });
}
// Self-check: the s-aware gate promises ≥ 900 m 3D near-in-s (|Δs| ≤
// 0.2), ≥ 400 m far-in-s. Puff anchor s ≈ nearest route fraction.
{
  const anchorS = (x: number, y: number): number => {
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < r.n; i += 4) {
      const dx = x - (r.x[i] as number);
      const dy = y - (r.y[i] as number);
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi / Math.max(1, r.n - 1);
  };
  let minNear = Infinity;
  let minFar = Infinity;
  for (const p of layoutBase) {
    const ps = anchorS(p.x, p.y);
    for (const c of camPoses) {
      const cs = (c as { s?: number }).s;
      if (cs === undefined) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (Math.abs(cs - ps) <= 0.2) {
        if (d < minNear) minNear = d;
      } else if (d < minFar) {
        minFar = d;
      }
    }
  }
  console.log(`layout self-check: min near-in-s 3D = ${minNear.toFixed(0)} m (need ≥ 900), min far-in-s = ${minFar.toFixed(0)} m (need ≥ 400)`);
  // Diagnostic only (the gates above are the verdict) — closest pair.
  {
    let bx = 0; let by = 0; let bz = 0; let bs = 0; let bpx = 0; let bpy = 0; let bpz = 0; let bps = 0;
    for (const p of layoutBase) {
      const ps = anchorS(p.x, p.y);
      for (const c of camPoses) {
        const cs = (c as { s?: number }).s;
        if (cs === undefined || Math.abs(cs - ps) > 0.2) continue;
        const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
        if (d === minNear) { bx = p.x; by = p.y; bz = p.z; bs = ps; bpx = c.x; bpy = c.y; bpz = c.z; bps = cs; }
      }
    }
    console.log(`  violator puff=(${bx.toFixed(0)},${by.toFixed(0)},${bz.toFixed(0)}) ps=${bs.toFixed(3)} vs cam=(${bpx.toFixed(0)},${bpy.toFixed(0)},${bpz.toFixed(0)}) cs=${bps.toFixed(3)}`);
  }
  if (minNear < 900) throw new Error(`layout violates near gate: ${minNear.toFixed(0)}`);
  if (minFar < 400) throw new Error(`layout violates far gate: ${minFar.toFixed(0)}`);
}
for (const s of [0.18, 0.8]) {
  for (const h of [9, 12]) {
    const { cov, dens, n, covPx } = coverageAt(s, h);
    console.log(`s=${s.toFixed(2)} ${h}:00 analytic=${(cov * 100).toFixed(1)}% pixel≈${(covPx * 100).toFixed(1)}% (dens=${dens.toFixed(3)} in-frustum=${n}/${layoutBase.length})`);
  }
}
