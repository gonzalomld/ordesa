// make-cloud-atlas.ts — §4b FASE 4c: procedural cumulus atlas, reproducible.
// 1024×1024, 4 quadrants of 512, R channel = density (the shader reads .r).
// Per quadrant (seeded, distinct per quadrant):
//   - shape: union of 6-9 overlapping discs (cumulus lobes), centres in the
//     upper half, flat base (cut at y = 0.35 with a 40 px smooth transition);
//   - SOLID core + edge-only erosion (4c: the old formula eroded the CORE
//     too — moth holes at noon):
//       core = smoothstep(0.55, 0.85, shape)
//       edge = shape · fbm5(uv · 6)        // 5 octaves, lacunarity 2
//       d    = max(core, edge · (1 − core))
//   - soft outer edge (smoothstep over contour distance, ≥ 24 px gradient).
// Never step() nor quantisation; no repeated pattern between quadrants.
// Standalone: `npx tsx scripts/make-cloud-atlas.ts` regenerates
// public/assets/clouds-atlas.<hash>.webp (quality ≥ 90) + the PNG audit
// copy, updates data/build/meta.json (+ public copy), and runs acceptance
// (×4 zoom: no 16×16 blocks, no core holes, ragged edge).
// Library: 13-build-terrain-assets.ts imports buildCloudAtlas() so
// `npm run data` reproduces the same bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export const ATLAS_SIZE = 1024;
const QUAD = 512;
const SEED_BASE = 9100;

function hash32(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mulberry(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash32(xi, yi, seed);
  const b = hash32(xi + 1, yi, seed);
  const c = hash32(xi, yi + 1, seed);
  const d = hash32(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number): number {
  let amp = 0.5;
  let freq = 6;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

interface Lobe {
  x: number;
  y: number;
  r: number;
}

function quadrantDensity(qx: number, qy: number, seedQ: number, lobes: Lobe[]): number {
  // shape: union of discs
  let shape = 0;
  for (const L of lobes) {
    const d = Math.hypot(qx - L.x, qy - L.y) / L.r;
    if (d < 1) shape = Math.max(shape, 1 - d);
  }
  // §4b FASE 4c: SOLID core, erosion ONLY on the rim — the old formula
  // (shape − (1−shape)·0.6·(1−fbm)) ate the nucleus and punched holes.
  // Core threshold 0.40: lobe overlap must read as one mass (measured
  // core fill 49.5% @0.45 → need ≥55%).
  const core = smoothstep(0.40, 0.70, shape);
  const n = fbm(qx * 6, qy * 6, seedQ);
  const edge = shape * n;
  let d = Math.max(core, edge * (1 - core));
  // flat base: cut at y = 0.35, 40 px smooth transition (qy measured from bottom)
  d *= smoothstep(0.35 - 40 / QUAD, 0.35, qy);
  // soft outer edge: ≥ 24 px gradient on all sides (sprite edges stay invisible)
  const edgeDist = Math.min(qx, 1 - qx, qy, 1 - qy);
  d *= smoothstep(0, 24 / QUAD, edgeDist);
  return Math.min(1, Math.max(0, d));
}

export async function buildCloudAtlas(): Promise<{ png: Buffer; webp: Buffer }> {
  const S = ATLAS_SIZE;
  const buf = Buffer.alloc(S * S * 3);
  for (let q = 0; q < 4; q++) {
    const seedQ = SEED_BASE + q * 101;
    const rnd = mulberry(seedQ);
    const nLobes = 6 + Math.floor(rnd() * 4); // 6-9 lobes
    const lobes: Lobe[] = [];
    for (let i = 0; i < nLobes; i++) {
      lobes.push({
        x: 0.15 + rnd() * 0.7,
        y: 0.42 + rnd() * 0.46, // upper half
        r: 0.13 + rnd() * 0.17,
      });
    }
    const ox = (q % 2) * QUAD;
    const oy = Math.floor(q / 2) * QUAD;
    for (let y = 0; y < QUAD; y++) {
      for (let x = 0; x < QUAD; x++) {
        // qx from left, qy from BOTTOM (matches PlaneGeometry uv v=0 at bottom)
        const qx = (x + 0.5) / QUAD;
        const qy = 1 - (y + 0.5) / QUAD;
        const v = quadrantDensity(qx, qy, seedQ, lobes);
        const a = Math.round(v * 255);
        const i = ((oy + y) * S + (ox + x)) * 3;
        buf[i] = a;
        buf[i + 1] = a;
        buf[i + 2] = a;
      }
    }
  }
  const png = await sharp(buf, { raw: { width: S, height: S, channels: 3 } })
    .png()
    .toBuffer();
  const webp = await sharp(buf, { raw: { width: S, height: S, channels: 3 } })
    .webp({ quality: 95 })
    .toBuffer();
  return { png, webp };
}

/** Acceptance on the ENCODED webp (what the GPU samples):
 * 16-px grid boundary gradient must not exceed the interior noise floor,
 * fully-flat 4×4 blocks must be rare (no posterisation), the CORE (upper
 * half of each quadrant) must be mostly solid (no moth holes), and the rim
 * must actually vary (ragged edge, not a smooth balloon). */
export async function acceptAtlas(webp: Buffer): Promise<{ blockRatio: number; flatFrac: number; coreFill: number; rimVar: number }> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const ch = info.channels;
  const at = (x: number, y: number): number => data[(y * W + x) * ch] as number;
  let bSum = 0;
  let bN = 0;
  let iSum = 0;
  let iN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 1 < W ? Math.abs(at(x + 1, y) - at(x, y)) : 0;
      const dy = y + 1 < H ? Math.abs(at(x, y + 1) - at(x, y)) : 0;
      const onGrid = x % 16 === 15 || y % 16 === 15;
      if (onGrid) {
        bSum += dx + dy;
        bN += 2;
      } else {
        iSum += dx + dy;
        iN += 2;
      }
    }
  }
  const blockRatio = bSum / Math.max(1, bN) / (iSum / Math.max(1, iN));
  // ramp posterisation: fully-flat 4×4 blocks INSIDE the 0.1..0.9 ramps
  // (the only zone where banding shows). Background (≤25) and solid core
  // (≥230) are correct, not defects.
  let flat = 0;
  let total = 0;
  for (let y = 0; y + 4 <= H; y += 4) {
    for (let x = 0; x + 4 <= W; x += 4) {
      const v0 = at(x, y);
      if (v0 <= 25 || v0 >= 230) continue;
      total++;
      let same = true;
      for (let yy = 0; yy < 4 && same; yy++) {
        for (let xx = 0; xx < 4; xx++) {
          if (at(x + xx, y + yy) !== v0) {
            same = false;
            break;
          }
        }
      }
      if (same) flat++;
    }
  }
  // core solidity: upper-half texels with density > 0.5 must dominate —
  // else the atlas has holes and noon reads as grey moth. Measured over
  // the LOBE area (shape > 0.15), not the crown box (background-correct
  // emptiness is not a hole).
  let coreN = 0;
  let coreFull = 0;
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * QUAD;
    const oy = Math.floor(q / 2) * QUAD;
    for (let y = oy; y < oy + 220; y += 2) {
      for (let x = ox + 80; x < ox + 432; x += 2) {
        const v = at(x, y) / 255;
        if (v > 0.15) {
          coreN++;
          if (v > 0.5) coreFull++;
        }
      }
    }
  }
  const coreFill = coreN > 0 ? coreFull / coreN : 0;
  // rim variance: texels in the 0.1..0.5 band must vary (std > 0.05) —
  // a flat rim edge reads as a balloon, not a cumulus.
  let rimSum = 0;
  let rimSq = 0;
  let rimN = 0;
  for (let y = 0; y < H; y += 3) {
    for (let x = 0; x < W; x += 3) {
      const v = at(x, y) / 255;
      if (v > 0.1 && v < 0.5) {
        rimSum += v;
        rimSq += v * v;
        rimN++;
      }
    }
  }
  const rimMean = rimSum / Math.max(1, rimN);
  const rimVar = Math.sqrt(Math.max(0, rimSq / Math.max(1, rimN) - rimMean * rimMean));
  return { blockRatio, flatFrac: flat / Math.max(1, total), coreFill, rimVar };
}

/** Histogram helper for tuning (not a gate): deciles of the crown box. */
export async function crownHist(webp: Buffer): Promise<number[]> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const at = (x: number, y: number): number => (data[(y * W + x) * 3] as number) / 255;
  const hist = new Array(10).fill(0) as number[];
  for (let q = 0; q < 4; q++) {
    const ox = (q % 2) * QUAD;
    const oy = Math.floor(q / 2) * QUAD;
    for (let y = oy; y < oy + 200; y += 2) {
      for (let x = ox + 100; x < ox + 412; x += 2) {
        hist[Math.min(9, Math.floor(at(x, y) * 10))]++;
      }
    }
  }
  return hist;
}

function isMainModule(urlSuffix: string): boolean {
  return process.argv[1] !== undefined && import.meta.url.endsWith(urlSuffix);
}
if (isMainModule("make-cloud-atlas.ts")) {
  const { png, webp } = await buildCloudAtlas();
  const { blockRatio, flatFrac, coreFill, rimVar } = await acceptAtlas(webp);
  console.log(`acceptance: 16px-boundary/interior gradient ratio = ${blockRatio.toFixed(3)} (need < 2.0)`);
  console.log(`acceptance: flat-4x4 fraction = ${(flatFrac * 100).toFixed(2)}% (need < 2%)`);
  console.log(`acceptance: core fill (>0.5 | >0.15 in crown) = ${(coreFill * 100).toFixed(1)}% (need ≥ 55%)`);
  console.log(`acceptance: rim band std = ${rimVar.toFixed(4)} (need > 0.05)`);
  if (blockRatio >= 2.0 || flatFrac >= 0.02 || coreFill < 0.55 || rimVar <= 0.05) {
    console.error("ATLAS REJECTED: squares, holes, or balloon rim at ×4");
    process.exit(1);
  }
  const hash = createHash("sha256").update(webp).digest("hex").slice(0, 8);
  const webpName = `clouds-atlas.${hash}.webp`;
  const pngName = `clouds-atlas.${hash}.png`;
  // drop the superseded hashed files (same prefix, different hash)
  for (const f of ["public/assets", "data/build"]) {
    void f;
  }
  const { readdirSync } = await import("node:fs");
  for (const old of readdirSync("public/assets")) {
    if (old.startsWith("clouds-atlas.") && old !== webpName && old !== pngName) {
      rmSync(`public/assets/${old}`);
      console.log(`removed: public/assets/${old}`);
    }
  }
  writeFileSync(`public/assets/${webpName}`, webp);
  writeFileSync(`public/assets/${pngName}`, png);
  console.log(`saved: public/assets/${webpName} ${(webp.length / 1024).toFixed(1)} KB`);
  console.log(`saved: public/assets/${pngName} ${(png.length / 1024).toFixed(1)} KB (audit copy)`);
  for (const mf of ["data/build/meta.json", "public/assets/meta.json"]) {
    if (!existsSync(mf)) continue;
    const meta = JSON.parse(readFileSync(mf, "utf8")) as {
      assets: Record<string, string>;
      sizesBytes: Record<string, number>;
    };
    meta.assets["clouds-atlas"] = `assets/${webpName}`;
    meta.assets["clouds-atlas-png"] = `assets/${pngName}`;
    meta.sizesBytes["clouds-atlas"] = webp.length;
    meta.sizesBytes["clouds-atlas-png"] = png.length;
    writeFileSync(mf, JSON.stringify(meta, null, 2));
    console.log(`updated: ${mf}`);
  }
}
