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

// --- G8: phase-3A resolved anchor tables (runtime truth, brief wins) ---
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
  // BLOQUEANTE suspicion: vDist garbage kills the whole line. Print the
  // real instanced-attribute range next to lengthM — if max != ~18126,
  // the cut, not the geometry, is the killer.
  {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < routeJ.d.length; i++) {
      const v = routeJ.d[i] as number;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    console.log(`  track-dist attr: min=${mn.toFixed(1)} max=${mx.toFixed(1)} lengthM=${routeJ.lengthM} (route.d feeds instanceDistStart/End 1:1)`);
  }
}
