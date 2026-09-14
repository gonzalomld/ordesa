// 14-build-labels-camera.ts — D7 peaks + D8 default framing.
//
// Peaks: approximate seeds → local MDT maximum in 400 m (150 m for Tozal).
// Names only from published sources (see content/sources.md); unknowns keep
// nombre:null and never enter the UI. Route milestones come from route.json.
// Camera: reference verified in the brief — WSW of the Pradera at
// (738600,4725200), 3500-4500 m, heading ~75°, fov 50° — rechecked by ray
// marching over the MDT; anchors + visibility list saved to camera.json.
import { readFileSync, writeFileSync } from "node:fs";
import { DEM_FILE, ROUTE_FILE } from "./geo-constants.ts";
import { readDem } from "./lib/tiff.ts";
import { utm30NToWgs84 } from "./lib/utm.ts";

const dem = await readDem(DEM_FILE);

// seeds: [x, y, radiusM, confirmedName|null, sourceNote]
// U2: the peak search takes the MAXIMUM in the disc. For spurs that rise
// monotonically into a higher ridge (Tozal prow 2255 → ridge 2447) the max
// is the wrong rule — pin those by hand with radius 0 (exact XY, MDT cota).
const SEEDS: [number, number, number, string | null, string][] = [
  [748638, 4729252, 400, "Monte Perdido", "MDT 3347 = oficial 3348 (MITECO)"],
  [747748, 4730232, 400, null, "sin identificar (MTN25 0178-2 pendiente)"],
  [747118, 4730878, 400, null, "sin identificar (MTN25 0178-2 pendiente)"],
  [741342, 4730862, 400, null, "sin identificar (MTN25 0146-4 pendiente)"],
  [740402, 4730878, 400, null, "sin identificar (MTN25 0146-4 pendiente)"],
  [744368, 4730238, 400, null, "sin identificar (MTN25 0178-1 pendiente)"],
  [743578, 4730438, 400, null, "sin identificar (MTN25 0178-1 pendiente)"],
  [742558, 4730842, 400, null, "sin identificar (MTN25 0146-4 pendiente)"],
  [739198, 4729072, 400, "Mondarruego", "MDT 2845 = avistamiento cabra 2022 (sources.md)"],
  [744788, 4726902, 400, null, "sin identificar (MTN25 0178-1 pendiente)"],
  [738482, 4729158, 400, null, "sin identificar (MTN25 0146-3 pendiente)"],
  [744088, 4726632, 400, null, "sin identificar (MTN25 0178-1 pendiente)"],
  [741022, 4728318, 400, null, "sin identificar (MTN25 0146-4 pendiente)"],
  [743262, 4728958, 400, null, "sin identificar (MTN25 0146-4 pendiente)"],
  [744712, 4728058, 400, null, "sin identificar (MTN25 0178-1 pendiente)"],
  // U2: Tozal del Mallo (2254 m) — free-standing prow on the S wall above
  // the Pradera. MDT transect 741710,4726950 → 741555,4727105 rises
  // monotonically 2255 → 2447 m (no saddle): the 2254 m published summit is
  // the S prow of that spur, not the ridge behind. Anchor pinned at the prow
  // with radius 60 m; cota comes from the MDT by construction. Old anchor
  // 739040,4726295 fell on the valley floor (1351 m).
  [741710, 4726950, 0, "Tozal del Mallo", "espolón S MDT 2255 = publicado 2254"],
];

interface Label {
  id: string;
  tipo: "cumbre" | "hito";
  x: number;
  y: number;
  z: number;
  nombre: string | null;
  fuente: string;
}

const labels: Label[] = [];
SEEDS.forEach(([sx, sy, r, nombre, fuente], k) => {
  let best = { z: -Infinity, x: sx, y: sy };
  if (r === 0) {
    // pinned: exact XY (spur prow, not the max of the disc) — cota from MDT
    best = { z: dem.sampleBilinear(sx, sy), x: sx, y: sy };
  } else {
    for (let y = sy - r; y <= sy + r; y += 5)
      for (let x = sx - r; x <= sx + r; x += 5) {
        if (Math.hypot(x - sx, y - sy) > r) continue;
        const z = dem.sampleBilinear(x, y);
        if (z > best.z) best = { z, x, y };
      }
  }
  const { lat, lon } = utm30NToWgs84(best.x, best.y);
  console.log(
    `${nombre ?? `pico${k}`} → ${Math.round(best.x)},${Math.round(best.y)} z=${best.z.toFixed(0)} (${lat.toFixed(5)},${lon.toFixed(5)})`,
  );
  labels.push({
    id: nombre ? nombre.toLowerCase().replace(/[^a-z]+/g, "-") : `pico-${k}`,
    tipo: "cumbre",
    x: Math.round(best.x),
    y: Math.round(best.y),
    z: Math.round(best.z),
    nombre,
    fuente,
  });
});

// route milestones from route.json (arrays-parallel format)
const route = JSON.parse(readFileSync(ROUTE_FILE, "utf8")) as {
  x: number[];
  y: number[];
  z_mdt: number[];
  d: number[];
  lengthM: number;
};
function atDist(m: number): { x: number; y: number; z: number; d: number } {
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < route.d.length; i++) {
    const dd = Math.abs((route.d[i] as number) - m);
    if (dd < bd) {
      bd = dd;
      bi = i;
    }
  }
  return {
    x: route.x[bi] as number,
    y: route.y[bi] as number,
    z: (route.z_mdt[bi] as number) - 4, // strip drape offset → ground
    d: route.d[bi] as number,
  };
}
const H = (m: number, id: string, nombre: string, fuente: string): void => {
  const p = atDist(m);
  labels.push({ id, tipo: "hito", ...p, nombre, fuente });
  console.log(`${nombre} → km ${(p.d / 1000).toFixed(2)} z=${p.z.toFixed(0)}`);
};
H(0, "pradera", "Pradera de Ordesa", "GPX inicio, MDT 1318");
H(2440, "cota-maxima", "Cota máxima del camino", "trazado km 2,44 MDT 1999 (mirador 1952: verificar D6-P5)");
H(9670, "cola-caballo", "Cola de Caballo", "trazado km 9,67 MDT 1762 = publicado ~1760");
writeFileSync("public/assets/labels.json", JSON.stringify({ labels }, null, 1));
console.log(`saved: public/assets/labels.json (${labels.length})`);

// --- camera (D8): verified reference, rechecked by ray march ---
function elevAt(x: number, y: number): number {
  return dem.sampleBilinear(x, y);
}
function visible(
  cx: number,
  cy: number,
  cz: number,
  tx: number,
  ty: number,
  tz: number,
): boolean {
  const steps = 120;
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = cx + (tx - cx) * f;
    const y = cy + (ty - cy) * f;
    const z = cz + (tz - cz) * f;
    if (x < 738240 || x > 749040 || y < 4722700 || y > 4730880) continue;
    if (elevAt(x, y) > z + 3) return false;
  }
  return true;
}
const CAM = { x: 738600, y: 4725200, z: 4000 };
const anchors = [
  { id: "pradera", x: 741218, y: 4726062, z: 1321 },
  { id: "monte-perdido", x: 748638, y: 4729252, z: 3347 },
  { id: "cola-caballo", x: 747191, y: 4726348, z: 1762 },
  { id: "calcilarruego", x: 741507, y: 4725203, z: 1960 },
];
const checks = anchors.map((a) => ({
  ...a,
  visible: visible(CAM.x, CAM.y, CAM.z, a.x, a.y, a.z),
}));
for (const c of checks)
  console.log(`${c.visible ? "VISIBLE " : "OCULTA  "} ${c.id}`);
const dx = 741218 - CAM.x + (748638 - CAM.x);
const dy = 4726062 - CAM.y + (4729252 - CAM.y);
// heading ≈ 75° handled in-engine via lookAt target below
const target = { x: 744500, y: 2100, z: -2600 }; // world coords filled in-engine
const camera = {
  reference: { epsgX: CAM.x, epsgY: CAM.y, epsgZ: CAM.z, headingDeg: 75, fov: 50 },
  target,
  checks,
  note: "Cola oculta esperada (pared S tapa el circo desde el oeste). FOV 50 horizontal; vertical: alejar 1.35×.",
};
writeFileSync("data/build/camera.json", JSON.stringify(camera, null, 2));
writeFileSync("public/assets/camera.json", JSON.stringify(camera, null, 2));
console.log("saved: data/build/camera.json (+ public copy)");
