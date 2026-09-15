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
  PITCH_MAX_HARD,
  SUBJECT_X,
  WALKER_NDC_Y,
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
  /** G16 (pasada rig puro): the damped H_CORRECTION the camera flies with.
   * The gate watches THIS (corrHSm), not the plan-dist series — knot
   * inflexions of the choreography are not nodding. */
  corrH: number;
}

export interface RigPose {
  pos: [number, number, number];
  target: [number, number, number];
  yaw: number;
  pitch: number;
  /** Orientation quaternion [x,y,z,w] (YXZ: rope yaw + walker pitch). */
  quaternion: [number, number, number, number];
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
  const diag: RigDiag = { distPlan: 0, hCam: 0, lookM: 0, backM: 0, holgura: Infinity, yaw: 0, pitch: 0, corrH: 0 };

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
   * then the epilogue MODE blend (position + aim, lookAt after, no slerp).
   * §4 correction: D_MIN is measured camera→WALKER (P(d)), not camera→aim.
   * The old aim-based push-back let the walker sit almost under the camera
   * in the cirque (aim 900 m out, walker overhead → 38.9° dive and 0.3 m/px
   * pixelation no texture can survive). The walker position needs rawD, so
   * ropePose takes it as a parameter — poseAt/update pass rawD(sc). */
  function ropePose(s: number, dHint?: number): RopePose {
    const sc = Math.min(1, Math.max(0, s));
    const d = dHint ?? rawD(sc);
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
    // D_MIN push-back in plan, holding altitude, along the aim→cam ray.
    // Scaling cam along aim→cam preserves cam->aim yaw BY CONSTRUCTION
    // (yaw is defined by that exact ray), so G18 stays tautological and G4
    // untouched. Enforces BOTH camera→aim and camera→walker ≥ FOLLOW_D_MIN
    // (§4: the cirque case had aim at 900 m with the walker almost under
    // the camera → 38.9° dive and 0.3 m/px pixelation). The walker half is
    // a ONE-SHOT quadratic (solve |cam + u·d − walker| = D_MIN for d ≥ 0),
    // capped at 3× the aim distance: iterating or projecting onto another
    // ray launches the camera when the walker sits abeam (measured: G18
    // 74°, G4 5.26, G23 behind, G19 ×18, sweep hang — never again).
    // Whatever shortfall survives the cap, PITCH_MAX_HARD bounds the dive.
    const pW = trackAt(route, Math.min(route.lengthM, d));
    const wx = pW.x - world.centerX;
    const wz = -(pW.y - world.centerY);
    {
      let ux = camPos[0] - aim[0];
      let uz = camPos[2] - aim[2];
      let dpAim = Math.hypot(ux, uz);
      if (dpAim < 1e-6) {
        const q0 = trackAt(route, Math.max(0, d - 5));
        ux = q0.x - pAim.x;
        uz = -((q0.y - pAim.y));
        dpAim = Math.hypot(ux, uz) || 1;
      }
      ux /= dpAim;
      uz /= dpAim;
      const dAim = Math.max(0, FOLLOW_D_MIN - dpAim);
      let dWalk = 0;
      const ex = camPos[0] - wx;
      const ez = camPos[2] - wz;
      if (Math.hypot(ex, ez) < FOLLOW_D_MIN) {
        const b2 = ux * ex + uz * ez;
        const c = ex * ex + ez * ez - FOLLOW_D_MIN * FOLLOW_D_MIN;
        const disc = Math.max(0, b2 * b2 - c);
        dWalk = Math.min(-b2 + Math.sqrt(disc), 3 * dpAim);
      }
      const push = Math.max(dAim, Math.max(0, dWalk));
      if (push > 0) {
        camPos[0] += ux * push;
        camPos[2] += uz * push;
      }
    }
    let dp = Math.hypot(camPos[0] - aim[0], camPos[2] - aim[2]);
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

  // effAngles: DEAD with the yaw-table model (E5 scaffolding). composePose
  // is the only source of yaw/pitch — any import of this name is a leftover
  // of the wrong model. (Kept as a failing stub so the breakage is loud.)
  function effAngles(): never {
    throw new Error("effAngles is deleted — composePose is the only source of yaw/pitch");
  }
  void effAngles;

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
   * so damping never shears the geometry. Epilogue/D_MIN identical
   * (§4: D_MIN to the walker here too — same push-back, same anchor). */
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
    const pW = trackAt(route, Math.min(route.lengthM, d));
    const wx = pW.x - world.centerX;
    const wz = -(pW.y - world.centerY);
    // D_MIN dual push-back along aim→pos (same as ropePose: yaw-preserving,
    // one-shot quadratic, capped — see above).
    {
      let ux = pos[0] - aim[0];
      let uz = pos[2] - aim[2];
      let dpAim = Math.hypot(ux, uz);
      if (dpAim < 1e-6) {
        const q0 = trackAt(route, Math.max(0, d - 5));
        ux = q0.x - pW.x;
        uz = -((q0.y - pW.y));
        dpAim = Math.hypot(ux, uz) || 1;
      }
      ux /= dpAim;
      uz /= dpAim;
      const dAim = Math.max(0, FOLLOW_D_MIN - dpAim);
      let dWalk = 0;
      const ex = pos[0] - wx;
      const ez = pos[2] - wz;
      if (Math.hypot(ex, ez) < FOLLOW_D_MIN) {
        const b2 = ux * ex + uz * ez;
        const c = ex * ex + ez * ez - FOLLOW_D_MIN * FOLLOW_D_MIN;
        const disc = Math.max(0, b2 * b2 - c);
        dWalk = Math.min(-b2 + Math.sqrt(disc), 3 * dpAim);
      }
      const push = Math.max(dAim, Math.max(0, dWalk));
      if (push > 0) {
        pos[0] += ux * push;
        pos[2] += uz * push;
      }
    }
    let dp = Math.hypot(pos[0] - aim[0], pos[2] - aim[2]);
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

  /** Walker-framed orientation (pose purity: poseAt IS the pose on screen).
   * Yaw comes from the rope anchor->aim (valley axis, as before); pitch
   * comes from the WALKER so the walked track stays in frame:
   *   pitchWalker = atan2(camY - walkerY, distPlan(cam, walker))  // down+
   *   pitch = min(pitchWalker - walkerNdcY · (fovDeg/2), PITCH_MAX_HARD)
   * PITCH_MAX_HARD applies HERE, as an absolute cap on the flown pitch
   * (§4 correction: the old "UP excursion" form never capped anything —
   * max(pitchW - lift, pitchW - 28) === pitchW - lift always, so s=0.80
   * flew at 38.9° and the cirque pixelated at 0.3 m/px). Capping the
   * absolute pitch can park the walker low where the drone flies close —
   * that is G23's business to report, not this function's to hide.
   * Built as a YXZ quaternion directly — no lookAt (lookAt computes a pitch
   * that would be thrown away, and patching rotation.x after it mixes axes
   * near vertical views). setViewOffset (SUBJECT_X) shifts the frustum, not
   * the orientation: compatible. */
  function composePose(
    camPos: [number, number, number],
    aim: [number, number, number],
    walker: [number, number, number],
    walkerNdcY: number,
    fovDeg: number,
  ): { yaw: number; pitch: number; quat: [number, number, number, number] } {
    const yaw = bearingDeg(aim[0] - camPos[0], aim[2] - camPos[2]);
    const wdx = walker[0] - camPos[0];
    const wdz = walker[2] - camPos[2];
    const distPlanW = Math.max(1e-6, Math.hypot(wdx, wdz));
    const pitchWalker = (Math.atan2(camPos[1] - walker[1], distPlanW) * 180) / Math.PI;
    const pitch = Math.min(pitchWalker - walkerNdcY * (fovDeg / 2), PITCH_MAX_HARD);
    const yawR = (yaw * Math.PI) / 180;
    const pitchR = (pitch * Math.PI) / 180;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitchR, -yawR, 0, "YXZ"));
    return { yaw, pitch, quat: [q.x, q.y, q.z, q.w] };
  }

  /** Walker world position at distance d + epilogue handling. The epilogue
   * blends position + aim point (never quaternions): walker slides to the
   * aim and walkerNdcY fades to 0 with the same k, so the loop ends centred. */
  function walkerAt(
    d: number,
    sc: number,
    aim: [number, number, number],
  ): { walker: [number, number, number]; walkerNdcY: number } {
    const pW = trackAt(route, Math.min(route.lengthM, d));
    const walker: [number, number, number] = [
      pW.x - world.centerX,
      pW.z + FOLLOW_H_AIM,
      -(pW.y - world.centerY),
    ];
    if (sc >= EPILOGUE_S) {
      const k = epilogueBlend(sc);
      return {
        walker: [
          walker[0] + (aim[0] - walker[0]) * k,
          walker[1] + (aim[1] - walker[1]) * k,
          walker[2] + (aim[2] - walker[2]) * k,
        ],
        walkerNdcY: WALKER_NDC_Y * (1 - k),
      };
    }
    return { walker, walkerNdcY: WALKER_NDC_Y };
  }

  function poseAt(s: number): RigPose {
    const sc = Math.min(1, Math.max(0, s));
    const d = rawD(sc);
    const rope = ropePose(sc, d);
    // static pose: safety policy, NO temporal smoothing (poseAt is pure).
    const sample = (x: number, y: number): number => sampleGrid(elev, meta, x, y);
    const safe = resolveFollowSafety(sample, world.centerX, world.centerY, rope, route, world);
    let pos = safe.camPos;
    const floor = floorClearance(pos);
    if (pos[1] < floor) pos = [pos[0], floor, pos[2]];
    const w = walkerAt(d, sc, safe.aim);
    const c = composePose(pos, safe.aim, w.walker, w.walkerNdcY, deps.camera.fov);
    const dp = Math.hypot(pos[0] - safe.aim[0], pos[2] - safe.aim[2]);
    return { pos, target: safe.aim, yaw: c.yaw, pitch: c.pitch, quaternion: c.quat, dist: dp, hCam: safe.hCam, lookM: rope.lookM, backM: safe.backM };
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
    const d = rawD(s);
    const w = walkerAt(d, s, built.aim);
    const c = composePose(posF, built.aim, w.walker, w.walkerNdcY, deps.camera.fov);
    deps.camera.position.set(posF[0], posF[1], posF[2]);
    deps.camera.quaternion.set(c.quat[0], c.quat[1], c.quat[2], c.quat[3]);
    applyViewOffset();
    lastTarget = built.aim;
    diag.distPlan = Math.hypot(posF[0] - built.aim[0], posF[2] - built.aim[2]);
    diag.hCam = rope.hCam + corrHSm;
    diag.lookM = rope.lookM;
    diag.backM = rope.backM + corrBackSm;
    const [ex, ey] = worldToEpsg(posF[0], posF[2], world);
    diag.holgura = posF[1] - sampleGrid(elev, meta, ex, ey);
    diag.yaw = c.yaw;
    diag.pitch = c.pitch;
    diag.corrH = corrHSm;
  }

  return { update, poseAt, getDiag: () => diag, getTarget: () => lastTarget };
}

// Re-exported for verify-3a (same construction, no mirror).
export { followAt };
