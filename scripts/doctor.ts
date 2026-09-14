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
  console.log("  camera:");
  CAMERA_ANCHORS.forEach((c, i) => {
    const yawV = res.camYawUnwrapped[i] as number;
    // A4b is a yaw gate: dist/pitch/hT interpolate (sentinel -1).
    const shape = c.distM < 0 ? "interp" : `dist=${c.distM} pitch=${c.pitchDeg} hT=${c.hTargetM}`;
    console.log(
      `    ${c.id} s=${c.s.toFixed(3)} d=${((res.camDById[c.id] as number)).toFixed(1)} m ${shape} yaw=${yawV.toFixed(1)} (unwrapped)`,
    );
  });
  if (res.yawBranch.length > 0) {
    console.log("  yaw branches (E5.2: most clear-LOS wins, ties -> less rotation):");
    for (const b of res.yawBranch) {
      console.log(`    ${b.from}->${b.to}: ${b.branch === "direct" ? "rama directa" : "rama +180"} (${b.clear}/${b.total})`);
    }
  }
  const sunset = bisectSunset((h) => nodeSun(42.645, -0.055, 2026, 8, 16, h, 120).elevationDeg);
  const e = nodeSun(42.645, -0.055, 2026, 8, 16, sunset, 120).elevationDeg;
  console.log(`  sunset: ${hhmmss(sunset)} local, elev(sunset)=${e.toFixed(3)} deg (need -0.833 +/-0.005)`);
}
