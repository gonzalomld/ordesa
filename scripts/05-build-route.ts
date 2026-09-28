// 05-build-route.ts — THE ONLY writer of route.json (§8d).
//
// Input: the GPX, and optionally the OSM re-trace candidate.
//   a. GPX → resample → drape → ALWAYS writes public/assets/route-gpx-legacy.json
//      (versioned; this is the rollback). All its XY/geometry is GPX.
//   b. If data/build/route-osm-candidate.json exists AND its legacyHash matches
//      the content hash of the legacy just written → route.json = candidate
//      geometry. Otherwise route.json = the GPX version, with a LOUD warning.
// The candidate is PLAN (x, y, origin) only. Z is ALWAYS re-draped here from
// the full-precision GeoTIFF DEM (dem.sampleBilinear), never taken from the
// candidate (its z comes from the 1 m-quantised heightmap). d, cumClimb and
// z_gpx are recomputed too — see buildRoute().
//
// 19-retrace-osm.ts reads route-gpx-legacy.json (NEVER route.json: that is the
// cut that breaks the circular dependency) and seals its content hash.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BBOX,
  CLIMB_SMOOTH_RADIUS_M,
  CLIMB_THRESHOLD_M,
  DEM_FILE,
  GPX_FILE,
  REF_POINTS,
  ROUTE_FILE,
  ROUTE_LEGACY_FILE,
  ROUTE_OFFSET_M,
  ROUTE_SMOOTH_RADIUS,
  ROUTE_STEP_M,
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";
import { wgs84ToUtm30N } from "./lib/utm.ts";

const CANDIDATE_FILE = "data/build/route-osm-candidate.json";
const ROUTE_BOUNDS_GEN = "src/generated/route-bounds.ts";

interface GpxPt {
  lat: number;
  lon: number;
  ele: number;
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
    const ele = Number(m[3] ?? NaN);
    // DEDUP (§8b): the source GPX repeats every trkpt twice (446 tags, 224
    // unique positions). 05 walks arc-length over these — a zero-length leg
    // is harmless there, but every consumer that indexes raw segments j→j+1
    // (audit, ?debug=gaps chords) needs the real vertices. Drop exact
    // repeats; the resample output is unchanged (zero-length legs add no
    // arc length, so targets/indices only shift by rounding).
    const prev = pts[pts.length - 1];
    if (prev !== undefined && prev.lat === lat && prev.lon === lon) continue;
    pts.push({ lat, lon, ele });
  }
  if (pts.length === 0) throw new Error(`${path}: no <trkpt> found`);
  return pts;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// --- GPX → plan polyline (resample to constant step + lateral smoothing) ---
const gpx = parseGpx(GPX_FILE);
console.log(`GPX: ${gpx.length} raw points`);
const gpxProj = gpx.map((p) => {
  const { x, y } = wgs84ToUtm30N(p.lat, p.lon);
  return { x, y, zGpx: p.ele };
});

function resample<T extends { x: number; y: number }>(
  pts: T[],
  stepM: number,
  zOf: (a: T, b: T, f: number) => number,
): { xs: number[]; ys: number[]; zs: number[]; total: number } {
  const d = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = (pts[i] as T).x - (pts[i - 1] as T).x;
    const dy = (pts[i] as T).y - (pts[i - 1] as T).y;
    d.push((d[i - 1] as number) + Math.hypot(dx, dy));
  }
  const total = d[d.length - 1] as number;
  const n = Math.max(2, Math.round(total / stepM));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (j < d.length - 2 && (d[j + 1] as number) < target) j++;
    const d0 = d[j] as number;
    const d1 = d[j + 1] as number;
    const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    const a = pts[j] as T;
    const b = pts[j + 1] as T;
    xs.push(a.x + (b.x - a.x) * f);
    ys.push(a.y + (b.y - a.y) * f);
    zs.push(zOf(a, b, f));
  }
  return { xs, ys, zs, total };
}

const gpxRes = resample(gpxProj, ROUTE_STEP_M, (a, b, f) => a.zGpx + (b.zGpx - a.zGpx) * f);
const gpxX = gpxRes.xs;
const gpxY = gpxRes.ys;
const gpxZGpx = gpxRes.zs;
const RN = gpxX.length;
console.log(`resampled: ${RN} points @ ~${(ROUTE_STEP_M).toFixed(2)} m`);

// Smooth lateral noise (XY only).
const r = ROUTE_SMOOTH_RADIUS;
const smX: number[] = [];
const smY: number[] = [];
const smZGpx: number[] = [];
for (let i = 0; i < RN; i++) {
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (let k = -r; k <= r; k++) {
    const q = gpxX[i + k];
    if (q !== undefined) {
      sx += q;
      sy += (gpxY[i + k] as number);
      c++;
    }
  }
  smX.push(sx / c);
  smY.push(sy / c);
  smZGpx.push(gpxZGpx[i] as number);
}

const dem = await readDem(DEM_FILE);

interface RouteSeries {
  xs: number[];
  ys: number[];
  zGpx: number[];
  zMdt: number[];
  zRaw: number[];
  d: number[];
  cumClimb: number[];
  totalClimbM: number;
  lengthM: number;
}

/** Rebuilds every Z-dependent series from the plan XY: Z from the DEM (never
 *  from the candidate), uniform d over the given arc length, and the
 *  watch-style accumulated climb. */
function buildRoute(xs: number[], ys: number[], zGpx: number[], lengthM: number): RouteSeries {
  const N = xs.length;
  const n = N - 1;
  const total = lengthM;
  const d = xs.map((_, i) => round1((total * i) / n));
  // Drawn Z: raw drape from the full-precision DEM + fixed offset.
  const zS = xs.map((x, i) => dem.sampleBilinear(x, ys[i] as number));
  const zMdt = zS.map((z) => round1(z + ROUTE_OFFSET_M));
  // Accumulated climb, watch-style: hysteresis of CLIMB_THRESHOLD_M over the
  // Z series SMOOTHED at CLIMB_SMOOTH_RADIUS_M (S7). Only the climb
  // accumulation is smoothed; the drawn Z stays the raw drape.
  const w = Math.round(CLIMB_SMOOTH_RADIUS_M / ROUTE_STEP_M);
  const zC = zS.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = -w; k <= w; k++) {
      const v = zS[i + k];
      if (v !== undefined) {
        s += v;
        c++;
      }
    }
    return s / c;
  });
  const TH = CLIMB_THRESHOLD_M;
  const cumClimb: number[] = new Array(zS.length);
  let acc = 0;
  let anchor = zC[0] as number;
  let peak = zC[0] as number;
  let valley = zC[0] as number;
  let up = false;
  for (let i = 0; i < zC.length; i++) {
    const z = zC[i] as number;
    if (!up) {
      if (z < valley) valley = z;
      if (z - valley >= TH) {
        up = true;
        anchor = valley;
        peak = z;
      }
    } else {
      if (z > peak) peak = z;
      if (peak - z >= TH) {
        acc += peak - anchor;
        up = false;
        valley = z;
      }
    }
    cumClimb[i] = Math.round((acc + (up ? peak - anchor : 0)) * 10) / 10;
  }
  return {
    xs,
    ys,
    zGpx,
    zMdt,
    zRaw: zMdt.slice(),
    d,
    cumClimb,
    totalClimbM: Math.round((acc + (up ? peak - anchor : 0)) * 10) / 10,
    lengthM: round1(total),
  };
}

const meta = {
  crs: "EPSG:25830",
  stepM: ROUTE_STEP_M,
  offsetM: ROUTE_OFFSET_M,
  climbThresholdM: CLIMB_THRESHOLD_M,
  climbSmoothM: CLIMB_SMOOTH_RADIUS_M,
};

function serialize(s: RouteSeries, origin: string[]): string {
  return JSON.stringify({
    ...meta,
    lengthM: s.lengthM,
    totalClimbM: s.totalClimbM,
    x: s.xs.map(round1),
    y: s.ys.map(round1),
    z_mdt: s.zMdt,
    z_raw: s.zRaw,
    z_gpx: s.zGpx.map(round1),
    d: s.d,
    cumClimb: s.cumClimb,
    origin,
  });
}

// --- a) GPX legacy: ALWAYS written (the rollback) ---
const legacySeries = buildRoute(smX, smY, smZGpx, gpxRes.total);
if (legacySeries.lengthM !== round1(legacySeries.lengthM)) {
  throw new Error("route: non-finite length");
}
writeFileSync(ROUTE_LEGACY_FILE, serialize(legacySeries, smX.map(() => "gpx")));
const legacyHash = createHash("sha256").update(readFileSync(ROUTE_LEGACY_FILE)).digest("hex").slice(0, 8);
console.log(
  `saved: ${ROUTE_LEGACY_FILE} (${legacySeries.xs.length} pts, ${(legacySeries.lengthM / 1000).toFixed(2)} km, hash ${legacyHash})`,
);

// --- b) adopt the OSM candidate only if it is VIGENT (byte-current) ---
let adopted = false;
let adoptNote = "";
if (existsSync(CANDIDATE_FILE)) {
  const cand = JSON.parse(readFileSync(CANDIDATE_FILE, "utf8")) as {
    legacyHash?: string;
    x: number[];
    y: number[];
    origin: string[];
    lengthM: number;
  };
  if (!cand.legacyHash) {
    adoptNote = `candidate has no legacyHash — regenerate 19`;
  } else if (cand.legacyHash !== legacyHash) {
    adoptNote = `candidate legacyHash ${cand.legacyHash} != legacy ${legacyHash}`;
  } else if (cand.x.length !== cand.y.length || cand.x.length !== cand.origin.length) {
    adoptNote = `candidate arrays uneven (x ${cand.x.length}, y ${cand.y.length}, origin ${cand.origin.length})`;
  } else {
    adopted = true;
  }
} else {
  adoptNote = `${CANDIDATE_FILE} missing`;
}

let routeSeries: RouteSeries;
let routeOrigin: string[];
if (adopted) {
  const cand = JSON.parse(readFileSync(CANDIDATE_FILE, "utf8")) as {
    x: number[];
    y: number[];
    origin: string[];
    lengthM: number;
  };
  // z_gpx: nearest legacy point in XY — NOT arc-length fraction. The candidate
  // is displaced laterally up to 26 m, so fractional mapping would derive
  // exactly where the geometry changes. In re-traced stretches z_gpx is
  // therefore an APPROXIMATION by construction; the epilogue chart is the
  // only consumer and never drives geometry.
  const zGpxCand = cand.x.map((x, i) => {
    const y = cand.y[i] as number;
    let bd = Infinity;
    let bz = 0;
    for (let k = 0; k < smX.length; k++) {
      const dd = (smX[k] as number - x) ** 2 + (smY[k] as number - y) ** 2;
      if (dd < bd) {
        bd = dd;
        bz = smZGpx[k] as number;
      }
    }
    return bz;
  });
  routeSeries = buildRoute(cand.x, cand.y, zGpxCand, cand.lengthM);
  routeOrigin = cand.origin;
  console.log(
    `adopted OSM candidate: ${routeSeries.xs.length} pts, ${(routeSeries.lengthM / 1000).toFixed(2)} km ` +
      `(GPX legacy ${(legacySeries.lengthM / 1000).toFixed(2)} km, delta ${routeSeries.lengthM - legacySeries.lengthM >= 0 ? "+" : ""}${round1(routeSeries.lengthM - legacySeries.lengthM)} m)`,
  );
} else {
  routeSeries = legacySeries;
  routeOrigin = smX.map(() => "gpx");
  console.warn(
    `\n!! 05: NOT adopting the re-trace — route.json = GPX version. Reason: ${adoptNote}.\n` +
      `!! Run 19-retrace-osm.ts (needs a current ${ROUTE_LEGACY_FILE}) and re-run 05.\n`,
  );
}

// Sanity: every point must sit inside the bbox.
const outside = routeSeries.xs.filter(
  (x, i) => x < BBOX.minx || x > BBOX.maxx || (routeSeries.ys[i] as number) < BBOX.miny || (routeSeries.ys[i] as number) > BBOX.maxy,
);
if (outside.length > 0) {
  throw new Error(`${outside.length}/${routeSeries.xs.length} route points outside bbox`);
}

writeFileSync(ROUTE_FILE, serialize(routeSeries, routeOrigin));
console.log(`saved: ${ROUTE_FILE} (${routeSeries.xs.length} pts, ${(routeSeries.lengthM / 1000).toFixed(2)} km, origin ${adopted ? "osm+gpx" : "gpx"})`);

// --- §8d-3: derive the act boundaries that are terrain accidents, not
// editorial choices. Source of truth: the route just written.
//   · cota máxima → d of the max-z sample (the same point the beam anchors).
//   · Cola de Caballo → d of the route point nearest REF_POINTS.colaCaballo,
//     floored to the hundred so it stays round.
// 0, 300, 3000 and 10500 are Gonzalo's editorial calls and stay fixed.
const cotaMaxD = routeSeries.d[routeSeries.zMdt.indexOf(Math.max(...routeSeries.zMdt))] as number;
{
  const cc = REF_POINTS.colaCaballo as { x: number; y: number };
  let bd = Infinity;
  let bi = 0;
  for (let i = 0; i < routeSeries.xs.length; i++) {
    const dd = Math.hypot((routeSeries.xs[i] as number) - cc.x, (routeSeries.ys[i] as number) - cc.y);
    if (dd < bd) {
      bd = dd;
      bi = i;
    }
  }
  const colaD = Math.floor(((routeSeries.d[bi] as number) / 100)) * 100;
  const bounds = [0, 300, cotaMaxD, 3000, colaD, 10500];
  for (let i = 1; i < bounds.length; i++) {
    if (!((bounds[i] as number) > (bounds[i - 1] as number))) {
      throw new Error(`route-bounds: boundaries not strictly increasing (${bounds.join(", ")})`);
    }
  }
  const gen =
    `// route-bounds.ts — GENERATED by scripts/05-build-route.ts (§8d). Do not edit.\n` +
    `// cota máxima from the max-z sample; Cola de Caballo from the nearest point\n` +
    `// (floored to 100 m). 0, 300, 3000, 10500 are editorial.\n` +
    `export const COTA_MAX_D_M = ${cotaMaxD};\n` +
    `export const COLA_CABALLO_D_M = ${colaD};\n` +
    `export const ACT_BOUND_D_M = [${bounds.join(", ")}] as const;\n`;
  writeFileSync(ROUTE_BOUNDS_GEN, gen);
  console.log(`saved: ${ROUTE_BOUNDS_GEN} (cota-max ${cotaMaxD} m, cola ${colaD} m, bounds ${bounds.join(", ")})`);
}
