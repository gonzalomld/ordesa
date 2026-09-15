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
  corridor?: { x: Float32Array; y: Float32Array; halfM: number },
): THREE.BufferGeometry {
  const nx = Math.floor((meta.width - 1) / step) + 1;
  const ny = Math.floor((meta.height - 1) / step) + 1;
  // E4: if a corridor is given, grid vertices within halfM of ANY track
  // point snap to step 1 (no decimation along the path). Implementation:
  // dense rows/cols around the track bbox at full res, coarse elsewhere is
  // overkill — instead we densify by choosing per-column/per-row source
  // indices: full-res indices inside the corridor band, stepped outside.
  // Simpler and exact: build at step, then overwrite corridor vertices with
  // the full-res sample (same filter as the vertex would use at LOD 0).
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
  if (corridor) snapCorridorToFullRes(geo, elev, meta, nx, ny, step, corridor);
  geo.computeVertexNormals();
  return geo;
}

/** E4 step-N height: what the GPU draws at (x,y) — bilinear over the step-N
 * vertex lattice. Exported so the viewer drapes the line on the SAME lattice
 * the terrain draws (G13). Inside the snapped corridor the mesh carries
 * full-res heights instead; G13 mirrors that with its own corridor test. */
export function meshHeightAtStep(
  elev: Float32Array,
  meta: Meta,
  x: number,
  y: number,
  step: number,
): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const lc = Math.floor(col / step) * step;
  const lr = Math.floor(row / step) * step;
  const fx = Math.min(1, Math.max(0, (col - lc) / step));
  const fy = Math.min(1, Math.max(0, (row - lr) / step));
  const W = meta.width;
  const H = meta.height;
  const at = (c: number, r: number): number =>
    elev[Math.min(H - 1, Math.max(0, r)) * W + Math.min(W - 1, Math.max(0, c))] as number;
  const c0 = Math.min(W - 1 - step, Math.max(0, lc));
  const r0 = Math.min(H - 1 - step, Math.max(0, lr));
  const a = at(c0, r0);
  const b = at(Math.min(W - 1, c0 + step), r0);
  const c = at(c0, Math.min(H - 1, r0 + step));
  const d = at(Math.min(W - 1, c0 + step), Math.min(H - 1, r0 + step));
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Back-compat alias (step 2). Prefer meshHeightAtStep with the live LOD. */
export function meshHeightAtStep2(
  elev: Float32Array,
  meta: Meta,
  x: number,
  y: number,
): number {
  return meshHeightAtStep(elev, meta, x, y, 2);
}

/** E4: overwrite mesh vertices near the track with the full-res heightmap
 * sample — the same filter a LOD-0 vertex would use. Path and ground then
 * coincide by construction instead of by luck. */
function snapCorridorToFullRes(
  geo: THREE.BufferGeometry,
  elev: Float32Array,
  meta: Meta,
  nx: number,
  ny: number,
  step: number,
  corridor: { x: Float32Array; y: Float32Array; halfM: number },
): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  // coarse spatial hash over track points (cell = halfM) for O(1) lookup
  const cell = corridor.halfM;
  const inv = 1 / cell;
  const minX = meta.bbox.minx;
  const minY = meta.bbox.miny;
  const key = (cx: number, cy: number): number => cx * 4096 + cy;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < corridor.x.length; i++) {
    const k = key(
      Math.floor(((corridor.x[i] as number) - minX) * inv),
      Math.floor(((corridor.y[i] as number) - minY) * inv),
    );
    let b = buckets.get(k);
    if (!b) {
      b = [];
      buckets.set(k, b);
    }
    b.push(i);
  }
  const half2 = corridor.halfM * corridor.halfM;
  for (let row = 0; row < ny; row++) {
    const srcRow = row * step;
    const epsgY = meta.originY - (srcRow + 0.5) * meta.resY;
    for (let col = 0; col < nx; col++) {
      const srcCol = col * step;
      const epsgX = meta.originX + (srcCol + 0.5) * meta.resX;
      const ccx = Math.floor((epsgX - minX) * inv);
      const ccy = Math.floor((epsgY - minY) * inv);
      let near = false;
      for (let ax = -1; ax <= 1 && !near; ax++) {
        for (let ay = -1; ay <= 1 && !near; ay++) {
          const b = buckets.get(key(ccx + ax, ccy + ay));
          if (!b) continue;
          for (const i of b) {
            const dx = (corridor.x[i] as number) - epsgX;
            const dy = (corridor.y[i] as number) - epsgY;
            if (dx * dx + dy * dy <= half2) {
              near = true;
              break;
            }
          }
        }
      }
      if (near) {
        // full-res sample: nearest grid cell (what a step-1 vertex reads)
        const fc = Math.min(meta.width - 1, Math.max(0, Math.round((epsgX - meta.originX) / meta.resX - 0.5)));
        const fr = Math.min(meta.height - 1, Math.max(0, Math.round((meta.originY - epsgY) / meta.resY - 0.5)));
        pos.setY(row * nx + col, elev[fr * meta.width + fc] as number);
      }
    }
  }
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
