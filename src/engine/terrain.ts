// terrain.ts — mesh builder parametrised by step. Never assumes a single
// geometry for the whole extent (MDT02 2 m will need a quadtree with
// per-tile LOD; keep this builder pure so tiles can reuse it).
import * as THREE from "three";

export interface Meta {
  crs: string;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number; // west edge (tiepoint)
  originY: number; // north edge (tiepoint)
  minZ: number;
  maxZ: number;
}

export interface World {
  centerX: number;
  centerY: number;
  sizeX: number;
  sizeZ: number;
}

export function worldFromMeta(meta: Meta): World {
  const centerX = (meta.bbox.minx + meta.bbox.maxx) / 2;
  const centerY = (meta.bbox.miny + meta.bbox.maxy) / 2;
  return {
    centerX,
    centerY,
    sizeX: meta.bbox.maxx - meta.bbox.minx,
    sizeZ: meta.bbox.maxy - meta.bbox.miny,
  };
}

/** EPSG:25830 → world (x east, z south-positive flip so north is -z). */
export function epsgToWorld(
  x: number,
  y: number,
  z: number,
  world: World,
): [number, number, number] {
  return [x - world.centerX, z, -(y - world.centerY)];
}

export async function loadMeta(): Promise<Meta> {
  const res = await fetch("/assets/meta.json");
  if (!res.ok) throw new Error(`meta.json: HTTP ${res.status}`);
  return (await res.json()) as Meta;
}

/** Decode the RG heightmap PNG in CPU (exact, no GPU filtering tricks). */
export async function loadElevations(meta: Meta): Promise<Float32Array> {
  const res = await fetch("/assets/heightmap.png");
  if (!res.ok) throw new Error(`heightmap.png: HTTP ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = meta.width;
  canvas.height = meta.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, meta.width, meta.height);
  const d = img.data;
  const n = meta.width * meta.height;
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = meta.minZ + (d[i * 4] as number) * 256 + (d[i * 4 + 1] as number);
  }
  return elev;
}

export function buildTerrainGeometry(
  elev: Float32Array,
  meta: Meta,
  world: World,
  step: number,
): THREE.BufferGeometry {
  const nx = Math.floor((meta.width - 1) / step) + 1;
  const ny = Math.floor((meta.height - 1) / step) + 1;
  const positions = new Float32Array(nx * ny * 3);
  const uvs = new Float32Array(nx * ny * 2);
  let p = 0;
  let q = 0;
  for (let row = 0; row < ny; row++) {
    const srcRow = row * step;
    const epsgY = meta.originY - (srcRow + 0.5) * meta.resY;
    for (let col = 0; col < nx; col++) {
      const srcCol = col * step;
      const epsgX = meta.originX + (srcCol + 0.5) * meta.resX;
      const z = elev[srcRow * meta.width + srcCol] as number;
      positions[p++] = epsgX - world.centerX;
      positions[p++] = z;
      positions[p++] = -(epsgY - world.centerY);
      uvs[q++] = col / (nx - 1);
      uvs[q++] = 1 - row / (ny - 1);
    }
  }
  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let k = 0;
  for (let row = 0; row < ny - 1; row++) {
    for (let col = 0; col < nx - 1; col++) {
      const a = row * nx + col;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

/** Bilinear sample of the decoded grid in EPSG:25830 coords (for HUD readout fallback). */
export function sampleGrid(
  elev: Float32Array,
  meta: Meta,
  x: number,
  y: number,
): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const a = elev[r0 * meta.width + c0] as number;
  const b = elev[r0 * meta.width + c0 + 1] as number;
  const c = elev[(r0 + 1) * meta.width + c0] as number;
  const d = elev[(r0 + 1) * meta.width + c0 + 1] as number;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
