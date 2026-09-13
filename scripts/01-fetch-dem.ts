// 01-fetch-dem.ts — WCS (IGN) → data/source/dem.tif (gitignored cache).
// Reads: resolution comes from the file's own tags (see lib/tiff.ts).
import {
  BBOX,
  DEM_FILE,
  WCS_COVERAGE_5M,
  WCS_URL,
  WCS_VERSION,
  WMS_MAX_ATTEMPTS,
  WMS_RETRY_BASE_MS,
} from "./geo-constants.ts";
import { downloadCached } from "./lib/http.ts";

const url =
  `${WCS_URL}?service=WCS&version=${WCS_VERSION}&request=GetCoverage` +
  `&coverageId=${WCS_COVERAGE_5M}` +
  `&subset=x(${BBOX.minx},${BBOX.maxx})` +
  `&subset=y(${BBOX.miny},${BBOX.maxy})` +
  `&format=image/tiff`;

console.log(`WCS GetCoverage:\n  ${url}`);
await downloadCached(url, DEM_FILE, WMS_MAX_ATTEMPTS, WMS_RETRY_BASE_MS);
