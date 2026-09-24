// tiles-overlay.ts — T1 ?debug=tiles instrument: resident-tile grid.
//
// Coloured Line2 rectangles on the tile edges (one hue per atlas slot, so
// a tile in the wrong hole shows instantly) + atlas-slot numbers as CSS
// labels pinned to the tile centres (projected once — pure instrument,
// never in the production bundle, never writes piece state).
// Also publishes window.__tiles for the capture:
//   { tiles, resident, slots, residentM2, gridCols, gridRows }
import * as THREE from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { Meta } from "./terrain.ts";
import { TILE_GRID, TILE_SLOTS, type TileSlot } from "../generated/tiles.ts";

export interface TilesMount {
  group: THREE.Group;
  labels: HTMLDivElement;
  info: { tiles: number; resident: number; slots: number[] };
}

/** Hue per atlas slot (evenly spaced, full saturation/value). */
export function slotColor(slot: number): number {
  const h = ((slot * 360) / 16 / 360) % 1;
  const s = 1;
  const v = 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  if (i % 6 === 0) { r = v; g = t; b = p; }
  else if (i % 6 === 1) { r = q; g = v; b = p; }
  else if (i % 6 === 2) { r = p; g = v; b = t; }
  else if (i % 6 === 3) { r = p; g = q; b = v; }
  else if (i % 6 === 4) { r = t; g = p; b = v; }
  else { r = v; g = p; b = q; }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

export function mountTilesOverlay(
  meta: Meta,
  elev: Float32Array,
  world: { centerX: number; centerY: number },
  camera: THREE.Camera,
  resolution: THREE.Vector2,
): TilesMount {
  void meta;
  void camera;
  void elev;
  const group = new THREE.Group();
  const labels = document.createElement("div");
  labels.className = "tiles-labels";
  labels.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden;";
  // T1: los bordes viven a +30 m sobre el heightmap (sampleGridLocal) para
  // que el propio bloque negro NO los oculte con depthTest (el overlay mide
  // la rejilla, no la oculta). Sin esto la rejilla se entierra bajo el
  // bloque que mide y parece "desplazada" aunque esté en su sitio.
  const LIFT_M = 30;
  const sample = (x: number, y: number): number => {
    // bilinear on the decoded heightmap grid (same scheme as terrain.ts)
    const m = (window as unknown as { __META?: Meta }).__META;
    return sampleGridLocal(elev, m as Meta, x, y);
  };
  const slots = TILE_SLOTS as TileSlot[];
  for (const s of slots) {
    const x0 = TILE_GRID.originX + s.c * TILE_GRID.tileM;
    const y0 = TILE_GRID.originY + s.r * TILE_GRID.tileM;
    const x1 = x0 + TILE_GRID.tileM;
    const y1 = y0 + TILE_GRID.tileM;
    const corners: Array<[number, number]> = [
      [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
    ];
    const pts: number[] = [];
    for (const [ex, ey] of corners) {
      const z = sample(ex, ey) + LIFT_M;
      pts.push(ex - world.centerX, z, -(ey - world.centerY));
    }
    const geo = new LineGeometry();
    geo.setPositions(pts);
    const mat = new LineMaterial({
      color: slotColor(s.slot),
      linewidth: 3,
      worldUnits: false,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,
    });
    mat.resolution.copy(resolution);
    const line = new Line2(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 9;
    group.add(line);
    // centre label: project once at mount (the debug camera is static
    // per capture; the grid itself is geometry and stays correct).
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const cz = sample(cx, cy) + LIFT_M;
    const v = new THREE.Vector3(cx - world.centerX, cz, -(cy - world.centerY));
    v.project(camera);
    const lab = document.createElement("div");
    lab.textContent = String(s.slot);
    lab.style.cssText =
      `position:absolute;left:${((v.x * 0.5 + 0.5) * 100).toFixed(1)}%;` +
      `top:${((-v.y * 0.5 + 0.5) * 100).toFixed(1)}%;transform:translate(-50%,-50%);` +
      `font:600 13px/1 system-ui;color:#fff;text-shadow:0 0 4px #000,0 0 4px #000;`;
    labels.appendChild(lab);
  }
  document.body.appendChild(labels);
  const info = {
    tiles: TILE_GRID.cols * TILE_GRID.rows,
    resident: slots.length,
    slots: slots.map((s) => s.slot),
  };
  (window as unknown as { __tiles?: unknown }).__tiles = {
    ...info,
    gridCols: TILE_GRID.cols,
    gridRows: TILE_GRID.rows,
    tileM: TILE_GRID.tileM,
    borderM: TILE_GRID.borderM,
  };
  return { group, labels, info };
}

function sampleGridLocal(elev: Float32Array, m: Meta, x: number, y: number): number {
  const col = (x - m.originX) / m.resX - 0.5;
  const row = (m.originY - y) / m.resY - 0.5;
  const c0 = Math.max(0, Math.min(m.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(m.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const a = elev[r0 * m.width + c0] as number;
  const b = elev[r0 * m.width + c0 + 1] as number;
  const c = elev[(r0 + 1) * m.width + c0] as number;
  const d = elev[(r0 + 1) * m.width + c0 + 1] as number;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
