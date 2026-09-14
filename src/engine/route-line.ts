// route-line.ts — D5/B5: full Line2 track, cream, dual-pass occlusion.
// Phase 3A: ONE geometry (never split, no drawRange per frame). Walked vs
// pending is a per-segment distance attribute (C4: LineGeometry is
// instanced — one segment = one instance, so the attribute is instanced and
// the vertex picks its end via position.y) compared against uProgressDist.
// Both passes (ghost GreaterDepth + solid LessEqualDepth, the D5 soft
// occlusion) share the geometry and the same uniform objects.
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { TRACK_DIM_FUTURE, TRACK_DIM_PAST } from "../narrative/choreography.ts";
import { epsgToWorld, sampleGrid, type World } from "./terrain.ts";
import type { RouteData } from "./telemetry.ts";

export function buildRouteLine(
  route: RouteData,
  world: World,
  elev: Float32Array,
  meta: Parameters<typeof sampleGrid>[1],
  resolution: THREE.Vector2,
): { group: THREE.Group; setDim(f: number): void; setProgressDist(dM: number): void } {
  const group = new THREE.Group();
  // drape along the terrain NORMAL (not vertical): offset 4 m scaled by slope
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
    const gz = (route.z[i] as number) - 4 + ny * off;
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
  const patchLine = (m: LineMaterial): void => {
    const prev = m.onBeforeCompile.bind(m);
    m.onBeforeCompile = (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
      prev(shader);
      const uniforms = shader.uniforms as Record<string, unknown>;
      uniforms["uProgressDist"] = uProgressDist;
      uniforms["uDimPast"] = uDimPast;
      uniforms["uDimFuture"] = uDimFuture;
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
varying float vDist; uniform float uProgressDist; uniform float uDimPast; uniform float uDimFuture;`,
        )
        .replace(
          "float alpha = opacity;",
          `float walked = step( vDist, uProgressDist );
float alpha = opacity * mix( uDimFuture, uDimPast, walked );`,
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
  const ghost = new Line2(geo, mk(THREE.GreaterDepth, 0.25));
  const solid = new Line2(geo, mk(THREE.LessEqualDepth, 1));
  ghost.frustumCulled = false;
  solid.frustumCulled = false;
  ghost.renderOrder = 5;
  solid.renderOrder = 6;
  group.add(ghost, solid);
  return {
    group,
    setDim(f: number) {
      (ghost.material as LineMaterial).opacity = 0.25 * f;
      (solid.material as LineMaterial).opacity = 1 * f;
    },
    setProgressDist(dM: number) {
      uProgressDist.value = dM;
    },
  };
}
