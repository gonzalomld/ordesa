// 15-build-rock.ts — R1: rock tile cut from the ortho itself.
//
// Scans the deshadowed albedo for the 256² window with the most pixels that
// are BOTH steep (MDT slope > 35°) and mid-bright (90 < lum < 190, i.e.
// sunlit rock, not forest, not snow, not deep shadow). Extracts it and
// upscales to 1024. Seams are hidden at runtime with MirroredRepeatWrapping,
// not by editing pixels here.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { BBOX, DEM_FILE, META_FILE } from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";

const ALBEDO = "data/build/albedo.png";
const W = 2160;
const H = Math.round((W * (BBOX.maxy - BBOX.miny)) / (BBOX.maxx - BBOX.minx));

const dem = await readDem(DEM_FILE);
const { data: px, info } = await sharp(ALBEDO)
  .resize({ width: W, height: H, fit: "fill" })
  .raw()
  .toBuffer({ resolveWithObject: true });
const CH = info.channels;
const lumAt = (c: number, r: number): number => {
  const i = (r * W + c) * CH;
  return (
    0.2126 * (px[i] as number) +
    0.7152 * (px[i + 1] as number) +
    0.0722 * (px[i + 2] as number)
  );
};
const epsgAt = (c: number, r: number): [number, number] => [
  BBOX.minx + ((c + 0.5) / W) * (BBOX.maxx - BBOX.minx),
  BBOX.maxy - ((r + 0.5) / H) * (BBOX.maxy - BBOX.miny),
];

// coarse slope grid (every 4th px)
const SW = Math.ceil(W / 4);
const SH = Math.ceil(H / 4);
const steep = new Uint8Array(SW * SH);
for (let r = 0; r < SH; r++) {
  for (let c = 0; c < SW; c++) {
    const [x, y] = epsgAt(c * 4, r * 4);
    const e = 5;
    const dzdx = (dem.sampleBilinear(x + e, y) - dem.sampleBilinear(x - e, y)) / (2 * e);
    const dzdy = (dem.sampleBilinear(x, y + e) - dem.sampleBilinear(x, y - e)) / (2 * e);
    const slope = (Math.acos(1 / Math.hypot(dzdx, dzdy, 1)) * 180) / Math.PI;
    steep[r * SW + c] = slope > 35 ? 1 : 0;
  }
}

// best 256² window, stride 32
let best = { score: -1, left: 0, top: 0 };
for (let top = 0; top + 256 <= H; top += 32) {
  for (let left = 0; left + 256 <= W; left += 32) {
    let s = 0;
    for (let r = top; r < top + 256; r += 4) {
      for (let c = left; c < left + 256; c += 4) {
        if (!steep[Math.floor(r / 4) * SW + Math.floor(c / 4)]) continue;
        const l = lumAt(c, r);
        if (l > 90 && l < 190) s++;
      }
    }
    if (s > best.score) best = { score: s, left, top };
  }
}
console.log(`rock window: ${best.left},${best.top} 256² (score ${best.score})`);
const [ex, ey] = epsgAt(best.left, best.top);
console.log(`epsg ≈ ${ex.toFixed(0)},${ey.toFixed(0)}`);

const tile = await sharp(ALBEDO)
  .resize({ width: W, height: H, fit: "fill" })
  .extract({ left: best.left, top: best.top, width: 256, height: 256 })
  .resize({ width: 1024, height: 1024, kernel: "lanczos3" })
  .webp({ quality: 85 })
  .toBuffer();
const hash = createHash("sha256").update(tile).digest("hex").slice(0, 8);
const name = `terrain-rock.${hash}.webp`;
writeFileSync(`public/assets/${name}`, tile);
console.log(`saved: public/assets/${name} ${(tile.length / 1024).toFixed(0)} KB`);

// register in meta.json (+ public copy) without touching other keys
for (const p of [META_FILE, "public/assets/meta.json"]) {
  const meta = JSON.parse(readFileSync(p, "utf8"));
  meta.assets["terrain-rock"] = `assets/${name}`;
  meta.sizesBytes["terrain-rock"] = tile.length;
  meta.rockWindow = { left: best.left, top: best.top, epsgX: Math.round(ex), epsgY: Math.round(ey) };
  writeFileSync(p, JSON.stringify(meta, null, 2));
}
console.log("registered terrain-rock in meta.json (+ public copy)");
