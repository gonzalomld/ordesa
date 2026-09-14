// collision.ts — E5: collision REPOSITIONS, never dollies. Pure (no three,
// no DOM): the rig and verify:3a share this exact policy, no mirrors.
//
// Response order on impact (script pose first):
//  1. script pose (dist/yaw/pitch as choreographed)
//  2. yaw + 180 deg (opposite slope), same dist, same pitch
//  3. pitch up to PITCH_MAX_HARD, dist untouched (direct branch first —
//     less rotation from script — then the flipped branch; the brief's
//     chain tries flip+up only, this superset never shortens while a
//     same-ray pitch-up would clear)
//  4. shorten LAST, floored at max(DIST_MIN_M, 0.5 x script dist).
// Shortening was the zoom; now it is the last resort.
import {
  COLLIDE_MARGIN_M,
  COLLIDE_SHORTEN_FLOOR_FRAC,
  DIST_MIN_M,
  PITCH_MAX_HARD,
} from "./choreography.ts";

export interface Sampler {
  (xEpsg: number, yEpsg: number): number;
}

const D2R = Math.PI / 180;
// March resolution, same as the pre-E5 rig/verify sweeps (no new tuning).
const MARCH_MIN = 8;
const MARCH_MAX = 240;
const MARCH_EVERY_M = 20;

export function placeCamera(
  tx: number,
  ty: number,
  tz: number,
  dist: number,
  yawDeg: number,
  pitchDeg: number,
): [number, number, number] {
  const yr = yawDeg * D2R;
  const pr = pitchDeg * D2R;
  const cp = Math.cos(pr);
  return [
    tx + dist * cp * Math.sin(yr),
    ty + dist * Math.sin(pr),
    tz - dist * cp * Math.cos(yr),
  ];
}

function march(
  sample: Sampler,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  tz: number,
  px: number,
  py: number,
  pz: number,
): { blocked: boolean; safeDist: number } {
  const dx = px - tx;
  const dy = py - ty;
  const dz = pz - tz;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return { blocked: false, safeDist: dist };
  const steps = Math.min(MARCH_MAX, Math.max(MARCH_MIN, Math.floor(dist / MARCH_EVERY_M)));
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    // world -> EPSG:25830 (north = -z flip, same as epsgToWorld inverse)
    const ex = tx + dx * f + cx;
    const ey = cy - (tz + dz * f);
    if (sample(ex, ey) > ty + dy * f + COLLIDE_MARGIN_M) {
      return { blocked: true, safeDist: dist * ((i - 1) / steps) * 0.9 };
    }
  }
  return { blocked: false, safeDist: dist };
}

export type PoseMode = "direct" | "flip" | "pitchup" | "shorten";

export interface ResolvedPose {
  dist: number;
  yaw: number;
  pitch: number;
  mode: PoseMode;
}

/** E5 policy, pure. sample/cx/cy abstract the heightfield (rig passes
 * sampleGrid, verify passes its PNG decode — same math, same verdict). */
export function resolvePosePure(
  sample: Sampler,
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  tz: number,
  distRaw: number,
  yawRaw: number,
  pitchRaw: number,
): ResolvedPose {
  const floor = Math.max(DIST_MIN_M, COLLIDE_SHORTEN_FLOOR_FRAC * distRaw);
  const p0 = placeCamera(tx, ty, tz, distRaw, yawRaw, pitchRaw);
  if (!march(sample, cx, cy, tx, ty, tz, p0[0], p0[1], p0[2]).blocked) {
    return { dist: distRaw, yaw: yawRaw, pitch: pitchRaw, mode: "direct" };
  }
  const yawFlip = yawRaw + 180;
  const p1 = placeCamera(tx, ty, tz, distRaw, yawFlip, pitchRaw);
  if (!march(sample, cx, cy, tx, ty, tz, p1[0], p1[1], p1[2]).blocked) {
    return { dist: distRaw, yaw: yawFlip, pitch: pitchRaw, mode: "flip" };
  }
  const pitchUp = Math.max(pitchRaw, PITCH_MAX_HARD);
  if (pitchUp > pitchRaw + 1e-9) {
    const p2 = placeCamera(tx, ty, tz, distRaw, yawRaw, pitchUp);
    if (!march(sample, cx, cy, tx, ty, tz, p2[0], p2[1], p2[2]).blocked) {
      return { dist: distRaw, yaw: yawRaw, pitch: pitchUp, mode: "pitchup" };
    }
    const p3 = placeCamera(tx, ty, tz, distRaw, yawFlip, pitchUp);
    if (!march(sample, cx, cy, tx, ty, tz, p3[0], p3[1], p3[2]).blocked) {
      return { dist: distRaw, yaw: yawFlip, pitch: pitchUp, mode: "pitchup" };
    }
    // Shorten along the flip+up ray (the chain's last ray).
    const r = march(sample, cx, cy, tx, ty, tz, p3[0], p3[1], p3[2]);
    return { dist: Math.max(floor, r.safeDist), yaw: yawFlip, pitch: pitchUp, mode: "shorten" };
  }
  // Script pitch already at/above the ceiling: shorten along the flip ray.
  const r = march(sample, cx, cy, tx, ty, tz, p1[0], p1[1], p1[2]);
  return { dist: Math.max(floor, r.safeDist), yaw: yawFlip, pitch: pitchRaw, mode: "shorten" };
}
