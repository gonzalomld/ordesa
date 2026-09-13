// verify.ts — 8 quality gates over the VERSIONED artefacts only. No network,
// no dem.tif (gitignored download cache, absent in CI) — safe in `build`.
//
// Source of elevation truth here is the decoded public/assets/heightmap.png
// grid + data/build/meta.json. When data/source/dem.tif happens to exist
// (local `npm run data`), an extra strict check compares every PNG pixel
// against the DEM; in CI that check is skipped, the other gates still run.
//
// Fails (non-zero exit) on any gate so `build` breaks honestly.
// Informational diagnostics (GPX-vs-MDT profile, reference elevations) never
// fail but are never silenced either: they print and the reader decides.
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";
import {
  BBOX,
  BBOX_HEIGHT_M,
  BBOX_WIDTH_M,
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

// --- bilinear sampler over the decoded grid (same edge convention as the DEM reader) ---
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
  points: { x: number; y: number; z_mdt: number; z_gpx: number; d: number }[];
};

// --- 1. max elevation ≈ 3347 m (Monte Perdido, official 3348) ---
gate(
  "max-elevation",
  Math.abs(gridMax - EXPECTED_MAX_Z) <= EXPECTED_MAX_TOL,
  `model max ${gridMax} m (expected ${EXPECTED_MAX_Z} ±${EXPECTED_MAX_TOL})`,
);

// --- 2. min elevation ≈ 1107 m ---
gate(
  "min-elevation",
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

// --- 4. track inside bbox: 100% of GPX points ---
{
  const outside = route.points.filter(
    (p) => p.x < BBOX.minx || p.x > BBOX.maxx || p.y < BBOX.miny || p.y > BBOX.maxy,
  );
  gate(
    "track-in-bbox",
    outside.length === 0,
    `${route.points.length - outside.length}/${route.points.length} points inside bbox`,
  );
}

// --- 5. track-terrain coherence: draped z within [mdt, mdt+25] ---
{
  let below = 0;
  let above = 0;
  for (const p of route.points) {
    const mdt = sampleGrid(p.x, p.y);
    const drawn = p.z_mdt - ROUTE_OFFSET_M; // strip the known drape offset
    if (drawn < mdt - 0.5) below++;
    if (drawn > mdt + ROUTE_DRAPE_MAX_ABOVE_M) above++;
  }
  gate(
    "track-terrain",
    below === 0 && above === 0,
    `${below} below MDT, ${above} above +${ROUTE_DRAPE_MAX_ABOVE_M} m (n=${route.points.length})`,
  );
}

// --- 6. GPX-vs-MDT profile (diagnostic, never fails) ---
{
  let sum = 0;
  let max = 0;
  let count = 0;
  for (const p of route.points) {
    if (!Number.isFinite(p.z_gpx)) continue;
    const mdt = sampleGrid(p.x, p.y);
    const diff = Math.abs(p.z_gpx - mdt);
    sum += diff;
    if (diff > max) max = diff;
    count++;
  }
  info("gpx-vs-mdt", `mean |GPS−LiDAR| ${(sum / count).toFixed(1)} m, max ${max.toFixed(1)} m (n=${count})`);
}

// --- 7. reference elevations (diagnostic, never fails, never silenced) ---
for (const [name, ref] of Object.entries(REF_POINTS)) {
  if (!ref.expectedZ) continue;
  const z = sampleGrid(ref.x, ref.y);
  info("ref-elevation", `${name}: MDT ${z.toFixed(0)} m vs expected ~${ref.expectedZ} m`);
}

// --- 8. heightmap round-trip: PNG dims + decoded range must match meta.json exactly ---
// Catches an ICC profile sneaking in, swapped channels, or lossy re-saving.
// (Full pixel-vs-DEM comparison runs below when dem.tif exists locally.)
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

// --- strict local check: every PNG pixel vs the source DEM (skipped in CI) ---
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

// --- meta.json vs geo-constants cross-check ---
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

if (failures > 0) {
  console.error(`\nverify: ${failures} gate(s) FAILED`);
  process.exit(1);
}
console.log("\nverify: all gates passed");
