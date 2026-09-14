// camera-rig.ts — pursuit camera composed from d. Owns collision +
// asymmetric distance smoothing. Constructor NEVER touches the camera
// (C11: with ?orbit=1 the rig is instantiated for poseAt but must not write).
import * as THREE from "three";
import { trackAt, type RouteLike } from "./anchors.ts";
import { buildPchip } from "./curve.ts";
import {
  CAM_CLEARANCE_M,
  COLLIDE_MARGIN_M,
  DIST_MIN_M,
  K_IN,
  K_OUT,
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
  // E1/R3: yaw PCHIP runs on yawS (A9 "hold" excluded) — the return leg is
  // one A8->A10 span. Sampling camSNaN slots would poison the curve.
  const pchipYaw = buildPchip(res.yawS, res.yawUnwrapped, "cam-yaw");
  const pchipH = buildPchip(res.camS, res.camHTarget, "cam-h");
  const D2R = Math.PI / 180;

  let corrSm = 0; // smoothed COLLISION CORRECTION only (A3) — the choreographed dist is followed exactly
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
    return { target, yaw: pchipYaw(s), pitch: pchipPitch(s), hT, distRaw: pchipDist(s) };
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

  /** March target->candidate over the grid; returns the largest safe
   * distance, or distRaw when nothing blocks. */
  function collide(target: [number, number, number], distRaw: number, yaw: number, pitch: number): number {
    const [tx, ty, tz] = target;
    // full-length candidate
    const [cx, cy, cz] = spherical(target, distRaw, pitch, yaw);
    const dx = cx - tx;
    const dy = cy - ty;
    const dz = cz - tz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return distRaw;
    const steps = Math.min(240, Math.max(8, Math.floor(dist / 20)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const px = tx + dx * f;
      const py = ty + dy * f;
      const pz = tz + dz * f;
      const [ex, ey] = worldToEpsg(px, pz, world);
      if (sampleGrid(elev, meta, ex, ey) > py + COLLIDE_MARGIN_M) {
        return Math.max(DIST_MIN_M, dist * ((i - 1) / steps) * 0.9);
      }
    }
    return distRaw;
  }

  function floorClearance(pos: [number, number, number]): number {
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    return sampleGrid(elev, meta, ex, ey) + CAM_CLEARANCE_M;
  }

  function poseAt(s: number): RigPose {
    const sc = Math.min(1, Math.max(0, s));
    const r = rawPose(sc);
    // static pose: collision applied WITHOUT the asymmetric smoothing
    // (smoothing is a temporal concern, poseAt is a pure function of s)
    let dist = collide(r.target, r.distRaw, r.yaw, r.pitch);
    let pos = spherical(r.target, dist, r.pitch, r.yaw);
    const floor = floorClearance(pos);
    if (pos[1] < floor) {
      pos = [pos[0], floor, pos[2]];
      // re-derive dist from the lifted position for honest diagnostics
      dist = Math.hypot(pos[0] - r.target[0], pos[1] - r.target[1], pos[2] - r.target[2]);
    }
    return { pos, target: r.target, yaw: r.yaw, pitch: r.pitch, dist };
  }

  function update(dt: number): void {
    const st = progress.getState();
    const s = Math.min(1, Math.max(0, st.s));
    const r = rawPose(s);
    // A3: choreography is followed EXACTLY; only the collision correction
    // is smoothed (K_IN shorten fast, K_OUT recover slow). The camera can
    // never lag behind its own script, and the 25 m floor is NOT smoothed
    // (instant lift — burying the lens for even one frame is worse than a pop).
    const safe = collide(r.target, r.distRaw, r.yaw, r.pitch);
    const corr = Math.max(0, r.distRaw - safe);
    if (dt > 0 && Number.isFinite(dt)) {
      const k = corr > corrSm ? K_IN : K_OUT;
      corrSm += (corr - corrSm) * (1 - Math.exp(-k * dt));
    } else {
      corrSm = corr;
    }
    const dist = Math.max(DIST_MIN_M, r.distRaw - corrSm);
    let pos = spherical(r.target, dist, r.pitch, r.yaw);
    const floor = floorClearance(pos);
    if (pos[1] < floor) pos = [pos[0], floor, pos[2]];
    deps.camera.position.set(pos[0], pos[1], pos[2]);
    deps.camera.lookAt(r.target[0], r.target[1], r.target[2]);
    lastYaw = r.yaw;
    lastPitch = r.pitch;
    lastTarget = r.target;
    const [ex, ey] = worldToEpsg(pos[0], pos[2], world);
    diag.yaw = r.yaw;
    diag.pitch = r.pitch;
    diag.dist = dist;
    diag.holgura = pos[1] - sampleGrid(elev, meta, ex, ey);
  }

  return { update, poseAt, getDiag: () => diag, getTarget: () => lastTarget };
}
