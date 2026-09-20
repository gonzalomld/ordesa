// camera-rig.ts — C1 BAKED RAIL: the camera is a pure function of s.
// Bake once at construction (bakeCamRail in anchors.ts — shared with
// verify:3a/doctor, no mirrors); runtime samples the table and mounts the
// YXZ quaternion exactly as before. No temporal state, no SLERP, no tween,
// no extra rAF — reversible by construction. Constructor NEVER touches the
// camera (C11: with ?orbit=1 the rig is instantiated for poseAt but must
// not write).
import * as THREE from "three";
import { bakeCamRail, quatYXZ, resolveFollowProfile, type BakedRail, type FollowProfile, type RouteLike } from "./anchors.ts";
import { resolveFollowSafety } from "./collision.ts";
import { CAM_CLEARANCE_M, SUBJECT_X_CLOSED, SUBJECT_X_K, SUBJECT_X_K_REDUCED, SUBJECT_X_OPEN } from "./choreography.ts";
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
  /** G16 (pasada rig puro): DEAD with C1 (no damped H-correction exists —
   * the ladder baked statically). Kept as 0 so the HUD shape holds; the
   * G16 gate now watches the baked mode series instead. */
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

/** Bearing deg-from-north-clockwise of a plan vector (world XZ).
 * North=-z. Re-exported from anchors (single definition). */
export { bearingDeg } from "./anchors.ts";

export function createRig(deps: RigDeps): {
  update(dt: number): void;
  poseAt(s: number): RigPose;
  getDiag(): RigDiag;
  getTarget(): [number, number, number];
  setSubjectClosed(c: boolean): void;
} {
  const { route, world, elev, meta, progress } = deps;
  const res = progress.resolved();
  // C2: el perfil del epílogo se re-deriva con heightfield (Z del
  // centroide + escalera de cobertura G78) antes de hornear. progress.ts
  // no importa engine/terrain (dirección de dependencias); el rig sí.
  const follow: FollowProfile = resolveFollowProfile(
    route,
    (x: number, y: number) => sampleGrid(elev, meta, x, y),
    { minx: meta.bbox.minx, miny: meta.bbox.miny, maxx: meta.bbox.maxx, maxy: meta.bbox.maxy },
  );
  const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");

  // C1 bake (once): EPSG [x, z, y] rail via the shared bakeCamRail.
  const tBake0 = performance.now();
  const rail: BakedRail = bakeCamRail(
    {
      route,
      follow,
      sToD: (s: number) => pchipSD(s),
      sample: (x: number, y: number) => sampleGrid(elev, meta, x, y),
      cx: world.centerX,
      cy: world.centerY,
      fovDeg: deps.camera.fov,
      floorM: CAM_CLEARANCE_M,
    },
    (rope) =>
      resolveFollowSafety(
        (x: number, y: number) => sampleGrid(elev, meta, x, y),
        world.centerX,
        world.centerY,
        { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan },
        route,
        world,
      ),
  );
  const bakeMs = performance.now() - tBake0;
  (window as unknown as { __railBakeMs?: number }).__railBakeMs = bakeMs;

  // EPSG->world (rig convention, single place): wx = ex - cx, wy = alt,
  // wz = -(ey - cy). The rail stores EPSG [x, z, y]: fCamX=easting,
  // fCamY=altitude, fCamZ=northing.
  const e2w = (ex: number, alt: number, ey: number): [number, number, number] => [
    ex - world.centerX,
    alt,
    -(ey - world.centerY),
  ];

  let lastTarget: [number, number, number] = [0, 0, 0];
  const diag: RigDiag = { distPlan: 0, hCam: 0, lookM: 0, backM: 0, holgura: Infinity, yaw: 0, pitch: 0, corrH: 0 };

  // 3B live subject: eases toward its target with 1-exp(-k·dt) (400 ms at
  // k=8, instant with reduced motion). Feeds ONLY setViewOffset — pose,
  // yaw, pitch and s come from the baked rail untouched (G4/G66 intact).
  let subjectX = SUBJECT_X_OPEN;
  let subjectTarget = SUBJECT_X_OPEN;
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onPanelCollapsed = (e: Event): void => {
    const c = (e as CustomEvent<{ collapsed: boolean }>).detail?.collapsed ?? false;
    subjectTarget = c ? SUBJECT_X_CLOSED : SUBJECT_X_OPEN;
  };
  if (typeof window !== "undefined") window.addEventListener("panel:collapsed", onPanelCollapsed);

  function applyViewOffset(dt: number): void {
    const k = reducedMotion ? SUBJECT_X_K_REDUCED : SUBJECT_X_K;
    subjectX += (subjectTarget - subjectX) * (1 - Math.exp(-k * Math.max(0, dt)));
    if (Math.abs(subjectX - 0.5) < 1e-4) {
      deps.camera.clearViewOffset();
    } else {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const offX = (0.5 - subjectX) * w;
      deps.camera.setViewOffset(w, h, offX, 0, w, h);
    }
    (window as unknown as { __subjectX?: number }).__subjectX = subjectX;
  }

  /** 3B: force the framing target (folded/narrow/orbit/?cam= -> CLOSED). */
  function setSubjectClosed(closed: boolean): void {
    subjectTarget = closed ? SUBJECT_X_CLOSED : SUBJECT_X_OPEN;
  }

  function poseAt(s: number): RigPose {
    const sc = Math.min(1, Math.max(0, s));
    const yaw = rail.fYaw(sc);
    const pitch = rail.fPitch(sc);
    const pos = e2w(rail.fCamX(sc), rail.fCamY(sc), rail.fCamZ(sc));
    const target = e2w(rail.fAimX(sc), rail.fAimY(sc), rail.fAimZ(sc));
    const quat = quatYXZ(yaw, pitch);
    const dp = Math.hypot(pos[0] - target[0], pos[2] - target[2]);
    return { pos, target, yaw, pitch, quaternion: quat, dist: dp, hCam: 0, lookM: 0, backM: 0 };
  }

  function update(dt: number): void {
    void dt; // C1: no temporal state — update samples the rail like poseAt.
    const st = progress.getState();
    const s = Math.min(1, Math.max(0, st.s));
    const yaw = rail.fYaw(s);
    const pitch = rail.fPitch(s);
    const pos = e2w(rail.fCamX(s), rail.fCamY(s), rail.fCamZ(s));
    const aim = e2w(rail.fAimX(s), rail.fAimY(s), rail.fAimZ(s));
    const quat = quatYXZ(yaw, pitch);
    deps.camera.position.set(pos[0], pos[1], pos[2]);
    deps.camera.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    // 3B: dt clamped like the scroll loop (<=250 ms); C1 pose stays pure.
    applyViewOffset(Math.min(0.25, Math.max(0, dt)));
    lastTarget = aim;
    diag.distPlan = Math.hypot(pos[0] - aim[0], pos[2] - aim[2]);
    diag.hCam = 0;
    diag.lookM = 0;
    diag.backM = 0;
    const ex = pos[0] + world.centerX;
    const ey = world.centerY - pos[2];
    diag.holgura = pos[1] - sampleGrid(elev, meta, ex, ey);
    diag.yaw = yaw;
    diag.pitch = pitch;
    diag.corrH = 0;
  }

  return { update, poseAt, getDiag: () => diag, getTarget: () => lastTarget, setSubjectClosed };
}

// Re-exported for verify:3a (same construction, no mirror).
export { followAt } from "./anchors.ts";
