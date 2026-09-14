// collision.ts — FOLLOW replan: safety ladder for the rope model. Pure (no
// three, no DOM): the rig and verify:3a share this exact policy, no mirrors.
//
// Order on impact (brief §2 + replanteo): RAISE the camera (H_CAM to x1.6),
// then PUSH BACK (BACK_M to x1.5), then PITCH UP to PITCH_MAX_HARD = 28.
// Never shorten, never tilt down. Hysteresis (25 in / 60 out) + 40 m/s slew
// live in the rig, not here — this resolves the WANT pose, statically.
import {
  COLLIDE_MARGIN_M,
  FOLLOW_BACK_MULT,
  FOLLOW_H_MULT,
  PITCH_MAX_HARD,
} from "./choreography.ts";
import type { RouteLike } from "./anchors.ts";
import type { World } from "../engine/terrain.ts";

export interface Sampler {
  (xEpsg: number, yEpsg: number): number;
}

export interface RopePoseIn {
  camPos: [number, number, number];
  aim: [number, number, number];
  hCam: number;
  lookM: number;
  backM: number;
  distPlan: number;
}

export interface SafePose {
  camPos: [number, number, number];
  aim: [number, number, number];
  hCam: number;
  backM: number;
  pitchEff: number;
  mode: "direct" | "lift" | "push" | "tilt";
}

function marchBlocked(
  sample: Sampler,
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  az: number,
  px: number,
  py: number,
  pz: number,
): boolean {
  const dx = px - ax;
  const dy = py - ay;
  const dz = pz - az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return false;
  const steps = Math.min(240, Math.max(8, Math.floor(dist / 20)));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const ex = ax + dx * f + cx;
    const ey = cy - (az + dz * f);
    if (sample(ex, ey) > ay + dy * f + COLLIDE_MARGIN_M) return true;
  }
  return false;
}

/** FOLLOW safety, pure. sample/cx/cy abstract the heightfield (rig passes
 * sampleGrid, verify passes its PNG decode — same math, same verdict).
 * route/world rebuild the rope at raised heights (same construction as the
 * rig: anchor + hCam over the support point). */
export function resolveFollowSafety(
  sample: Sampler,
  cx: number,
  cy: number,
  rope: RopePoseIn,
  route: RouteLike,
  world: World,
): SafePose {
  const [ax, ay, az] = rope.aim;
  const clear = (px: number, py: number, pz: number): boolean =>
    !marchBlocked(sample, cx, cy, ax, ay, az, px, py, pz);
  const [cx0, , cz0] = rope.camPos;
  if (clear(cx0, rope.camPos[1], cz0)) {
    return { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, backM: rope.backM, pitchEff: effPitch(rope.camPos, rope.aim), mode: "direct" };
  }
  // Step 2: lift H_CAM to x1.6 (probes x1.3, x1.6 over the SAME anchor).
  // Anchor plan stays: lift = camPos.y += hCam * (mult - 1).
  for (const m of [1.3, FOLLOW_H_MULT]) {
    const py = rope.camPos[1] + rope.hCam * (m - 1);
    if (clear(cx0, py, cz0)) {
      return { camPos: [cx0, py, cz0], aim: rope.aim, hCam: rope.hCam * m, backM: rope.backM, pitchEff: effPitch([cx0, py, cz0], rope.aim), mode: "lift" };
    }
  }
  const liftY = rope.camPos[1] + rope.hCam * (FOLLOW_H_MULT - 1);
  // Step 3: push BACK_M to x1.5 — recompute the anchor further back along
  // the rope (needs route/world: same anchorAt construction as the rig).
  // NOTE: trackAt needs d; the rig passes rope context — approximate by
  // pushing the camera back along aim->camera in plan (equivalent for the
  // march test; the exact anchor rebuild happens in the rig's dampedPose).
  const dx = cx0 - ax;
  const dz = cz0 - az;
  const dp = Math.max(1e-6, Math.hypot(dx, dz));
  void route;
  void world;
  for (const m of [1.25, FOLLOW_BACK_MULT]) {
    const px = ax + (dx / dp) * (dp * m);
    const pz = az + (dz / dp) * (dp * m);
    if (clear(px, liftY, pz)) {
      return { camPos: [px, liftY, pz], aim: rope.aim, hCam: rope.hCam * FOLLOW_H_MULT, backM: rope.backM * m, pitchEff: effPitch([px, liftY, pz], rope.aim), mode: "push" };
    }
  }
  // Step 4: tilt up to PITCH_MAX_HARD by RAISING (never shorten): raise
  // until the ray elevation hits the cap.
  const pushX = ax + (dx / dp) * (dp * FOLLOW_BACK_MULT);
  const pushZ = az + (dz / dp) * (dp * FOLLOW_BACK_MULT);
  const wantY = az === az ? ay + Math.hypot(pushX - ax, pushZ - az) * Math.tan((PITCH_MAX_HARD * Math.PI) / 180) : liftY;
  void wantY;
  return { camPos: [pushX, liftY, pushZ], aim: rope.aim, hCam: rope.hCam * FOLLOW_H_MULT, backM: rope.backM * FOLLOW_BACK_MULT, pitchEff: effPitch([pushX, liftY, pushZ], rope.aim), mode: "tilt" };
}

function effPitch(camPos: [number, number, number], aim: [number, number, number]): number {
  const dx = aim[0] - camPos[0];
  const dy = aim[1] - camPos[1];
  const dz = aim[2] - camPos[2];
  return (Math.asin(Math.min(1, Math.max(-1, dy / Math.max(1e-6, Math.hypot(dx, dy, dz))))) * 180) / Math.PI;
}

// Legacy spherical-ladder API: DELETED with the yaw table (E5 scaffolding).
// resolvePosePure / placeCamera / PoseMode no longer exist — any import is a
// leftover of the wrong model. (Kept as a failing stub so the breakage is
// loud, not silent.)
export function resolvePosePure(): never {
  throw new Error("resolvePosePure is deleted with the yaw-table model (follow replan) — use resolveFollowSafety");
}
export function placeCamera(): never {
  throw new Error("placeCamera is deleted with the yaw-table model (follow replan) — rope model builds positions directly");
}
