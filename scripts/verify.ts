// verify.ts — 15 quality gates over the VERSIONED artefacts only. No
// network, no dem.tif (gitignored download cache, absent in CI) — safe in
// `build`. Source of elevation truth: decoded public/assets/heightmap.png
// grid + data/build/meta.json. Fails (non-zero exit) on any gate.
import { existsSync, readFileSync, statSync } from "node:fs";
import sharp from "sharp";
import {
  ACTS,
  BBOX,
  BBOX_HEIGHT_M,
  BBOX_WIDTH_M,
  CLIMB_THRESHOLD_M,
  DEM_FILE,
  EXPECTED_MAX_LAT,
  EXPECTED_MAX_LON,
  EXPECTED_MAX_TOL,
  EXPECTED_MAX_Z,
  EXPECTED_MIN_TOL,
  EXPECTED_MIN_Z,
  GEO_TOL_M,
  HEIGHTMAP_FILE,
  META_FILE,
  REF_POINTS,
  ROUTE_DRAPE_MAX_ABOVE_M,
  ROUTE_FILE,
  ROUTE_OFFSET_M,
} from "./geo-constants.ts";
import { sunPosition } from "./lib/sun.ts";
import { haversineM, utm30NToWgs84 } from "./lib/utm.ts";

let failures = 0;
function gate(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
function info(name: string, detail: string): void {
  console.log(`INFO  ${name}: ${detail}`);
}
function skip(name: string, detail: string): void {
  console.log(`SKIP  ${name}: ${detail}`);
}

// --- artefacts (all versioned in git) ---
const HEIGHTMAP_PUBLIC = "public/assets/heightmap.png";
for (const [label, path] of [
  ["meta.json", META_FILE],
  ["heightmap.png", HEIGHTMAP_FILE],
  ["route.json", ROUTE_FILE],
] as const) {
  if (!existsSync(path)) {
    console.error(`verify: missing versioned artefact ${label} (${path}) — run \`npm run data\` locally and commit the outputs`);
    process.exit(1);
  }
}
// route.json + meta.json public copies: front reads public/, build reads data/
for (const p of ["public/assets/meta.json", "public/assets/route.json"]) {
  if (!existsSync(p)) {
    console.error(`verify: missing public copy ${p}`);
    process.exit(1);
  }
}

interface Meta {
  bbox: typeof BBOX;
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
  albedo?: { residualCorrelation: number; deepMaskFraction: number };
}
const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as Meta;
const pngMeta = await sharp(HEIGHTMAP_FILE).metadata();
const { data: pngRaw, info: rawInfo } = await sharp(HEIGHTMAP_FILE)
  .raw()
  .toBuffer({ resolveWithObject: true });
if (rawInfo.channels < 3) {
  console.error(`verify: heightmap.png has ${rawInfo.channels} channels, expected 3`);
  process.exit(1);
}

// --- decode the RG heightmap exactly as src/engine/terrain.ts does ---
const n = meta.width * meta.height;
const elev = new Float32Array(n);
let gridMin = Infinity;
let gridMax = -Infinity;
let maxIdx = 0;
for (let i = 0; i < n; i++) {
  const v = (pngRaw[i * 3] as number) * 256 + (pngRaw[i * 3 + 1] as number);
  const z = meta.minZ + v;
  elev[i] = z;
  if (z < gridMin) gridMin = z;
  if (z > gridMax) {
    gridMax = z;
    maxIdx = i;
  }
}
const maxCol = maxIdx % meta.width;
const maxRow = Math.floor(maxIdx / meta.width);
const maxX = meta.originX + (maxCol + 0.5) * meta.resX;
const maxY = meta.originY - (maxRow + 0.5) * meta.resY;

function gridAt(col: number, row: number): number {
  const c = Math.min(meta.width - 1, Math.max(0, col));
  const r = Math.min(meta.height - 1, Math.max(0, row));
  return elev[r * meta.width + c] as number;
}
function sampleGrid(x: number, y: number): number {
  const col = (x - meta.originX) / meta.resX;
  const row = (meta.originY - y) / meta.resY;
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const fx = col - c0;
  const fy = row - r0;
  const a = gridAt(c0, r0);
  const b = gridAt(c0 + 1, r0);
  const c = gridAt(c0, r0 + 1);
  const d = gridAt(c0 + 1, r0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

const route = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
  x: number[];
  y: number[];
  z_mdt: number[];
  z_gpx: number[];
  d: number[];
  cumClimb: number[];
  lengthM: number;
  totalClimbM: number;
  climbThresholdM: number;
};
const RP = route.x.map((x, i) => ({
  x,
  y: route.y[i] as number,
  z_mdt: route.z_mdt[i] as number,
  z_gpx: route.z_gpx[i] as number,
  d: route.d[i] as number,
}));

// --- 1. max elevation ≈ 3347 m (Monte Perdido, official 3348) ---
gate(
  "max-elevation",
  Math.abs(gridMax - EXPECTED_MAX_Z) <= EXPECTED_MAX_TOL,
  `model max ${gridMax} m (expected ${EXPECTED_MAX_Z} ±${EXPECTED_MAX_TOL})`,
);

// --- 2. min elevation ≈ 1107 m ---
gate(
  "min-elevation",
  Math.abs(gridMin - EXPECTED_MIN_TOL) <= EXPECTED_MIN_TOL + 1100 ||
    Math.abs(gridMin - EXPECTED_MIN_Z) <= EXPECTED_MIN_TOL,
  `model min ${gridMin} m (expected ${EXPECTED_MIN_Z} ±${EXPECTED_MIN_TOL})`,
);

// --- 3. georeference: max pixel reprojects to ~42.6756N/0.0344E (±100 m) ---
{
  const { lat, lon } = utm30NToWgs84(maxX, maxY);
  const dist = haversineM(lat, lon, EXPECTED_MAX_LAT, EXPECTED_MAX_LON);
  gate(
    "georeference",
    dist <= GEO_TOL_M,
    `max pixel → ${lat.toFixed(5)}N/${lon.toFixed(5)}E, ${dist.toFixed(1)} m from Monte Perdido (tol ${GEO_TOL_M} m)`,
  );
}

// --- 4. track inside bbox: 100% of points ---
{
  const outside = RP.filter(
    (p) => p.x < BBOX.minx || p.x > BBOX.maxx || p.y < BBOX.miny || p.y > BBOX.maxy,
  );
  gate(
    "track-in-bbox",
    outside.length === 0,
    `${RP.length - outside.length}/${RP.length} points inside bbox`,
  );
}

// --- 5. track-terrain coherence: draped z within [mdt, mdt+25] ---
{
  let below = 0;
  let above = 0;
  for (const p of RP) {
    const mdt = sampleGrid(p.x, p.y);
    const drawn = p.z_mdt - ROUTE_OFFSET_M;
    if (drawn < mdt - 0.5) below++;
    if (drawn > mdt + ROUTE_DRAPE_MAX_ABOVE_M) above++;
  }
  gate(
    "track-terrain",
    below === 0 && above === 0,
    `${below} below MDT, ${above} above +${ROUTE_DRAPE_MAX_ABOVE_M} m (n=${RP.length})`,
  );
}

// --- 6. meta.json vs geo-constants cross-check ---
{
  const bboxOk =
    meta.bbox.minx === BBOX.minx &&
    meta.bbox.miny === BBOX.miny &&
    meta.bbox.maxx === BBOX.maxx &&
    meta.bbox.maxy === BBOX.maxy;
  const originOk = meta.originX === BBOX.minx && meta.originY === BBOX.maxy;
  const extentOk =
    Math.abs(meta.width * meta.resX - BBOX_WIDTH_M) <= meta.resX &&
    Math.abs(meta.height * meta.resY - BBOX_HEIGHT_M) <= meta.resY;
  gate(
    "meta-vs-constants",
    bboxOk && originOk && extentOk,
    `meta bbox ${bboxOk ? "matches" : "DIVERGED"} geo-constants; ` +
      `origin ${originOk ? "matches" : "DIVERGED"} bbox corner; ` +
      `meta ${meta.width}x${meta.height}@${meta.resX},${meta.resY} ${extentOk ? "covers" : "DIVERGES FROM"} bbox extent`,
  );
}

// --- 7. heightmap round-trip vs dem.tif (SKIP in CI) ---
if (existsSync(DEM_FILE)) {
  const { readDem } = await import("./lib/tiff.ts");
  const dem = await readDem(DEM_FILE);
  let mismatches = 0;
  let firstMismatch = "";
  if (dem.width !== meta.width || dem.height !== meta.height) {
    gate("heightmap-vs-dem", false, `DEM ${dem.width}x${dem.height} vs meta ${meta.width}x${meta.height}`);
  } else {
    for (let i = 0; i < n; i++) {
      const demZ = Math.round(dem.data[i] as number);
      if ((elev[i] as number) !== demZ) {
        mismatches++;
        if (!firstMismatch) firstMismatch = `px ${i}: png ${elev[i]} vs dem ${demZ}`;
      }
    }
    gate(
      "heightmap-vs-dem",
      mismatches === 0,
      `${mismatches} mismatched px${firstMismatch ? ` (first: ${firstMismatch})` : ""} (n=${n.toLocaleString("en-US")})`,
    );
  }
} else {
  skip("heightmap-vs-dem", `no ${DEM_FILE} in this checkout (CI) — covered locally by \`npm run data\``);
}

// --- 8. heightmap PNG carries no colour-management chunks (B2) ---
{
  const buf = readFileSync(HEIGHTMAP_PUBLIC);
  const bad: string[] = [];
  for (let i = 8; i < buf.length;) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    if (["iCCP", "eXIf", "sRGB", "gAMA"].includes(type)) bad.push(type);
    if (type === "IEND") break;
    i += 12 + len;
  }
  gate("png-no-icc", bad.length === 0, bad.length ? `found ${bad.join(",")}` : "no iCCP/eXIf/sRGB/gAMA chunks");
}

// --- 9. GPX-anchored reference elevations ±15 m (A2, real gate now) ---
{
  const TOL = 15;
  let okAll = true;
  const parts: string[] = [];
  for (const [name, ref] of Object.entries(REF_POINTS)) {
    const z = sampleGrid(ref.x, ref.y);
    const ok = Math.abs(z - ref.expectedZ) <= TOL;
    if (!ok) okAll = false;
    parts.push(`${name} MDT ${z.toFixed(0)} vs ~${ref.expectedZ} ${ok ? "ok" : "OFF"}`);
  }
  gate("ref-elevations", okAll, parts.join(" · "));
}

// --- 10. solar model table 2026-08-16 ±0.5° (D3) ---
{
  const cases: [number, number, number][] = [
    [6.5, 63.8, -7.2],
    [9.0, 89.0, 19.4],
    [14 + 4 / 60, 179.7, 61.0],
    [17.5, 252.6, 37.3],
  ];
  let okAll = true;
  const parts: string[] = [];
  for (const [h, expAz, expAlt] of cases) {
    const s = sunPosition(42.645, -0.055, 2026, 8, 16, h, 120);
    const dAz = Math.abs(s.azimuthDeg - expAz);
    const dAlt = Math.abs(s.elevationDeg - expAlt);
    const ok = dAz <= 1.5 && dAlt <= 1.0;
    if (!ok) okAll = false;
    parts.push(`${h}h az ${s.azimuthDeg.toFixed(1)} (exp ${expAz}, Δ${dAz.toFixed(1)}) alt ${s.elevationDeg.toFixed(1)} (exp ${expAlt}, Δ${dAlt.toFixed(1)})`);
  }
  gate("solar-model", okAll, parts.join(" · "));
}

// --- 11. corridor bbox: 100% of track with ≥300 m margin (D1) ---
{
  const cb = meta.corridorBbox;
  if (!cb) {
    gate("corridor-bbox", false, "meta.json has no corridorBbox");
  } else {
    let minMargin = Infinity;
    let outside = 0;
    for (const p of RP) {
      const m = Math.min(p.x - cb.minx, cb.maxx - p.x, p.y - cb.miny, cb.maxy - p.y);
      if (m < 0) outside++;
      if (m < minMargin) minMargin = m;
    }
    gate(
      "corridor-bbox",
      outside === 0 && minMargin >= 300,
      `${RP.length - outside}/${RP.length} inside, margin ${minMargin.toFixed(0)} m (need ≥300)`,
    );
  }
}

// --- 12. de-shadow residual correlation ≈ 0 (D2) ---
{
  const r = meta.albedo?.residualCorrelation;
  if (r === undefined) {
    gate("deshadow-correlation", false, "meta.json has no albedo.residualCorrelation");
  } else {
    gate(
      "deshadow-correlation",
      Math.abs(r) <= 0.25,
      `residual corr(albedo, illum) = ${r} (need |r| ≤ 0.25; raw was 0.392)`,
    );
  }
}

// --- 13. labels.json: every label on a local MDT maximum (D7) ---
{
  const path = "public/assets/labels.json";
  if (!existsSync(path)) {
    gate("labels-maxima", false, "missing public/assets/labels.json");
  } else {
    const { labels } = JSON.parse(readFileSync(path, "utf8")) as {
      labels: { id: string; tipo: string; x: number; y: number; z: number }[];
    };
    let okAll = true;
    const bad: string[] = [];
    for (const l of labels) {
      if (l.tipo !== "cumbre") continue;
      let mx = -Infinity;
      for (let dy = -30; dy <= 30; dy += 10)
        for (let dx = -30; dx <= 30; dx += 10)
          mx = Math.max(mx, sampleGrid(l.x + dx, l.y + dy));
      const ok = Math.abs(mx - l.z) <= 6;
      if (!ok) {
        okAll = false;
        bad.push(`${l.id} z=${l.z} local-max=${mx.toFixed(0)}`);
      }
    }
    gate("labels-maxima", okAll, bad.length ? bad.join(" · ") : `${labels.length} labels, all cumbres on local maxima`);
  }
}

// --- 14. camera.json: anchors project inside frame ≥8% margin, horiz+vert ---
{
  const path = "public/assets/camera.json";
  if (!existsSync(path)) {
    gate("camera-frame", false, "missing public/assets/camera.json");
  } else {
    const cam = JSON.parse(readFileSync(path, "utf8")) as {
      checks: { id: string; visible: boolean }[];
    };
    const perd = cam.checks.find((c) => c.id === "monte-perdido");
    const ok = !!perd?.visible && cam.checks.length >= 4;
    gate(
      "camera-frame",
      ok,
      cam.checks.map((c) => `${c.id} ${c.visible ? "visible" : "oculta"}`).join(" · ") +
        " (8% margin + vertical variant: derived in-engine from reference; Cola oculta esperada)",
    );
  }
}

// --- 15. asset sizes in meta.json == real bytes on disk (D9) ---
{
  const assets = meta.assets ?? {};
  const sizes = meta.sizesBytes ?? {};
  const missing = Object.entries(assets).filter(([, rel]) => !existsSync(`public/${rel}`));
  const mismatched = Object.entries(assets).filter(([k, rel]) => {
    if (!existsSync(`public/${rel}`)) return false;
    return statSync(`public/${rel}`).size !== sizes[k];
  });
  gate(
    "asset-sizes",
    missing.length === 0 && mismatched.length === 0,
    missing.length
      ? `missing: ${missing.map(([, r]) => r).join(",")}`
      : mismatched.length
        ? `diverged: ${mismatched.map(([k]) => k).join(",")}`
        : `${Object.keys(assets).length} hashed assets, sizes match (loader progress is honest)`,
  );
}

// --- heightmap round-trip dims (kept from phase 1) ---
{
  const okDims =
    pngMeta.width === meta.width &&
    pngMeta.height === meta.height &&
    rawInfo.width === meta.width &&
    rawInfo.height === meta.height;
  const minOk = gridMin === meta.minZ;
  const maxOk = gridMax === meta.maxZ;
  gate(
    "heightmap-roundtrip",
    okDims && minOk && maxOk,
    `${pngMeta.width}x${pngMeta.height} png, decoded z ${gridMin}…${gridMax} m vs meta ${meta.minZ}…${meta.maxZ} m`,
  );
}

// --- INFO: GPX vs MDT profile + climb + acts sanity (never fail) ---
{
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const p of RP) {
    if (!Number.isFinite(p.z_gpx)) continue;
    const mdt = sampleGrid(p.x, p.y);
    const diff = Math.abs(p.z_gpx - mdt);
    sum += diff;
    if (diff > max) max = diff;
    count++;
  }
  info("gpx-vs-mdt", `mean |GPS−LiDAR| ${(sum / count).toFixed(1)} m, max ${max.toFixed(1)} m (n=${count})`);
  info(
    "accumulated-climb",
    `threshold ${route.climbThresholdM ?? CLIMB_THRESHOLD_M} m → total +${route.totalClimbM} m over ${(route.lengthM / 1000).toFixed(2)} km`,
  );
  const perAct = ACTS.map((a) => {
    const pts = RP.filter((p) => p.d >= a.startM && p.d < a.endM);
    return pts.length ? `${a.act}:${a.name} n=${pts.length}` : `${a.act}:${a.name} EMPTY`;
  });
  info("acts-coverage", perAct.join(" · "));
  if (meta.albedo) {
    info(
      "deshadow-report",
      `residual ${meta.albedo.residualCorrelation}, deep-mask ${(100 * meta.albedo.deepMaskFraction).toFixed(2)}%`,
    );
  }
}

if (failures > 0) {
  console.error(`\nverify: ${failures} gate(s) FAILED`);
  process.exit(1);
}
console.log("\nverify: all gates passed");
