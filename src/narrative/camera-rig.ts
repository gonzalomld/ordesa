// camera-rig.ts — pursuit camera composed from d. Owns collision +
// asymmetric distance smoothing. Constructor NEVER touches the camera
// (C11: with ?orbit=1 the rig is instantiated for poseAt but must not write).
import * as THREE from "three";
import { trackAt, type RouteLike } from "./anchors.ts";
import { buildPchip } from "./curve.ts";
import { resolvePosePure } from "./collision.ts";
import {
  CAM_ALT_MIN,
  CAM_CLEARANCE_M,
  CORR_RELEASE_M,
  CORR_SLEW_MPS,
  DIST_MIN_M,
  K_IN,
  K_OUT,
  PITCH_MAX,
} from "./choreography.ts";
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
  yaw: number;
  pitch: number;
  dist: number;
  holgura: number;
}

export interface RigPose {
  pos: [number, number, number];
  target: [number, number, number];
  yaw: number;
  pitch: number;
  dist: number;
}

function toWorld(x: number, yEpsg: number, z: number, world: World): [number, number, number] {
  return [x - world.centerX, z, -(yEpsg - world.centerY)];
}

function worldToEpsg(wx: number, wz: number, world: World): [number, number] {
  return [wx + world.centerX, world.centerY - wz];
}

export function createRig(deps: RigDeps): {
  update(dt: number): void;
  poseAt(s: number): RigPose;
  getDiag(): RigDiag;
  getTarget(): [number, number, number];
} {
  const { route, world, elev, meta, progress } = deps;
  const res = progress.resolved();
  const pchipDist = buildPchip(res.camS, res.camDistM, "cam-dist");
  const pchipPitch = buildPchip(res.camS, res.camPitch, "cam-pitch");
  // Yaw PCHIP runs on the branch-decided series (E5.2 + A9 pin) — the same
  // arrays verify:3a builds.
  const pchipYaw = buildPchip(res.yawS, res.yawUnwrapped, "cam-yaw");
  const pchipH = buildPchip(res.camS, res.camHTarget, "cam-h");
  const D2R = Math.PI / 180;

  // E5: smoothing damps POSE CORRECTIONS (dist +yaw/pitch repositioning),
  // not the script. All three share the same asymmetric rates: fast in
  // (K_IN), slow out (K_OUT).
  let corrDistSm = 0;
  let corrYawSm = 0;
  let corrPitchSm = 0;
  let lastYaw = res.yawUnwrapped[0] as number;
  let lastPitch = pchipPitch(0);
  let lastTarget: [number, number, number] = [0, 0, 0];
  const diag: RigDiag = { yaw: lastYaw, pitch: lastPitch, dist: pchipDist(0), holgura: Infinity };

  // s->d evaluation without touching scroll (poseAt must be callable standalone)
  const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
  function rawD(s: number): number {
    return pchipSD(s);
  }

  function rawPoseTarget(s: number): [number, number, number] {
    const d = rawD(s);
    const p = trackAt(route, d);
    const [tx, , tz] = toWorld(p.x, p.y, 0, world);
    return [tx, p.z + pchipH(s), tz];
  }
  lastTarget = rawPoseTarget(0);

  function rawPose(s: number): { target: [number, number, number]; yaw: number; pitch: number; hT: number; distRaw: number } {
    const d = rawD(s);
    const p = trackAt(route, d);
    const [tx, , tz] = toWorld(p.x, p.y, 0, world);
    const hT = pchipH(s);
    const target: [number, number, number] = [tx, p.z + hT, tz];
    // E1-ter: altitude rule with pitch cap, applied to the SCRIPT pose
    // (before collision). camAlt floors the height; pitch recomputes from
    // the floored height; dist grows if pitch would exceed PITCH_MAX.
    // Never lowers camAlt — the sky criterion (G12) depends on it.
    let distRaw = pchipDist(s);
    let pitch = pchipPitch(s);
    {
      const sinBase = Math.sin(pitch * D2R);
      const camAlt = Math.max(target[1] + distRaw * sinBase, CAM_ALT_MIN);
      const sinNeed = Math.min(1, (camAlt - target[1]) / Math.max(1e-6, distRaw));
      pitch = (Math.asin(Math.min(1, Math.max(-1, sinNeed))) * 180) / Math.PI;
      if (pitch > PITCH_MAX) {
        const sinMax = Math.sin((PITCH_MAX * Math.PI) / 180);
        distRaw = (camAlt - target[1]) / Math.max(1e-6, sinMax);
        pitch = PITCH_MAX;
      }
    }
    return { target, yaw: pchipYaw(s), pitch, hT, distRaw };
  }

  function spherical(target: [number, number, number], dist: number, pitchDeg: number, yawDeg: number): [number, number, number] {
    // yaw = bearing FROM target TO camera, deg from north, clockwise.
    // World: +x east, north = -z (epsgToWorld flip). pitch above horizon.
    const pitch = pitchDeg * D2R;
    const yaw = yawDeg * D2R;
    const cp = Math.cos(pitch);
    return [
      target[0] + dist * cp * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] - dist * cp * Math.cos(yaw),
    ];
  }

  /** E5: the pose is a SCRIPT decision (branch-chosen yaw) plus the shared
   * reposition policy — no per-frame shorten-first zoom, no duplicated
   * march code (collision.ts owns it; verify:3a imports the same). */
  function resolveStatic(
    target: [number, number, number],
    distRaw: number,
    yaw: number,
    pitch: number,
  ): { dist: number; yaw: number; pitch: number } {
    const sample = (x: number, y: number): number => sampleGrid(elev, meta, x, y);
    const r = resolvePosePure(sample, world.centerX, world.centerY,
      target[0], target[1], target[2], distRaw, yaw, pitch);
    return { dist: r.dist, yaw: r.yaw, pitch: r.pitch };
  }

  function floorClearance(pos: [number, number, number]): number {
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    return sampleGrid(elev, meta, ex, ey) + CAM_CLEARANCE_M;
  }

  /** T5: clearance of a candidate pose (for the hysteresis band). */
  function clearanceOf(
    target: [number, number, number],
    dist: number,
    yaw: number,
    pitch: number,
  ): number {
    const pos = spherical(target, dist, pitch, yaw);
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    return pos[1] - sampleGrid(elev, meta, ex, ey);
  }

  function poseAt(s: number): RigPose {
    const sc = Math.min(1, Math.max(0, s));
    const r = rawPose(sc);
    // static pose: reposition policy, NO temporal smoothing (poseAt is a
    // pure function of s; update() below owns the frame-to-frame damping).
    const rp = resolveStatic(r.target, r.distRaw, r.yaw, r.pitch);
    let dist = rp.dist;
    let pos = spherical(r.target, dist, rp.pitch, rp.yaw);
    const floor = floorClearance(pos);
    if (pos[1] < floor) {
      pos = [pos[0], floor, pos[2]];
      // re-derive dist from the lifted position for honest diagnostics
      dist = Math.hypot(pos[0] - r.target[0], pos[1] - r.target[1], pos[2] - r.target[2]);
    }
    return { pos, target: r.target, yaw: rp.yaw, pitch: rp.pitch, dist };
  }

  // T5: HYSTERESIS + SLEW. The asymmetric K_IN=18/K_OUT=2.5 pair rings
  // when the LOS grazes terrain (snap in / creep out / snap in = a few-Hz
  // nod of the whole frame). So: the correction ENGAGES when clearance < 25
  // and does not RELEASE until clearance > 60 (dead band, no chatter); and
  // |d(corr)| is capped at 40 m/s AFTER smoothing (a legit reframe never
  // needs more). corrSm state covers dist+yaw+pitch; engaged covers the band.
  let engaged = false;
  function update(dt: number): void {
    const st = progress.getState();
    const s = Math.min(1, Math.max(0, st.s));
    const r = rawPose(s);
    const want = resolveStatic(r.target, r.distRaw, r.yaw, r.pitch);
    // hysteresis on the WANT (pre-smoothing): engage below 25, release past 60
    const wantClear = clearanceOf(r.target, want.dist, want.yaw, want.pitch);
    if (!engaged && wantClear < CAM_CLEARANCE_M) engaged = true;
    else if (engaged && wantClear > CORR_RELEASE_M) engaged = false;
    const wantCorrDist = engaged ? Math.max(0, r.distRaw - want.dist) : 0;
    const wantCorrYaw = engaged ? want.yaw - r.yaw : 0;
    const wantCorrPitch = engaged ? want.pitch - r.pitch : 0;
    if (dt > 0 && Number.isFinite(dt)) {
      const kD = wantCorrDist > corrDistSm ? K_IN : K_OUT;
      const kY = Math.abs(wantCorrYaw) > Math.abs(corrYawSm) ? K_IN : K_OUT;
      const kP = Math.abs(wantCorrPitch) > Math.abs(corrPitchSm) ? K_IN : K_OUT;
      let nD = corrDistSm + (wantCorrDist - corrDistSm) * (1 - Math.exp(-kD * dt));
      let nY = corrYawSm + (wantCorrYaw - corrYawSm) * (1 - Math.exp(-kY * dt));
      let nP = corrPitchSm + (wantCorrPitch - corrPitchSm) * (1 - Math.exp(-kP * dt));
      // T5 slew AFTER smoothing, pose-coherent: factor the remaining dist
      // step down to CORR_SLEW_MPS and apply the SAME factor to yaw/pitch
      // so the pose travels slower without shearing.
      {
        const stepD = wantCorrDist - nD;
        const f = Math.abs(stepD) > CORR_SLEW_MPS * dt ? (CORR_SLEW_MPS * dt) / Math.abs(stepD) : 1;
        nD += stepD * f - stepD;
        nY += (wantCorrYaw - nY) * f - (wantCorrYaw - nY);
        nP += (wantCorrPitch - nP) * f - (wantCorrPitch - nP);
      }
      corrDistSm = nD;
      corrYawSm = nY;
      corrPitchSm = nP;
    } else {
      corrDistSm = wantCorrDist;
      corrYawSm = wantCorrYaw;
      corrPitchSm = wantCorrPitch;
    }
    const dist = Math.max(DIST_MIN_M, r.distRaw - corrDistSm);
    const yaw = r.yaw + corrYawSm;
    const pitch = r.pitch + corrPitchSm;
    let pos = spherical(r.target, dist, pitch, yaw);
    const floor = floorClearance(pos);
    if (pos[1] < floor) pos = [pos[0], floor, pos[2]];
    deps.camera.position.set(pos[0], pos[1], pos[2]);
    deps.camera.lookAt(r.target[0], r.target[1], r.target[2]);
    lastYaw = yaw;
    lastPitch = pitch;
    lastTarget = r.target;
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    diag.yaw = yaw;
    diag.pitch = pitch;
    diag.dist = dist;
    diag.holgura = pos[1] - sampleGrid(elev, meta, ex, ey);
  }

  return { update, poseAt, getDiag: () => diag, getTarget: () => lastTarget };
}
