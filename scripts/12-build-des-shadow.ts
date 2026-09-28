// 12-build-des-shadow.ts — full de-shadowing (D2) with the fitted flight sun.
// illumination = AMBIENT + max(0, n·s) × visibility, bilinear-upsampled to
// working resolution. Unreliable pixels (deep projected shadow + very dark)
// are infilled with the median albedo of their (slope,brightness) class.
// Outputs: data/build/albedo.png (working albedo) + reports residual
// correlation + deep-mask fraction into ortho.json + meta.json.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import {
  BBOX,
  DEM_FILE,
  META_FILE,
  META_PUBLIC_COPY,
  ORTHO_MOSAIC,
  ORTHO_SIDECAR,
} from "./geo-constants.ts";
import { AMBIENT, FLOOR, applyDeshadow } from "./lib/deshadow.ts";
import { readDem } from "./lib/tiff.ts";

const W = 2160;
const H = Math.round((W * (BBOX.maxy - BBOX.miny)) / (BBOX.maxx - BBOX.minx));
console.log(`working: ${W}x${H}`);

const sidecar = JSON.parse(readFileSync(ORTHO_SIDECAR, "utf8"));
const fit = sidecar.solarFit as { az: number; alt: number };
console.log(`flight sun: az ${fit.az} alt ${fit.alt}`);
const AZ = fit.az;
const ALT = fit.alt;

const dem = await readDem(DEM_FILE);

function sunDir(azDeg: number, altDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const al = (altDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(al), Math.sin(al), Math.cos(az) * Math.cos(al)];
}
const [SX, SY, SZ] = sunDir(AZ, ALT);

// --- bilinear upsample helpers over the DEM ---
function elevAt(x: number, y: number): number {
  return dem.sampleBilinear(x, y);
}
function normalAt(x: number, y: number): [number, number, number] {
  const e = 2.5;
  const dzdx = (elevAt(x + e, y) - elevAt(x - e, y)) / (2 * e);
  const dzdy = (elevAt(x, y + e) - elevAt(x, y - e)) / (2 * e);
  const inv = 1 / Math.hypot(dzdx, dzdy, 1);
  return [-dzdx * inv, inv, dzdy * inv]; // (east, up, north)
}

// --- visibility via horizon angle along the sun azimuth ---
const [DX, , DZ] = sunDir(AZ, 0);
function horizonAngle(x0: number, y0: number): number {
  const z0 = elevAt(x0, y0);
  let maxAng = -90;
  for (let d = 10; d <= 2500; d += 10) {
    const x = x0 + DX * d;
    const y = y0 + DZ * d;
    if (x < BBOX.minx || x > BBOX.maxx || y < BBOX.miny || y > BBOX.maxy) break;
    const ang = (Math.atan2(elevAt(x, y) - z0, d) * 180) / Math.PI;
    if (ang > maxAng) maxAng = ang;
  }
  return maxAng;
}

// --- load ortho at working res ---
const { data: px, info } = await sharp(ORTHO_MOSAIC)
  .resize({ width: W, height: H, fit: "fill" })
  .raw()
  .toBuffer({ resolveWithObject: true });
const CH = info.channels;
const n = W * H;
const illum = new Float32Array(n);
const vis = new Float32Array(n);
const lumA = new Float32Array(n);
const slopeA = new Float32Array(n);

console.log("computing illumination…");
for (let r = 0; r < H; r++) {
  const y = BBOX.maxy - ((r + 0.5) / H) * (BBOX.maxy - BBOX.miny);
  for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const x = BBOX.minx + ((c + 0.5) / W) * (BBOX.maxx - BBOX.minx);
    const [nx, ny, nzN] = normalAt(x, y);
    const lambert = Math.max(0, nx * SX + ny * SY + nzN * SZ);
    const hz = (r % 2 === 0 || true) ? horizonAngle(x, y) : 0;
    const v = Math.min(1, Math.max(0, (ALT - hz) / 2 + 0.5));
    vis[i] = v;
    illum[i] = AMBIENT + lambert * v;
    const o = i * CH;
    lumA[i] =
      0.2126 * (px[o] as number) +
      0.7152 * (px[o + 1] as number) +
      0.0722 * (px[o + 2] as number);
    slopeA[i] = Math.acos(Math.min(1, ny)) * (180 / Math.PI);
  }
  if (r % 200 === 0) console.log(`  row ${r}/${H}`);
}

// --- unreliable mask: deep shadow + dark ---
const unreliable = new Uint8Array(n);
let darkCount = 0;
for (let i = 0; i < n; i++) {
  if ((vis[i] as number) < 0.05 && (lumA[i] as number) < 40) {
    unreliable[i] = 1;
    darkCount++;
  }
}
console.log(`deep mask: ${(100 * (darkCount / n)).toFixed(2)}%`);

// --- class medians (raw albedo units), scaled by global gain below ---
// grosera: 3 slope bands × 2 brightness bands
function cls(i: number): number {
  const s = slopeA[i] as number;
  const sb = s < 12 ? 0 : s < 30 ? 1 : 2;
  const lb = (lumA[i] as number) < 90 ? 0 : 1;
  return sb * 2 + lb;
}
const buckets: number[][] = [[], [], [], [], [], []];
for (let i = 0; i < n; i += 4) {
  if (unreliable[i]) continue;
  const dv = Math.max(illum[i] as number, FLOOR);
  const o = i * CH;
  buckets[cls(i)]?.push((px[o] as number) / dv, (px[o + 1] as number) / dv, (px[o + 2] as number) / dv);
}
function median(a: number[]): number {
  if (!a.length) return 128;
  a.sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] as number;
}
const inMean = lumA.reduce((a, b) => a + b, 0) / n;
let relMean = 0;
{
  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i += 2) {
    if (unreliable[i]) continue;
    const o = i * CH;
    const dv = Math.max(illum[i] as number, FLOOR);
    s +=
      0.2126 * ((px[o] as number) / dv) +
      0.7152 * ((px[o + 1] as number) / dv) +
      0.0722 * ((px[o + 2] as number) / dv);
    c++;
  }
  relMean = s / c;
}
const preGain = inMean / relMean;
const medR = buckets.map((b) => median(b.filter((_, k) => k % 3 === 0)) * preGain);
const medG = buckets.map((b) => median(b.filter((_, k) => k % 3 === 1)) * preGain);
const medB = buckets.map((b) => median(b.filter((_, k) => k % 3 === 2)) * preGain);
console.log("class medians:", medR.map((v) => v.toFixed(2)).join(","));

// gain fixed above (preGain ≈ inMean/relMean); write final pixels
const gain = preGain;
const out = Buffer.alloc(n * 3);
for (let i = 0; i < n; i++) {
  const o = i * CH;
  let r: number;
  let g: number;
  let b: number;
  if (unreliable[i]) {
    const c = cls(i);
    r = medR[c] as number;
    g = medG[c] as number;
    b = medB[c] as number;
  } else {
    r = applyDeshadow(px[o] as number, illum[i] as number, gain);
    g = applyDeshadow(px[o + 1] as number, illum[i] as number, gain);
    b = applyDeshadow(px[o + 2] as number, illum[i] as number, gain);
  }
  out[i * 3] = Math.min(255, Math.max(0, Math.round(r)));
  out[i * 3 + 1] = Math.min(255, Math.max(0, Math.round(g)));
  out[i * 3 + 2] = Math.min(255, Math.max(0, Math.round(b)));
}

// --- residual correlation: albedo lum vs illumination ---
let ma = 0;
let mi = 0;
const al = new Float64Array(n);
for (let i = 0; i < n; i++) {
  al[i] =
    0.2126 * (out[i * 3] as number) +
    0.7152 * (out[i * 3 + 1] as number) +
    0.0722 * (out[i * 3 + 2] as number);
  ma += al[i] as number;
  mi += illum[i] as number;
}
ma /= n;
mi /= n;
let sab = 0;
let saa = 0;
let sbb = 0;
for (let i = 0; i < n; i++) {
  const da = (al[i] as number) - ma;
  const db = (illum[i] as number) - mi;
  sab += da * db;
  saa += da * da;
  sbb += db * db;
}
const residual = sab / Math.sqrt(saa * sbb);
console.log(`residual corr(albedo, illum) = ${residual.toFixed(3)}`);

const ALBEDO_FILE = "data/build/albedo.png";
mkdirSync(dirname(ALBEDO_FILE), { recursive: true });
await sharp(out, { raw: { width: W, height: H, channels: 3 } })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(ALBEDO_FILE);
console.log(`saved: ${ALBEDO_FILE}`);

if (existsSync("data/build/albedo-mask.png")) void 0;
const maskOut = Buffer.alloc(n);
for (let i = 0; i < n; i++) maskOut[i] = unreliable[i] ? 255 : 0;
await sharp(maskOut, { raw: { width: W, height: H, channels: 1 } })
  .png()
  .toFile("data/build/albedo-mask.png");

sidecar.albedo = {
  az: AZ,
  alt: ALT,
  residualCorrelation: Number(residual.toFixed(3)),
  deepMaskFraction: Number((darkCount / n).toFixed(4)),
  file: ALBEDO_FILE,
};
writeFileSync(ORTHO_SIDECAR, JSON.stringify(sidecar, null, 2));
console.log("updated ortho.json with albedo report");

// --- persist the illumination field for 20-build-ortho-tiles.ts (T1-c) ---
// Encoding RG 8+8, same convention as the heightmap (03): the field is
// smooth by construction (5 m MDT, no finer content), so 16 bits are
// plenty and sharp round-trips them exactly (a 1-channel u16 buffer gets
// degraded to sRGB uchar by sharp — verified, do NOT "simplify" this to
// grey16). Same BBOX framing as the working grid: row r ↔
// y = maxy − ((r+0.5)/H)·(maxy−miny), col c ↔ x = minx + ((c+0.5)/W)·(maxx−minx).
// v = round((illum−min)/(max−min)·65535); R = v>>8; G = v&255; B = 0.
// meta.json is MERGED (read-modify-write like 20 does), never rewritten:
// rewriting from scratch would wipe the tiles index (17 tile keys).
{
  let illumMin = Infinity;
  let illumMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = illum[i] as number;
    if (v < illumMin) illumMin = v;
    if (v > illumMax) illumMax = v;
  }
  if (!(illumMax > illumMin)) throw new Error("12: degenerate illum field (max <= min)");
  const span = illumMax - illumMin;
  const rg = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const v = Math.round((((illum[i] as number) - illumMin) / span) * 65535);
    rg[i * 3] = v >> 8;
    rg[i * 3 + 1] = v & 255;
    rg[i * 3 + 2] = 0;
  }
  const ILLUM_FILE = "data/build/illum.png";
  await sharp(rg, { raw: { width: W, height: H, channels: 3 } })
    .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
    .toFile(ILLUM_FILE);
  console.log(`saved: ${ILLUM_FILE} (range ${illumMin.toFixed(4)}…${illumMax.toFixed(4)})`);
  if (!existsSync("data/build/albedo-mask.png")) throw new Error("12: albedo-mask.png missing");
  const mosaicBytes = readFileSync(ORTHO_MOSAIC);
  const mosaicHash = createHash("sha256").update(mosaicBytes).digest("hex").slice(0, 8);
  const m12 = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, unknown>;
  m12.illumination = {
    file: ILLUM_FILE,
    width: W,
    height: H,
    bits: 16,
    encoding: "v = round((illum-min)/(max-min)*65535); R = v>>8; G = v&255; B = 0",
    min: illumMin,
    max: illumMax,
    gain,
    mosaicHash,
    mosaicFile: ORTHO_MOSAIC,
    mask: { file: "data/build/albedo-mask.png", fraction: Number((darkCount / n).toFixed(4)) },
  };
  writeFileSync(META_FILE, JSON.stringify(m12, null, 2));
  writeFileSync(META_PUBLIC_COPY, JSON.stringify(m12, null, 2));
  console.log(`illumination: gain ${gain.toFixed(4)}, mosaic ${mosaicHash} (+ public copy)`);
  // límite 2: meta.json debe conservar las 17 claves de teselas tras el merge
  const tileKeys = Object.keys((m12.assets ?? {}) as Record<string, string>).filter(
    (k) => k === "tiles-atlas" || k.startsWith("tile-c"),
  );
  if (tileKeys.length !== 17) {
    throw new Error(`12: meta.json lost tile keys after merge (found ${tileKeys.length}, need 17)`);
  }
}
