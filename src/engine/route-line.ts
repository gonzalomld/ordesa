// route-line.ts — D5/B5: full Line2 track, cream, dual-pass occlusion +
// E3 halo pass. Phase 3A: ONE geometry (never split, no drawRange per
// frame). Walked vs pending is a per-segment distance attribute (C4:
// LineGeometry is instanced — one segment = one instance, so the attribute
// is instanced and the vertex picks its end via position.y) compared
// against uProgressDist. E2: the road ahead does not exist — pending alpha
// is 0 with a TRACK_FADE_M tip; the epilogue (s>=0.98) raises uProgressDist
// to lengthM so the whole loop draws. E3: width follows camera-target
// distance (2 px far .. 7 px near) + an additive x3 halo gated by uGlow
// near A3/A7/A8. All three passes share the geometry and the uniforms.
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import {
  GLOW_ALPHA,
  GLOW_MULT,
  LINE_W_D_FAR,
  LINE_W_D_NEAR,
  LINE_W_FAR,
  LINE_W_NEAR,
  TRACK_DIM_FUTURE,
  TRACK_DIM_PAST,
  TRACK_FADE_M,
} from "../narrative/choreography.ts";
import { epsgToWorld, sampleGrid, type World } from "./terrain.ts";
import type { RouteData } from "./telemetry.ts";

export interface RouteLine {
  group: THREE.Group;
  setDim(f: number): void;
  setProgressDist(dM: number): void;
  /** E3: call every frame — width from camera distance, glow from journey s. */
  setFraming(camDistM: number, glow01: number): void;
  /** BLOQUEANTE isolation probe: expose the shared uniform for tests. */
  debugProgressDist(): number;
  /** ?debug=trackdist: gradient probe (blue Pradera → red Cola). */
  setTrackDistMode(on: boolean): void;
  /** HUD audit: first/last vDist sample + instance count. */
  debugIds(): { first: number; last: number; count: number };
  /** G15 (pasada rig puro): offscreen ID pass — render ONLY the solid Line2
   * (no terrain, no halo, flat unlit colour) into a 256x144 target and count
   * non-null pixels. A 1088-point grid cannot see a 2 px line; this can. */
  countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number;
}

/** Shared offscreen counter: one target, one readPixels, one loop.
 * Used by G12 (sky/void occluder pass) and G15 (track ID pass). */
export function renderCount(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  buf: Uint8Array,
  scene: THREE.Scene,
  camera: THREE.Camera,
  w: number,
  h: number,
  isHit: (r: number, g: number, b: number) => boolean,
): number {
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
  renderer.setRenderTarget(prev);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (isHit(buf[i * 4] as number, buf[i * 4 + 1] as number, buf[i * 4 + 2] as number)) n++;
  }
  return n;
}

export function buildRouteLine(
  route: RouteData,
  world: World,
  elev: Float32Array,
  meta: Parameters<typeof sampleGrid>[1],
  resolution: THREE.Vector2,
  /** E4: mesh vertex heights at LOD step (same lattice the GPU draws).
   * When given, line Z samples the MESH height (same filter as the vertex),
   * not the full-res MDT — two heights for the same point then coincide. */
  meshZ?: (x: number, y: number) => number,
): RouteLine {
  const group = new THREE.Group();
  // drape along the terrain NORMAL (not vertical): offset 4 m scaled by slope.
  // E4: the height under the line is meshZ (LOD lattice) when provided —
  // the mesh vertex filter, not the full-res MDT — so line and ground agree
  // even where decimation flattened a gully. Slope still comes from the
  // full grid (stable normals); only the height is lattice-quantised.
  const pos: number[] = [];
  for (let i = 0; i < route.n; i++) {
    const x = route.x[i] as number;
    const y = route.y[i] as number;
    const e = 5;
    const dzdx = (sampleGrid(elev, meta, x + e, y) - sampleGrid(elev, meta, x - e, y)) / (2 * e);
    const dzdy = (sampleGrid(elev, meta, x, y + e) - sampleGrid(elev, meta, x, y - e)) / (2 * e);
    const inv = 1 / Math.hypot(dzdx, dzdy, 1);
    const nx = -dzdx * inv;
    const ny = inv;
    const nz = dzdy * inv; // north component
    const off = 4 / Math.max(0.45, ny); // more clearance on steep walls
    const gx = x + nx * off;
    const gy = y + nz * off;
    // E4: mesh-lattice height (+4 drape含む source parity with route.z when
    // no meshZ) then the normal offset along Y.
    const base = meshZ ? meshZ(gx, gy) + 4 : sampleGrid(elev, meta, gx, gy);
    const gz = base - 4 + ny * off;
    void nz;
    const [wx, wy, wz] = epsgToWorld(gx, y, gz, world);
    pos.push(wx, wy, wz);
  }
  const geo = new LineGeometry();
  geo.setPositions(pos);
  // C4: per-segment accumulated distance (instanced: n-1 segments, METRES
  // in route.d — doctor prints instanceDistEnd min/max to prove the units;
  // an index-vs-metres mixup here blanks the line until km 3.6).
  const nSeg = Math.max(0, route.n - 1);
  const dStart = new Float32Array(nSeg);
  const dEnd = new Float32Array(nSeg);
  for (let i = 0; i < nSeg; i++) {
    dStart[i] = route.d[i] as number;
    dEnd[i] = route.d[i + 1] as number;
  }
  geo.setAttribute("instanceDistStart", new THREE.InstancedBufferAttribute(dStart, 1));
  geo.setAttribute("instanceDistEnd", new THREE.InstancedBufferAttribute(dEnd, 1));

  const uProgressDist = { value: 0 };
  const uDimPast = { value: TRACK_DIM_PAST };
  const uDimFuture = { value: TRACK_DIM_FUTURE };
  const uTipFade = { value: TRACK_FADE_M };
  const uLengthM = { value: route.lengthM };
  const uTrackDist = { value: 0 };
  const patchLine = (m: LineMaterial): void => {
    const prev = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
      prev(shader);
      const uniforms = shader.uniforms as Record<string, unknown>;
      uniforms["uProgressDist"] = uProgressDist;
      uniforms["uDimPast"] = uDimPast;
      uniforms["uDimFuture"] = uDimFuture;
      uniforms["uTipFade"] = uTipFade;
      uniforms["uLengthM"] = uLengthM;
      uniforms["uTrackDist"] = uTrackDist;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
attribute float instanceDistStart; attribute float instanceDistEnd; varying float vDist;`,
        )
        .replace(
          "void main() {",
          `void main() {
vDist = ( position.y < 0.5 ) ? instanceDistStart : instanceDistEnd;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying float vDist; uniform float uProgressDist; uniform float uDimPast; uniform float uDimFuture; uniform float uTipFade; uniform float uLengthM; uniform float uTrackDist;`,
        )
        .replace(
          "float alpha = opacity;",
          // E2: ahead does not exist (uDimFuture = 0); the tip fade is the
          // visible head (TRACK_FADE_M, audit: 180 m at drone distance).
          // Ghost + solid share the rule.
          // ?debug=trackdist: gradient probe INSTEAD of the cut — blue
          // Pradera, red Cola, blue again on return. One load, one answer.
          `float head = 1.0 - smoothstep( uProgressDist - uTipFade, uProgressDist, vDist );
float alpha = opacity * mix( uDimFuture, uDimPast * head, step( vDist, uProgressDist ) );
if ( uTrackDist > 0.5 ) { diffuseColor.rgb = vec3( vDist / uLengthM, 0.0, 1.0 - vDist / uLengthM ); alpha = opacity; }`,
        );
    };
    m.customProgramCacheKey = () => "ordesa-route-progress";
  };
  const mk = (depthFunc: THREE.DepthFunctions, opacity: number): LineMaterial => {
    const m = new LineMaterial({
      color: 0xefe3c8,
      linewidth: 2.75,
      worldUnits: false,
      alphaToCoverage: false,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
    });
    m.depthFunc = depthFunc;
    m.resolution.copy(resolution);
    patchLine(m);
    return m;
  };
  const ghostMat = mk(THREE.GreaterDepth, 0.25);
  const solidMat = mk(THREE.LessEqualDepth, 1);
  const ghost = new Line2(geo, ghostMat);
  const solid = new Line2(geo, solidMat);
  ghost.frustumCulled = false;
  solid.frustumCulled = false;
  ghost.renderOrder = 5;
  solid.renderOrder = 6;
  group.add(ghost, solid);
  // E3 halo: same geometry, drawn first, width x3, additive cream at 18%.
  const haloMat = mk(THREE.LessEqualDepth, GLOW_ALPHA);
  haloMat.blending = THREE.AdditiveBlending;
  const halo = new Line2(geo, haloMat);
  halo.frustumCulled = false;
  halo.renderOrder = 4;
  group.add(halo);
  // G15 ID pass: the SAME solid Line2, flat unlit material, rendered alone
  // into a 256x144 target. Patched with the SAME cut (uProgressDist shared)
  // — the ID pass answers "does the user see the path?", not "does the
  // geometry paint". Without the cut it always drew the whole line (97 px
  // with the trail invisible on screen).
  const idMat = new LineMaterial({ color: 0xffffff, linewidth: 2, worldUnits: false, alphaToCoverage: false });
  idMat.resolution.set(256, 144);
  patchLine(idMat);
  const idLine = new Line2(geo, idMat);
  idLine.frustumCulled = false;
  const idScene = new THREE.Scene();
  idScene.add(idLine);
  const idTarget = new THREE.WebGLRenderTarget(256, 144, { depthBuffer: true });
  const idBuf = new Uint8Array(256 * 144 * 4);
  return {
    group,
    setDim(f: number) {
      ghostMat.opacity = 0.25 * f;
      solidMat.opacity = 1 * f;
      haloMat.opacity = GLOW_ALPHA * f;
    },
    setProgressDist(dM: number) {
      uProgressDist.value = dM;
    },
    debugProgressDist() {
      return uProgressDist.value;
    },
    setTrackDistMode(on: boolean) {
      uTrackDist.value = on ? 1 : 0;
    },
    debugIds() {
      const attr = geo.getAttribute("instanceDistEnd") as THREE.InstancedBufferAttribute | undefined;
      const arr = attr?.array as ArrayLike<number> | undefined;
      if (!attr || !arr || arr.length === 0) return { first: NaN, last: NaN, count: 0 };
      return { first: arr[0] as number, last: arr[arr.length - 1] as number, count: attr.count };
    },
    countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
      // G15: ID pass WITH the progress cut (idMat shares uProgressDist).
      // Shared helper: one target, one readPixels, one loop.
      return renderCount(renderer, idTarget, idBuf, idScene, camera, 256, 144,
        (rr, gg, bb) => rr > 4 || gg > 4 || bb > 4);
    },
    setFraming(camDistM: number, glow01: number) {
      // E3 drone revision (pasada rig puro): 2 px beyond 2000 m, 3 px under
      // 600 m. The far line stays thin; only the immediate foreground fattens.
      const f = Math.min(1, Math.max(0, (LINE_W_D_FAR - camDistM) / (LINE_W_D_FAR - LINE_W_D_NEAR)));
      const s = f * f * (3 - 2 * f);
      const w = LINE_W_FAR + (LINE_W_NEAR - LINE_W_FAR) * s;
      solidMat.linewidth = w;
      ghostMat.linewidth = w;
      haloMat.linewidth = w * GLOW_MULT;
      const g = Math.min(1, Math.max(0, glow01));
      haloMat.opacity = GLOW_ALPHA * g;
    },
  };
}
