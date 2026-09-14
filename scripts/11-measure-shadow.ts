// 11-measure-shadow.ts — MEASURE BEFORE BUILDING (D2/B6).
// Grid-searches the flight sun (B6: az 60-260 × alt 25-75, step 5°) for the
// pair that MINIMISES correlation(albedo, illumination). Reports the raw
// number so we know whether full de-shadowing is worth it (>0.5),
// soft (0.2-0.5) or light (<0.2). Result saved into data/source/ortho.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  BBOX,
  DEM_FILE,
  ORTHO_MOSAIC,
  ORTHO_SIDECAR,
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";
import { sunPosition } from "./lib/sun.ts";

const dem = await readDem(DEM_FILE);
console.log(`DEM ${dem.width}x${dem.height}`);

// --- luminance at working resolution ---
const W = 1080;
const H = Math.round((W * (BBOX.maxy - BBOX.miny)) / (BBOX.maxx - BBOX.minx));
const { data: px, info } = await sharp(ORTHO_MOSAIC)
  .resize({ width: W, height: H, fit: "fill" })
  .raw()
  .toBuffer({ resolveWithObject: true });
const ch = info.channels;
function luminanceAt(x: number, y: number): number {
  const fx = ((x - BBOX.minx) / (BBOX.maxx - BBOX.minx)) * W;
  const fy = ((BBOX.maxy - y) / (BBOX.maxy - BBOX.miny)) * H;
  const c = Math.min(W - 1, Math.max(0, Math.floor(fx)));
  const r = Math.min(H - 1, Math.max(0, Math.floor(fy)));
  const i = (r * W + c) * ch;
  return (
    0.2126 * (px[i] as number) +
    0.7152 * (px[i + 1] as number) +
    0.0722 * (px[i + 2] as number)
  );
}

// --- subsample grid: every 6th DEM pixel ---
const STEP = 6;
const xs: number[] = [];
const ys: number[] = [];
for (let r = 0; r < dem.height; r += STEP) {
  for (let c = 0; c < dem.width; c += STEP) {
    xs.push(dem.minx + (c + 0.5) * dem.resX);
    ys.push(dem.maxy - (r + 0.5) * dem.resY);
  }
}
const N = xs.length;
console.log(`grid: ${N} points`);

// --- normals from DEM (central differences, metres) ---
function normalAt(x: number, y: number): [number, number, number] {
  const e = 5;
  const dzdx =
    (dem.sampleBilinear(x + e, y) - dem.sampleBilinear(x - e, y)) / (2 * e);
  const dzdy =
    (dem.sampleBilinear(x, y + e) - dem.sampleBilinear(x, y - e)) / (2 * e);
  const inv = 1 / Math.hypot(dzdx, dzdy, 1);
  return [-dzdx * inv, inv, dzdy * inv]; // x east, y up, z south(+)= -north... see below
}

// world: sun dir from az (compass, 0=N) / alt
function sunDir(azDeg: number, altDeg: number): [number, number, number] {
  const az = (azDeg * Math.PI) / 180;
  const al = (altDeg * Math.PI) / 180;
  // east = sin(az)*cos(alt), up = sin(alt), north = cos(az)*cos(alt)
  return [Math.sin(az) * Math.cos(al), Math.sin(al), Math.cos(az) * Math.cos(al)];
}

// --- horizon-angle maps: for each azimuth, max terrain elevation angle ---
// B6: widened grid (was 90-240/33-70) — the old fit landed on the az edge.
const AZS: number[] = [];
for (let a = 60; a <= 260; a += 5) AZS.push(a);
const ALTS: number[] = [];
for (let a = 25; a <= 75; a += 5) ALTS.push(a);
const horizon = new Map<number, Float32Array>();
{
  const RAY_STEP = 20;
  const RAY_MAX = 2500;
  for (const az of AZS) {
    const [dx, , dz] = sunDir(az, 0); // horizontal direction only
    const hz = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x0 = xs[i] as number;
      const y0 = ys[i] as number;
      const z0 = dem.sampleBilinear(x0, y0);
      let maxAng = -90;
      // east/north steps: dx east, dz north
      for (let d = RAY_STEP; d <= RAY_MAX; d += RAY_STEP) {
        const x = x0 + dx * d;
        const yy = y0 + dz * d; // north input to sampleBilinear (y=northing)
        if (x < BBOX.minx || x > BBOX.maxx || yy < BBOX.miny || yy > BBOX.maxy)
          break;
        const z = dem.sampleBilinear(x, yy);
        const ang = (Math.atan2(z - z0, d) * 180) / Math.PI;
        if (ang > maxAng) maxAng = ang;
      }
      hz[i] = maxAng;
    }
    horizon.set(az, hz);
    console.log(`horizon az ${az} done`);
  }
}

const lum = new Float64Array(N);
for (let i = 0; i < N; i++) lum[i] = luminanceAt(xs[i] as number, ys[i] as number);

function pearson(a: Float64Array | Float32Array, b: Float64Array | Float32Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

// --- grid search: illumination = ambient + lambert × visibility ---
const AMBIENT = 0.35;
let best = { az: 0, alt: 0, corr: 1, rawCorr: 0, illumMean: 0 };
const illum = new Float64Array(N);
const albedo = new Float64Array(N);
for (const alt of ALTS) {
  for (const az of AZS) {
    const [sx, sy, sz] = sunDir(az, alt);
    const hz = horizon.get(az) as Float32Array;
    for (let i = 0; i < N; i++) {
      const [nx, ny, nzN] = normalAt(xs[i] as number, ys[i] as number);
      // nzN is +south-comp? normalAt returns [-dzdx, up, +dzdy] with y=northing so third comp is north
      const lambert = Math.max(0, nx * sx + ny * sy + nzN * sz);
      // soft visibility edge over 2°
      const vis = Math.min(1, Math.max(0, (alt - (hz[i] as number)) / 2 + 0.5));
      illum[i] = AMBIENT + lambert * vis;
    }
    // albedo with floor (measurement pass: no class infill)
    for (let i = 0; i < N; i++)
      albedo[i] = (lum[i] as number) / Math.max(illum[i] as number, 0.25);
    const corr = pearson(albedo, illum);
    if (Math.abs(corr) < Math.abs(best.corr)) {
      // raw correlation for the report
      const raw = pearson(lum, illum);
      best = { az, alt, corr, rawCorr: raw, illumMean: 0 };
    }
  }
  console.log(`alt ${alt} done (best so far az ${best.az} corr ${best.corr.toFixed(3)})`);
}

// deep-shadow mask fraction at best pair
{
  const [, ,] = [0, 0, 0];
  const hz = horizon.get(best.az) as Float32Array;
  let dark = 0;
  for (let i = 0; i < N; i++) {
    const vis = Math.min(1, Math.max(0, (best.alt - (hz[i] as number)) / 2 + 0.5));
    if (vis < 0.05 && (lum[i] as number) < 40) dark++;
  }
  console.log(`deep-shadow mask: ${(100 * (dark / N)).toFixed(2)}% of frame`);
  console.log(
    `BEST az ${best.az} alt ${best.alt} corr(albedo,illum)=${best.corr.toFixed(3)} rawCorr(lum,illum)=${best.rawCorr.toFixed(3)}`,
  );
  // closest July flight hour via NOAA
  let bh = "";
  for (let h = 10; h <= 16; h += 0.5) {
    const s = sunPosition(42.645, -0.055, 2024, 7, 15, h, 120);
    bh += `${h.toFixed(1)}h az${s.azimuthDeg.toFixed(0)} alt${s.elevationDeg.toFixed(0)} | `;
  }
  console.log(`NOAA july table: ${bh}`);
  const sidecar = existsSync(ORTHO_SIDECAR)
    ? JSON.parse(readFileSync(ORTHO_SIDECAR, "utf8"))
    : {};
  sidecar.solarFit = best;
  writeFileSync(ORTHO_SIDECAR, JSON.stringify(sidecar, null, 2));
  console.log(`saved fit → ${ORTHO_SIDECAR}`);
}
