// 20-build-ortho-tiles.ts — FASE T1: 16 teselas PNOA 25 cm + atlas 4096.
//
// Tiling scheme (fixed now, painful to change later):
//   regular grid in EPSG:25830 over the corridor bbox (meta.corridorBbox).
//   usable terrain per tile: 126 m · capture adds a 1 m border each side
//   (4 px) → 128 m = 512 px @ 0.25 m/px, WebP q80.
//   The border is NOT optional: without it, bilinear filtering at a tile
//   edge would sample the atlas neighbour, which is somewhere else in the
//   world — the classic failure of this technique (a wrong-pixel line on
//   every joint). 126 m makes 4096/512 = 8 columns exact in the atlas.
//   Atlas: 4096², 8×8 slots of 512². T1 fills 16 (block below), rest black.
//   Index: one texel per grid tile (built at runtime from generated/tiles.ts
//   as a NEAREST DataTexture): slot+1, 0 = not resident → corridor fallback.
//
// Only a 4×4 block (504×504 m) centred on the Mirador de Calcilarruego.
// Full corridor + streaming + LOD come later (T2), only if this passes.
//
// Outputs (content-hashed):
//   public/assets/tiles/tile-c{c}-r{r}.<hash>.webp (16)
//   public/assets/tiles/tiles-atlas.<hash>.webp (4096², 16 slots filled)
//   + tiles index into data/build/meta.json (+ public copy)
//   + src/generated/tiles.ts (grid + slots, travels inside the bundle)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { CORRIDOR_BLEND_M, META_FILE, WMS_LAYER, WMS_MAX_ATTEMPTS, WMS_MAX_CONCURRENCY, WMS_RETRY_BASE_MS, WMS_URL, WMS_VERSION } from "./geo-constants.ts";
import { fetchWithRetry } from "./lib/http.ts";

// --- scheme constants (the fixed scheme; mirrored to generated/tiles.ts) ---
export const TILE_M = 126; // usable terrain per tile
export const TILE_BORDER_M = 1; // each side → 128 m capture
export const TILE_PX = 512; // @ 0.25 m/px
export const TILE_CAPTURE_M = TILE_M + TILE_BORDER_M * 2; // 128
export const TILE_BORDER_PX = 4; // 1 m @ 0.25 m/px
export const TILE_CONTENT_PX = TILE_PX - TILE_BORDER_PX * 2; // 504
export const TILE_QUALITY = 80; // WebP q80
export const ATLAS_PX = 4096;
export const ATLAS_COLS = 8; // 4096/512 exact — no waste
export const BLOCK_N = 4;

const OUT_DIR = "public/assets/tiles";
mkdirSync(OUT_DIR, { recursive: true });

const hashOf = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex").slice(0, 8);

// --- corridor bbox + grid (origin = corridor min corner) ---
const meta = JSON.parse(readFileSync(META_FILE, "utf8")) as {
  corridorBbox: { minx: number; miny: number; maxx: number; maxy: number };
};
const cb = meta.corridorBbox;
if (!cb) throw new Error("20: meta.json has no corridorBbox — run 13 first");
const corrW = cb.maxx - cb.minx;
const corrH = cb.maxy - cb.miny;
const COLS = Math.ceil(corrW / TILE_M);
const ROWS = Math.ceil(corrH / TILE_M);
console.log(`corridor ${corrW}×${corrH} m → grid ${COLS}×${ROWS} (${COLS * ROWS} tiles at ${TILE_M} m)`);

// --- 4×4 block centred on the Mirador de Calcilarruego (EPSG:25830) ---
const MIR_X = 741507;
const MIR_Y = 4725203;
const colF = (MIR_X - cb.minx) / TILE_M;
const rowF = (MIR_Y - cb.miny) / TILE_M;
const c0 = Math.max(0, Math.min(COLS - BLOCK_N, Math.round(colF - BLOCK_N / 2)));
const r0 = Math.max(0, Math.min(ROWS - BLOCK_N, Math.round(rowF - BLOCK_N / 2)));
console.log(`mirador tile-float (${colF.toFixed(2)}, ${rowF.toFixed(2)}) → block c${c0}..c${c0 + BLOCK_N - 1} r${r0}..r${r0 + BLOCK_N - 1}`);

interface TileJob { c: number; r: number; slot: number; }
const jobs: TileJob[] = [];
{
  let k = 0;
  for (let dr = 0; dr < BLOCK_N; dr++) {
    for (let dc = 0; dc < BLOCK_N; dc++) {
      jobs.push({ c: c0 + dc, r: r0 + dr, slot: k++ });
    }
  }
}

function contentBbox(c: number, r: number): [number, number, number, number] {
  const x0 = cb.minx + c * TILE_M;
  const y0 = cb.miny + r * TILE_M;
  return [x0, y0, x0 + TILE_M, y0 + TILE_M];
}
function captureBbox(c: number, r: number): [number, number, number, number] {
  const [x0, y0, x1, y1] = contentBbox(c, r);
  return [x0 - TILE_BORDER_M, y0 - TILE_BORDER_M, x1 + TILE_BORDER_M, y1 + TILE_BORDER_M];
}

async function fetchTile(j: TileJob): Promise<Buffer> {
  const [minx, miny, maxx, maxy] = captureBbox(j.c, j.r);
  const url =
    `${WMS_URL}?service=WMS&version=${WMS_VERSION}&request=GetMap` +
    `&layers=${WMS_LAYER}&styles=&crs=EPSG%3A25830` +
    `&bbox=${minx},${miny},${maxx},${maxy}` +
    `&width=${TILE_PX}&height=${TILE_PX}&format=image/jpeg`;
  const res = await fetchWithRetry(url, WMS_MAX_ATTEMPTS, WMS_RETRY_BASE_MS);
  return Buffer.from(await res.arrayBuffer());
}

let cursor = 0;
const jpegs = new Map<number, Buffer>();
async function worker(): Promise<void> {
  while (cursor < jobs.length) {
    const j = jobs[cursor++] as TileJob;
    const buf = await fetchTile(j);
    jpegs.set(j.slot, buf);
    console.log(`  fetched c${j.c} r${j.r} slot ${j.slot}: ${(buf.length / 1024).toFixed(1)} KB`);
  }
}
await Promise.all(
  Array.from({ length: Math.min(WMS_MAX_CONCURRENCY, jobs.length) }, () => worker()),
);

// --- tile files: JPEG → WebP q80, content-hashed names ---
interface TileRec { c: number; r: number; slot: number; file: string; bytes: number; }
const recs: TileRec[] = [];
for (const j of jobs) {
  const jpg = jpegs.get(j.slot);
  if (!jpg) throw new Error(`missing tile slot ${j.slot}`);
  const webp = await sharp(jpg).webp({ quality: TILE_QUALITY }).toBuffer();
  const h = hashOf(webp);
  const name = `tile-c${j.c}-r${j.r}.${h}.webp`;
  writeFileSync(`${OUT_DIR}/${name}`, webp);
  recs.push({ c: j.c, r: j.r, slot: j.slot, file: `assets/tiles/${name}`, bytes: webp.length });
}
const totalBytes = recs.reduce((s, t) => s + t.bytes, 0);
console.log(`tiles: ${recs.length} × ${(totalBytes / recs.length / 1024).toFixed(1)} KB mean, ${(totalBytes / 1024).toFixed(1)} KB total`);

// --- atlas 4096²: the 16 tiles composited into slots, rest black, WebP q80 ---
{
  const composites = jobs.map((j) => {
    const sc = j.slot % ATLAS_COLS;
    const sr = Math.floor(j.slot / ATLAS_COLS);
    const jpg = jpegs.get(j.slot);
    if (!jpg) throw new Error(`missing tile slot ${j.slot}`);
    return { input: jpg, left: sc * TILE_PX, top: sr * TILE_PX };
  });
  const atlasBuf = await sharp({
    create: { width: ATLAS_PX, height: ATLAS_PX, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite(composites)
    .webp({ quality: TILE_QUALITY })
    .toBuffer();
  const h = hashOf(atlasBuf);
  const name = `tiles-atlas.${h}.webp`;
  writeFileSync(`${OUT_DIR}/${name}`, atlasBuf);
  console.log(`atlas: ${OUT_DIR}/${name} ${(atlasBuf.length / 1024 / 1024).toFixed(2)} MB`);

  // --- meta.json index (+ public copy) ---
  const m = JSON.parse(readFileSync(META_FILE, "utf8")) as {
    assets: Record<string, string>;
    sizesBytes: Record<string, number>;
    tiles?: unknown;
  };
  m.assets = m.assets ?? {};
  m.sizesBytes = m.sizesBytes ?? {};
  m.assets["tiles-atlas"] = `assets/tiles/${name}`;
  m.sizesBytes["tiles-atlas"] = atlasBuf.length;
  for (const t of recs) {
    const key = `tile-c${t.c}-r${t.r}`;
    m.assets[key] = t.file;
    m.sizesBytes[key] = t.bytes;
  }
  m.tiles = {
    tileM: TILE_M,
    borderM: TILE_BORDER_M,
    px: TILE_PX,
    quality: TILE_QUALITY,
    cols: COLS,
    rows: ROWS,
    originX: cb.minx,
    originY: cb.miny,
    atlasPx: ATLAS_PX,
    atlasCols: ATLAS_COLS,
    block: { c0, r0, n: BLOCK_N },
    slots: recs.map((t) => ({ c: t.c, r: t.r, slot: t.slot })),
  };
  writeFileSync(META_FILE, JSON.stringify(m, null, 2));
  writeFileSync("public/assets/meta.json", JSON.stringify(m, null, 2));
  console.log(`updated: ${META_FILE} (+ public copy)`);

  // --- generated bundle module (grid + slots, no network at runtime) ---
  const gen =
    `// tiles.ts — GENERATED by scripts/20-build-ortho-tiles.ts (T1). Do not edit.\n` +
    `export const TILE_GRID = {\n` +
    `  tileM: ${TILE_M}, borderM: ${TILE_BORDER_M}, px: ${TILE_PX},\n` +
    `  cols: ${COLS}, rows: ${ROWS}, originX: ${cb.minx}, originY: ${cb.miny},\n` +
    `  atlasPx: ${ATLAS_PX}, atlasCols: ${ATLAS_COLS},\n` +
    `  block: { c0: ${c0}, r0: ${r0}, n: ${BLOCK_N} },\n` +
    `} as const;\n` +
    `export interface TileSlot { c: number; r: number; slot: number }\n` +
    `export const TILE_SLOTS: TileSlot[] = ${JSON.stringify(recs.map((t) => ({ c: t.c, r: t.r, slot: t.slot })))};\n`;
  writeFileSync("src/generated/tiles.ts", gen);
  console.log(`wrote: src/generated/tiles.ts (${recs.length} slots)`);
}

// --- report (brief §T1 a) ---
console.log(`\nT1 tiles: total ${(totalBytes / 1024).toFixed(1)} KB, mean ${(totalBytes / recs.length / 1024).toFixed(1)} KB/tile (gate G122: mean ≤ 60 KB)`);
console.log(`corridor blend edge still ${CORRIDOR_BLEND_M} m; full corridor would be ~${((COLS * ROWS * (totalBytes / recs.length)) / 1024 / 1024).toFixed(1)} MB at this rate`);
