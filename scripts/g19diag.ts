import { readFileSync } from "node:fs";
import sharp from "sharp";
import { bakeCamRail, resolveAnchors, resolveFollowProfile } from "../src/narrative/anchors.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import { buildPchip } from "../src/narrative/curve.ts";
import { CAM_CLEARANCE_M, RIM_CORRIDOR_HALF_M, RIM_MARGIN_M } from "../src/narrative/choreography.ts";

const route = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as {
  x: number[]; y: number[]; z_mdt: number[]; z_raw?: number[]; d: number[]; cumClimb: number[]; lengthM: number;
};
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
  width: number; height: number; resX: number; resY: number; originX: number; originY: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
};
const r = {
  n: route.x.length, lengthM: route.lengthM,
  x: Float32Array.from(route.x), y: Float32Array.from(route.y),
  z: Float32Array.from(route.z_mdt), d: Float32Array.from(route.d),
  cumClimb: Float32Array.from(route.cumClimb),
  zRaw: Float32Array.from(route.z_raw ?? route.z_mdt),
};
const { data: pngRaw } = await sharp("public/assets/heightmap.png").raw().toBuffer({ resolveWithObject: true });
const pngMeta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as { minZ: number };
function sampleGrid(x: number, y: number): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const W = meta.width;
  const at = (cc: number, rr: number): number =>
    (pngMeta.minZ + (pngRaw[(rr * W + cc) * 3] as number) * 256 + (pngRaw[(rr * W + cc) * 3 + 1] as number));
  const a = at(c0, r0);
  const b = at(c0 + 1, r0);
  const c = at(c0, r0 + 1);
  const d = at(c0 + 1, r0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
const cx = (meta.bbox.minx + meta.bbox.maxx) / 2;
const cy = (meta.bbox.miny + meta.bbox.maxy) / 2;
const res = resolveAnchors(r);
res.follow = resolveFollowProfile(r, sampleGrid, meta.bbox);
const pchipSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
const rail = bakeCamRail(
  { route: r, follow: res.follow, sToD: pchipSD, sample: sampleGrid, cx, cy, fovDeg: 50, floorM: CAM_CLEARANCE_M },
  (rope) => resolveFollowSafety(sampleGrid, cx, cy,
    { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan },
    r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 }),
);
const SARG = Number(process.argv[2] ?? "0");
const stridePx = 4;
const stepM = meta.resX * stridePx;
const W = meta.width;
const H = meta.height;
const zFull = (c: number, rr: number): number =>
  (pngMeta.minZ + (pngRaw[(rr * W + c) * 3] as number) * 256 + (pngRaw[(rr * W + c) * 3 + 1] as number));
const NP = 9;
for (const S of SARG === 0 ? [0.86, 0.87, 0.88, 0.89, 0.891, 0.899, 0.9, 0.91, 0.92, 0.93] : [SARG]) {
  const camX = rail.fCamX(S) - cx;
  const camY = rail.fCamY(S);
  const camZ = -(rail.fCamZ(S) - cy);
  const aimX = rail.fAimX(S) - cx;
  const aimY = rail.fAimY(S);
  const aimZ = -(rail.fAimZ(S) - cy);
  const camEpsgX = rail.fCamX(S);
  const camEpsgY = rail.fCamZ(S);
  let fx = rail.fAimX(S) - camEpsgX;
  let fy = rail.fAimZ(S) - camEpsgY;
  const fl = Math.max(1e-6, Math.hypot(fx, fy));
  fx /= fl;
  fy /= fl;
  const rayDy = aimY - camY;
  const rayDp = Math.max(1e-6, Math.hypot(aimX - camX, aimZ - camZ));
  const planDp = rayDp;
  // top-N peores: array de candidatos
  const cand: { over: number; along: number; across: number; ex: number; ey: number }[] = [];
  for (let along = 0; along <= planDp; along += stepM) {
    const rayAlt = camY + (rayDy * along) / rayDp;
    for (let across = -RIM_CORRIDOR_HALF_M; across <= RIM_CORRIDOR_HALF_M; across += stepM) {
      const ex = camEpsgX + fx * along + -fy * across;
      const ey = camEpsgY + fy * along + fx * across;
      const c = Math.min(W - 1, Math.max(0, Math.round((ex - meta.originX) / meta.resX - 0.5)));
      const r2 = Math.min(H - 1, Math.max(0, Math.round((meta.originY - ey) / meta.resY - 0.5)));
      const over = zFull(c, r2) - rayAlt - RIM_MARGIN_M;
      cand.push({ over, along, across, ex, ey });
    }
  }
  cand.sort((a, b2) => b2.over - a.over);
  const d = pchipSD(S);
  console.log(`s=${S.toFixed(3)} d=${d.toFixed(0)} camAlt=${camY.toFixed(0)} camEx=${camEpsgX.toFixed(0)} camEy=${camEpsgY.toFixed(0)} aimAlt=${aimY.toFixed(0)} planDp=${planDp.toFixed(0)} mode=${rail.mode[Math.min(rail.n, Math.round(S * rail.n))]}`);
  for (const t of cand.slice(0, NP)) {
    console.log(`   over=${t.over.toFixed(0)} along=${t.along.toFixed(0)} across=${t.across.toFixed(0)} ex=${t.ex.toFixed(0)} ey=${t.ey.toFixed(0)} zTerr=${(t.over + camY + ((aimY - camY) * t.along) / rayDp + RIM_MARGIN_M).toFixed(0)}`);
  }
}
