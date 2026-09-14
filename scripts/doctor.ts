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
