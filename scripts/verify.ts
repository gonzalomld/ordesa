// verify.ts — 8 quality gates over the VERSIONED artefacts. No network.
//
// Fails (non-zero exit) on any gate so `build` breaks honestly.
// Informational diagnostics (GPX-vs-MDT profile, reference elevations) never
// fail but are never silenced either: they print and the reader decides.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  BBOX,
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
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";
import { haversineM, utm30NToWgs84 } from "./lib/utm.ts";

let failures = 0;
function gate(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}
function info(name: string, detail: string): void {
  console.log(`INFO  ${name}: ${detail}`);
}

// --- artefacts ---
const dem = await readDem(DEM_FILE);
const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as Record<string, unknown>;
const png = sharp(HEIGHTMAP_FILE);
const pngMeta = await png.metadata();
const rawPng = await sharp(HEIGHTMAP_FILE).raw().toBuffer({ resolveWithObject: true });
const route = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
  points: { x: number; y: number; z_mdt: number; z_gpx: number; d: number }[];
};

// --- 1. max elevation ≈ 3347 m (Monte Perdido, official 3348) ---
gate(
  "max-elevation",
  Math.abs(dem.maxZ - EXPECTED_MAX_Z) <= EXPECTED_MAX_TOL,
  `model max ${dem.maxZ} m (expected ${EXPECTED_MAX_Z} ±${EXPECTED_MAX_TOL})`,
);

// --- 2. min elevation ≈ 1107 m ---
gate(
  "min-elevation",
  Math.abs(dem.minZ - EXPECTED_MIN_Z) <= EXPECTED_MIN_TOL,
  `model min ${dem.minZ} m (expected ${EXPECTED_MIN_Z} ±${EXPECTED_MIN_TOL})`,
);

// --- 3. georeference: max pixel reprojects to ~42.6756N/0.0344E (±100 m) ---
{
  const maxPx = dem.maxPixel();
  const { lat, lon } = utm30NToWgs84(maxPx.x, maxPx.y);
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
    const mdt = dem.sampleBilinear(p.x, p.y);
    const drawn = p.z_mdt - 4; // strip the known drape offset
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
  let n = 0;
  for (const p of route.points) {
    if (!Number.isFinite(p.z_gpx)) continue;
    const mdt = dem.sampleBilinear(p.x, p.y);
    const diff = Math.abs(p.z_gpx - mdt);
    sum += diff;
    if (diff > max) max = diff;
    n++;
  }
  info("gpx-vs-mdt", `mean |GPS−LiDAR| ${(sum / n).toFixed(1)} m, max ${max.toFixed(1)} m (n=${n})`);
}

// --- 7. reference elevations (diagnostic, never fails, never silenced) ---
for (const [name, ref] of Object.entries(REF_POINTS)) {
  if (!ref.expectedZ) continue;
  const z = dem.sampleBilinear(ref.x, ref.y);
  info("ref-elevation", `${name}: MDT ${z.toFixed(0)} m vs expected ~${ref.expectedZ} m`);
}

// --- 8. heightmap round-trip: decode PNG, compare against the DEM exactly ---
{
  const { data, info: rawInfo } = rawPng;
  const okDims = rawInfo.width === dem.width && rawInfo.height === dem.height;
  let exactMin = Infinity;
  let exactMax = -Infinity;
  let mismatches = 0;
  let firstMismatch = "";
  const n = dem.width * dem.height;
  for (let i = 0; i < n; i++) {
    const v = (data[i * 3] as number) * 256 + (data[i * 3 + 1] as number);
    const elev = (meta.minZ as number) + v;
    const demZ = Math.round(dem.data[i] as number);
    if (elev < exactMin) exactMin = elev;
    if (elev > exactMax) exactMax = elev;
    if (elev !== demZ) {
      mismatches++;
      if (!firstMismatch) firstMismatch = `px ${i}: png ${elev} vs dem ${demZ}`;
    }
  }
  const minOk = exactMin === (meta.minZ as number) && exactMin === dem.minZ;
  const maxOk = exactMax === (meta.maxZ as number) && exactMax === dem.maxZ;
  gate(
    "heightmap-roundtrip",
    okDims && minOk && maxOk && mismatches === 0,
    `${pngMeta.width}x${pngMeta.height} png, decoded z ${exactMin}…${exactMax} m, ` +
      `${mismatches} mismatched px${firstMismatch ? ` (first: ${firstMismatch})` : ""}`,
  );
}

// --- meta.json vs geo-constants cross-check ---
{
  const m = meta as {
    bbox: typeof BBOX;
    resX: number;
    resY: number;
    width: number;
    height: number;
  };
  const bboxOk =
    m.bbox.minx === BBOX.minx &&
    m.bbox.miny === BBOX.miny &&
    m.bbox.maxx === BBOX.maxx &&
    m.bbox.maxy === BBOX.maxy;
  const resOk =
    Math.abs(m.resX - dem.resX) < 1e-9 &&
    Math.abs(m.resY - dem.resY) < 1e-9 &&
    m.width === dem.width &&
    m.height === dem.height;
  gate(
    "meta-vs-constants",
    bboxOk && resOk,
    `meta bbox ${bboxOk ? "matches" : "DIVERGED"} geo-constants; ` +
      `meta ${m.width}x${m.height}@${m.resX},${m.resY} ${resOk ? "matches" : "DIVERGED"} DEM tags`,
  );
}

if (failures > 0) {
  console.error(`\nverify: ${failures} gate(s) FAILED`);
  process.exit(1);
}
console.log("\nverify: all gates passed");
