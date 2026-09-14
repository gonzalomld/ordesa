// 03-build-heightmap.ts — DEM → public/assets/heightmap.png + data/build/meta.json.
//
// Encoding: v = round(elev - MINZ); R = v >> 8; G = v & 255; B = 0.
// Written from a raw buffer with NO metadata: never call withMetadata()
// (in sharp it ADDS metadata instead of removing it). An attached ICC
// profile would make the browser color-manage the PNG and silently corrupt
// the elevation. adaptiveFiltering is mandatory (halves the file size).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import sharp from "sharp";
import {
  BBOX,
  CRS,
  DEM_FILE,
  HEIGHTMAP_FILE,
  META_FILE,
  META_PUBLIC_COPY,
} from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";

const dem = await readDem(DEM_FILE);
console.log(
  `DEM: ${dem.width}x${dem.height} @ ${dem.resX}x${dem.resY} m/px, ` +
    `z ${dem.minZ}…${dem.maxZ} m`,
);
const minZ = dem.minZ;
const maxV = dem.maxZ - minZ;
if (maxV > 65535) throw new Error(`elevation range ${maxV} exceeds 16-bit RG encoding`);

const buf = Buffer.alloc(dem.width * dem.height * 3);
for (let i = 0; i < dem.width * dem.height; i++) {
  const v = Math.round((dem.data[i] as number) - minZ);
  buf[i * 3] = v >> 8;
  buf[i * 3 + 1] = v & 255;
  buf[i * 3 + 2] = 0;
}

mkdirSync(dirname(HEIGHTMAP_FILE), { recursive: true });
await sharp(buf, { raw: { width: dem.width, height: dem.height, channels: 3 } })
  .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
  .toFile(HEIGHTMAP_FILE);
console.log(`saved: ${HEIGHTMAP_FILE}`);

const maxPx = dem.maxPixel();
const meta = {
  crs: CRS,
  bbox: { ...BBOX },
  width: dem.width,
  height: dem.height,
  resX: dem.resX,
  resY: dem.resY,
  originX: dem.minx,
  originY: dem.maxy,
  minZ,
  maxZ: dem.maxZ,
  maxPixel: maxPx,
  encoding: "v = round(elev - minZ); R = v >> 8; G = v & 255; B = 0",
  generatedAt: new Date().toISOString(),
};
mkdirSync(dirname(META_FILE), { recursive: true });
mkdirSync(dirname(META_PUBLIC_COPY), { recursive: true });
writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
copyFileSync(META_FILE, META_PUBLIC_COPY); // byte-identical copy for the front
console.log(`saved: ${META_FILE} (+ public copy)`);
