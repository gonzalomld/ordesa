// camera-rig.ts — FOLLOW replan: tracking drone built from the path itself.
// aim = P(d + LOOK) + H_AIM, camera = anchor + H_CAM, lookAt(aim).
// anchor = P(d - BACK), extrapolated past P(0) along the P(0)->P(300) rope
// when d < BACK (E2 amendment: Pradera opening shot from the valley mouth).
// No yaw table, no unwrapped series, no LOS branch vote, no altitude floor,
// no pitch table (E5 scaffolding deleted with the wrong model).
// Constructor NEVER touches the camera (C11: with ?orbit=1 the rig is
// instantiated for poseAt but must not write).
import * as THREE from "three";
import { anchorPlan, epilogueBlend, followAt, trackAt, type FollowProfile, type RouteLike } from "./anchors.ts";
import { resolveFollowSafety } from "./collision.ts";
import {
  CAM_CLEARANCE_M,
  CORR_RELEASE_M,
  CORR_SLEW_MPS,
  EPILOGUE_S,
  FOLLOW_D_MIN,
  FOLLOW_H_AIM,
  K_IN,
  K_OUT,
  SUBJECT_X,
} from "./choreography.ts";
import { buildPchip } from "./curve.ts";
import type { ProgressHandle } from "./progress.ts";
import { sampleGrid, type Meta, type World } from "../engine/terrain.ts";

export interface RigDeps {
  camera: THREE.PerspectiveCamera;
  route: RouteLike;
  world: World;
  elev: Float32Array;
  meta: Meta;
  progress: ProgressHandle;
}

export interface RigDiag {
  /** plan distance camera->aim (m); the G9-plan magnitude. */
  distPlan: number;
  hCam: number;
  lookM: number;
  backM: number;
  holgura: number;
  /** effective yaw/pitch, READ-ONLY diagnostics (never controls). */
  yaw: number;
  pitch: number;
}

export interface RigPose {
  pos: [number, number, number];
  target: [number, number, number];
  yaw: number;
  pitch: number;
  /** plan distance camera->aim (m). */
  dist: number;
  hCam: number;
  lookM: number;
  backM: number;
}

/** Bearing deg-from-north-clockwise of a plan vector (world XZ). North=-z. */
export function bearingDeg(dx: number, dz: number): number {
  return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
}

function worldToEpsg(wx: number, wz: number, world: World): [number, number] {
  return [wx + world.centerX, world.centerY - wz];
}

interface RopePose {
  camPos: [number, number, number];
  aim: [number, number, number];
  hCam: number;
  lookM: number;
  backM: number;
  distPlan: number;
}

export function createRig(deps: RigDeps): {
  update(dt: number): void;
  poseAt(s: number): RigPose;
  getDiag(): RigDiag;
  getTarget(): [number, number, number];
} {
  const { route, world, elev, meta, progress } = deps;
  const res = progress.resolved();
  const follow: FollowProfile = res.follow as FollowProfile;

  // T5 envelopes, kept: hysteresis (engage <25, release >60) + asymmetric
  // K_IN/K_OUT + 40 m/s slew. What they damp is now H_CAM/BACK_M (lift/push),
  // not spherical dist/yaw/pitch.
  let corrHSm = 0;
  let corrBackSm = 0;
  let engaged = false;
  let lastTarget: [number, number, number] = [0, 0, 0];
  const diag: RigDiag = { distPlan: 0, hCam: 0, lookM: 0, backM: 0, holgura: Infinity, yaw: 0, pitch: 0 };

  // s->d evaluation without touching scroll (poseAt must be callable standalone)
  const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
  function rawD(s: number): number {
    return pchipSD(s);
  }

  /** Rope anchor in EPSG plan (E2 amendment: extrapolate past P(0)).
   * Shared with G18 via anchorPlan (anchors.ts) — same function, no mirror. */
  function anchorAt(d: number, backM: number): { x: number; y: number; z: number } {
    return anchorPlan(route, d, backM);
  }

  /** Pure rope pose (brief §2): D_MIN push-back in plan holding altitude,
   * then the epilogue MODE blend (position + aim, lookAt after, no slerp). */
  function ropePose(s: number): RopePose {
    const sc = Math.min(1, Math.max(0, s));
    const d = rawD(sc);
    const prof = followAt(follow, sc);
    const pAim = trackAt(route, Math.min(route.lengthM, d + prof.lookM));
    const pA = anchorAt(d, prof.backM);
    const aim: [number, number, number] = [
      pAim.x - world.centerX,
      pAim.z + FOLLOW_H_AIM,
      -(pAim.y - world.centerY),
    ];
    const camPos: [number, number, number] = [
      pA.x - world.centerX,
      pA.z + prof.hCam,
      -(pA.y - world.centerY),
    ];
    // D_MIN push-back in plan along aim->anchor, holding altitude.
    let dx = camPos[0] - aim[0];
    let dz = camPos[2] - aim[2];
    let dp = Math.hypot(dx, dz);
    if (dp < FOLLOW_D_MIN) {
      if (dp < 1e-6) {
        const q0 = trackAt(route, Math.max(0, d - 5));
        dx = q0.x - pAim.x;
        dz = -((q0.y - pAim.y));
        dp = Math.hypot(dx, dz) || 1;
      }
      camPos[0] = aim[0] + (dx / dp) * FOLLOW_D_MIN;
      camPos[2] = aim[2] + (dz / dp) * FOLLOW_D_MIN;
      dp = FOLLOW_D_MIN;
    }
    if (sc >= EPILOGUE_S) {
      const k = epilogueBlend(sc);
      const epiPos: [number, number, number] = [
        follow.epiCam.x - world.centerX,
        follow.epiCam.z,
        -(follow.epiCam.y - world.centerY),
      ];
      const epiAim: [number, number, number] = [
        follow.epiAim.x - world.centerX,
        follow.epiAim.z + FOLLOW_H_AIM,
        -(follow.epiAim.y - world.centerY),
      ];
      camPos[0] += (epiPos[0] - camPos[0]) * k;
      camPos[1] += (epiPos[1] - camPos[1]) * k;
      camPos[2] += (epiPos[2] - camPos[2]) * k;
      aim[0] += (epiAim[0] - aim[0]) * k;
      aim[1] += (epiAim[1] - aim[1]) * k;
      aim[2] += (epiAim[2] - aim[2]) * k;
      dp = Math.hypot(camPos[0] - aim[0], camPos[2] - aim[2]);
    }
    return { camPos, aim, hCam: prof.hCam, lookM: prof.lookM, backM: prof.backM, distPlan: dp };
  }

  function clearanceOfPos(pos: [number, number, number]): number {
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    return pos[1] - sampleGrid(elev, meta, ex, ey);
  }

  function floorClearance(pos: [number, number, number]): number {
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    return sampleGrid(elev, meta, ex, ey) + CAM_CLEARANCE_M;
  }

  /** Effective yaw (cam->aim, the rope yaw the camera flies) + ray
   * elevation of cam->aim. READ-ONLY diagnostics. */
  function effAngles(camPos: [number, number, number], aim: [number, number, number]): { yaw: number; pitch: number } {
    const dx = aim[0] - camPos[0];
    const dy = aim[1] - camPos[1];
    const dz = aim[2] - camPos[2];
    const yaw = bearingDeg(dx, dz);
    const rayElev = (Math.asin(Math.min(1, Math.max(-1, dy / Math.max(1e-6, Math.hypot(dx, dy, dz))))) * 180) / Math.PI;
    return { yaw, pitch: rayElev };
  }

  function applyViewOffset(): void {
    // 3B seed (brief §7): subject at SUBJECT_X via frustum shift, NOT a
    // rotation (rotation would break G18 + decenter the aim).
    if (SUBJECT_X === 0.5) {
      deps.camera.clearViewOffset();
      return;
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    const offX = (0.5 - SUBJECT_X) * w;
    deps.camera.setViewOffset(w, h, offX, 0, w, h);
  }

  /** Damped pose: same construction as ropePose from corrected (hCam, backM)
   * so damping never shears the geometry. Epilogue/D_MIN identical. */
  function dampedPose(s: number, hCorr: number, bCorr: number): { pos: [number, number, number]; aim: [number, number, number]; dp: number } {
    const sc = Math.min(1, Math.max(0, s));
    const d = rawD(sc);
    const prof = followAt(follow, sc);
    const pAim = trackAt(route, Math.min(route.lengthM, d + prof.lookM));
    const backM = prof.backM + bCorr;
    const pA = anchorAt(d, backM);
    const aim: [number, number, number] = [
      pAim.x - world.centerX,
      pAim.z + FOLLOW_H_AIM,
      -(pAim.y - world.centerY),
    ];
    const pos: [number, number, number] = [
      pA.x - world.centerX,
      pA.z + prof.hCam + hCorr,
      -(pA.y - world.centerY),
    ];
    let dx = pos[0] - aim[0];
    let dz = pos[2] - aim[2];
    let dp = Math.hypot(dx, dz);
    if (dp < FOLLOW_D_MIN) {
      if (dp < 1e-6) {
        const q0 = trackAt(route, Math.max(0, d - 5));
        dx = q0.x - pAim.x;
        dz = -((q0.y - pAim.y));
        dp = Math.hypot(dx, dz) || 1;
      }
      pos[0] = aim[0] + (dx / dp) * FOLLOW_D_MIN;
      pos[2] = aim[2] + (dz / dp) * FOLLOW_D_MIN;
      dp = FOLLOW_D_MIN;
    }
    if (sc >= EPILOGUE_S) {
      const k = epilogueBlend(sc);
      const epiPos: [number, number, number] = [
        follow.epiCam.x - world.centerX,
        follow.epiCam.z,
        -(follow.epiCam.y - world.centerY),
      ];
      const epiAim: [number, number, number] = [
        follow.epiAim.x - world.centerX,
        follow.epiAim.z + FOLLOW_H_AIM,
        -(follow.epiAim.y - world.centerY),
      ];
      pos[0] += (epiPos[0] - pos[0]) * k;
      pos[1] += (epiPos[1] - pos[1]) * k;
      pos[2] += (epiPos[2] - pos[2]) * k;
      aim[0] += (epiAim[0] - aim[0]) * k;
      aim[1] += (epiAim[1] - aim[1]) * k;
      aim[2] += (epiAim[2] - aim[2]) * k;
      dp = Math.hypot(pos[0] - aim[0], pos[2] - aim[2]);
    }
    return { pos, aim, dp };
  }

  function poseAt(s: number): RigPose {
    const sc = Math.min(1, Math.max(0, s));
    const rope = ropePose(sc);
    // static pose: safety policy, NO temporal smoothing (poseAt is pure).
    const sample = (x: number, y: number): number => sampleGrid(elev, meta, x, y);
    const safe = resolveFollowSafety(sample, world.centerX, world.centerY, rope, route, world);
    let pos = safe.camPos;
    const floor = floorClearance(pos);
    if (pos[1] < floor) pos = [pos[0], floor, pos[2]];
    const ang = effAngles(pos, safe.aim);
    const dp = Math.hypot(pos[0] - safe.aim[0], pos[2] - safe.aim[2]);
    return { pos, target: safe.aim, yaw: ang.yaw, pitch: ang.pitch, dist: dp, hCam: safe.hCam, lookM: rope.lookM, backM: safe.backM };
  }

  function update(dt: number): void {
    const st = progress.getState();
    const s = Math.min(1, Math.max(0, st.s));
    const rope = ropePose(s);
    const sample = (x: number, y: number): number => sampleGrid(elev, meta, x, y);
    const want = resolveFollowSafety(sample, world.centerX, world.centerY, rope, route, world);
    // hysteresis on the WANT clearance (engage <25, release >60) + slew.
    const wantClear = clearanceOfPos(want.camPos);
    if (!engaged && wantClear < CAM_CLEARANCE_M) engaged = true;
    else if (engaged && wantClear > CORR_RELEASE_M) engaged = false;
    const wantCorrH = engaged ? Math.max(0, want.hCam - rope.hCam) : 0;
    const wantCorrB = engaged ? Math.max(0, want.backM - rope.backM) : 0;
    if (dt > 0 && Number.isFinite(dt)) {
      const kH = wantCorrH > corrHSm ? K_IN : K_OUT;
      const kB = wantCorrB > corrBackSm ? K_IN : K_OUT;
      let nH = corrHSm + (wantCorrH - corrHSm) * (1 - Math.exp(-kH * dt));
      let nB = corrBackSm + (wantCorrB - corrBackSm) * (1 - Math.exp(-kB * dt));
      // slew AFTER smoothing, pose-coherent (same factor both axes).
      const stepH = wantCorrH - nH;
      const f = Math.abs(stepH) > CORR_SLEW_MPS * dt ? (CORR_SLEW_MPS * dt) / Math.abs(stepH) : 1;
      nH += stepH * f - stepH;
      nB += (wantCorrB - nB) * f - (wantCorrB - nB);
      corrHSm = nH;
      corrBackSm = nB;
    } else {
      corrHSm = wantCorrH;
      corrBackSm = wantCorrB;
    }
    const built = dampedPose(s, corrHSm, corrBackSm);
    const floor = floorClearance(built.pos);
    const posF: [number, number, number] = built.pos[1] < floor ? [built.pos[0], floor, built.pos[2]] : built.pos;
    deps.camera.position.set(posF[0], posF[1], posF[2]);
    deps.camera.lookAt(built.aim[0], built.aim[1], built.aim[2]);
    applyViewOffset();
    lastTarget = built.aim;
    const ang = effAngles(posF, built.aim);
    diag.distPlan = Math.hypot(posF[0] - built.aim[0], posF[2] - built.aim[2]);
    diag.hCam = rope.hCam + corrHSm;
    diag.lookM = rope.lookM;
    diag.backM = rope.backM + corrBackSm;
    const [ex, ey] = worldToEpsg(posF[0], posF[2], world);
    diag.holgura = posF[1] - sampleGrid(elev, meta, ex, ey);
    diag.yaw = ang.yaw;
    diag.pitch = ang.pitch;
  }

  return { update, poseAt, getDiag: () => diag, getTarget: () => lastTarget };
}

// Re-exported for verify-3a (same construction, no mirror).
export { followAt };
