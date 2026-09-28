// deshadow.ts — ÚNICA fuente de la operación de desombreado (PURA).
//
// PUREZA OBLIGATORIA: prohibido readFileSync/fetch/sharp/top-level await
// aquí dentro. Este módulo es importable sin efectos desde cualquier sitio
// (12-build-des-shadow.ts, 20-build-ortho-tiles.ts, verify-3a.ts). Si le
// metes I/O, importar el módulo dispara el pipeline entero — no lo hagas.
//
// La OPERACIÓN vive aquí, no solo los números: la divergencia de T1-c fue
// la fórmula (al 20 le faltaba la división + el gain), no las constantes.
// Si escribes `/ Math.max(` + `* gain` fuera de este fichero, G129 te lo
// caza. Un solo sitio donde la aritmética existe.

export const AMBIENT = 0.35;
export const FLOOR = 0.25;

/** Desombreado por canal: v en raw 0..255, illum = muestreo bilineal del
 * campo persistido, gain = escalar GLOBAL de meta.json (mismo para todas
 * las teselas — prohibido recalcularlo por tesela: el brillo dependería
 * del contenido y saldría un mosaico a parches). */
export function applyDeshadow(v: number, illum: number, gain: number): number {
  return (v / Math.max(illum, FLOOR)) * gain;
}
