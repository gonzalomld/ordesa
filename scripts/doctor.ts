// doctor.ts — asset weights, mesh sizes, meta-vs-disk (Node side of D10).
// Frame timings live in the page (?debug=1 + window.__metrics); doctor
// covers everything measurable without a GPU. Informational, never fails.
import { existsSync, statSync } from "node:fs";
import { META_FILE } from "./geo-constants.ts";

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log("assets:");
const meta = JSON.parse(
  (await import("node:fs")).readFileSync(META_FILE, "utf8"),
) as {
  width: number;
  height: number;
  assets?: Record<string, string>;
  sizesBytes?: Record<string, number>;
  albedo?: { residualCorrelation: number; deepMaskFraction: number };
  solar?: { bestAz: number; bestAlt: number };
  flight?: { fecha: string; resolucion: string };
  corridorMarginM?: number;
  totalClimbM?: number;
};
for (const [k, rel] of Object.entries(meta.assets ?? {})) {
  const p = `public/${rel}`;
  const disk = existsSync(p) ? statSync(p).size : -1;
  const rec = meta.sizesBytes?.[k] ?? -1;
  console.log(
    `  ${k}: ${disk >= 0 ? mb(disk) : "MISSING"}  ${rel}  ${disk === rec ? "(meta ok)" : `(meta ${rec} DIVERGED)`}`,
  );
}
console.log(`  heightmap: ${mb(statSync("public/assets/heightmap.png").size)}  assets/heightmap.png`);
console.log(`  route: ${mb(statSync("public/assets/route.json").size)}  assets/route.json`);
const firstPaint =
  statSync("public/assets/heightmap.png").size +
  statSync(`public/${meta.assets?.["terrain-base-2048"]}`).size +
  statSync("public/assets/route.json").size;
console.log(`first paint (heightmap + base-2048 + route): ${mb(firstPaint)} (budget ≤ 3 MB)`);
let total = firstPaint;
for (const [, rel] of Object.entries(meta.assets ?? {})) {
  if (rel.includes("base-2048")) continue;
  total += statSync(`public/${rel}`).size;
}
console.log(`total versioned payload: ${mb(total)} (budget ≤ 14 MB)`);

for (const step of [1, 2, 4, 8]) {
  const w = Math.floor((meta.width - 1) / step) + 1;
  const h = Math.floor((meta.height - 1) / step) + 1;
  console.log(`mesh step ${step}: ${w}x${h} = ${(w * h).toLocaleString("en-US")} vertices`);
}
if (meta.flight) console.log(`flight: ${meta.flight.fecha} @ ${meta.flight.resolucion} m/px`);
if (meta.solar) console.log(`flight sun fit: az ${meta.solar.bestAz} alt ${meta.solar.bestAlt}`);
if (meta.albedo) {
  console.log(
    `deshadow: residual corr ${meta.albedo.residualCorrelation}, deep mask ${(100 * meta.albedo.deepMaskFraction).toFixed(2)}%`,
  );
}
if (meta.corridorMarginM !== undefined)
  console.log(`corridor margin: ${meta.corridorMarginM} m`);
console.log(
  "frame timings: open ?debug=1 in the page (window.__metrics: terreno/nubes/post/etiquetas).",
);
console.log(
  "captures: ?t=06:45&cam=pradera · ?t=08:42&cam=general · ?t=14:04&cam=general · ?t=17:30&cam=mirador",
);

// --- C1: baked camera rail series (runtime truth, brief wins) ---
// Same bakeCamRail the browser rig calls (shared, no mirror): s, d, yaw,
// pitch, |Δyaw|/0.001, |Δpitch|/0.001, quaternion step per 0.001 (q and -q
// are the same orientation). Written to content/camera-series.csv.
{
  const { resolveFollowProfile, bakeCamRail, quatDistDeg, quatYXZ } = await import("../src/narrative/anchors.ts");
  const { buildPchip: buildPchipC1 } = await import("../src/narrative/curve.ts");
  const { CAM_CLEARANCE_M: CLR, EPILOGUE_S: EPI_S } = await import("../src/narrative/choreography.ts");
  const { resolveFollowSafety: ladderC1 } = await import("../src/narrative/collision.ts");
  const routeJ = JSON.parse(
    (await import("node:fs")).readFileSync("public/assets/route.json", "utf8"),
  ) as { x: number[]; y: number[]; z_mdt: number[]; d: number[]; cumClimb: number[]; lengthM: number };
  const metaJ = JSON.parse(
    (await import("node:fs")).readFileSync("data/build/meta.json", "utf8"),
  ) as { width: number; height: number; resX: number; resY: number; originX: number; originY: number; minZ: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } };
  const sharpC1 = (await import("sharp")).default;
  const { data: pngC1 } = await sharpC1("public/assets/heightmap.png").raw().toBuffer({ resolveWithObject: true });
  const sampleC1 = (x: number, y: number): number => {
    const col = (x - metaJ.originX) / metaJ.resX - 0.5;
    const row = (metaJ.originY - y) / metaJ.resY - 0.5;
    const c0 = Math.max(0, Math.min(metaJ.width - 2, Math.floor(col)));
    const r0 = Math.max(0, Math.min(metaJ.height - 2, Math.floor(row)));
    const fx = Math.min(1, Math.max(0, col - c0));
    const fy = Math.min(1, Math.max(0, row - r0));
    const W = metaJ.width;
    const at = (cc: number, rr: number): number =>
      (metaJ.minZ + (pngC1[(rr * W + cc) * 3] as number) * 256 + (pngC1[(rr * W + cc) * 3 + 1] as number));
    return at(c0, r0) * (1 - fx) * (1 - fy) + at(c0 + 1, r0) * fx * (1 - fy) + at(c0, r0 + 1) * (1 - fx) * fy + at(c0 + 1, r0 + 1) * fx * fy;
  };
  const cxC1 = (metaJ.bbox.minx + metaJ.bbox.maxx) / 2;
  const cyC1 = (metaJ.bbox.miny + metaJ.bbox.maxy) / 2;
  const rlC1 = {
    n: routeJ.x.length, lengthM: routeJ.lengthM,
    x: Float32Array.from(routeJ.x), y: Float32Array.from(routeJ.y), z: Float32Array.from(routeJ.z_mdt),
    d: Float32Array.from(routeJ.d), cumClimb: Float32Array.from(routeJ.cumClimb),
  };
  const { resolveAnchors: resAncC1 } = await import("../src/narrative/anchors.ts");
  const resC1 = resAncC1(rlC1);
  resC1.follow = resolveFollowProfile(rlC1);
  const sdC1 = buildPchipC1(resC1.sAnchors, resC1.dAnchorsM, "s->d");
  const tC1 = performance.now();
  const railC1 = bakeCamRail(
    { route: rlC1, follow: resC1.follow, sToD: sdC1, sample: sampleC1, cx: cxC1, cy: cyC1, fovDeg: 50, floorM: CLR },
    (rope) => ladderC1(sampleC1, cxC1, cyC1, { camPos: rope.camPos, aim: rope.aim, hCam: rope.hCam, lookM: rope.lookM, backM: rope.backM, distPlan: rope.distPlan }, rlC1, { centerX: cxC1, centerY: cyC1, sizeX: 0, sizeZ: 0 }),
  );
  const bakeMsC1 = performance.now() - tC1;
  const STEPS_C1 = 1000;
  const rowsC1: string[] = ["s,d,yaw,pitch,dyaw,dpitch,qdist"];
  let maxDy = 0; let maxDyS = 0; let maxDp = 0; let maxDpS = 0; let maxQ = 0; let maxQS = 0; let maxA = 0; let maxAS = 0;
  let prevQC1: [number, number, number, number] | null = null;
  let prevQd = 0;
  for (let i = 0; i <= STEPS_C1; i++) {
    const s = i / STEPS_C1;
    const y = railC1.fYaw(s);
    const p = railC1.fPitch(s);
    const q = quatYXZ(y, p);
    const qd = prevQC1 ? quatDistDeg(prevQC1, q) : 0;
    if (i > 0) {
      const i0 = Math.max(0, i - 1);
      const y0 = railC1.fYaw(i0 / STEPS_C1);
      const p0 = railC1.fPitch(i0 / STEPS_C1);
      let dy = Math.abs(y - y0);
      if (dy > 180) dy = 360 - dy;
      const dp = Math.abs(p - p0);
      if (s < EPI_S) {
        if (dy > maxDy) { maxDy = dy; maxDyS = s; }
        if (dp > maxDp) { maxDp = dp; maxDpS = s; }
        if (qd > maxQ) { maxQ = qd; maxQS = s; }
        if (prevQC1) {
          const acc = Math.abs(qd - prevQd);
          if (acc > maxA) { maxA = acc; maxAS = s; }
        }
      }
      rowsC1.push(`${s.toFixed(4)},${railC1.fD(s).toFixed(1)},${y.toFixed(3)},${p.toFixed(3)},${dy.toFixed(4)},${dp.toFixed(4)},${qd.toFixed(4)}`);
    } else {
      rowsC1.push(`${s.toFixed(4)},${railC1.fD(s).toFixed(1)},${y.toFixed(3)},${p.toFixed(3)},0.0000,0.0000,0.0000`);
    }
    prevQd = qd;
    prevQC1 = q;
  }
  (await import("node:fs")).writeFileSync("content/camera-series.csv", rowsC1.join("\n") + "\n");
  console.log(`\nC1 rail: bake ${bakeMsC1.toFixed(1)} ms (budget <30 — machine-dependent, CI reference), samples ${railC1.n + 1} -> content/camera-series.csv`);
  console.log(`C1 rail maxima (s<0.98): |dyaw|=${maxDy.toFixed(2)} @${maxDyS.toFixed(4)} (G4<=2.5); |dpitch|=${maxDp.toFixed(2)} @${maxDpS.toFixed(4)} (G66<=1.5); qdist=${maxQ.toFixed(2)} @${maxQS.toFixed(4)} (G66<=2.8); accel=${maxA.toFixed(2)} @${maxAS.toFixed(4)} (G66<=1.0)`);
}
// NOTE: doctor prints the GRID-FREE series (resolveAnchors only). The live
// yaw series includes the E5.2 construction-side branch choice (needs the
// heightfield — see verify:3a / progress.ts via applyYawBranches) and is
// printed by verify:3a, not here. If the two ever disagree, the brief wins.
{
  const { resolveAnchors, trackAt, bisectSunset } = await import("../src/narrative/anchors.ts");
  const { buildPchip } = await import("../src/narrative/curve.ts");
  const { CAMERA_ANCHORS, BRIEF_LENGTH_M } = await import("../src/narrative/choreography.ts");
  const { sunPosition: nodeSun } = await import("./lib/sun.ts");
  const routeJ = JSON.parse(
    (await import("node:fs")).readFileSync("public/assets/route.json", "utf8"),
  ) as {
    x: number[];
    y: number[];
    z_mdt: number[];
    d: number[];
    cumClimb: number[];
    lengthM: number;
  };
  const rl = {
    n: routeJ.x.length,
    lengthM: routeJ.lengthM,
    x: Float32Array.from(routeJ.x),
    y: Float32Array.from(routeJ.y),
    z: Float32Array.from(routeJ.z_mdt),
    d: Float32Array.from(routeJ.d),
    cumClimb: Float32Array.from(routeJ.cumClimb),
  };
  const res = resolveAnchors(rl);
  const hhmm = (h: number): string => {
    const m = Math.round(h * 60);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const hhmmss = (h: number): string => {
    const s = Math.round(h * 3600);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  console.log(`\n3A anchors (lengthM ${res.lengthM} m, brief ${BRIEF_LENGTH_M} m, divergence ${res.divergencePct.toFixed(3)}%):`);
  console.log("  s->d:");
  const fSD = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
  void fSD;
  void trackAt;
  for (let i = 0; i < res.sAnchors.length; i++) {
    console.log(
      `    s=${(res.sAnchors[i] as number).toFixed(3)} d=${(res.dAnchorsM[i] as number).toFixed(1)} m (${((res.dAnchorsM[i] as number) / 1000).toFixed(2)} km)`,
    );
  }
  console.log("  time:");
  for (let i = 0; i < res.timeD.length; i++) {
    const d = res.timeD[i] as number;
    const h = res.timeH[i] as number;
    console.log(`    d=${d.toFixed(1)} m ${hhmm(h)}`);
  }
  console.log("  camera: FOLLOW replan — no yaw table. Three series + loop geometry:");
  const { FOLLOW_NUDOS_S, FOLLOW_H_CAM_N, FOLLOW_LOOK_N, FOLLOW_BACK_N } = await import("../src/narrative/choreography.ts");
  const { followAt, resolveFollowProfile } = await import("../src/narrative/anchors.ts");
  const follow = resolveFollowProfile(rl);
  console.log(`  follow knots (s): ${FOLLOW_NUDOS_S.join(" ")}`);
  console.log(`  H_CAM:  ${FOLLOW_H_CAM_N.join(" ")}`);
  console.log(`  LOOK_M: ${FOLLOW_LOOK_N.join(" ")}`);
  console.log(`  BACK_M: ${FOLLOW_BACK_N.join(" ")}`);
  console.log("  at act borders (s=0.06/0.30/0.46/0.68/0.86/0.98):");
  for (const sb of [0.06, 0.3, 0.46, 0.68, 0.86, 0.98]) {
    const p = followAt(follow, sb);
    console.log(`    s=${sb.toFixed(2)} H=${p.hCam.toFixed(0)} LOOK=${p.lookM.toFixed(0)} BACK=${p.backM.toFixed(0)}`);
  }
  console.log(`  epilogue: centroid ${follow.centroid.x.toFixed(0)},${follow.centroid.y.toFixed(0)} z=${follow.centroid.z.toFixed(0)} loopR=${follow.loopR.toFixed(0)} distPlan=${follow.epiDistPlan.toFixed(0)} cam ${follow.epiCam.x.toFixed(0)},${follow.epiCam.y.toFixed(0)} z=${follow.epiCam.z.toFixed(0)}`);
  const sunset = bisectSunset((h) => nodeSun(42.645, -0.055, 2026, 8, 16, h, 120).elevationDeg);
  const e = nodeSun(42.645, -0.055, 2026, 8, 16, sunset, 120).elevationDeg;
  console.log(`  sunset: ${hhmmss(sunset)} local, elev(sunset)=${e.toFixed(3)} deg (need -0.833 +/-0.005)`);
  // §4 correction: the RUNTIME dome uniforms (turbidity/rayleigh/mie/G +
  // SKY_SCALE) — the brief's complaint was unanswerable: no way to know
  // whether 2.2 ever reached the shader. lightingAt(12) IS what
  // applyLighting feeds the dome at noon; print it.
  {
    const { lightingAt } = await import("../src/engine/sun.ts");
    const { SKY_SAT, SKY_SCALE } = await import("../src/narrative/choreography.ts");
    const L = lightingAt(12);
    const L9 = lightingAt(9);
    console.log(
      `  sky@12:00 turbidity=${L.turbidity} rayleigh=${L.rayleigh} mieCoefficient=${L.mieCoefficient} mieDirectionalG=${L.mieDirectionalG} uSkyScale=${SKY_SCALE} uSkySat=${SKY_SAT} exposure=${L.exposure}`,
    );
    // §4b FASE 4: convection curve audit — floor at dawn, full at noon.
    console.log(
      `  clouds: density(9:00)=${L9.cloudDensity.toFixed(2)} density(12:00)=${L.cloudDensity.toFixed(2)} (need 0.45 / 1.00)`,
    );
  }
  // RASTRO gl_InstanceID: no attribute left — distance IS the index.
  // The old instanceDistEnd check is dead (its units were right and still
  // the shader read the wrong buffer). What matters now: uniform resample.
  {
    const ds = routeJ.d as number[];
    let uniform = true;
    for (let i = 1; i < ds.length; i++) {
      if (Math.abs((ds[i] as number) - (ds[i - 1] as number) - 5) > 0.01) {
        uniform = false;
        break;
      }
    }
    console.log(`  track-index: n=${ds.length} step=5 m uniform=${uniform} lengthM=${routeJ.lengthM} (vDist = gl_InstanceID * uStepM)`);
  }
}
