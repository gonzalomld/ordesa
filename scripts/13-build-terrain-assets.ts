// 13-build-terrain-assets.ts — D1: base + corridor + normal + cloud atlas.
//
// Inputs: data/build/albedo.png (D2 output, 2160×1636) + DEM + route.
// Outputs (content-hashed, sizes recorded into data/build/meta.json):
//   terrain-base.<hash>.webp      4096 px, whole frame
//   terrain-base-2048.<hash>.webp 2048 px fallback (weak devices)
//   terrain-corridor.<hash>.webp  8192×~3530, track bbox + 400 m @ 0.83 m/px
//   terrain-corridor-4k.<hash>.webp 4096-wide fallback
//   terrain-normal.<hash>.webp    4096 px, high-pass luminance normals,
//                                 slope-modulated, from the DESHADOWED albedo
//   clouds-atlas.<hash>.webp      1024², 4 noise puffs
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  BBOX,
  CORRIDOR_BLEND_M,
  CORRIDOR_MARGIN_M,
  DEM_FILE,
  META_FILE,
  ROUTE_FILE,
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";

const ALBEDO = "data/build/albedo.png";
const OUT = "public/assets";
const hashOf = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex").slice(0, 8);

const dem = await readDem(DEM_FILE);
const route = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
  x: number[];
  y: number[];
};

// --- corridor bbox: track extent + margin ---
let tMinX = Infinity;
let tMaxX = -Infinity;
let tMinY = Infinity;
let tMaxY = -Infinity;
for (let i = 0; i < route.x.length; i++) {
  const x = route.x[i] as number;
  const y = route.y[i] as number;
  if (x < tMinX) tMinX = x;
  if (x > tMaxX) tMaxX = x;
  if (y < tMinY) tMinY = y;
  if (y > tMaxY) tMaxY = y;
}
const corridorBbox = {
  minx: Math.floor(tMinX - CORRIDOR_MARGIN_M),
  miny: Math.floor(tMinY - CORRIDOR_MARGIN_M),
  maxx: Math.ceil(tMaxX + CORRIDOR_MARGIN_M),
  maxy: Math.ceil(tMaxY + CORRIDOR_MARGIN_M),
};
const corrW = corridorBbox.maxx - corridorBbox.minx;
const corrH = corridorBbox.maxy - corridorBbox.miny;
console.log(
  `corridor bbox ${corrW}×${corrH} m → 8192 px = ${(corrW / 8192).toFixed(2)} m/px`,
);

// verify margin over the track
let minMargin = Infinity;
for (let i = 0; i < route.x.length; i++) {
  const x = route.x[i] as number;
  const y = route.y[i] as number;
  minMargin = Math.min(
    minMargin,
    x - corridorBbox.minx,
    corridorBbox.maxx - x,
    y - corridorBbox.miny,
    corridorBbox.maxy - y,
  );
}
console.log(`corridor margin over track: ${minMargin.toFixed(0)} m (need ≥300)`);

// --- normal map inputs: deshadowed luminance at 4096 ---
const NW = 4096;
const NH = Math.round((NW * (BBOX.maxy - BBOX.miny)) / (BBOX.maxx - BBOX.minx));
console.log(`normal working: ${NW}x${NH}`);
const { data: alb, info: albInfo } = await sharp(ALBEDO)
  .resize({ width: NW, height: NH, fit: "fill" })
  .raw()
  .toBuffer({ resolveWithObject: true });
const ACH = albInfo.channels;
const lum = new Float32Array(NW * NH);
for (let i = 0; i < NW * NH; i++)
  lum[i] =
    0.2126 * (alb[i * ACH] as number) +
    0.7152 * (alb[i * ACH + 1] as number) +
    0.0722 * (alb[i * ACH + 2] as number);

// separable gaussian blur (sigma ≈ 10 px) for the high-pass
function blurH(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        acc += (src[y * w + xx] as number) * (k[i + r] as number);
      }
      dst[y * w + x] = acc / s;
    }
  return dst;
}
function blurV(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  let s = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    k.push(v);
    s += v;
  }
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        acc += (src[yy * w + x] as number) * (k[i + r] as number);
      }
      dst[y * w + x] = acc / s;
    }
  return dst;
}
console.log("blurring luminance…");
const low = blurV(blurH(lum, NW, NH, 10), NW, NH, 10);

// slope at 4096 working res (bilinear MDT), 0=flat → 1=cliff
const STRENGTH = 2.2; // exposed as normalStrength in the viewer
const normBuf = Buffer.alloc(NW * NH * 3);
for (let r = 0; r < NH; r++) {
  const y = BBOX.maxy - ((r + 0.5) / NH) * (BBOX.maxy - BBOX.miny);
  for (let c = 0; c < NW; c++) {
    const i = r * NW + c;
    const x = BBOX.minx + ((c + 0.5) / NW) * (BBOX.maxx - BBOX.minx);
    const hp =
      (lum[i] as number) -
      (low[i] as number); // high-pass residual = microrelief
    // Sobel on the residual via neighbours
    const xm = lum[r * NW + Math.max(0, c - 1)] as number;
    const xp = lum[r * NW + Math.min(NW - 1, c + 1)] as number;
    const ym = lum[Math.max(0, r - 1) * NW + c] as number;
    const yp = lum[Math.min(NH - 1, r + 1) * NW + c] as number;
    void hp;
    const gx = (xp - xm) / 2 - ((low[r * NW + Math.min(NW - 1, c + 1)] as number) - (low[r * NW + Math.max(0, c - 1)] as number)) / 2;
    const gy = (yp - ym) / 2 - ((low[Math.min(NH - 1, r + 1) * NW + c] as number) - (low[Math.max(0, r - 1) * NW + c] as number)) / 2;
    const e = 5;
    const dzdx = (dem.sampleBilinear(x + e, y) - dem.sampleBilinear(x - e, y)) / (2 * e);
    const dzdy = (dem.sampleBilinear(x, y + e) - dem.sampleBilinear(x, y - e)) / (2 * e);
    const slopeDeg = (Math.acos(1 / Math.hypot(dzdx, dzdy, 1)) * 180) / Math.PI;
    // weak on meadow/forest (<12°), full on wall/scree (>30°)
    const w = Math.min(1, Math.max(0.12, (slopeDeg - 12) / 18));
    const mPerPx = (BBOX.maxx - BBOX.minx) / NW;
    const sx = ((gx / 255) * STRENGTH * w) / mPerPx;
    const sy = ((gy / 255) * STRENGTH * w) / mPerPx;
    const inv = 1 / Math.hypot(sx, sy, 1);
    normBuf[i * 3] = Math.round((-sx * inv * 0.5 + 0.5) * 255);
    normBuf[i * 3 + 1] = Math.round((-sy * inv * 0.5 + 0.5) * 255);
    normBuf[i * 3 + 2] = Math.round(inv * 255);
  }
  if (r % 600 === 0) console.log(`  normal row ${r}/${NH}`);
}

// --- emit assets ---
async function emitWebp(
  input: Buffer | { raw: { width: number; height: number; channels: number }; data: Buffer },
  opts: { quality: number },
): Promise<{ hash: string; bytes: number; buf: Buffer }> {
  const img = Buffer.isBuffer(input)
    ? sharp(input)
    : sharp((input as { data: Buffer }).data, {
        raw: (input as { raw: object }).raw as {
          width: number;
          height: number;
          channels: 3;
        },
      });
  const buf = await img.webp({ quality: opts.quality }).toBuffer();
  return { hash: hashOf(buf), bytes: buf.length, buf };
}

const assets: Record<string, string> = {};
const sizesBytes: Record<string, number> = {};
async function save(kind: string, buf: Buffer): Promise<void> {
  const h = hashOf(buf);
  const name = `${kind}.${h}.webp`;
  writeFileSync(`${OUT}/${name}`, buf);
  assets[kind] = `assets/${name}`;
  sizesBytes[kind] = buf.length;
  console.log(`saved: ${OUT}/${name} ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

// base 4096 + fallback 2048 from the albedo
{
  const b4 = await sharp(ALBEDO)
    .resize({ width: 4096 })
    .webp({ quality: 80 })
    .toBuffer();
  await save("terrain-base", b4);
  const b2 = await sharp(ALBEDO)
    .resize({ width: 2048 })
    .webp({ quality: 78 })
    .toBuffer();
  await save("terrain-base-2048", b2);
}
// corridor: crop albedo in ground coords → 8192 + 4096 fallback
{
  const fx0 = (corridorBbox.minx - BBOX.minx) / (BBOX.maxx - BBOX.minx);
  const fx1 = (corridorBbox.maxx - BBOX.minx) / (BBOX.maxx - BBOX.minx);
  const fy0 = (BBOX.maxy - corridorBbox.maxy) / (BBOX.maxy - BBOX.miny);
  const fy1 = (BBOX.maxy - corridorBbox.miny) / (BBOX.maxy - BBOX.miny);
  const AW = 2160;
  const AH = Math.round((AW * (BBOX.maxy - BBOX.miny)) / (BBOX.maxx - BBOX.minx));
  const left = Math.round(fx0 * AW);
  const top = Math.round(fy0 * AH);
  const wdt = Math.round(fx1 * AW) - left;
  const hgt = Math.round(fy1 * AH) - top;
  const CH = Math.round((8192 * hgt) / wdt);
  console.log(`corridor crop ${wdt}x${hgt} → 8192x${CH}`);
  const c8 = await sharp(ALBEDO)
    .extract({ left, top, width: wdt, height: hgt })
    .resize({ width: 8192, height: CH, fit: "fill" })
    .webp({ quality: 80 })
    .toBuffer();
  await save("terrain-corridor", c8);
  const c4 = await sharp(ALBEDO)
    .extract({ left, top, width: wdt, height: hgt })
    .resize({ width: 4096, height: Math.round(CH / 2), fit: "fill" })
    .webp({ quality: 78 })
    .toBuffer();
  await save("terrain-corridor-4k", c4);
}
// normal (lossless-ish high quality; keep detail)
{
  const nb = await sharp(normBuf, { raw: { width: NW, height: NH, channels: 3 } })
    .webp({ quality: 90 })
    .toBuffer();
  await save("terrain-normal", nb);
}
// cloud atlas: §4b FASE 4b — procedural cumulus (make-cloud-atlas.ts).
// Library import so `npm run data` reproduces the same bytes; the
// standalone script also writes the files + meta + acceptance when run
// directly (`npx tsx scripts/make-cloud-atlas.ts`).
{
  const { buildCloudAtlas, acceptAtlas } = await import("./make-cloud-atlas.ts");
  const { png, webp } = await buildCloudAtlas();
  const { blockRatio, flatFrac, coreFill, rimVar } = await acceptAtlas(webp);
  console.log(`cloud atlas acceptance: blockRatio=${blockRatio.toFixed(3)} flat=${(flatFrac * 100).toFixed(2)}% core=${(coreFill * 100).toFixed(1)}% rimStd=${rimVar.toFixed(4)}`);
  if (blockRatio >= 2.0 || flatFrac >= 0.02 || coreFill < 0.55 || rimVar <= 0.05) {
    throw new Error("ATLAS REJECTED: squares, holes, or balloon rim at ×4");
  }
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update(webp).digest("hex").slice(0, 8);
  writeFileSync(`${OUT}/clouds-atlas.${h}.webp`, webp);
  writeFileSync(`${OUT}/clouds-atlas.${h}.png`, png);
  assets["clouds-atlas"] = `assets/clouds-atlas.${h}.webp`;
  assets["clouds-atlas-png"] = `assets/clouds-atlas.${h}.png`;
  sizesBytes["clouds-atlas"] = webp.length;
  sizesBytes["clouds-atlas-png"] = png.length;
  console.log(`saved: ${OUT}/clouds-atlas.${h}.webp ${(webp.length / 1024).toFixed(1)} KB`);
}

// --- write corridor + sizes into meta.json (+ public copy) ---
const meta = JSON.parse(readFileSync(META_FILE, "utf8"));
meta.corridorBbox = corridorBbox;
meta.corridorMetersPerPx = Number((corrW / 8192).toFixed(3));
meta.assets = assets;
meta.sizesBytes = sizesBytes;
meta.corridorMarginM = Number(minMargin.toFixed(0));
const sidecar = JSON.parse(readFileSync("data/source/ortho.json", "utf8"));
meta.flight = sidecar.flight?.points?.[0]
  ? { fecha: sidecar.flight.points[0].fecha, resolucion: sidecar.flight.points[0].resolucion }
  : undefined;
meta.solar = sidecar.solarFit
  ? { bestAz: sidecar.solarFit.az, bestAlt: sidecar.solarFit.alt }
  : undefined;
meta.albedo = sidecar.albedo;
writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
writeFileSync("public/assets/meta.json", JSON.stringify(meta, null, 2));
console.log(`updated: ${META_FILE} (+ public copy)`);
console.log(`blend edge: ${CORRIDOR_BLEND_M} m (applied in-shader, see terrain.ts)`);
