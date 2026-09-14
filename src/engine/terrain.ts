// terrain.ts — mesh builder parametrised by step + corridor UV2 blend +
// CPU ray-march over the decoded grid (shared by D7 labels and D2 fit).
import * as THREE from "three";

export interface Meta {
  crs: string;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
  minZ: number;
  maxZ: number;
  corridorBbox?: { minx: number; miny: number; maxx: number; maxy: number };
  assets?: Record<string, string>;
  sizesBytes?: Record<string, number>;
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
  (window as unknown as { __META?: Meta }).__META =
    (window as unknown as { __META?: Meta }).__META;
  const res = await fetch("/assets/meta.json");
  if (!res.ok) throw new Error(`meta.json: HTTP ${res.status}`);
  const m = (await res.json()) as Meta;
  (window as unknown as { __META?: Meta }).__META = m;
  return m;
}

/** Decode the RG heightmap PNG in CPU (exact, no GPU filtering tricks). */
export async function loadElevations(meta: Meta, url?: string): Promise<Float32Array> {
  const src = url ?? `/${meta.assets?.heightmap ?? "assets/heightmap.png"}`;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`heightmap: HTTP ${res.status}`);
  const blob = await res.blob();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
  } catch {
    // fallback for browsers without colorSpaceConversion support
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = document.createElement("img");
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img decode failed"));
        img.src = objUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = meta.width;
      canvas.height = meta.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, meta.width, meta.height).data;
      const n = meta.width * meta.height;
      const elev = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        elev[i] = meta.minZ + (d[i * 4] as number) * 256 + (d[i * 4 + 1] as number);
      }
      return elev;
    } finally {
      URL.revokeObjectURL(objUrl);
    }
  }
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
  const uv2 = new Float32Array(nx * ny * 3); // u, v, blend weight
  const cb = meta.corridorBbox;
  let p = 0;
  let q = 0;
  let r2 = 0;
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
      if (cb) {
        const u = (epsgX - cb.minx) / (cb.maxx - cb.minx);
        const v = (epsgY - cb.miny) / (cb.maxy - cb.miny);
        const edge = 150; // CORRIDOR_BLEND_M
        const dxm = Math.min(epsgX - cb.minx, cb.maxx - epsgX);
        const dym = Math.min(epsgY - cb.miny, cb.maxy - epsgY);
        const wgt = Math.min(1, Math.min(dxm, dym) / edge);
        uv2[r2++] = u;
        uv2[r2++] = v;
        uv2[r2++] = Math.max(0, Math.min(1, wgt));
      } else {
        uv2[r2++] = 0;
        uv2[r2++] = 0;
        uv2[r2++] = 0;
      }
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
  geo.setAttribute("uv2c", new THREE.BufferAttribute(uv2, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

/** Bilinear sample of the decoded grid in EPSG:25830 coords. */
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

/** March a segment over the grid; true if terrain rises above it (+margin). */
export function terrainRayHit(
  elev: Float32Array,
  meta: Meta,
  ox: number,
  oy: number,
  oz: number,
  tx: number,
  ty: number,
  tz: number,
  margin = 3,
): boolean {
  const dist = Math.hypot(tx - ox, ty - oy);
  const steps = Math.min(240, Math.max(8, Math.floor(dist / 20)));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const z = oz + (tz - oz) * f;
    if (sampleGrid(elev, meta, ox + (tx - ox) * f, oy + (ty - oy) * f) > z + margin)
      return true;
  }
  return false;
}
