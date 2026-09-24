// 18-audit-gpx.ts — §8 trace-integrity audit: MEASURE before re-tracing.
//
// Over the ORIGINAL GPX (pre-resample of 05-build-route): consecutive-point
// plan distances. Every pair > GAP_M is a straight-line invention of the
// arc-length walk in 05-build-route, later draped onto the MDT (so the path
// never flies — but it may cross ground no footpath would take).
//
// Elevation source: public/assets/heightmap.png + data/build/meta.json,
// BILINEAR sampling — the terrain the user sees. dem.tif is NEVER used
// (gitignored cache that may not exist; comparing against it is an encoding
// check, not this audit).
//
// Slope over a 20 m BASE (not point-to-point): the heightmap encodes
// v = round(elev − minZ), i.e. 1 m quantisation; a 5 m step would carry
// atan(1/5) = ±11.3° of quantisation noise, while 20 m keeps ±2.9°.
// Plus the full elevation profile (every 5 m) per gap with max/min/relief
// and gradient sign-change count (0–1 = clean hillside, 3+ = crossing gullies).
//
// Outputs:
//   data/build/gpx-gaps.json — full audit (versioned deliverable for §8b)
//   src/generated/gaps.ts    — RAW GPX vertices (EPSG:25830) + along-track
//                              cumdist, for the ?debug=gaps detector (§8b:
//                              perpendicular deviation off each raw chord —
//                              computed live in gaps-overlay.ts, never prod)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { ACTS, GPX_FILE } from "./geo-constants.ts";
import { wgs84ToUtm30N } from "./lib/utm.ts";

const GAP_M = 25;
const PROFILE_STEP_M = 5;
const SLOPE_BASE_M = 20; // slope base; PROFILE samples per base leg = 4
const SLOPE_LEG = Math.round(SLOPE_BASE_M / PROFILE_STEP_M);
const FLAT_STEP_M = 1.0; // |dz| under this over 5 m is quantisation — ignored for sign changes
const OUT_JSON = "data/build/gpx-gaps.json";
const OUT_GEN = "src/generated/gaps.ts";

interface GpxPt {
  lat: number;
  lon: number;
}

function parseGpx(path: string): GpxPt[] {
  const xml = readFileSync(path, "utf8");
  const pts: GpxPt[] = [];
  const re =
    /<trkpt[^>]*lat="([\d.+-]+)"[^>]*lon="([\d.+-]+)"[^>]*>(?:[\s\S]*?<ele>([\d.+-]+)<\/ele>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    // DEDUP: the source GPX repeats every trkpt twice (446 tags, 224 unique
    // positions). A zero-length chord has no perpendicular — drop exact
    // repeats so raw segments j→j+1 index the real vertices.
    const prev = pts[pts.length - 1];
    if (prev !== undefined && prev.lat === lat && prev.lon === lon) continue;
    pts.push({ lat, lon });
  }
  if (pts.length === 0) throw new Error(`${path}: no <trkpt> found`);
  return pts;
}

// --- raw track in work CRS ---
const gpx = parseGpx(GPX_FILE);
const pts = gpx.map((p) => wgs84ToUtm30N(p.lat, p.lon));
const cum: number[] = [0];
for (let i = 1; i < pts.length; i++) {
  const a = pts[i - 1] as { x: number; y: number };
  const b = pts[i] as { x: number; y: number };
  cum.push((cum[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
}
const totalM = cum[cum.length - 1] as number;
console.log(`GPX raw: ${pts.length} trkpts, ${(totalM / 1000).toFixed(3)} km`);

// --- elevation: decoded heightmap, bilinear (same scheme as verify.ts) ---
interface Meta {
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
  minZ: number;
}
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as Meta;
const { data: pngRaw } = await sharp("public/assets/heightmap.png")
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = meta.width;
const H = meta.height;
function gridAtPx(c: number, r: number): number {
  const cc = Math.min(W - 1, Math.max(0, c));
  const rr = Math.min(H - 1, Math.max(0, r));
  return (
    meta.minZ +
    (pngRaw[(rr * W + cc) * 3] as number) * 256 +
    (pngRaw[(rr * W + cc) * 3 + 1] as number)
  );
}
function sampleMDT(x: number, y: number): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(W - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(H - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const a = gridAtPx(c0, r0);
  const b = gridAtPx(c0 + 1, r0);
  const c = gridAtPx(c0, r0 + 1);
  const d = gridAtPx(c0 + 1, r0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function actFor(cumM: number): string {
  for (const a of ACTS) {
    if (cumM >= a.startM && cumM < a.endM) return `${a.act}:${a.name}`;
  }
  return "?";
}

interface Gap {
  index: number; // raw segment j → j+1
  ax: number;
  ay: number;
  bx: number;
  by: number;
  distM: number;
  cumKm: number; // along-track distance at the gap start
  act: string;
  zA: number;
  zB: number;
  dz: number; // zB − zA (MDT at the endpoints)
  maxSlopePct: number; // max |slope| over a 20 m base along the straight
  zMin: number;
  zMax: number;
  reliefM: number; // zMax − zMin along the profile
  signChanges: number; // gradient sign flips (|step| ≥ 1 m); 3+ = crossing gullies
  profile: number[]; // MDT elevation every 5 m along the straight
}

const gaps: Gap[] = [];
for (let j = 0; j < pts.length - 1; j++) {
  const a = pts[j] as { x: number; y: number };
  const b = pts[j + 1] as { x: number; y: number };
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  if (dist <= GAP_M) continue;
  const nProf = Math.max(2, Math.round(dist / PROFILE_STEP_M) + 1);
  const profile: number[] = [];
  for (let k = 0; k < nProf; k++) {
    const f = k / (nProf - 1);
    profile.push(sampleMDT(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f));
  }
  let maxSlopePct = 0;
  for (let k = 0; k + SLOPE_LEG < nProf; k++) {
    const run = SLOPE_LEG * PROFILE_STEP_M;
    const s = (Math.abs((profile[k + SLOPE_LEG] as number) - (profile[k] as number)) / run) * 100;
    if (s > maxSlopePct) maxSlopePct = s;
  }
  let signChanges = 0;
  let prevSign = 0;
  for (let k = 0; k + 1 < nProf; k++) {
    const g = (profile[k + 1] as number) - (profile[k] as number);
    if (Math.abs(g) < FLAT_STEP_M) continue; // quantisation flat
    const sign = g > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) signChanges++;
    prevSign = sign;
  }
  const zA = profile[0] as number;
  const zB = profile[profile.length - 1] as number;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const z of profile) {
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  gaps.push({
    index: j,
    ax: Math.round(a.x * 10) / 10,
    ay: Math.round(a.y * 10) / 10,
    bx: Math.round(b.x * 10) / 10,
    by: Math.round(b.y * 10) / 10,
    distM: Math.round(dist * 10) / 10,
    cumKm: Math.round(((cum[j] as number) / 1000) * 1000) / 1000,
    act: actFor(cum[j] as number),
    zA: Math.round(zA * 10) / 10,
    zB: Math.round(zB * 10) / 10,
    dz: Math.round((zB - zA) * 10) / 10,
    maxSlopePct: Math.round(maxSlopePct * 10) / 10,
    zMin: Math.round(zMin * 10) / 10,
    zMax: Math.round(zMax * 10) / 10,
    reliefM: Math.round((zMax - zMin) * 10) / 10,
    signChanges,
    profile: profile.map((z) => Math.round(z * 10) / 10),
  });
}

const over = (t: number): Gap[] => gaps.filter((g) => g.distM > t);
const interpM = gaps.reduce((s, g) => s + g.distM, 0);

const out = {
  generatedAt: new Date().toISOString(),
  source: { gpx: GPX_FILE, rawPoints: pts.length, elevation: "public/assets/heightmap.png + data/build/meta.json (bilinear)" },
  totalM: Math.round(totalM * 10) / 10,
  thresholdM: GAP_M,
  slopeBaseM: SLOPE_BASE_M,
  profileStepM: PROFILE_STEP_M,
  flatStepM: FLAT_STEP_M,
  counts: { over25: over(25).length, over50: over(50).length, over100: over(100).length },
  interpM: Math.round(interpM * 10) / 10,
  interpPct: Math.round((interpM / totalM) * 1000) / 10,
  gaps,
};
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log(`saved: ${OUT_JSON} (${gaps.length} gaps)`);

// --- front detector input: RAW vertices + cumdist (plan, EPSG:25830) ---
// §8b: the overlay tests each raw chord live (perpendicular deviation of
// the resampled+smoothed route off the chord) — no interval list survives
// a pipeline change, the raw vertices do.
mkdirSync(dirname(OUT_GEN), { recursive: true });
const r1 = (v: number): number => Math.round(v * 10) / 10;
// DEDUP: 05-build-route and straightRuns() both index raw segments j→j+1,
// so GAP_RAW must hold ONE vertex per raw point (446), not segment
// endpoints (890). The old writer pushed A and B of every gap.
writeFileSync(
  OUT_GEN,
  `// GENERATED by scripts/18-audit-gpx.ts — do not edit by hand.\n` +
    `// RAW GPX vertices in work CRS (EPSG:25830, plan only) + along-track\n` +
    `// cumdist (m). The ?debug=gaps detector (gaps-overlay.ts, lazy chunk)\n` +
    `// tests each raw chord live: interior route points within DEV_TOL_M\n` +
    `// (0.25 m) of the chord over runs ≥100 m paint magenta.\n` +
    `export const GAP_RAW: Array<readonly [number, number]> = ${JSON.stringify(pts.map((p) => [r1(p.x), r1(p.y)]))};\n` +
    `export const GAP_CUM: number[] = ${JSON.stringify(cum.map(r1))};\n` +
    `export const GAP_META = ${JSON.stringify({ rawPoints: pts.length, totalM: out.totalM, generatedAt: out.generatedAt })};\n`,
);
console.log(`saved: ${OUT_GEN} (${pts.length} raw vertices)`);

// --- console report: the four blocks ---
console.log(`\n== (1) gaps > ${GAP_M} m: index, EPSG endpoints, dist, cum-km, act ==`);
for (const g of gaps) {
  console.log(
    `#${g.index}: A(${g.ax},${g.ay}) → B(${g.bx},${g.by})  ${g.distM} m  @${g.cumKm} km  act ${g.act}`,
  );
}
console.log(`\n== (2) counts ==`);
console.log(`>25 m: ${over(25).length}   >50 m: ${over(50).length}   >100 m: ${over(100).length}`);
console.log(`\n== (3) invented trace ==`);
console.log(
  `${interpM.toFixed(1)} m of ${(totalM / 1000).toFixed(3)} km = ${((interpM / totalM) * 100).toFixed(2)}% straight-line interpolation`,
);
console.log(`\n== (4) relief per gap (MDT endpoints + 20 m-base slope + profile) ==`);
for (const g of gaps) {
  console.log(
    `#${g.index} @${g.cumKm} km act ${g.act}: dz ${g.dz >= 0 ? "+" : ""}${g.dz} m ` +
      `(${g.zA}→${g.zB}), maxSlope20m ${g.maxSlopePct}%, relief ${g.reliefM} m ` +
      `[${g.zMin}…${g.zMax}], signChanges ${g.signChanges} (n=${g.profile.length})`,
  );
}
