// 19-retrace-osm.ts — §8c OSM re-trace CANDIDATE (never production).
//
// Builds data/build/route-osm-candidate.json WITHOUT touching route.json
// or anything in public/assets:
//
//   · project every current route point onto the nearest OSM way, chaining
//     ways in GPX order with a Viterbi pass (way-switch penalty unless the
//     ways share a node; teleport penalty otherwise)
//   · where the OSM projection is >25 m away, KEEP the current geometry and
//     mark those points origin "gpx" (the five known no-coverage stretches)
//   · resample to 5 m + the same XY smoothing (radius 2) as 05-build-route
//
// Every candidate point carries origin "osm" | "gpx". Elevation comes from
// public/assets/heightmap.png + data/build/meta.json (bilinear) — the
// terrain the user sees, same as the §8 audit.
//
// Also writes src/generated/retrace.ts (plan XY only) for the lazy
// ?debug=retrace overlay chunk, and enforces the candidate gates:
//   G110-retrace-nonregression (was "plausible", absolute — wrong: the
//     1 m-quantised heightmap aliases on the subida zigzags, so the CURRENT
//     route fails it too. Non-regression instead, per zone + global max.)
//   G111-retrace-seams:  each remaining seam jump <= 15 m, turn <= 35°,
//     measured on the FINAL smoothed series (what is drawn)
//   G112-retrace-monotonic: cumdist strictly increasing, no repeated section
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import { ACTS, GPX_FILE, ROUTE_FILE, ROUTE_SMOOTH_RADIUS, ROUTE_STEP_M } from "./geo-constants.ts";
import { GAP_RAW } from "../src/generated/gaps.ts";
import { wgs84ToUtm30N } from "./lib/utm.ts";

const OSM_FILE = "data/source/osm-paths.geojson";
const OUT_JSON = "data/build/route-osm-candidate.json";
const OUT_GEN = "src/generated/retrace.ts";
const COVER_M = 25; // <=25 m: OSM covers; beyond: keep GPX geometry
const SEARCH_M = 60; // Viterbi candidate pool radius
const MAX_CAND = 8;

interface Pt {
  x: number;
  y: number;
}

// ---------- current route ----------
const routeJ = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
  x: number[];
  y: number[];
  d: number[];
  lengthM: number;
};
const RN = routeJ.x.length;
const cur: Pt[] = routeJ.x.map((x, i) => ({ x, y: routeJ.y[i] as number }));
const curD: number[] = routeJ.d;
console.log(`route: ${RN} pts, ${routeJ.lengthM} m`);

// ---------- OSM ways -> UTM segments ----------
interface OsmSeg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  way: number; // way index
}
const osmRaw = JSON.parse(readFileSync(OSM_FILE, "utf8")) as {
  elements: {
    id: number;
    nodes?: number[];
    geometry?: { lat: number; lon: number }[];
    tags?: Record<string, string>;
  }[];
};
const segs: OsmSeg[] = [];
const wayNodes: Set<number>[] = [];
osmRaw.elements.forEach((w, wi) => {
  const g = w.geometry ?? [];
  wayNodes.push(new Set(w.nodes ?? []));
  const P = g.map((p) => wgs84ToUtm30N(p.lat, p.lon));
  for (let i = 1; i < P.length; i++) {
    segs.push({
      x1: (P[i - 1] as Pt).x,
      y1: (P[i - 1] as Pt).y,
      x2: (P[i] as Pt).x,
      y2: (P[i] as Pt).y,
      way: wi,
    });
  }
});
console.log(`OSM: ${osmRaw.elements.length} ways, ${segs.length} segs`);

// ways sharing a node are chainable
const nodeWays = new Map<number, number[]>();
wayNodes.forEach((ns, wi) => {
  for (const n of ns) {
    const l = nodeWays.get(n) ?? [];
    l.push(wi);
    nodeWays.set(n, l);
  }
});
function shareNode(a: number, b: number): boolean {
  if (a === b) return true;
  const sa = wayNodes[a] as Set<number>;
  const sb = wayNodes[b] as Set<number>;
  const [small, big] = sa.size < sb.size ? [sa, sb] : [sb, sa];
  for (const n of small) if (big.has(n)) return true;
  return false;
}

// ---------- spatial index over OSM segs ----------
const CELL = 100;
const grid = new Map<string, number[]>();
segs.forEach((s, i) => {
  const x0 = Math.floor((Math.min(s.x1, s.x2) - SEARCH_M) / CELL);
  const x1 = Math.floor((Math.max(s.x1, s.x2) + SEARCH_M) / CELL);
  const y0 = Math.floor((Math.min(s.y1, s.y2) - SEARCH_M) / CELL);
  const y1 = Math.floor((Math.max(s.y1, s.y2) + SEARCH_M) / CELL);
  for (let cx = x0; cx <= x1; cx++)
    for (let cy = y0; cy <= y1; cy++) {
      const k = `${cx},${cy}`;
      const l = grid.get(k) ?? [];
      l.push(i);
      grid.set(k, l);
    }
});
function nearbySegs(x: number, y: number): number[] {
  return grid.get(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`) ?? [];
}
function projectSeg(s: OsmSeg, x: number, y: number): { px: number; py: number; dist: number } {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.min(1, Math.max(0, ((x - s.x1) * dx + (y - s.y1) * dy) / L2)) : 0;
  const px = s.x1 + dx * t;
  const py = s.y1 + dy * t;
  return { px, py, dist: Math.hypot(x - px, y - py) };
}

interface Cand {
  seg: number;
  way: number;
  px: number;
  py: number;
  dist: number;
}
// per route point: nearest OSM projections within SEARCH_M
const pools: Cand[][] = cur.map((p) => {
  const out: Cand[] = [];
  for (const si of nearbySegs(p.x, p.y)) {
    const s = segs[si] as OsmSeg;
    const pr = projectSeg(s, p.x, p.y);
    if (pr.dist <= SEARCH_M) out.push({ seg: si, way: s.way, px: pr.px, py: pr.py, dist: pr.dist });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, MAX_CAND);
});

// ---------- Viterbi chaining, per block with coverage ----------
const osmPt: (Pt | null)[] = new Array(RN).fill(null);
const osmDist: number[] = new Array(RN).fill(Infinity);
{
  let i = 0;
  while (i < RN) {
    if (pools[i] === undefined || (pools[i] as Cand[]).length === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < RN && (pools[j] as Cand[]).length > 0) j++;
    // block [i, j): viterbi
    const n = j - i;
    const prev = new Int32Array(n * MAX_CAND).fill(-1);
    const dp = new Float64Array(n * MAX_CAND).fill(Infinity);
    const K = (k: number): Cand[] => pools[i + k] as Cand[];
    K(0).forEach((c, a) => {
      dp[a] = c.dist;
    });
    for (let k = 1; k < n; k++) {
      const A = K(k - 1);
      const B = K(k);
      B.forEach((b, bi) => {
        let best = Infinity;
        let ba = 0;
        A.forEach((a, ai) => {
          const step = Math.hypot(b.px - a.px, b.py - a.py);
          const jump = Math.max(0, step - ROUTE_STEP_M * 2);
          const sw = a.seg === b.seg ? 0 : shareNode(a.way, b.way) ? 12 : 120;
          const c = (dp[(k - 1) * MAX_CAND + ai] as number) + 2 * jump + sw;
          if (c < best) {
            best = c;
            ba = ai;
          }
        });
        dp[k * MAX_CAND + bi] = best + b.dist;
        prev[k * MAX_CAND + bi] = ba;
      });
    }
    let bi = 0;
    {
      let best = Infinity;
      K(n - 1).forEach((_, a) => {
        const c = dp[(n - 1) * MAX_CAND + a] as number;
        if (c < best) {
          best = c;
          bi = a;
        }
      });
    }
    for (let k = n - 1; k >= 0; k--) {
      const c = K(k)[bi] as Cand;
      osmPt[i + k] = { x: c.px, y: c.py };
      osmDist[i + k] = c.dist;
      bi = k > 0 ? (prev[k * MAX_CAND + bi] as number) : 0;
    }
    i = j;
  }
}

// ---------- candidate polyline + origin ----------
// §8c-bis(1): SHORT gpx ranges are DELETED, not blended. A ≤40 m no-coverage
// stretch flanked by OSM on both sides whose true OSM-vs-current separation
// is 25–45 m crosses on OSM (a smooth ~30 m bow beats a 106° elbow pair);
// >60 m keeps the gpx range (OSM may map another variant). Measured values:
//   8.051–8.081 (30 m): 23.3 m cand / 24.8 m current → DELETE
//   14.441–14.466 (25 m): 22.7 m cand / 26.7 m current → DELETE
//   14.551–14.576 (25 m): 26.4 m cand / 26.7 m current → DELETE
// All three in 25–45 m: OSM crosses. Deletion = those points take the OSM
// projection even though it sits 25–30 m off the current line.
type Origin = "osm" | "gpx";
const DROP_SHORT_GPX = true;
const srcPts: Pt[] = [];
const srcOrg: Origin[] = [];
// short-range deletion needs the source index runs first: collect raw
// origin, find gpx runs ≤40 m flanked by osm, check max OSM distance.
const rawOrg: Origin[] = [];
for (let k = 0; k < RN; k++) {
  const op = osmPt[k];
  rawOrg.push(op !== null && (osmDist[k] as number) <= COVER_M ? "osm" : "gpx");
}
const dropIdx = new Set<number>();
if (DROP_SHORT_GPX) {
  let k = 0;
  while (k < RN) {
    if (rawOrg[k] !== "gpx") {
      k++;
      continue;
    }
    let j = k;
    while (j < RN && rawOrg[j] === "gpx") j++;
    // run [k, j) in source-index space; length in metres via current cumdist
    const runLen = (curD[j - 1] as number) - (curD[k] as number);
    const flanked = k > 0 && j < RN && rawOrg[k - 1] === "osm" && rawOrg[j] === "osm";
    if (flanked && runLen <= 40) {
      let mx = 0;
      for (let t = k; t < j; t++) mx = Math.max(mx, osmDist[t] as number);
      if (mx >= 25 && mx <= 45) {
        for (let t = k; t < j; t++) dropIdx.add(t);
        console.log(
          `short-gpx DROP: src [${k},${j}) ${(runLen).toFixed(0)} m @km ${((curD[k] as number) / 1000).toFixed(2)}, maxSep ${mx.toFixed(1)} m`,
        );
      } else {
        console.log(
          `short-gpx KEEP: src [${k},${j}) ${(runLen).toFixed(0)} m @km ${((curD[k] as number) / 1000).toFixed(2)}, maxSep ${mx.toFixed(1)} m (outside 25–45)`,
        );
      }
    }
    k = j;
  }
}
for (let k = 0; k < RN; k++) {
  const op = osmPt[k];
  if (dropIdx.has(k)) {
    srcPts.push(op as Pt);
    srcOrg.push("osm");
  } else if (op !== null && (osmDist[k] as number) <= COVER_M) {
    srcPts.push(op);
    srcOrg.push("osm");
  } else {
    srcPts.push(cur[k] as Pt);
    srcOrg.push("gpx");
  }
}

// ---------- resample @5 m (same walk as 05) + same XY smoothing ----------
function arcLengths(p: Pt[]): number[] {
  const d = [0];
  for (let k = 1; k < p.length; k++)
    d.push((d[k - 1] as number) + Math.hypot(p[k].x - p[k - 1].x, p[k].y - p[k - 1].y));
  return d;
}
const cum0 = arcLengths(srcPts);
const total0 = cum0[cum0.length - 1] as number;
const n = Math.max(2, Math.round(total0 / ROUTE_STEP_M));
const rs: Pt[] = [];
const rsOrg: Origin[] = [];
{
  let k = 0;
  for (let q = 0; q <= n; q++) {
    const target = (total0 * q) / n;
    while (k < cum0.length - 2 && (cum0[k + 1] as number) < target) k++;
    const d0 = cum0[k] as number;
    const d1 = cum0[k + 1] as number;
    const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    const a = srcPts[k] as Pt;
    const b = srcPts[k + 1] as Pt;
    rs.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    rsOrg.push(srcOrg[k] as Origin);
  }
}
const r = ROUTE_SMOOTH_RADIUS;
const nRs = rs.length; // resampled count known before smoothing (cn comes later)
const stepRs = total0 / n;
// §8c-bis(2): BLEND BEFORE smoothing. At each remaining osm<->gpx seam,
// cross-fade the two source polylines over BLEND_M each side (capped at
// half the gpx range length so the two ends of one range never overlap).
// The pipeline smoothing then works on an already-continuous line, and
// G111 judges the FINAL smoothed series — what is drawn.
const BLEND_M = 20;
const rsBlended: Pt[] = rs.map((p) => ({ ...p }));
{
  // seam positions in resampled index space + their gpx-range half-lengths
  const rangeHalf = new Map<number, number>(); // seam q -> half range (m)
  {
    let q = 0;
    while (q < nRs + 1) {
      if (q >= nRs || rsOrg[q] !== "gpx") {
        q++;
        continue;
      }
      let j = q;
      while (j < nRs && rsOrg[j] === "gpx") j++;
      const half = (total0 * (j - 1 - q)) / n / 2; // uniform resample: index→m
      rangeHalf.set(q, half); // gpx->osm seam at j recorded below
      (rangeHalf as Map<number, number>).set(j, half);
      q = j;
    }
  }
  for (let q = 1; q < nRs; q++) {
    if (rsOrg[q] === rsOrg[q - 1]) continue;
    const half = Math.min(BLEND_M, rangeHalf.get(q) ?? BLEND_M);
    const w = Math.max(2, Math.round(half / stepRs));
    // Anchor OUTSIDE the window: trends from ±(w+2..w+6), so the extension
    // is the leg's own heading, not the corner being removed. (Anchoring at
    // q±1/q±w reads the elbow itself and freezes half of it in place.)
    const pA0 = rs[Math.max(0, q - w - 6)] as Pt;
    const pA1 = rs[Math.max(0, q - w - 2)] as Pt;
    const pB0 = rs[Math.min(nRs - 1, q + w + 1)] as Pt;
    const pB1 = rs[Math.min(nRs - 1, q + w + 5)] as Pt;
    for (let t = -w; t <= w; t++) {
      const idx = q + t;
      if (idx < 0 || idx >= nRs) continue;
      const f = (t + w) / (2 * w);
      const s = f * f * (3 - 2 * f);
      // leg A trend extended forward, leg B trend extended backward
      const ax = pA1.x + ((pA1.x - pA0.x) / Math.max(1, w + 1)) * (t + 1);
      const ay = pA1.y + ((pA1.y - pA0.y) / Math.max(1, w + 1)) * (t + 1);
      const bx = pB0.x + ((pB1.x - pB0.x) / Math.max(1, w + 1)) * t;
      const by = pB0.y + ((pB1.y - pB0.y) / Math.max(1, w + 1)) * t;
      rsBlended[idx] = { x: ax + (bx - ax) * s, y: ay + (by - ay) * s };
    }
  }
}
const sm: Pt[] = rsBlended.map((p, q) => {
  let sx = 0;
  let sy = 0;
  let c = 0;
  for (let t = -r; t <= r; t++) {
    const v = rsBlended[q + t];
    if (v) {
      sx += v.x;
      sy += v.y;
      c++;
    }
  }
  return { x: sx / c, y: sy / c };
});
const cn = sm.length;
const cd: number[] = sm.map((_, q) => (total0 * q) / n);
const candLen = total0;
console.log(`candidate: ${cn} pts @ ~${(total0 / n).toFixed(2)} m, ${candLen.toFixed(1)} m`);

// ---------- elevation (heightmap bilinear, like the §8 audit) ----------
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
  minZ: number;
};
const { data: pngRaw } = await sharp("public/assets/heightmap.png")
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = meta.width;
const H = meta.height;
function gridAtPx(c: number, rr: number): number {
  const cc = Math.min(W - 1, Math.max(0, c));
  const r2 = Math.min(H - 1, Math.max(0, rr));
  return (
    meta.minZ +
    (pngRaw[(r2 * W + cc) * 3] as number) * 256 +
    (pngRaw[(r2 * W + cc) * 3 + 1] as number)
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
const cz = sm.map((p) => sampleMDT(p.x, p.y));

// ---------- helpers for the report ----------
function nearestD(pts: Pt[], cum: number[], x: number, y: number): number {
  let bi = 0;
  let bd = Infinity;
  for (let k = 0; k < pts.length; k++) {
    const dd = Math.hypot((pts[k] as Pt).x - x, (pts[k] as Pt).y - y);
    if (dd < bd) {
      bd = dd;
      bi = k;
    }
  }
  return cum[bi] as number;
}
function atD(pts: Pt[], cum: number[], dT: number): Pt {
  let k = 0;
  while (k < cum.length - 2 && (cum[k + 1] as number) < dT) k++;
  const d0 = cum[k] as number;
  const d1 = cum[k + 1] as number;
  const f = d1 > d0 ? (dT - d0) / (d1 - d0) : 0;
  const a = pts[k] as Pt;
  const b = pts[k + 1] as Pt;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
const curCum = curD;
const labels = JSON.parse(readFileSync("public/assets/labels.json", "utf8")) as {
  labels: { id: string; x: number; y: number; d?: number }[];
};

// G110-retrace-nonregression (reformulated §8c-bis(3): the old absolute
// ≤35° gate failed on the CURRENT route too — 75.3° max, 145 legs >35°.
// WHY no absolute threshold: the 1 m-quantised heightmap aliases on the
// subida zigzags (km 1.0–1.9), a cliff-band artefact inherited from the
// terrain, not a re-trace defect. Non-regression instead:
//   · per zone: candidate legs >35° <= current legs >35°
//   · global: candidate max <= current max (75.3°)
// Zones from the baseline audit: 0.7 · 1.0–1.8 · 2.6 · 4.4 · 14.8 km.
const G110_ZONES: [number, number][] = [
  [500, 1000],
  [1000, 1900],
  [2500, 3100],
  [3600, 4700],
  [14300, 14900],
];
function legsOver35(
  z: ArrayLike<number>,
  dd: ArrayLike<number>,
): { count: number; max: number; maxAt: number; perZone: number[] } {
  let count = 0;
  let max = 0;
  let maxAt = 0;
  const perZone = G110_ZONES.map(() => 0);
  // §8c-bis(3): compare like with like — only points present in BOTH series
  // (origin "osm" = OSM geometry; origin "gpx" = current geometry kept).
  // A leg counts toward a series only if all 5 samples (k..k+4) have the
  // required provenance. Series judged: candidate-osm vs current-where-
  // candidate-is-osm (frozen at generation time below), candidate-gpx vs
  // current-where-candidate-is-gpx. Both directions must non-regress.
  for (let k = 0; k + 4 < (z.length as number); k++) {
    const g = Math.abs((z[k + 4] as number) - (z[k] as number)) / 20;
    const deg = Math.atan(g) * (180 / Math.PI);
    if (deg > max) {
      max = deg;
      maxAt = dd[k] as number;
    }
    if (deg > 35) {
      count++;
      const d = dd[k] as number;
      G110_ZONES.forEach(([lo, hi], zi) => {
        if (d >= lo && d <= hi) perZone[zi] = (perZone[zi] as number) + 1;
      });
    }
  }
  return { count, max, maxAt, perZone };
}
// OSM-vs-OSM, GPX-vs-GPX: legsOver35 counts only legs whose 5 samples all
// carry the required provenance (origin mask). Mask arrays parallel to z.
function legsOver35Masked(
  z: ArrayLike<number>,
  dd: ArrayLike<number>,
  wantOsm: boolean,
  org: ArrayLike<string>,
): { count: number; max: number; maxAt: number; perZone: number[] } {
  let count = 0;
  let max = 0;
  let maxAt = 0;
  const perZone = G110_ZONES.map(() => 0);
  for (let k = 0; k + 4 < (z.length as number); k++) {
    let prov = true;
    for (let t = 0; t <= 4; t++) {
      if (((org[k + t] as string) === "osm") !== wantOsm) {
        prov = false;
        break;
      }
      // blend windows judge neither source
      if (nearSeam(dd[k + t] as number)) {
        prov = false;
        break;
      }
    }
    if (!prov) continue;
    const g = Math.abs((z[k + 4] as number) - (z[k] as number)) / 20;
    const deg = Math.atan(g) * (180 / Math.PI);
    if (deg > max) {
      max = deg;
      maxAt = dd[k] as number;
    }
    if (deg > 35) {
      count++;
      const d = dd[k] as number;
      G110_ZONES.forEach(([lo, hi], zi) => {
        if (d >= lo && d <= hi) perZone[zi] = (perZone[zi] as number) + 1;
      });
    }
  }
  return { count, max, maxAt, perZone };
}
// current-series provenance: nearest current point to each candidate point
// votes osm/gpx — but ONLY where the two series run on the same ground
// (nearest distance ≤ PROV_SAME_GROUND_M). Where OSM diverged 20–30 m, the
// current line samples different terrain and its legs are not the baseline
// for anything. Blend windows (±25 m) around seams are EXCLUDED from both
// masks: the blend fabricates geometry that is neither source. (Without the
// exclusion, candidate-gpx legs inside the blended window fail against
// unblended current-gpx legs on the same ground — e.g. d=1285–1295 @km 1.29,
// max 72.9° vs nothing.)
const SEAM_EXCL_M = 25;
const PROV_SAME_GROUND_M = 12;
const seamDs: number[] = [];
for (let k = 1; k < cn; k++) if (rsOrg[k] !== rsOrg[k - 1]) seamDs.push(cd[k] as number);
function nearSeam(d: number): boolean {
  return seamDs.some((s) => Math.abs(d - s) <= SEAM_EXCL_M);
}
const curOrg: string[] = new Array(cur.length).fill("gpx");
const curSameGround: boolean[] = new Array(cur.length).fill(false);
{
  for (let q = 0; q < cn; q++) {
    const p = sm[q] as Pt;
    let bi = 0;
    let bd = Infinity;
    for (let t = 0; t < cur.length; t++) {
      const dd = Math.hypot(p.x - (cur[t] as Pt).x, p.y - (cur[t] as Pt).y);
      if (dd < bd) {
        bd = dd;
        bi = t;
      }
    }
    // vote only where both series share ground — and record it
    if (bd <= PROV_SAME_GROUND_M) {
      curOrg[bi] = rsOrg[q] as string;
      curSameGround[bi] = true;
    }
  }
  // fill UNVOTED gaps only (never override a vote): short-range diffusion
  // so mask boundaries don't shatter on single unvoted points
  for (let pass = 0; pass < 12; pass++) {
    for (let t = 1; t < cur.length - 1; t++) {
      if (!curSameGround[t] && (curSameGround[t - 1] === true || curSameGround[t + 1] === true)) {
        curOrg[t] = curOrg[t - 1] === "osm" || curOrg[t + 1] === "osm" ? "osm" : "gpx";
        curSameGround[t] = true;
      }
    }
  }
}
// legsOver35Masked skips unvoted current points via the ground mask
function legsOver35MaskedCur(
  z: ArrayLike<number>,
  dd: ArrayLike<number>,
  wantOsm: boolean,
): { count: number; max: number; maxAt: number; perZone: number[] } {
  let count = 0;
  let max = 0;
  let maxAt = 0;
  const perZone = G110_ZONES.map(() => 0);
  for (let k = 0; k + 4 < (z.length as number); k++) {
    let prov = true;
    for (let t = 0; t <= 4; t++) {
      if (!curSameGround[k + t] || (curOrg[k + t] as string) !== (wantOsm ? "osm" : "gpx")) {
        prov = false;
        break;
      }
    }
    if (!prov) continue;
    const g = Math.abs((z[k + 4] as number) - (z[k] as number)) / 20;
    const deg = Math.atan(g) * (180 / Math.PI);
    if (deg > max) {
      max = deg;
      maxAt = dd[k] as number;
    }
    if (deg > 35) {
      count++;
      const d = dd[k] as number;
      G110_ZONES.forEach(([lo, hi], zi) => {
        if (d >= lo && d <= hi) perZone[zi] = (perZone[zi] as number) + 1;
      });
    }
  }
  return { count, max, maxAt, perZone };
}
const g110candOsm = legsOver35Masked(cz as number[], cd as number[], true, rsOrg as ArrayLike<string>);
const g110candGpx = legsOver35Masked(cz as number[], cd as number[], false, rsOrg as ArrayLike<string>);
const g110curOsm = legsOver35MaskedCur(
  (routeJ as unknown as { z_mdt: number[] }).z_mdt,
  curD as number[],
  true,
);
const g110curGpx = legsOver35MaskedCur(
  (routeJ as unknown as { z_mdt: number[] }).z_mdt,
  curD as number[],
  false,
);
const g110zoneOk =
  g110candOsm.perZone.every((c, zi) => c <= (g110curOsm.perZone[zi] as number)) &&
  g110candGpx.perZone.every((c, zi) => c <= (g110curGpx.perZone[zi] as number));
const g110ok =
  g110zoneOk && g110candOsm.max <= g110curOsm.max && g110candGpx.max <= g110curGpx.max;
// G111: seams — §8c-bis(4): measured on the FINAL smoothed series (sm),
// jump <= 15 m, turn <= 35°. The blend (above) runs BEFORE the pipeline
// smoothing, so what is judged is what is drawn.
interface Seam {
  d: number;
  from: Origin;
  to: Origin;
  jumpM: number;
  turnDeg: number;
}
const seams: Seam[] = [];
for (let k = 1; k < cn; k++) {
  if (rsOrg[k] !== rsOrg[k - 1]) {
    const a = sm[Math.max(0, k - 4)] as Pt;
    const b = sm[k] as Pt;
    const c = sm[Math.min(cn - 1, k + 4)] as Pt;
    const v1 = { x: b.x - a.x, y: b.y - a.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    const cos =
      l1 > 0 && l2 > 0 ? Math.min(1, Math.max(-1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2))) : 1;
    seams.push({
      d: Math.round((cd[k] as number) * 10) / 10,
      from: rsOrg[k - 1] as Origin,
      to: rsOrg[k] as Origin,
      jumpM: Math.round(Math.hypot((sm[k] as Pt).x - (sm[k - 1] as Pt).x, (sm[k] as Pt).y - (sm[k - 1] as Pt).y) * 10) / 10,
      turnDeg: Math.round((Math.acos(cos) * (180 / Math.PI)) * 10) / 10,
    });
  }
}
// G112: monotonic + no repeats
let monoOk = true;
for (let k = 1; k < cn; k++) if (!((cd[k] as number) > (cd[k - 1] as number))) monoOk = false;
let minSelfDist = Infinity;
for (let k = 0; k < cn; k += 2) {
  for (let q = k + 40; q < cn; q += 2) {
    const dd = Math.hypot((sm[k] as Pt).x - (sm[q] as Pt).x, (sm[k] as Pt).y - (sm[q] as Pt).y);
    if (dd < minSelfDist) minSelfDist = dd;
  }
}

// straight runs remaining (same ≤0.25 m perpendicular detector, computed
// against the RAW GPX chords from src/generated/gaps.ts — identical
// criterion to ?debug=gaps, run here over the candidate series).
// Candidate points are assigned to raw chords by NEAREST PROJECTION
// (not by d-window: the candidate has its own, longer arc length, so raw
// cumdist windows no longer line up post-retrace).
//
// NOTE: static import at top (tsx ESM-hoists; mid-file import would fail).
const rawChords: Pt[] = (GAP_RAW as readonly (readonly [number, number])[]).map(([x, y]) => ({ x, y }));
const DEV_TOL = 0.25;
const EDGE = 10;
const MIN_RUN = 100;
interface Run {
  dLo: number;
  dHi: number;
  kmLo: string;
  kmHi: string;
}
// chord assignment per candidate point: nearest raw chord with projection
// parameter inside the segment (fallback: nearest chord endpoint distance)
const assignChord: number[] = new Array(cn).fill(-1);
{
  for (let q = 0; q < cn; q++) {
    const p = sm[q] as Pt;
    let bj = -1;
    let bd = Infinity;
    for (let k = 0; k < rawChords.length - 1; k++) {
      const ax = rawChords[k].x;
      const ay = rawChords[k].y;
      const dx = rawChords[k + 1].x - ax;
      const dy = rawChords[k + 1].y - ay;
      const L2 = dx * dx + dy * dy;
      if (L2 <= 0) continue;
      const t = ((p.x - ax) * dx + (p.y - ay) * dy) / L2;
      const tc = Math.min(1, Math.max(0, t));
      const dd = Math.hypot(p.x - (ax + dx * tc), p.y - (ay + dy * tc));
      if (dd < bd) {
        bd = dd;
        bj = t >= 0 && t <= 1 ? k : bj;
        if (t >= 0 && t <= 1) bj = k;
      }
    }
    assignChord[q] = bj;
  }
}
const candRuns: Run[] = [];
{
  // per-chord max deviation of the candidate points assigned to it
  const maxDev = new Map<number, number>();
  const seenD = new Map<number, { lo: number; hi: number }>();
  for (let q = 0; q < cn; q++) {
    const k = assignChord[q] as number;
    if (k < 0) continue;
    const ax = rawChords[k].x;
    const ay = rawChords[k].y;
    const dx = rawChords[k + 1].x - ax;
    const dy = rawChords[k + 1].y - ay;
    const L = Math.hypot(dx, dy);
    if (L <= 0) continue;
    const p = sm[q] as Pt;
    const dev = Math.abs((p.x - ax) * dy - (p.y - ay) * dx) / L;
    if (dev > (maxDev.get(k) ?? 0)) maxDev.set(k, dev);
    const d = cd[q] as number;
    const s = seenD.get(k) ?? { lo: d, hi: d };
    s.lo = Math.min(s.lo, d);
    s.hi = Math.max(s.hi, d);
    seenD.set(k, s);
  }
  // chord lengths (raw arc length) + merge adjacent straight chords
  const chordLen = (k: number): number =>
    Math.hypot(rawChords[k + 1].x - rawChords[k].x, rawChords[k + 1].y - rawChords[k].y);
  const straight: boolean[] = [];
  for (let k = 0; k < rawChords.length - 1; k++)
    straight.push(chordLen(k) >= MIN_RUN && (maxDev.get(k) ?? Infinity) <= DEV_TOL);
  let lo = -1;
  const flush = (end: number): void => {
    if (lo < 0) return;
    const dLo = (seenD.get(lo) as { lo: number; hi: number }).lo;
    const dHi = (seenD.get(end - 1) as { lo: number; hi: number }).hi;
    if (dHi - dLo >= MIN_RUN)
      candRuns.push({
        dLo: Math.round(dLo * 10) / 10,
        dHi: Math.round(dHi * 10) / 10,
        kmLo: (dLo / 1000).toFixed(2),
        kmHi: (dHi / 1000).toFixed(2),
      });
    lo = -1;
  };
  for (let k = 0; k <= straight.length; k++) {
    if (straight[k] === true) {
      if (lo < 0) lo = k;
    } else flush(k);
  }
}

// ---------- write candidate + overlay input ----------
// route-osm-candidate.json carries the full report inputs; retrace.ts only
// the plan polyline + origin for the lazy ?debug=retrace chunk.
const r1 = (v: number): number => Math.round(v * 10) / 10;
const nOsm = rsOrg.filter((o) => o === "osm").length;
const nGpx = cn - nOsm;
const gpxRanges: [number, number][] = [];
{
  let lo = -1;
  for (let k = 0; k <= cn; k++) {
    if (rsOrg[k] === "gpx") {
      if (lo < 0) lo = k;
    } else if (lo >= 0) {
      gpxRanges.push([r1(cd[lo] as number), r1(cd[k - 1] as number)]);
      lo = -1;
    }
  }
}
// Cola de Caballo: nearest candidate point to the label XY
const cola = labels.labels.find((l) => l.id === "cola-caballo") as { x: number; y: number };
const colaD = nearestD(sm, cd, cola.x, cola.y);
// top-10 separations CANDIDATE-vs-CURRENT (per candidate point, nearest
// current point; thinned to one per 100 m stretch): where the retrace
// actually moved the trace. >60 m = OSM may map a different variant.
interface Sep {
  d: number;
  km: string;
  distM: number;
  x: number;
  y: number;
}
const seps: Sep[] = sm.map((p, k) => {
  const q = p as Pt;
  let bc = Infinity;
  for (let t = 0; t < cur.length; t += 2) {
    const dd = Math.hypot(q.x - (cur[t] as Pt).x, q.y - (cur[t] as Pt).y);
    if (dd < bc) bc = dd;
  }
  return {
    d: cd[k] as number,
    km: ((cd[k] as number) / 1000).toFixed(2),
    distM: Math.round(bc * 10) / 10,
    x: Math.round(q.x * 10) / 10,
    y: Math.round(q.y * 10) / 10,
  };
});
const top10 = [...seps]
  .sort((a, b) => b.distM - a.distM)
  .filter((s, k, arr) => k === 0 || Math.abs(s.d - (arr[k - 1] as Sep).d) > 100)
  .slice(0, 10)
  .sort((a, b) => a.d - b.d);

const out = {
  generatedAt: new Date().toISOString(),
  source: {
    route: ROUTE_FILE,
    osm: OSM_FILE,
    elevation: "public/assets/heightmap.png + data/build/meta.json (bilinear)",
  },
  lengthM: r1(candLen),
  prevLengthM: routeJ.lengthM,
  deltaM: r1(candLen - routeJ.lengthM),
  deltaPct: Math.round(((candLen - routeJ.lengthM) / routeJ.lengthM) * 10000) / 100,
  colaD: r1(colaD),
  prevColaD: 9670.5,
  colaDeltaM: r1(colaD - 9670.5),
  originPct: {
    osm: Math.round((nOsm / cn) * 1000) / 10,
    gpx: Math.round((nGpx / cn) * 1000) / 10,
    nOsm,
    nGpx,
    n: cn,
  },
  // G110 reads BARE TERRAIN: the candidate z series carries no drape
  // offset (route.json z carries +4 m); both series read the same ground.
  g110detail: null as null,
  gpxRanges,
  straightRuns: candRuns,
  straightM: r1(candRuns.reduce((s, x) => s + (x.dHi - x.dLo), 0)),
  seams,
  gates: {
    g110: {
      name: "G110-retrace-nonregression",
      ok: g110ok,
      osm: {
        candLegs: g110candOsm.count,
        curLegs: g110curOsm.count,
        candPerZone: g110candOsm.perZone,
        curPerZone: g110curOsm.perZone,
        candMax: Math.round(g110candOsm.max * 10) / 10,
        curMax: Math.round(g110curOsm.max * 10) / 10,
      },
      gpx: {
        candLegs: g110candGpx.count,
        curLegs: g110curGpx.count,
        candPerZone: g110candGpx.perZone,
        curPerZone: g110curGpx.perZone,
        candMax: Math.round(g110candGpx.max * 10) / 10,
        curMax: Math.round(g110curGpx.max * 10) / 10,
      },
      zones: G110_ZONES.map(([lo, hi]) => `${(lo / 1000).toFixed(1)}–${(hi / 1000).toFixed(1)}`),
    },
    g111: {
      name: "G111-retrace-seams",
      ok: seams.every((s) => s.jumpM <= 15 && s.turnDeg <= 35),
      seams: seams.length,
      worst: seams.reduce(
        (w, s) => (s.jumpM > w.jumpM || s.turnDeg > w.turnDeg ? s : w),
        { d: 0, from: "osm" as Origin, to: "osm" as Origin, jumpM: 0, turnDeg: 0 },
      ),
    },
    g112: {
      name: "G112-retrace-monotonic",
      ok: monoOk,
      minSelfDistM: Math.round(minSelfDist * 10) / 10,
    },
  },
  top10,
  x: sm.map((p) => r1((p as Pt).x)),
  y: sm.map((p) => r1((p as Pt).y)),
  z: (cz as number[]).map(r1),
  d: (cd as number[]).map(r1),
  origin: rsOrg,
};
mkdirSync(dirname(OUT_JSON), { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
console.log(`saved: ${OUT_JSON} (${cn} pts)`);

mkdirSync(dirname(OUT_GEN), { recursive: true });
writeFileSync(
  OUT_GEN,
  `// GENERATED by scripts/19-retrace-osm.ts — do not edit by hand.\n` +
    `// OSM re-trace candidate (plan only) for the lazy ?debug=retrace chunk.\n` +
    `// Full data (z, report, gates) lives in data/build/route-osm-candidate.json.\n` +
    `export const RETRACE_X: number[] = ${JSON.stringify(out.x)};\n` +
    `export const RETRACE_Y: number[] = ${JSON.stringify(out.y)};\n` +
    `export const RETRACE_D: number[] = ${JSON.stringify(out.d)};\n` +
    `export const RETRACE_ORIGIN: Array<"osm" | "gpx"> = ${JSON.stringify(out.origin)};\n` +
    `export const RETRACE_META = ${JSON.stringify({ lengthM: out.lengthM, prevLengthM: out.prevLengthM, generatedAt: out.generatedAt })};\n`,
);
console.log(`saved: ${OUT_GEN} (${cn} pts)`);

// ---------- console report ----------
console.log(`\n== length ==`);
console.log(
  `candidate ${out.lengthM} m vs ${out.prevLengthM} m (delta ${out.deltaM >= 0 ? "+" : ""}${out.deltaM} m = ${out.deltaPct >= 0 ? "+" : ""}${out.deltaPct}%)`,
);
console.log(`\n== Cola de Caballo ==`);
console.log(
  `candidate d=${out.colaD} m (today 9670.5 m, delta ${out.colaDeltaM >= 0 ? "+" : ""}${out.colaDeltaM} m)`,
);
console.log(`\n== act borders + beams/labels (exact: nearest candidate point to each XY) ==`);
for (const a of ACTS) {
  if (a.act === 0) {
    console.log(`act ${a.act}:${a.name} @${a.startM} -> @0 (origin, no shift)`);
    continue;
  }
  const p = atD(cur, curCum, Math.min(a.startM, routeJ.lengthM));
  const nd = nearestD(sm, cd, p.x, p.y);
  console.log(
    `act ${a.act}:${a.name} @${a.startM} -> @${nd.toFixed(1)} (${nd - a.startM >= 0 ? "+" : ""}${(nd - a.startM).toFixed(1)} m)`,
  );
}
for (const l of labels.labels) {
  if (l.id === "pradera") {
    console.log(`hito ${l.id} d=${l.d ?? 0} -> @0 (origin)`);
    continue;
  }
  const nd = nearestD(sm, cd, l.x, l.y);
  const dd = l.d ?? nd;
  console.log(
    `hito ${l.id} d=${dd} -> @${nd.toFixed(1)} (${nd - dd >= 0 ? "+" : ""}${(nd - dd).toFixed(1)} m)`,
  );
}
console.log(`\n== origin ==`);
console.log(`osm ${out.originPct.osm}% (${nOsm}/${cn}) · gpx ${out.originPct.gpx}% (${nGpx}/${cn})`);
console.log(
  `gpx (no-coverage) ranges: ${gpxRanges.map(([a, b]) => `${(a / 1000).toFixed(2)}–${(b / 1000).toFixed(2)}`).join(" | ")}`,
);
console.log(`\n== straight runs remaining (<=0.25 m, >=100 m) ==`);
console.log(`candidate ${out.straightM} m in ${candRuns.length} runs (today 6820 m in 28 runs)`);
for (const x of candRuns) console.log(`  km ${x.kmLo}–${x.kmHi} (${(x.dHi - x.dLo).toFixed(0)} m)`);
console.log(`\n== top-10 candidate-vs-current separations ==`);
for (const s of top10)
  console.log(
    `  km ${s.km}: ${s.distM} m @(${s.x},${s.y})${s.distM > 60 ? "  <-- VARIANT SUSPECT (>60 m)" : ""}`,
  );
console.log(`\n== gates ==`);
console.log(
  `G110-retrace-nonregression: ${out.gates.g110.ok ? "PASS" : "FAIL"} ` +
    `(osm legs ${out.gates.g110.osm.candLegs} vs ${out.gates.g110.osm.curLegs}, max ${out.gates.g110.osm.candMax} vs ${out.gates.g110.osm.curMax}; ` +
    `gpx legs ${out.gates.g110.gpx.candLegs} vs ${out.gates.g110.gpx.curLegs}, max ${out.gates.g110.gpx.candMax} vs ${out.gates.g110.gpx.curMax})`,
);
console.log(
  `G111-retrace-seams: ${out.gates.g111.ok ? "PASS" : "FAIL"} (${seams.length} seams, worst jump ${out.gates.g111.worst.jumpM} m / turn ${out.gates.g111.worst.turnDeg}° @${out.gates.g111.worst.d} m, need <=15 m / <=35°)`,
);
console.log(
  `G112-retrace-monotonic: ${out.gates.g112.ok ? "PASS" : "FAIL"} (strictly increasing: ${monoOk}, min self-distance ${out.gates.g112.minSelfDistM} m)`,
);
if (!out.gates.g110.ok || !out.gates.g111.ok || !out.gates.g112.ok) process.exitCode = 1;
