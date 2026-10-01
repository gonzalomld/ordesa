// 22-build-track-gpx.ts — public/assets/senda-cazadores.gpx (descargable).
//
// Fuente: data/source/senda-cazadores.gpx (GPX original, WGS84). Se conserva
// la GEOMETRÍA tal cual (wpt + trkpt), pero se elimina toda mención a Wikiloc:
// creador neutro y sin bloque <metadata> (nombre/autor/enlaces). El verify de
// este script falla si queda cualquier "wikiloc" en el XML resultante.
//
// Local only (como el resto del pipeline). No entra en `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const SRC = "data/source/senda-cazadores.gpx";
const OUT = "public/assets/senda-cazadores.gpx";
const CREATOR = "Senda de los Cazadores — Ordesa 3D";

const xml = readFileSync(SRC, "utf8");
let out = xml
  // bloque de metadatos completo (nombre Wikiloc, autor, enlaces)
  .replace(/<metadata>[\s\S]*?<\/metadata>/i, "")
  // creador neutro
  .replace(/creator="[^"]*"/i, `creator="${CREATOR}"`)
  // nombre del track ("Senda de Los Cazadores  - Wikiloc") → limpio
  .replace(/<name>[^<]*wikiloc[^<]*<\/name>/gi, "<name>Senda de Los Cazadores</name>")
  // red de seguridad: cualquier nodo de texto con la marca se vacía
  .replace(/>[^<]*wikiloc[^<]*</gi, "><");

if (/wikiloc/i.test(out)) {
  throw new Error("22-build-track-gpx: queda una mención a Wikiloc en el GPX");
}
if (!/<trk>/.test(out) || !/<trkpt/.test(out)) {
  throw new Error("22-build-track-gpx: el GPX saneado no contiene track");
}

writeFileSync(OUT, out);
const hash = createHash("sha256").update(out).digest("hex").slice(0, 8);
const trkpts = (out.match(/<trkpt/g) ?? []).length;
console.log(`saved: ${OUT} (${trkpts} trkpts, sha256:${hash}, ${Buffer.byteLength(out)} B)`);
