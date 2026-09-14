// route-line.ts — D5/B5: full 3626-point Line2, cream, dual-pass occlusion.
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { epsgToWorld, sampleGrid, type World } from "./terrain.ts";
import type { RouteData } from "./telemetry.ts";

export function buildRouteLine2(
  route: RouteData,
  world: World,
  elev: Float32Array,
  meta: Parameters<typeof sampleGrid>[1],
  resolution: THREE.Vector2,
): { group: THREE.Group; setDim(f: number): void } {
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
    const gy = y + nz * off;
    const gz = (route.z[i] as number) - 4 + ny * off;
    void gy;
    const [wx, wy, wz] = epsgToWorld(gx, y, gz, world);
    pos.push(wx, wy, wz);
  }
  const geo = new LineGeometry();
  geo.setPositions(pos);
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
  };
}
