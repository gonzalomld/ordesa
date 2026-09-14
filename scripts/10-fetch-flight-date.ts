// 10-fetch-flight-date.ts — query the PNOA-MA MosaicElement layer for the
// flight date + native resolution over the bbox. Written to ortho.json and
// content/sources.md (never hand-copied). A single month over the whole
// frame means one solar geometry for the de-shadowing step.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ORTHO_SIDECAR, WMS_URL, WMS_VERSION } from "./geo-constants.ts";

const POINTS: [number, number, string][] = [
  [741218, 4726062, "Pradera"],
  [741507, 4725203, "Calcilarruego"],
  [747191, 4726348, "Cola de Caballo"],
  [748638, 4729252, "Monte Perdido"],
  [738240, 4722700, "esquina SW"],
  [749040, 4730880, "esquina NE"],
];

async function query(x: number, y: number): Promise<string> {
  const url =
    `${WMS_URL}?service=WMS&version=${WMS_VERSION}&request=GetFeatureInfo` +
    `&layers=OI.MosaicElement&query_layers=OI.MosaicElement` +
    `&crs=EPSG:25830&bbox=${x - 50},${y - 50},${x + 50},${y + 50}` +
    `&width=101&height=101&i=50&j=50&info_format=text/plain`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GetFeatureInfo HTTP ${res.status}`);
  return await res.text();
}

const out: { name: string; raw: string; fecha: string; resolucion: string }[] = [];
for (const [x, y, name] of POINTS) {
  const raw = await query(x, y);
  const fecha = (/FECHA\s*=\s*'?([\d-]+)'?/i.exec(raw)?.[1] ?? "").trim();
  const resolucion = (/RESOLUCION\s*=\s*'?([\d.,]+)'?/i.exec(raw)?.[1] ?? "").trim();
  console.log(`--- ${name} (${x},${y})\n${raw.trim().slice(0, 400)}`);
  out.push({ name, raw: raw.trim(), fecha, resolucion });
}

const fechas = new Set(out.map((o) => o.fecha).filter(Boolean));
const resols = new Set(out.map((o) => o.resolucion).filter(Boolean));
console.log(`fechas: ${[...fechas].join(" | ")}; resoluciones: ${[...resols].join(" | ")}`);

const sidecar = existsSync(ORTHO_SIDECAR)
  ? JSON.parse(readFileSync(ORTHO_SIDECAR, "utf8"))
  : {};
sidecar.flight = { points: out };
writeFileSync(ORTHO_SIDECAR, JSON.stringify(sidecar, null, 2));
console.log(`updated: ${ORTHO_SIDECAR}`);
