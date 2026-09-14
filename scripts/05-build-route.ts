// 05-build-route.ts — GPX → resample → drape → public/assets/route.json.
//
// - Parses the GPX with a hand-rolled regex reader (no dependency for this).
// - Resamples to a constant ~5 m step so camera speed is uniform.
// - Smooths lateral GPS noise with a short moving average in plan (XY), never in Z.
// - Z for drawing comes from the MDT (bilinear) + fixed offset. The raw GPS Z
//   is kept as a separate series (zGpx) for the epilogue chart.
import { readFileSync, writeFileSync } from "node:fs";
import {
  BBOX,
  CLIMB_SMOOTH_RADIUS_M,
  CLIMB_THRESHOLD_M,
  DEM_FILE,
  GPX_FILE,
  ROUTE_FILE,
  ROUTE_OFFSET_M,
  ROUTE_SMOOTH_RADIUS,
  ROUTE_STEP_M,
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";
import { wgs84ToUtm30N } from "./lib/utm.ts";

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
    pts.push({ lat: Number(m[1]), lon: Number(m[2]), ele: Number(m[3] ?? NaN) });
  }
  if (pts.length === 0) throw new Error(`${path}: no <trkpt> found`);
  return pts;
}

const gpx = parseGpx(GPX_FILE);
console.log(`GPX: ${gpx.length} raw points`);

// Project to work CRS.
const pts = gpx.map((p) => {
  const { x, y } = wgs84ToUtm30N(p.lat, p.lon);
  return { x, y, zGpx: p.ele };
});

// Resample to constant step (arc-length walk + linear interpolation).
function arcLengths(p: { x: number; y: number }[]): number[] {
  const d = [0];
  for (let i = 1; i < p.length; i++) {
    const dx = (p[i] as { x: number }).x - (p[i - 1] as { x: number }).x;
    const dy = (p[i] as { y: number }).y - (p[i - 1] as { y: number }).y;
    d.push((d[i - 1] as number) + Math.hypot(dx, dy));
  }
  return d;
}
const cum = arcLengths(pts);
const total = cum[cum.length - 1] as number;
const n = Math.max(2, Math.round(total / ROUTE_STEP_M));
const resampled: { x: number; y: number; zGpx: number }[] = [];
{
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (j < cum.length - 2 && (cum[j + 1] as number) < target) j++;
    const d0 = cum[j] as number;
    const d1 = cum[j + 1] as number;
    const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    const a = pts[j] as { x: number; y: number; zGpx: number };
    const b = pts[j + 1] as { x: number; y: number; zGpx: number };
    resampled.push({
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      zGpx: a.zGpx + (b.zGpx - a.zGpx) * f,
    });
  }
}
console.log(`resampled: ${resampled.length} points @ ~${(total / n).toFixed(2)} m`);

// Smooth lateral noise (XY only).
const r = ROUTE_SMOOTH_RADIUS;
const smoothed = resampled.map((p, i) => {
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (let k = -r; k <= r; k++) {
    const q = resampled[i + k];
    if (q) {
      sx += q.x;
      sy += q.y;
      c++;
    }
  }
  return { x: sx / c, y: sy / c, zGpx: p.zGpx };
});

// Drape on the MDT.
const dem = await readDem(DEM_FILE);
const round1 = (v: number): number => Math.round(v * 10) / 10;
// Accumulated climb, watch-style: hysteresis of CLIMB_THRESHOLD_M over the
// Z series SMOOTHED at CLIMB_SMOOTH_RADIUS_M (S7: 100 m ≈ ±20 pts — a real
// footpath rounds the dips a 5 m drape over a 5 m DTM climbs up and down).
// Drawing Z stays the raw drape; only the climb accumulation is smoothed.
const zS = smoothed.map((p) => dem.sampleBilinear(p.x, p.y));
const zC = zS.map((_, i) => {
  const w = Math.round(CLIMB_SMOOTH_RADIUS_M / ROUTE_STEP_M);
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
let finalClimb = 0;
{
  // Watch-style hysteresis: open an uphill segment only after a rise of
  // TH from the valley, close it only after a drop of TH from the peak.
  // Micro-oscillations below TH never open a segment, so they add nothing.
  // (declared here so the d-field below can use arc length `total`)
  let total = 0;
  let anchor = zC[0] as number; // base of the open uphill segment
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
        total += peak - anchor;
        up = false;
        valley = z;
      }
    }
    cumClimb[i] = Math.round((total + (up ? peak - anchor : 0)) * 10) / 10;
  }
  finalClimb = total + (up ? peak - anchor : 0);
  console.log(
    `accumulated climb (Z smoothed ±${CLIMB_SMOOTH_RADIUS_M} m, threshold ${TH} m): ${finalClimb.toFixed(1)} m`,
  );
}
const out = smoothed.map((p, i) => {
  const zMdt = zS[i] as number;
  return {
    x: round1(p.x),
    y: round1(p.y),
    z_mdt: round1(zMdt + ROUTE_OFFSET_M),
    z_gpx: round1(p.zGpx),
    d: round1((total * i) / n),
  };
});

// Sanity: every point must sit inside the bbox.
const outside = out.filter(
  (p) => p.x < BBOX.minx || p.x > BBOX.maxx || p.y < BBOX.miny || p.y > BBOX.maxy,
);
if (outside.length > 0) {
  throw new Error(`${outside.length}/${out.length} route points outside bbox`);
}

writeFileSync(
  ROUTE_FILE,
  JSON.stringify({
    crs: "EPSG:25830",
    stepM: ROUTE_STEP_M,
    offsetM: ROUTE_OFFSET_M,
    lengthM: round1(total),
    climbThresholdM: TH,
    climbSmoothM: CLIMB_SMOOTH_RADIUS_M,
    totalClimbM: Math.round(finalClimb * 10) / 10,
    x: out.map((p) => p.x),
    y: out.map((p) => p.y),
    z_mdt: out.map((p) => p.z_mdt),
    z_gpx: out.map((p) => p.z_gpx),
    d: out.map((p) => p.d),
    cumClimb,
  }),
);
console.log(`saved: ${ROUTE_FILE} (${out.length} pts, ${(total / 1000).toFixed(2)} km)`);
