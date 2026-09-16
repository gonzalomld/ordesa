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
const layoutBase = cloudLayout(meta, elevFull, { n: r.n, x: r.x, y: r.y }).map((p) => ({
  x: p.x,
  y: p.y,
  z: p.z,
  scale: p.scale * scaleRatio,
  alpha: p.alpha,
}));

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

function maskKept(m: number): number {
  if (m <= 0) return 1;
  if (m <= 0.06) return 1 - m * 0.7;
  return Math.max(0.5, 0.958 - (m - 0.06) * 0.55);
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
  // PRODUCTION curve (lightingAt) × user 1.0 × cap 1.0 — §4b FASE 4: NO
  // halving (matches setDensity).
  const rawDens = lightingAt(hour).cloudDensity;
  const hElev = lightingAt(hour).sunElevation;
  void hElev;
  const dens = Math.min(1, Math.max(0, rawDens));
  const kept = maskKept(mask);
  let area = 0;
  let n = 0;
  for (const p of layoutBase) {
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
    const rPx = ((p.scale / 2 / dist) * (VH / (2 * tanHalf)));
    area += Math.PI * rPx * rPx * p.alpha * dens * 0.45 * kept;
  }
  return { cov: Math.min(1, area / (VW * VH)), dens, n };
}

console.log(`params puffScale=${puffScale} mask=${mask} (choreo: scale=${CLOUD_PUFF_SCALE} mask=${CLOUD_MASK} target=${CLOUD_COVERAGE})`);
for (const s of [0.18, 0.8]) {
  for (const h of [9, 12]) {
    const { cov, dens, n } = coverageAt(s, h);
    console.log(`s=${s.toFixed(2)} ${h}:00 coverage=${(cov * 100).toFixed(1)}% (dens=${dens.toFixed(3)} in-frustum=${n}/${layoutBase.length})`);
  }
}
