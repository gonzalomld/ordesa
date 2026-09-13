// 04-build-texture.ts — ortho mosaic → terrain-2k.webp + terrain-8k.webp.
//
// Phase 1 only resizes + WebP. The 2k level paints first (fast first render);
// the 8k level (max 8192 px wide) swaps in behind.
//
// TODO(phase2): de-shadow the baked-in flight shadows (hillshade division
// against the DEM to recover flat albedo, then relight in-engine) and add a
// KTX2 level. Also decide snow masking above ~2500 m after checking the
// flight date in the WMS GetCapabilities.
import sharp from "sharp";
import { ORTHO_MOSAIC, TEXTURE_2K, TEXTURE_8K, TEXTURE_2K_WIDTH } from "./geo-constants.ts";

const webp8k = sharp(ORTHO_MOSAIC).metadata();
const { width } = await webp8k;
console.log(`mosaic: ${width}px wide`);
if ((width as number) > 8192) {
  throw new Error(`mosaic ${width}px exceeds 8192 px GPU-safe cap`);
}

await sharp(ORTHO_MOSAIC)
  .resize({ width: TEXTURE_2K_WIDTH })
  .webp({ quality: 80 })
  .toFile(TEXTURE_2K);
console.log(`saved: ${TEXTURE_2K}`);

await sharp(ORTHO_MOSAIC)
  .webp({ quality: 82 })
  .toFile(TEXTURE_8K);
console.log(`saved: ${TEXTURE_8K}`);
