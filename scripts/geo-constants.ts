// Senda de los Cazadores — single source of truth for geo constants.
//
// BBOX and CRS live HERE and nowhere else. The pipeline writes them into
// data/build/meta.json; the front reads meta.json only; verify.ts
// cross-checks meta.json against these values.

export const CRS = "EPSG:25830" as const; // ETRS89 / UTM 30N

export const BBOX = {
  minx: 738240,
  miny: 4722700,
  maxx: 749040,
  maxy: 4730880,
} as const;

export const BBOX_WIDTH_M = BBOX.maxx - BBOX.minx; // 10800
export const BBOX_HEIGHT_M = BBOX.maxy - BBOX.miny; // 8180

// --- IGN services (all open, all Spanish, verified against the live services) ---
export const WCS_URL = "https://servicios.idee.es/wcs-inspire/mdt";
export const WCS_VERSION = "2.0.1";
export const WCS_COVERAGE_5M = "Elevacion25830_5";

export const WMS_URL = "https://www.ign.es/wms-inspire/pnoa-ma";
export const WMS_VERSION = "1.3.0";
export const WMS_LAYER = "OI.OrthoimageCoverage";

// --- Track: primary source, versioned in git (never rely on the URL at runtime) ---
export const GPX_URL =
  "https://images.mnstatic.com/Tools/files/6effb092d4c0b8d8b7a25659ce8df4b16d5e645368f75e10d7e89f0aa64baa0e.gpx";
export const GPX_FILE = "data/source/senda-cazadores.gpx";

// --- Artefact paths ---
export const DEM_FILE = "data/source/dem.tif"; // gitignored download cache
export const ORTHO_DIR = "data/source/ortho-tiles"; // gitignored tile cache
export const ORTHO_MOSAIC = "data/source/ortho.jpg"; // gitignored mosaic cache
export const ORTHO_SIDECAR = "data/source/ortho.json"; // gitignored sidecar
export const META_FILE = "data/build/meta.json"; // versioned (canonical)
export const META_PUBLIC_COPY = "public/assets/meta.json"; // versioned (byte-identical copy for the front)
export const HEIGHTMAP_FILE = "public/assets/heightmap.png"; // versioned
export const TEXTURE_2K = "public/assets/terrain-2k.webp"; // versioned
export const TEXTURE_8K = "public/assets/terrain-8k.webp"; // versioned
export const ROUTE_FILE = "public/assets/route.json"; // versioned

// --- Reference points in EPSG:25830 (anchors from the project's own GPX;
// exact elevations come from the MDT). Verified 2026-09-13: XY projected
// from the GPX waypoint lat/lon with scripts/lib/utm.ts; MDT sampled
// bilinear from data/source/dem.tif. colaCaballo cota is taken from the
// nearest ROUTE point (km 9.67, 1762 m = published foot of the falls), not
// from the GPX waypoint (747159,4726471, MDT 1816 m, above the drop).
// calcilarruego: GPX waypoint mirador MDT 1960 m (published 1952 m); the
// track keeps climbing to 1999 m at km 2.44 — verify which is which before
// labelling (D6-P5). Tozal del Mallo: brief xy absorbed nothing in 150 m
// (local max 1351 m ≠ 2254 m); dropped until a 150 m search is sourced.
export interface RefPoint {
  x: number;
  y: number;
  lon: number;
  lat: number;
  expectedZ: number;
}

export const REF_POINTS: Record<string, RefPoint> = {
  pradera: { x: 741218, y: 4726062, lon: -0.05737, lat: 42.64923, expectedZ: 1321 },
  puente: { x: 741372, y: 4725929, lon: -0.05555, lat: 42.64798, expectedZ: 1318 },
  calcilarruego: { x: 741507, y: 4725203, lon: -0.05421, lat: 42.64141, expectedZ: 1960 },
  routeMax: { x: 741764, y: 4724974, lon: -0.05116, lat: 42.6394, expectedZ: 1999 },
  colaCaballo: { x: 747191, y: 4726348, lon: 0.01561, lat: 42.64989, expectedZ: 1762 },
  montePerdido: { x: 748638, y: 4729252, lon: 0.03442, lat: 42.67556, expectedZ: 3347 },
};

// --- Quality gate (Monte Perdido, official 3348 m) ---
export const EXPECTED_MIN_Z = 1107;
export const EXPECTED_MIN_TOL = 5;
export const EXPECTED_MAX_Z = 3347;
export const EXPECTED_MAX_TOL = 3;
export const EXPECTED_MAX_LAT = 42.67558;
export const EXPECTED_MAX_LON = 0.03439;
export const GEO_TOL_M = 100;

// --- Narrative: route date (Europe/Madrid) + act limits as DISTANCES (m) ---
// Distances, never point indices: a resample change must not break the acts.
export const ROUTE_DATE = "2026-08-16";
export const ACTS = [
  { act: 0, name: "La Pradera", startM: 0, endM: 300 },
  { act: 1, name: "La subida", startM: 300, endM: 2440 },
  { act: 2, name: "El mirador", startM: 2440, endM: 3000 },
  { act: 3, name: "La cornisa", startM: 3000, endM: 9000 },
  { act: 4, name: "El circo y la cascada", startM: 9000, endM: 10500 },
  { act: 5, name: "El regreso", startM: 10500, endM: 1e9 },
] as const;

// --- Corridor texture (phase 2): track bbox + margin, blend edge ---
export const CORRIDOR_MARGIN_M = 400;
export const CORRIDOR_BLEND_M = 150;
export const CLIMB_THRESHOLD_M = 5; // watch-style accumulated-climb gate (R6)

// --- Pipeline tuning ---
export const ORTHO_TILE_PX = 2048; // max WMS request size
export const ORTHO_MAX_WIDTH_PX = 8192; // phase-1 cap (~1.3 m/px over 10.8 km)
export const TEXTURE_2K_WIDTH = 2048;
export const ROUTE_STEP_M = 5;
export const ROUTE_SMOOTH_RADIUS = 2; // moving-average radius in plan (XY), never in Z
export const ROUTE_OFFSET_M = 4; // drape offset above the MDT
export const ROUTE_DRAPE_MAX_ABOVE_M = 25;
export const WMS_MAX_CONCURRENCY = 4; // be polite: public free service
export const WMS_MAX_ATTEMPTS = 3;
export const WMS_RETRY_BASE_MS = 1000;
