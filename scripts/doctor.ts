// doctor.ts — prints asset weights, vertex counts and load-relevant sizes.
// Informational only; never fails.
import { statSync } from "node:fs";
import {
  HEIGHTMAP_FILE,
  META_FILE,
  ROUTE_FILE,
  TEXTURE_2K,
  TEXTURE_8K,
} from "./geo-constants.ts";

const mb = (p: string): string => `${(statSync(p).size / 1024 / 1024).toFixed(2)} MB  ${p}`;
console.log("assets:");
for (const p of [META_FILE, HEIGHTMAP_FILE, TEXTURE_2K, TEXTURE_8K, ROUTE_FILE]) {
  console.log(`  ${mb(p)}`);
}

const meta = JSON.parse(
  (await import("node:fs")).readFileSync(META_FILE, "utf8"),
) as { width: number; height: number };
for (const step of [1, 2, 4, 8]) {
  const w = Math.floor((meta.width - 1) / step) + 1;
  const h = Math.floor((meta.height - 1) / step) + 1;
  console.log(`mesh step ${step}: ${w}x${h} = ${(w * h).toLocaleString("en-US")} vertices`);
}
console.log(
  `first paint: heightmap + terrain-2k = ${(
    (statSync(HEIGHTMAP_FILE).size + statSync(TEXTURE_2K).size) /
    1024 /
    1024
  ).toFixed(2)} MB`,
);
