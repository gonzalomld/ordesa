// route-bridge.ts — R1: puenteo de vaguadas del perfil (PURA, única fuente).
//
// Un mínimo local se puentea si:
//   · profundidad >= 8 m respecto al MENOR de sus dos hombros (el más bajo),
//   · la bajada + la recuperación caben en <= 120 m de camino,
//   · los dos hombros están a menos de 10 m de altura entre sí.
// Cuando se cumple, la z del tramo pasa a ser interpolación lineal entre los
// dos hombros: cruzar el barranco en vez de bajar a él.
//
// La tercera condición es la que protege los descensos de verdad: en el
// regreso por el valle se baja cientos de metros, pero se baja y no se vuelve
// a subir, así que los hombros nunca se parecen y no se toca nada.
//
// PURA — prohibido readFileSync/fetch/sharp aquí. Importable sin efectos.
// La usan 05-build-route.ts (aplicar) y verify-3a.ts (comprobar), una sola
// definición para que no diverjan.

export const BRIDGE_MIN_DEPTH_M = 8;
export const BRIDGE_MAX_WIDTH_M = 120;
export const BRIDGE_MAX_SHOULDER_DELTA_M = 10;

export interface RouteBridge {
  /** índice del mínimo local */
  i: number;
  /** índices de los dos hombros (L < i < R) */
  L: number;
  R: number;
  /** min(z[L], z[R]) - z[i] (m) */
  depthM: number;
  /** (R - L) * stepM (m) */
  widthM: number;
}

/**
 * Detecta las vaguadas puenteables de un perfil z con paso stepM.
 * Mínimo local ESTRICTO (z[i] < z[i-1] && z[i] < z[i+1]) para no duplicar
 * mesetas; entre los pares de puntos que flanquean el mínimo dentro de
 * BRIDGE_MAX_WIDTH_M se elige el de mayor profundidad con hombros parecidos
 * (|Δ| < BRIDGE_MAX_SHOULDER_DELTA_M). No se puentea nunca un tramo con un
 * punto más bajo que z[i] entre los hombros.
 */
export function findBridges(z: number[], stepM: number): RouteBridge[] {
  const N = z.length;
  const out: RouteBridge[] = [];
  const maxK = Math.floor(BRIDGE_MAX_WIDTH_M / stepM / 2) + 1;
  for (let i = 2; i < N - 2; i++) {
    const zi = z[i] as number;
    if (!(zi < (z[i - 1] as number) && zi < (z[i + 1] as number))) continue;
    let best: { L: number; R: number; depthM: number; widthM: number } | null = null;
    for (let kl = 1; kl <= maxK; kl++) {
      if (i - kl < 1) break; // shoulders must be interior (never index 0/-)
      const hL = z[i - kl] as number;
      if (hL <= zi) continue;
      for (let kr = 1; kr <= maxK; kr++) {
        if (i + kr > N - 2) break; // interior
        if ((kl + kr) * stepM > BRIDGE_MAX_WIDTH_M + 1e-6) break;
        const hR = z[i + kr] as number;
        if (hR <= zi) continue;
        if (Math.abs(hL - hR) >= BRIDGE_MAX_SHOULDER_DELTA_M) continue;
        const depthM = Math.min(hL, hR) - zi;
        if (depthM < BRIDGE_MIN_DEPTH_M) continue;
        if (!best || depthM > best.depthM) best = { L: i - kl, R: i + kr, depthM, widthM: (kl + kr) * stepM };
      }
    }
    if (!best) continue;
    // i debe ser el punto más bajo del tramo (no aplanar un punto más hondo).
    let isMin = true;
    for (let k = best.L; k <= best.R; k++) {
      if ((z[k] as number) < zi) {
        isMin = false;
        break;
      }
    }
    if (!isMin) continue;
    out.push({ i, L: best.L, R: best.R, depthM: best.depthM, widthM: best.widthM });
  }
  return out;
}

/** Devuelve una copia del perfil con cada tramo puenteado interpolado
 * linealmente entre sus dos hombros. No muta la entrada. */
export function applyBridges(z: number[], bridges: RouteBridge[]): number[] {
  const out = z.slice();
  for (const b of bridges) {
    const hL = z[b.L] as number;
    const hR = z[b.R] as number;
    for (let k = b.L; k <= b.R; k++) {
      out[k] = hL + (hR - hL) * ((k - b.L) / (b.R - b.L));
    }
  }
  return out;
}
