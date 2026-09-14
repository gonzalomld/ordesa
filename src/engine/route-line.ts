// route-line.ts — D5/B5: full Line2 track, cream, dual-pass occlusion +
// E3 halo pass. Phase 3A: ONE geometry (never split, no drawRange per
// frame). Walked vs pending is a per-segment distance attribute (C4:
// LineGeometry is instanced — one segment = one instance, so the attribute
// is instanced and the vertex picks its end via position.y) compared
// against uProgressDist. E2: the road ahead does not exist — pending alpha
// is 0 with a 40 m soft tip; the epilogue (s>=0.98) raises uProgressDist to
// lengthM so the whole loop draws. E3: width follows camera-target
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
  TRACK_TIP_FADE_M,
} from "../narrative/choreography.ts";
import { epsgToWorld, sampleGrid, type World } from "./terrain.ts";
import type { RouteData } from "./telemetry.ts";

export interface RouteLine {
  group: THREE.Group;
  setDim(f: number): void;
  setProgressDist(dM: number): void;
  /** E3: call every frame — width from camera distance, glow from journey s. */
  setFraming(camDistM: number, glow01: number): void;
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
  // C4: per-segment accumulated distance (instanced: n-1 segments)
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
  const uTipFade = { value: TRACK_TIP_FADE_M };
  const patchLine = (m: LineMaterial): void => {
    const prev = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
      prev(shader);
      const uniforms = shader.uniforms as Record<string, unknown>;
      uniforms["uProgressDist"] = uProgressDist;
      uniforms["uDimPast"] = uDimPast;
      uniforms["uDimFuture"] = uDimFuture;
      uniforms["uTipFade"] = uTipFade;
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
varying float vDist; uniform float uProgressDist; uniform float uDimPast; uniform float uDimFuture; uniform float uTipFade;`,
        )
        .replace(
          "float alpha = opacity;",
          // E2: ahead does not exist (uDimFuture = 0); 40 m soft tip so the
          // head is a fade, not a chop. Ghost + solid share the rule.
          `float head = 1.0 - smoothstep( uProgressDist - uTipFade, uProgressDist, vDist );
float alpha = opacity * mix( uDimFuture, uDimPast * head, step( vDist, uProgressDist ) );`,
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
    setFraming(camDistM: number, glow01: number) {
      // E3: 2 px beyond 1200 m, 7 px under 400 m, smoothstep between.
      // Halo width tracks x3; its opacity tracks uGlow (0 away from hitos).
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
