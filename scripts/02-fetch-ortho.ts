// 02-fetch-ortho.ts — WMS PNOA-MA in ≤2048 px tiles → mosaic + sidecar.
//
// The WMS answers JPEG and we have no GDAL, so the mosaic is saved as JPEG
// with a sidecar ortho.json (bbox, CRS, m/px). It is NEVER called .tif.
//
// Polite by design: max 4 concurrent requests, exponential-backoff retries
// (3 attempts), on-disk tile cache (no re-download of existing tiles).
// Public free service — don't hammer it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import {
  BBOX,
  BBOX_HEIGHT_M,
  BBOX_WIDTH_M,
  CRS,
  ORTHO_DIR,
  ORTHO_MOSAIC,
  ORTHO_SIDECAR,
  ORTHO_TILE_PX,
  WMS_LAYER,
  WMS_MAX_ATTEMPTS,
  WMS_MAX_CONCURRENCY,
  WMS_RETRY_BASE_MS,
  WMS_URL,
  WMS_VERSION,
} from "./geo-constants.ts";
import { fetchWithRetry } from "./lib/http.ts";

const NX = 4;
const NY = 4;
// Mosaic size for phase 1: 8192 px wide (~1.3 m/px). Even tile grid, no slivers.
const MOSAIC_W = 8192;
const MOSAIC_H = Math.round((BBOX_HEIGHT_M / BBOX_WIDTH_M) * MOSAIC_W);
const TILE_GROUND_W = BBOX_WIDTH_M / NX;
const TILE_PX_W = Math.round(MOSAIC_W / NX); // 2048
const ROW_H_BASE = Math.floor(MOSAIC_H / NY);
if (TILE_PX_W > ORTHO_TILE_PX || ROW_H_BASE > ORTHO_TILE_PX) {
  throw new Error(`tile size ${TILE_PX_W}x${ROW_H_BASE} exceeds WMS limit ${ORTHO_TILE_PX}`);
}
// Row heights: all equal except the last row, which absorbs the rounding remainder.
const ROW_H: number[] = Array.from({ length: NY }, (_, iy) =>
  iy < NY - 1 ? ROW_H_BASE : MOSAIC_H - ROW_H_BASE * (NY - 1),
);
const ROW_TOP: number[] = [];
ROW_H.reduce((acc, h, iy) => ((ROW_TOP[iy] as number) = acc, acc + h), 0);

mkdirSync(ORTHO_DIR, { recursive: true });

interface Tile {
  ix: number;
  iy: number;
  file: string;
  left: number;
  top: number;
  w: number;
  h: number;
}

const tiles: Tile[] = [];
for (let iy = 0; iy < NY; iy++) {
  for (let ix = 0; ix < NX; ix++) {
    tiles.push({
      ix,
      iy,
      file: `${ORTHO_DIR}/tile-${ix}-${iy}.jpg`,
      left: ix * TILE_PX_W,
      top: ROW_TOP[iy] as number,
      w: TILE_PX_W,
      h: ROW_H[iy] as number,
    });
  }
}

function tileBbox(t: Tile): [number, number, number, number] {
  // Pixel rows and ground rows scale together (rows differ only by rounding).
  const tileGroundTop = (t.top / MOSAIC_H) * BBOX_HEIGHT_M; // metres south of north edge
  const tileGroundH = (t.h / MOSAIC_H) * BBOX_HEIGHT_M;
  const minx = BBOX.minx + t.ix * TILE_GROUND_W;
  const maxx = minx + TILE_GROUND_W;
  // WMS row 0 = north edge (maxy side).
  const maxy = BBOX.maxy - tileGroundTop;
  const miny = maxy - tileGroundH;
  return [minx, miny, maxx, maxy];
}

async function fetchTile(t: Tile, force: boolean): Promise<void> {
  if (existsSync(t.file) && !force) {
    console.log(`  cached: ${t.file}`);
    return;
  }
  const [minx, miny, maxx, maxy] = tileBbox(t);
  const url =
    `${WMS_URL}?service=WMS&version=${WMS_VERSION}&request=GetMap` +
    `&layers=${WMS_LAYER}&styles=&crs=${encodeURIComponent(CRS)}` +
    `&bbox=${minx},${miny},${maxx},${maxy}` +
    `&width=${t.w}&height=${t.h}&format=image/jpeg`;
  const res = await fetchWithRetry(url, WMS_MAX_ATTEMPTS, WMS_RETRY_BASE_MS);
  writeFileSync(t.file, Buffer.from(await res.arrayBuffer()));
  console.log(`  saved: ${t.file}`);
}

const force = process.argv.includes("--force");
// Concurrency-limited worker pool.
let cursor = 0;
async function worker(): Promise<void> {
  while (cursor < tiles.length) {
    const t = tiles[cursor++] as Tile;
    await fetchTile(t, force);
  }
}
await Promise.all(
  Array.from({ length: Math.min(WMS_MAX_CONCURRENCY, tiles.length) }, () => worker()),
);

// Mosaic with sharp (JPEG in, JPEG out — the WMS only serves JPEG).
// Rows tile edge-to-edge exactly (row heights absorb rounding), no crop needed.
console.log(`compositing ${NX}x${NY} tiles → ${MOSAIC_W}x${MOSAIC_H}…`);
const composites = tiles.map((t) => ({
  input: readFileSync(t.file),
  left: t.left,
  top: t.top,
}));
await sharp({
  create: {
    width: MOSAIC_W,
    height: MOSAIC_H,
    channels: 3,
    background: { r: 0, g: 0, b: 0 },
  },
})
  .composite(composites)
  .jpeg({ quality: 92 })
  .toFile(ORTHO_MOSAIC);

const mPerPxX = BBOX_WIDTH_M / MOSAIC_W;
const mPerPxY = BBOX_HEIGHT_M / MOSAIC_H;
writeFileSync(
  ORTHO_SIDECAR,
  JSON.stringify(
    {
      crs: CRS,
      bbox: BBOX,
      widthPx: MOSAIC_W,
      heightPx: MOSAIC_H,
      metersPerPxX: mPerPxX,
      metersPerPxY: mPerPxY,
      tilesNx: NX,
      tilesNy: NY,
      source: `WMS ${WMS_URL} layer ${WMS_LAYER}`,
    },
    null,
    2,
  ),
);
console.log(`saved: ${ORTHO_MOSAIC} + ${ORTHO_SIDECAR} (${mPerPxX.toFixed(3)} m/px)`);
