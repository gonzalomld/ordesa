// lift-probe.ts — throwaway C1b tuner (node only, not shipped).
// For one H_CAM knot override: rebake, count ladder-active steps, list runs.
import { readFileSync } from "node:fs";
import { bakeCamRail, quatDistDeg, quatYXZ, resolveAnchors, resolveFollowProfile } from "../src/narrative/anchors.ts";
import { buildPchip } from "../src/narrative/curve.ts";
import { CAM_CLEARANCE_M, EPILOGUE_S, FOLLOW_BACK_N, FOLLOW_H_CAM_N, FOLLOW_LOOK_N, FOLLOW_NUDOS_S } from "../src/narrative/choreography.ts";
import { resolveFollowSafety } from "../src/narrative/collision.ts";
import sharp from "sharp";

const route = JSON.parse(readFileSync("public/assets/route.json", "utf8")) as {
  x: number[]; y: number[]; z_mdt: number[]; d: number[]; cumClimb: number[]; lengthM: number;
};
const meta = JSON.parse(readFileSync("data/build/meta.json", "utf8")) as {
  width: number; height: number; resX: number; resY: number; originX: number; originY: number; minZ: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
};
const r = {
  n: route.x.length, lengthM: route.lengthM,
  x: Float32Array.from(route.x), y: Float32Array.from(route.y), z: Float32Array.from(route.z_mdt),
  d: Float32Array.from(route.d), cumClimb: Float32Array.from(route.cumClimb),
};
const { data: pngRaw } = await sharp("public/assets/heightmap.png").raw().toBuffer({ resolveWithObject: true });
const sample = (x: number, y: number): number => {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const W = meta.width;
  const at = (c: number, rr: number): number =>
    (meta.minZ + (pngRaw[(rr * W + c) * 3] as number) * 256 + (pngRaw[(rr * W + c) * 3 + 1] as number));
  return at(c0, r0) * (1 - fx) * (1 - fy) + at(c0 + 1, r0) * fx * (1 - fy) + at(c0, r0 + 1) * (1 - fx) * fy + at(c0 + 1, r0 + 1) * fx * fy;
};
const cx = (meta.bbox.minx + meta.bbox.maxx) / 2;
const cy = (meta.bbox.miny + meta.bbox.maxy) / 2;
const res = resolveAnchors(r);
res.follow = resolveFollowProfile(r);

// args: "base" or "try <knotIdx> <deltaH> ..."
const mode = process.argv[2] as string;
if (mode !== "base" && mode !== "try") {
  console.log("usage: lift-probe.ts base | try <knotIdx> <deltaH> [<knotIdx2> <deltaH2> ...]");
  process.exit(1);
}
const hCamN = FOLLOW_H_CAM_N.slice();
const nudosS = FOLLOW_NUDOS_S.slice();
if (mode === "try") {
  const rest = process.argv.slice(3).map(Number);
  for (let k = 0; k < rest.length; k += 2) {
    const idx = rest[k] as number;
    const dh = rest[k + 1] as number;
    hCamN[idx] = (hCamN[idx] as number) + dh;
  }
}
// rebuild the follow profile with overridden H row (same PCHIP construction)
const fH = buildPchip(nudosS.slice(), hCamN.slice(), "follow-h");
const fLook = buildPchip(nudosS.slice(), FOLLOW_LOOK_N.slice(), "follow-look");
const fBack = buildPchip(nudosS.slice(), FOLLOW_BACK_N.slice(), "follow-back");
const follow = { ...(res.follow as object), fH, fLook, fBack } as typeof res.follow;
const sToD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
const t0 = performance.now();
const rail = bakeCamRail(
  { route: r, follow, sToD, sample, cx, cy, fovDeg: 50, floorM: CAM_CLEARANCE_M },
  (rope) => resolveFollowSafety(sample, cx, cy, { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan }, r, { centerX: cx, centerY: cy, sizeX: 0, sizeZ: 0 }),
);
console.log(`bake ${(performance.now() - t0).toFixed(0)} ms; H=[${hCamN.join(",")}]`);
let active = 0;
let maxRun = 0;
let cur = 0;
const runs: string[] = [];
let rs = -1; let rm = "";
for (let i = 0; i <= 1000; i++) {
  const m = rail.mode[Math.min(rail.n, Math.round((i / 1000) * rail.n))] as string;
  if (m !== "direct") {
    active++; cur++; maxRun = Math.max(maxRun, cur);
    if (rs < 0) { rs = i; rm = m; }
    else if (m !== rm) { runs.push(`${rm}[${(rs / 1000).toFixed(3)}-${((i - 1) / 1000).toFixed(3)}:${i - rs}]`); rs = i; rm = m; }
  } else {
    if (rs >= 0) { runs.push(`${rm}[${(rs / 1000).toFixed(3)}-${((i - 1) / 1000).toFixed(3)}:${i - rs}]`); rs = -1; }
    cur = 0;
  }
}
if (rs >= 0) runs.push(`${rm}[${(rs / 1000).toFixed(3)}-1.000:${1001 - rs}]`);
console.log(`active ${active}/1001 (${(active / 1001 * 100).toFixed(1)}%) maxRun ${maxRun}`);
console.log(`runs: ${runs.join(" ")}`);
// G66 on the candidate rail (same numbers as verify-3a: baked yaw/pitch series)
{
  let mp = 0; let atp = 0; let mq = 0; let atq = 0; let ma = 0; let ata = 0;
  let prevQ = 0;
  const qs: Array<[number, number, number, number]> = [];
  for (let i = 0; i <= 1000; i++) qs.push(quatYXZ(rail.fYaw(i / 1000), rail.fPitch(i / 1000)));
  for (let i = 0; i < 1000; i++) {
    if (i / 1000 >= EPILOGUE_S) continue;
    const v = Math.abs(rail.fPitch((i + 1) / 1000) - rail.fPitch(i / 1000));
    if (v > mp) { mp = v; atp = i; }
    const qd = quatDistDeg(qs[i] as [number, number, number, number], qs[i + 1] as [number, number, number, number]);
    if (qd > mq) { mq = qd; atq = i; }
    if (i > 0) {
      const acc = Math.abs(qd - prevQ);
      if (acc > ma) { ma = acc; ata = i; }
    }
    prevQ = qd;
  }
  console.log(`G66: max|dpitch|=${mp.toFixed(2)} @${(atp / 1000).toFixed(4)}; maxQ=${mq.toFixed(2)} @${(atq / 1000).toFixed(4)}; maxAccel=${ma.toFixed(2)} @${(ata / 1000).toFixed(4)} ${mp <= 1.5 && mq <= 2.8 && ma <= 1.0 ? "PASS" : "FAIL"}`);
}
