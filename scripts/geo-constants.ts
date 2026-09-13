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

// --- Reference points in EPSG:25830 (approximate anchors; exact elevations come from the MDT) ---
// NOTE (verified 2026-09-13 against the 5 m MDT + the project's own GPX waypoints):
// the brief's lon/lat→XY values are mathematically exact (own UTM projection
// reproduces them to the metre), but the XY do NOT sit on the named features:
//   brief "Pradera" 739468,4725309 → MDT 1970 m (mid-slope; the real Pradera floor is ~1320 m
//     at the GPX track start 741218,4726062 / puente 741372,4725929, both MDT ≈1318 m).
//   brief "Calcilarruego" 740680,4724706 → MDT 2138 m (ridge above the lookout;
//     the GPX waypoint mirador 741507,4725203 → MDT 1960 m, GPS 1929.6 m).
//   brief "Cola de Caballo" 744230,4725753 → MDT 2452 m (high on the wall;
//     the GPX waypoint cascada 747159,4726471 → MDT 1816 m, GPS 1814.6 m).
// kept verbatim so verify INFO lines stay comparable; fix the anchors (not the
// georeferencing) in a later pass with the user.
export interface RefPoint {
  x: number;
  y: number;
  lon: number;
  lat: number;
  expectedZ: number;
}

export const REF_POINTS: Record<string, RefPoint> = {
  pradera: { x: 739468, y: 4725309, lon: -0.079, lat: 42.643, expectedZ: 1320 },
  tozalMallo: { x: 739040, y: 4726295, lon: -0.0838, lat: 42.652, expectedZ: 0 },
  calcilarruego: { x: 740680, y: 4724706, lon: -0.0645, lat: 42.6372, expectedZ: 1952 },
  colaCaballo: { x: 744230, y: 4725753, lon: -0.0208, lat: 42.6455, expectedZ: 1760 },
  montePerdido: { x: 748647, y: 4729168, lon: 0.0345, lat: 42.6748, expectedZ: 3348 },
};

// --- Quality gate (Monte Perdido, official 3348 m) ---
export const EXPECTED_MIN_Z = 1107;
export const EXPECTED_MIN_TOL = 5;
export const EXPECTED_MAX_Z = 3347;
export const EXPECTED_MAX_TOL = 3;
export const EXPECTED_MAX_LAT = 42.67558;
export const EXPECTED_MAX_LON = 0.03439;
export const GEO_TOL_M = 100;

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
