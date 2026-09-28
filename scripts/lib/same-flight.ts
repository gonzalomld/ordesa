// same-flight.ts — G131: guard against PNOA-MA "máxima actualidad" drift.
//
// PNOA-MA serves the most recent flight. If a new flight entered between the
// local mosaic (data/source/ortho.jpg, hashed in meta.illumination) and today,
// the WMS tiles would be a DIFFERENT photo with a different sun, and the
// persisted illumination field would not apply to them. mosaicHash cannot
// detect that: it hashes OUR local file, not what WMS serves today.
//
// Check: request the c3-r9 ground patch from WMS at the mosaic's own
// resolution (~1.32 m/px) and compare against the same ground cropped from
// the local mosaic. meanAbsDiff per channel <= 6/255.
//
// NOT pure: needs network + the local mosaic. LOCAL ONLY, never in CI. It is
// called by 20-build-ortho-tiles.ts right before the first tile fetch (the
// network is guaranteed there by definition, so the gate cannot be skipped
// by forgetting a manual step). verify-3a stays network-free on purpose.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { BBOX, ORTHO_MOSAIC, WMS_LAYER, WMS_URL, WMS_VERSION } from "../geo-constants.ts";
import { fetchWithRetry } from "./http.ts";

// c3-r9 ground (corridor origin + 3*126 / + 9*126, 126 m): same soil as G128.
const X0 = 740819 + 3 * 126;
const Y0 = 4723818 + 9 * 126;
const S = 126;
const X1 = X0 + S;
const Y1 = Y0 + S;

const BW = BBOX.maxx - BBOX.minx;
const BH = BBOX.maxy - BBOX.miny;

/** Requests the c3-r9 patch from WMS and compares it with the local mosaic.
 *  Throws (loud) if PNOA changed flight: the whole deshadowing is void. */
export async function assertSameFlight(): Promise<void> {
  const meta = await sharp(ORTHO_MOSAIC).metadata();
  const MOS_W = meta.width ?? 0;
  const MOS_H = meta.height ?? 0;
  if (!MOS_W || !MOS_H) throw new Error(`G131: cannot read ${ORTHO_MOSAIC} dimensions`);

  // integer crop in mosaic pixels; WMS is asked for the same W×H so both
  // buffers compare 1:1 with no resampling on our side.
  const left = Math.round(((X0 - BBOX.minx) / BW) * MOS_W);
  const top = Math.round(((BBOX.maxy - Y1) / BH) * MOS_H);
  const wdt = Math.max(1, Math.round((S / BW) * MOS_W));
  const hgt = Math.max(1, Math.round((S / BH) * MOS_H));
  const local = await sharp(ORTHO_MOSAIC)
    .extract({ left, top, width: wdt, height: hgt })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const url =
    `${WMS_URL}?service=WMS&version=${WMS_VERSION}&request=GetMap` +
    `&layers=${WMS_LAYER}&styles=&crs=EPSG%3A25830` +
    `&bbox=${X0},${Y0},${X1},${Y1}` +
    `&width=${wdt}&height=${hgt}&format=image/jpeg`;
  const res = await fetchWithRetry(url, 3, 1000);
  const wmsJpg = Buffer.from(await res.arrayBuffer());
  const wms = await sharp(wmsJpg).raw().toBuffer({ resolveWithObject: true });

  if (wms.info.width !== local.info.width || wms.info.height !== local.info.height) {
    throw new Error(
      `G131: size mismatch WMS ${wms.info.width}×${wms.info.height} vs mosaic ${local.info.width}×${local.info.height}`,
    );
  }
  const n = local.info.width * local.info.height;
  const mad = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      mad[c] += Math.abs(
        (local.data[i * local.info.channels + c] as number) - (wms.data[i * wms.info.channels + c] as number),
      );
    }
  }
  const mean = mad.map((s) => s / n);
  console.log(
    `G131 meanAbsDiff per channel: R ${mean[0].toFixed(2)} G ${mean[1].toFixed(2)} B ${mean[2].toFixed(2)} /255 (need <= 6)`,
  );
  if (mean.some((m) => m > 6)) {
    throw new Error(
      "G131-same-flight: FAIL — PNOA changed flight. Redo the whole deshadowing, not just tiles. STOP.",
    );
  }
  console.log("G131-same-flight: PASS — same flight, illumination field applies.");
}
