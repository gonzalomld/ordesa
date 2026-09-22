import { readFileSync } from "node:fs";
import sharp from "sharp";
import { anchorPlan, bakeCamRail, followAt, lateralAt, resolveAnchors, resolveFollowProfile, trackAt } from "../src/narrative/anchors.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import { buildPchip } from "../src/narrative/curve.ts";
import { CAM_CLEARANCE_M } from "../src/narrative/choreography.ts";

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

// Para s dados: anclaje, dirección del rastro, normal, signo valle, offset aplicado,
// cam RAW con lat actual vs lat=0, mira, y geometría del muro (terreno en el extremo del rayo).
for (const S of [0.887, 0.891, 0.899, 0.91]) {
  const d = pchipSD(S);
  const prof = followAt(res.follow, S);
  const pA = anchorPlan(r, d, prof.backM);
  const lat = lateralAt(S);
  const q0 = trackAt(r, Math.max(0, d - 50));
  const q1 = trackAt(r, Math.min(r.lengthM, d + 50));
  let dx = q1.x - q0.x;
  let dy = q1.y - q0.y;
  const L = Math.max(1e-6, Math.hypot(dx, dy));
  dx /= L;
  dy /= L;
  const nx = -dy;
  const ny = dx;
  let mPos = 0;
  let mNeg = 0;
  for (const t of [75, 150, 225, 300]) {
    mPos += sampleGrid(pA.x + nx * t, pA.y + ny * t);
    mNeg += sampleGrid(pA.x - nx * t, pA.y - ny * t);
  }
  const sgn = mPos <= mNeg ? 1 : -1;
  const pAim = trackAt(r, Math.min(r.lengthM, d + prof.lookM));
  console.log(`s=${S.toFixed(3)} d=${d.toFixed(0)} backM=${prof.backM.toFixed(0)} lookM=${prof.lookM.toFixed(0)} lat=${lat.toFixed(0)}`);
  console.log(`   anchor=(${pA.x.toFixed(0)},${pA.y.toFixed(0)},z=${pA.z.toFixed(0)}) aim=(${(pAim.x as number).toFixed(0)},${(pAim.y as number).toFixed(0)},z=${(pAim.z as number).toFixed(0)})`);
  console.log(`   dir=(${dx.toFixed(3)},${dy.toFixed(3)}) n=(${nx.toFixed(3)},${ny.toFixed(3)}) mPos=${mPos.toFixed(0)} mNeg=${mNeg.toFixed(0)} sgn=${sgn}`);
  console.log(`   offsetAplicado=(${(sgn * nx * lat).toFixed(0)},${(sgn * ny * lat).toFixed(0)})`);
  // muro: cota del terreno en el punto del peor candidato ya conocida; aquí cota a lo largo del rayo SIN offset (lat=0) vs CON offset:
  // rayo con cámara desplazada: el desplazamiento lateral del rayo a fracción t del camino = lat*(1-t)
  const planDp = Math.hypot(pA.x - (pAim.x as number), pA.y - (pAim.y as number));
  console.log(`   planAnchorAim=${planDp.toFixed(0)} rayShiftEnMira(99%)~=${(lat * 0.01).toFixed(1)}m (la mira NO se mueve)`);
}
