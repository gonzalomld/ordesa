// clouds.ts — N2 (Everest-style): 24 grupos de 4-8 billboards con textura
// procedural (lienzo 2D, no fBm), de 1 a 13 km de ancho, a ≥ 500 m del
// terreno, opacidad 0,5-0,82 × amount(h) × mult(acto) × luz del día, deriva
// lenta en X con envoltura. Nada aparece ni desaparece: solo se desplaza.
//
// Colocación (semilla fija, en el arranque, publicada en __cloudBand):
// camYmax = máx de poseAt(s).y para s ∈ [0,1] paso 0,005 (INCLUIDO el
// epílogo); base = máx(camYmax + 300, 2900); techo = base + 600.
// Cada 10 frames las instancias se reordenan de lejos a cerca (los
// billboards translúcidos necesitan orden de pintado) — UNA sola
// InstancedMesh (calls no crece).
//
// Color: el neutro de N1 (blanco × P, P = 0,16+0,84·dayF) + el mismo tinte
// de niebla por distancia que el terreno (captura del cielo, fog:true).
// clouds.ts — N2 (Everest-style) + N2b (bruma de valle, cirros, anillo
// lejano): 24 grupos de cúmulos + 40 brumas + 6 cirros + 12 grupos de
// anillo, todo en la MISMA InstancedMesh (calls no crece).
//
// Familias (aFamily): 0 cúmulo, 1 bruma, 2 cirro, 3 anillo. Cuatro
// uniformes de cantidad (uAmtCumulus/uAmtMist/uAmtCirrus/uAmtFar): el
// vertex multiplica el alfa por la cantidad de su familia. Un solo
// material, un solo draw call. El reordenado N2 (lejos→cerca cada 10
// frames) incluye a todas las familias.
//
// Color: el neutro de N1 (blanco × P, P = 0,16+0,84·dayF) + el mismo tinte
// de niebla por distancia que el terreno (captura del cielo, fog:true).
// Cirros (fam 2): SIN tinte de niebla (vNoFog=1: por encima de la
// atmósfera baja). Bruma (fam 1): color base (0,86,0,91,0,97) × P.
// Movimiento de bruma (balanceo ±20 m + pulso 0,75+0,25·sin): por uTime y
// aMisc en el vertex, sin CPU.
import * as THREE from "three";
import {
  CLOUD_ACT_MULT,
  CLOUD_BASE_FLOOR_M,
  CLOUD_BASE_LIFT_M,
  CLOUD_BAND_DEPTH_M,
  CLOUD_CIRRUS_ALPHA_HI,
  CLOUD_CIRRUS_ALPHA_LO,
  CLOUD_CIRRUS_COUNT,
  CLOUD_CIRRUS_DRIFT_HI_MS,
  CLOUD_CIRRUS_DRIFT_LO_MS,
  CLOUD_CIRRUS_H_FRAC,
  CLOUD_CIRRUS_HI_M,
  CLOUD_CIRRUS_LO_M,
  CLOUD_CIRRUS_W_MAX_M,
  CLOUD_CIRRUS_W_MIN_M,
  CLOUD_CLEAR_CAM_M,
  CLOUD_CLEAR_GROUND_M,
  CLOUD_CLEAR_ROUTE_M,
  CLOUD_DRIFT_MAX_MS,
  CLOUD_DRIFT_MIN_MS,
  CLOUD_FAM_CIRRUS,
  CLOUD_FAM_CUMULUS,
  CLOUD_FAM_FAR,
  CLOUD_FAM_MIST,
  CLOUD_FAR_ALPHA_HI,
  CLOUD_FAR_ALPHA_LO,
  CLOUD_FAR_COUNT,
  CLOUD_FAR_DRIFT_HI_MS,
  CLOUD_FAR_DRIFT_LO_MS,
  CLOUD_FAR_H_LO,
  CLOUD_FAR_H_SPAN,
  CLOUD_FAR_HI_M,
  CLOUD_FAR_LO_M,
  CLOUD_FAR_MAX_BOARDS,
  CLOUD_FAR_MIN_BOARDS,
  CLOUD_FAR_OUT_HI_M,
  CLOUD_FAR_OUT_LO_M,
  CLOUD_FAR_W_MAX_M,
  CLOUD_FAR_W_MIN_M,
  CLOUD_GROUP_COUNT,
  CLOUD_GROUP_R_MIN_M,
  CLOUD_GROUP_R_SPAN_M,
  CLOUD_MARGIN_M,
  CLOUD_MAX_INSTANCES,
  CLOUD_MIST_ALPHA_HI,
  CLOUD_MIST_ALPHA_LO,
  CLOUD_MIST_BOB_HI_S,
  CLOUD_MIST_BOB_LO_S,
  CLOUD_MIST_BOB_M,
  CLOUD_MIST_CLEAR_BELOW_M,
  CLOUD_MIST_CLEAR_PLAN_M,
  CLOUD_MIST_COUNT,
  CLOUD_MIST_DRIFT_HI_MS,
  CLOUD_MIST_DRIFT_LO_MS,
  CLOUD_MIST_GROUND_MAX_M,
  CLOUD_MIST_H_FRAC,
  CLOUD_MIST_LIFT_HI_M,
  CLOUD_MIST_LIFT_LO_M,
  CLOUD_MIST_W_MAX_M,
  CLOUD_MIST_W_MIN_M,
  CLOUD_SORT_EVERY,
} from "../narrative/choreography.ts";
import type { Meta } from "./terrain.ts";

/** N2: atlas 1024×1024 — 4 cúmulos 512×256 (filas 0-511) + 2 brumas
 * 512×160 (fila 512-671). UV por variante (u0,v0,u1,v1). Tiles 0-3 =
 * cúmulos; tiles 4-5 = bruma (familias 1 y 2). */
export const CLOUD_ATLAS_TILES = [
  { u0: 0, v0: 0.75, u1: 0.5, v1: 1.0 },
  { u0: 0.5, v0: 0.75, u1: 1.0, v1: 1.0 },
  { u0: 0, v0: 0.5, u1: 0.5, v1: 0.75 },
  { u0: 0.5, v0: 0.5, u1: 1.0, v1: 0.75 },
  { u0: 0, v0: 0.34375, u1: 0.5, v1: 0.5 },
  { u0: 0.5, v0: 0.34375, u1: 1.0, v1: 0.5 },
];

/** N2: nº de billboards de cúmulos (24 grupos × 4-8, semilla fija). */
export const CLOUD_COUNT = 148;
/** N2b: instancias totales (cúmulos + bruma + cirros + anillo). */
export const CLOUD_TOTAL = CLOUD_MAX_INSTANCES;

export interface Clouds {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  centers: THREE.Vector3[];
  /** N2b: live material uniforms (uMap + 4 amounts) for the pixel-meter's
   * flat probe pass — same values, no copies. La sonda informa, no gobierna. */
  probeUniforms(): {
    uMap: { value: THREE.Texture | null };
    uAmtCumulus: { value: number };
    uAmtMist: { value: number };
    uAmtCirrus: { value: number };
    uAmtFar: { value: number };
  };
  /** N2b: cantidades por familia (multiplican el alfa; continuas → G35). */
  setAmounts(a: { cumulus: number; mist: number; cirrus: number; far: number }): void;
  /** N2: amount(h)×mult — compat (escribe uAmtCumulus; el anillo usa far). */
  setAmount(a: number): void;
  /** N2: multiplicador por acto (único botón de dirección de arte). */
  setMult(m: number): void;
  /** A9 (seguro): 0 = a nivel de ojo (densidad plena) .. 1 = nadir (fade). */
  setZenithFade(f: number): void;
  /** N1: dayF diario — smoothstep(−4°, 4°, elevación solar), escrito por
   * el viewer desde lightingAt (misma fuente que la niebla). Solo
   * multiplica el brillo neutro P; nunca tiñe. */
  setDayF(f: number): void;
  update(time: number, camera: THREE.Camera, vw: number, vh: number): void;
  getCoverage(): number;
  /** N2: ms del último reordenado (puerta: ≤ 0,4 ms en N2b). */
  sortMs(): number;
  dispose(): void;
}

export interface CloudBoard {
  /** EPSG plan + altitud (mismo marco que CloudCamPose). */
  x: number;
  y: number;
  z: number;
  /** ancho/alto del billboard en m. */
  w: number;
  h: number;
  /** variante de atlas 0-5 (0-3 cúmulos, 4-5 bruma). */
  tile: number;
  /** rotación fija ±0,07 rad. */
  rot: number;
  /** opacidad base. */
  alpha: number;
  /** grupo (deriva compartida). */
  group: number;
  /** N2b: familia 0-3. */
  family: number;
  /** N2b: fase del balanceo/pulso de bruma (rad). */
  phase: number;
  /** N2b: periodo del balanceo de bruma (s). */
  period: number;
  /** N2b: deriva propia en X (m/s) — mist/cirrus/far; cúmulos usan grupo. */
  driftV: number;
  /** N2b: color base (bruma 0,86/0,91/0,97; resto blanco). */
  tint: [number, number, number];
}

export interface CloudGroupInfo {
  cx: number;
  cy: number;
  cz: number;
  r: number;
  boards: number;
  driftV: number;
}

export interface CloudLayoutMeta {
  bbox: { minx: number; maxx: number; miny: number; maxy: number };
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
}

export interface CloudRoute {
  n: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

/** Poses de cámara muestreadas — EPSG plan (x, y) + altitud z. */
export interface CloudCamPose {
  x: number;
  y: number;
  z: number;
  s?: number;
}

export interface CloudBand {
  base: number;
  top: number;
  camYmax: number;
  groups: CloudGroupInfo[];
  accepted: number;
  /** rechazos por motivo (cam/route/ground/attempts). */
  rejected: { cam: number; route: number; ground: number; attempts: number };
  /** N2b: nº por familia + rechazos de bruma/anillo por motivo. */
  families: {
    cumulus: number;
    mist: number;
    cirrus: number;
    far: number;
    mistRejected: { ground: number; cam: number; attempts: number };
    farRejected: { attempts: number };
  };
}

/** N2: colocación de grupos — semilla fija, rechazos contados por motivo.
 * Devuelve billboards + banda publicada en __cloudBand. */
export function cloudLayout(
  meta: CloudLayoutMeta,
  elev: Float32Array,
  route?: CloudRoute,
  camPoses?: CloudCamPose[],
): { boards: CloudBoard[]; band: CloudBand } {
  const rnd = mulberry(20260816);
  let camYmax = -Infinity;
  if (camPoses && camPoses.length > 0) {
    for (const c of camPoses) {
      if (c.z > camYmax) camYmax = c.z;
    }
  } else {
    camYmax = 2600;
  }
  const base = Math.max(camYmax + CLOUD_BASE_LIFT_M, CLOUD_BASE_FLOOR_M);
  const top = base + CLOUD_BAND_DEPTH_M;
  const rejected = { cam: 0, route: 0, ground: 0, attempts: 0 };
  const groups: CloudGroupInfo[] = [];
  const boards: CloudBoard[] = [];
  const minx = meta.bbox.minx + CLOUD_MARGIN_M;
  const maxx = meta.bbox.maxx - CLOUD_MARGIN_M;
  const miny = meta.bbox.miny + CLOUD_MARGIN_M;
  const maxy = meta.bbox.maxy - CLOUD_MARGIN_M;
  // distancia en planta a un segmento de ruta (muestreo grueso ×4)
  const routeDist = (x: number, y: number): number => {
    if (!route || route.n < 2) return Infinity;
    let bd = Infinity;
    for (let i = 0; i < route.n; i += 4) {
      const dx = x - (route.x[i] as number);
      const dy = y - (route.y[i] as number);
      const d = dx * dx + dy * dy;
      if (d < bd) bd = d;
    }
    return Math.sqrt(bd);
  };
  const camDist = (x: number, y: number): number => {
    if (!camPoses || camPoses.length === 0) return Infinity;
    let bd = Infinity;
    for (const c of camPoses) {
      const dx = x - c.x;
      const dy = y - c.y;
      const d = dx * dx + dy * dy;
      if (d < bd) bd = d;
    }
    return Math.sqrt(bd);
  };
  let accepted = 0;
  for (let g = 0; g < CLOUD_GROUP_COUNT; g++) {
    let placed = false;
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      const x = minx + rnd() * (maxx - minx);
      const y = miny + rnd() * (maxy - miny);
      const z = base + rnd() * (top - base);
      const ground = sampleElev(elev, meta as Meta, x, y);
      if (z - ground < CLOUD_CLEAR_GROUND_M) {
        rejected.ground++;
        continue;
      }
      const dc = camDist(x, y);
      if (dc < CLOUD_CLEAR_CAM_M) {
        rejected.cam++;
        continue;
      }
      const dr = routeDist(x, y);
      if (dr < CLOUD_CLEAR_ROUTE_M) {
        rejected.route++;
        continue;
      }
      // grupo aceptado
      const R = CLOUD_GROUP_R_MIN_M + Math.pow(rnd(), 1.6) * CLOUD_GROUP_R_SPAN_M;
      const driftV = CLOUD_DRIFT_MIN_MS + rnd() * (CLOUD_DRIFT_MAX_MS - CLOUD_DRIFT_MIN_MS);
      const nBoards = 4 + Math.floor(rnd() * 5); // 4-8
      const m = 0.5 + rnd() * 0.7;
      const M = 0.08 + rnd() * 0.28;
      for (let b = 0; b < nBoards; b++) {
        const w = R * (0.4 + rnd() * 0.75);
        const h = w * (0.3 + rnd() * 0.42);
        boards.push({
          x: x + (rnd() * 2 - 1) * R * m * 0.5,
          y: y + (rnd() * 2 - 1) * R * M * 0.5,
          z: z + (rnd() * 2 - 1) * R * m * 0.25,
          w,
          h,
          tile: Math.floor(rnd() * 4),
          rot: (rnd() * 2 - 1) * 0.07,
          alpha: 0.5 + rnd() * 0.32,
          group: groups.length,
          family: CLOUD_FAM_CUMULUS,
          phase: 0,
          period: 0,
          driftV,
          tint: [1, 1, 1],
        });
      }
      groups.push({ cx: x, cy: y, cz: z, r: R, boards: nBoards, driftV });
      accepted++;
      placed = true;
    }
    if (!placed) rejected.attempts++;
  }
  // --- N2b: bruma de valle (40) — donde el terreno < 1900 m, y = suelo +
  // 60..220 m. Rechazo: <600 m en planta de una pose Y <200 m bajo ella.
  const mistRejected = { ground: 0, cam: 0, attempts: 0 };
  let mistN = 0;
  for (let k = 0; k < CLOUD_MIST_COUNT; k++) {
    let placed = false;
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      const x = minx + rnd() * (maxx - minx);
      const y = miny + rnd() * (maxy - miny);
      const ground = sampleElev(elev, meta as Meta, x, y);
      if (ground >= CLOUD_MIST_GROUND_MAX_M) {
        mistRejected.ground++;
        continue;
      }
      const z = ground + CLOUD_MIST_LIFT_LO_M + rnd() * (CLOUD_MIST_LIFT_HI_M - CLOUD_MIST_LIFT_LO_M);
      if (camPoses && camPoses.length > 0) {
        let bad = false;
        for (const c of camPoses) {
          const dp = Math.hypot(x - c.x, y - c.y);
          if (dp < CLOUD_MIST_CLEAR_PLAN_M && c.z - z < CLOUD_MIST_CLEAR_BELOW_M) {
            bad = true;
            break;
          }
        }
        if (bad) {
          mistRejected.cam++;
          continue;
        }
      }
      const w = CLOUD_MIST_W_MIN_M + rnd() * (CLOUD_MIST_W_MAX_M - CLOUD_MIST_W_MIN_M);
      const h = w * CLOUD_MIST_H_FRAC;
      boards.push({
        x,
        y,
        z,
        w,
        h,
        tile: 4 + Math.floor(rnd() * 2),
        rot: (rnd() * 2 - 1) * 0.07,
        alpha: CLOUD_MIST_ALPHA_LO + rnd() * (CLOUD_MIST_ALPHA_HI - CLOUD_MIST_ALPHA_LO),
        group: groups.length,
        family: CLOUD_FAM_MIST,
        phase: rnd() * Math.PI * 2,
        period: CLOUD_MIST_BOB_LO_S + rnd() * (CLOUD_MIST_BOB_HI_S - CLOUD_MIST_BOB_LO_S),
        driftV: CLOUD_MIST_DRIFT_LO_MS + rnd() * (CLOUD_MIST_DRIFT_HI_MS - CLOUD_MIST_DRIFT_LO_MS),
        tint: [0.86, 0.91, 0.97],
      });
      groups.push({ cx: x, cy: y, cz: z, r: w * 0.5, boards: 1, driftV: 0 });
      mistN++;
      placed = true;
    }
    if (!placed) mistRejected.attempts++;
  }
  // --- N2b: cirros (6) — 7000-9000 m, 6-12 km × 0,10, alfa 0,07-0,13,
  // deriva 6-10 m/s. Sin gates (siempre por encima de todo).
  let cirrusN = 0;
  for (let k = 0; k < CLOUD_CIRRUS_COUNT; k++) {
    const x = minx + rnd() * (maxx - minx);
    const y = miny + rnd() * (maxy - miny);
    const z = CLOUD_CIRRUS_LO_M + rnd() * (CLOUD_CIRRUS_HI_M - CLOUD_CIRRUS_LO_M);
    const w = CLOUD_CIRRUS_W_MIN_M + rnd() * (CLOUD_CIRRUS_W_MAX_M - CLOUD_CIRRUS_W_MIN_M);
    const h = w * CLOUD_CIRRUS_H_FRAC;
    const driftV = CLOUD_CIRRUS_DRIFT_LO_MS + rnd() * (CLOUD_CIRRUS_DRIFT_HI_MS - CLOUD_CIRRUS_DRIFT_LO_MS);
    boards.push({
      x,
      y,
      z,
      w,
      h,
      tile: 4 + Math.floor(rnd() * 2),
      rot: (rnd() * 2 - 1) * 0.07,
      alpha: CLOUD_CIRRUS_ALPHA_LO + rnd() * (CLOUD_CIRRUS_ALPHA_HI - CLOUD_CIRRUS_ALPHA_LO),
      group: groups.length,
      family: CLOUD_FAM_CIRRUS,
      phase: 0,
      period: 0,
      driftV,
      tint: [1, 1, 1],
    });
    groups.push({ cx: x, cy: y, cz: z, r: w * 0.5, boards: 1, driftV });
    cirrusN++;
  }
  // --- N2b: anillo lejano (12 grupos de 3-5) — anillo cuadrado a 2-4 km
  // fuera del bbox, uno cada 30° ±18° de ruido, 3000-3800 m, 3-7 km de
  // ancho, alfa 0,24-0,40, deriva 1-3 m/s.
  const farRejected = { attempts: 0 };
  let farN = 0;
  const ringCx = (meta.bbox.minx + meta.bbox.maxx) / 2;
  const ringCy = (meta.bbox.miny + meta.bbox.maxy) / 2;
  const ringRx = (meta.bbox.maxx - meta.bbox.minx) / 2;
  const ringRy = (meta.bbox.maxy - meta.bbox.miny) / 2;
  for (let k = 0; k < CLOUD_FAR_COUNT; k++) {
    const ang = ((k * 30 + (rnd() * 2 - 1) * 18) * Math.PI) / 180;
    // N2b: anillo CUADRADO a 2-4 km fuera del bbox — el CENTRO sale fuera
    // por construcción; los 3-5 billboards se dispersan alrededor del
    // centro (alguno puede caer dentro: es Richtung, no posición).
    const out = CLOUD_FAR_OUT_LO_M + rnd() * (CLOUD_FAR_OUT_HI_M - CLOUD_FAR_OUT_LO_M);
    // anillo cuadrado: proyecta la dirección sobre el rectángulo expandido
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const tx = dx !== 0 ? (ringRx + out) / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? (ringRy + out) / Math.abs(dy) : Infinity;
    const t = Math.min(tx, ty);
    const x = ringCx + dx * t;
    const y = ringCy + dy * t;
    const z = CLOUD_FAR_LO_M + rnd() * (CLOUD_FAR_HI_M - CLOUD_FAR_LO_M);
    const driftV = CLOUD_FAR_DRIFT_LO_MS + rnd() * (CLOUD_FAR_DRIFT_HI_MS - CLOUD_FAR_DRIFT_LO_MS);
    const nBoards = CLOUD_FAR_MIN_BOARDS + Math.floor(rnd() * (CLOUD_FAR_MAX_BOARDS - CLOUD_FAR_MIN_BOARDS + 1));
    const R = 2000 + rnd() * 1500;
    let okBoards = 0;
    for (let b = 0; b < nBoards; b++) {
      const w = CLOUD_FAR_W_MIN_M + rnd() * (CLOUD_FAR_W_MAX_M - CLOUD_FAR_W_MIN_M);
      const h = w * (CLOUD_FAR_H_LO + rnd() * CLOUD_FAR_H_SPAN);
      // N2b: altitud por BILLBOARD en [3000,3800] (el centro del grupo ya
      // está en la banda; la dispersión ±R·m·0,25 es en planta, no en z).
      const bz = CLOUD_FAR_LO_M + rnd() * (CLOUD_FAR_HI_M - CLOUD_FAR_LO_M);
      boards.push({
        x: x + (rnd() * 2 - 1) * R * 0.5,
        y: y + (rnd() * 2 - 1) * R * 0.2,
        z: bz,
        w,
        h,
        tile: Math.floor(rnd() * 4),
        rot: (rnd() * 2 - 1) * 0.07,
        alpha: CLOUD_FAR_ALPHA_LO + rnd() * (CLOUD_FAR_ALPHA_HI - CLOUD_FAR_ALPHA_LO),
        group: groups.length,
        family: CLOUD_FAM_FAR,
        phase: 0,
        period: 0,
        driftV,
        tint: [1, 1, 1],
      });
      okBoards++;
    }
    if (okBoards > 0) {
      groups.push({ cx: x, cy: y, cz: z, r: R, boards: okBoards, driftV });
      farN++;
    } else {
      farRejected.attempts++;
    }
  }
  return {
    boards,
    band: {
      base,
      top,
      camYmax,
      groups,
      accepted,
      rejected,
      families: {
        cumulus: accepted,
        mist: mistN,
        cirrus: cirrusN,
        far: farN,
        mistRejected,
        farRejected,
      },
    },
  };
}

function mulberry(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleElev(
  elev: Float32Array,
  meta: Meta,
  x: number,
  y: number,
): number {
  const col = (x - meta.originX) / meta.resX - 0.5;
  const row = (meta.originY - y) / meta.resY - 0.5;
  const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
  const fx = Math.min(1, Math.max(0, col - c0));
  const fy = Math.min(1, Math.max(0, row - r0));
  const a = elev[r0 * meta.width + c0] as number;
  const b = elev[r0 * meta.width + c0 + 1] as number;
  const c = elev[(r0 + 1) * meta.width + c0] as number;
  const d = elev[(r0 + 1) * meta.width + c0 + 1] as number;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

export function buildClouds(
  meta: Meta,
  elev: Float32Array,
  atlasUrl: string,
  route?: CloudRoute,
  camPoses?: CloudCamPose[],
): Clouds {
  const group = new THREE.Group();
  const geo = new THREE.PlaneGeometry(1, 1);

  // half-res heightfield texture for the soft-intersection fade
  const hw = Math.ceil(meta.width / 2);
  const hh = Math.ceil(meta.height / 2);
  const hdata = new Float32Array(hw * hh);
  for (let r = 0; r < hh; r++) {
    for (let c = 0; c < hw; c++) {
      hdata[r * hw + c] = elev[Math.min(meta.height - 1, r * 2) * meta.width + Math.min(meta.width - 1, c * 2)] as number;
    }
  }
  const htex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.FloatType);
  htex.magFilter = THREE.LinearFilter;
  htex.minFilter = THREE.LinearFilter;
  htex.wrapS = THREE.ClampToEdgeWrapping;
  htex.wrapT = THREE.ClampToEdgeWrapping;
  htex.needsUpdate = true;

  const cx = (meta.bbox.minx + meta.bbox.maxx) / 2;
  const cy = (meta.bbox.miny + meta.bbox.maxy) / 2;
  const uniforms = {
    uMap: { value: null as THREE.Texture | null },
    uDayF: { value: 1 },
    /** N2b: cantidades por familia (multiplican el alfa; continuas → G35). */
    uAmtCumulus: { value: 0.5 },
    uAmtMist: { value: 0 },
    uAmtCirrus: { value: 1 },
    uAmtFar: { value: 0.5 },
    /** N2: mult por acto — único botón de dirección de arte (fams 0 y 3). */
    uMult: { value: 1 },
    uZenithFade: { value: 0 },
    /** N2b: tiempo (s) para balanceo/pulso de bruma en el vertex. */
    uTime: { value: 0 },
    uHeightMap: { value: htex },
    uHMin: { value: new THREE.Vector2(meta.bbox.minx, meta.bbox.miny) },
    uHSize: { value: new THREE.Vector2(meta.bbox.maxx - meta.bbox.minx, meta.bbox.maxy - meta.bbox.miny) },
    uHMaxY: { value: meta.bbox.maxy },
    uHCenter: { value: new THREE.Vector2(cx, cy) },
  };
  // UV por variante (4 cúmulos; el shader no conoce la bruma N2b).
  const tileU = new THREE.Vector4(0, 0.75, 0.5, 1.0);
  const tileU1 = new THREE.Vector4(0.5, 0.75, 1.0, 1.0);
  const tileU2 = new THREE.Vector4(0, 0.5, 0.5, 0.75);
  const tileU3 = new THREE.Vector4(0.5, 0.5, 1.0, 0.75);
  void tileU;
  void tileU1;
  void tileU2;
  void tileU3;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // N1/N2: fog:true — el tinte cálido llega por la niebla (height-fog toma
    // el color de la captura del cielo). El material de nubes recibe el mismo
    // tinte por distancia que el terreno.
    fog: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `
      attribute vec4 aData; // x: tile, y: rotation, z: family, w: alpha base
      attribute vec2 aSize; // w,h del billboard en m
      attribute vec4 aMisc; // x: phase, y: period, z: tintR, w: tintG (tintB = 1 siempre salvo bruma→0.97)
      varying vec2 vUv; varying float vAlpha; varying vec3 vWPos; varying vec3 vTint; varying float vNoFog;
      uniform float uAmtCumulus; uniform float uAmtMist; uniform float uAmtCirrus; uniform float uAmtFar;
      uniform float uMult; uniform float uTime;
      void main(){
        float tile = aData.x;
        float family = aData.z;
        // N2b: UV por variante (tiles 0-3 cúmulos 512×256; tiles 4-5 bruma 512×160)
        vec2 tileMin = tile < 0.5 ? vec2(0.0, 0.75) : tile < 1.5 ? vec2(0.5, 0.75)
          : tile < 2.5 ? vec2(0.0, 0.5) : tile < 3.5 ? vec2(0.5, 0.5)
          : tile < 4.5 ? vec2(0.0, 0.34375) : vec2(0.5, 0.34375);
        vec2 tileMax = tile < 0.5 ? vec2(0.5, 1.0) : tile < 1.5 ? vec2(1.0, 1.0)
          : tile < 2.5 ? vec2(0.5, 0.75) : tile < 3.5 ? vec2(1.0, 0.75)
          : tile < 4.5 ? vec2(0.5, 0.5) : vec2(1.0, 0.5);
        vUv = mix(tileMin, tileMax, uv);
        // N2: rot fija (aData.y, ±0,07) — sin deriva rotacional.
        float rot = aData.y;
        vec2 p = vec2(position.x * aSize.x, position.y * aSize.y);
        vec2 rp = mat2(cos(rot),-sin(rot),sin(rot),cos(rot)) * p;
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        // N2b: balanceo vertical de bruma ±20 m (periodo por instancia) + el
        // pulso de opacidad va en vAlpha. Todo por uTime: sin CPU.
        float bob = 0.0;
        float pulse = 1.0;
        if (family > 0.5 && family < 1.5) {
          float w = 6.2831853 / max(aMisc.y, 1.0);
          bob = ${CLOUD_MIST_BOB_M.toFixed(1)} * sin(uTime * w + aMisc.x);
          pulse = 0.75 + 0.25 * sin(uTime * 0.02 + aMisc.x);
        }
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c.xyz + right * rp.x + up * rp.y + vec3(0.0, bob, 0.0);
        vWPos = wp;
        // N2b: alfa = base × cantidad(familia) [× mult en fams 0 y 3] [× pulso en bruma].
        float fam = family < 0.5 ? uAmtCumulus * uMult
          : family < 1.5 ? uAmtMist * pulse
          : family < 2.5 ? uAmtCirrus
          : uAmtFar * uMult;
        vAlpha = aData.w * fam;
        vTint = vec3(aMisc.z, aMisc.w, family > 0.5 && family < 1.5 ? 0.97 : 1.0);
        vNoFog = family > 1.5 && family < 2.5 ? 1.0 : 0.0;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vAlpha; varying vec3 vWPos; varying vec3 vTint; varying float vNoFog;
      uniform sampler2D uMap; uniform sampler2D uHeightMap;
      uniform vec2 uHMin; uniform vec2 uHSize; uniform float uHMaxY; uniform vec2 uHCenter;
      uniform float uZenithFade;
      uniform float uDayF;
      void main(){
        // soft particles: fade where the fragment meets the terrain.
        // N2b: los cirros (vNoFog=1) no se recortan contra el heightfield.
        vec2 epsg = vec2(vWPos.x + uHCenter.x, uHCenter.y - vWPos.z);
        vec2 huv = vec2((epsg.x - uHMin.x) / uHSize.x, (uHMaxY - epsg.y) / uHSize.y);
        float terr = texture2D(uHeightMap, huv).r;
        float soft = mix(smoothstep(terr + 20.0, terr + 150.0, vWPos.y), 1.0, vNoFog);
        // N2: alfa de la TEXTURA (canal A del lienzo) — sin máscara uMask.
        vec4 tex = texture2D(uMap, vUv);
        // A9 (seguro): a nadir los billboards son manchas — fade a cenit.
        float a = tex.a * vAlpha * soft * (1.0 - uZenithFade);
        if (a < 0.004) discard;
        // N1/N2 color neutro: tinte × P, P = 0.16+0.84·dayF. La panza ya
        // viene sombreada en la TEXTURA (source-atop azul-gris); el cálido
        // llega por la niebla (fog:true), nunca por puff. De noche: P=0.16.
        float P = 0.16 + 0.84 * uDayF;
        vec3 col = tex.rgb * vTint * P;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  // N2b: capacidad total (cúmulos + bruma + cirros + anillo) en la MISMA
  // InstancedMesh — calls no crece. Puerta: instancias totales ≤ 260.
  const MAXB = CLOUD_MAX_INSTANCES;
  const mesh = new THREE.InstancedMesh(geo, mat, MAXB);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.count = MAXB;
  const dummy = new THREE.Object3D();
  const data = new Float32Array(MAXB * 4);
  const sizes = new Float32Array(MAXB * 2);
  /** N2b: aMisc = (phase, period, tintR, tintG). */
  const misc = new Float32Array(MAXB * 4);
  const centers: THREE.Vector3[] = [];
  // Production layout (semilla fija; N2 sustituye al predictor 4c).
  const { boards, band } = cloudLayout(meta, elev, route, camPoses);
  // N2b: __cloudBand ampliado — nº por familia, rechazos y motivo (G36+).
  // cloudLayout es la única fuente (este módulo); el viewer solo añade el
  // marco base/techo/camYmax con la misma fórmula.
  (window as unknown as { __cloudBandFam?: unknown }).__cloudBandFam = {
    accepted: band.accepted,
    rejected: band.rejected,
    families: band.families,
    instances: boards.length,
  };
  const NB = Math.min(MAXB, boards.length);
  // N2b: deriva propia por billboard (b.driftV — cúmulos: la del grupo) +
  // estado EPSG-x por billboard para la envoltura al borde del DEM.
  const driftX = new Float32Array(MAXB);
  const driftV = new Float32Array(MAXB);
  const boardR = new Float32Array(MAXB);
  // orden de pintado (índices a boards, lejos→cerca; se reescribe cada 10 f)
  const order = new Int32Array(MAXB);
  const writeInstance = (slot: number, b: CloudBoard): void => {
    dummy.position.set(b.x - cx, b.z, -(b.y - cy));
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    data[slot * 4] = b.tile;
    data[slot * 4 + 1] = b.rot;
    data[slot * 4 + 2] = b.family;
    data[slot * 4 + 3] = b.alpha;
    sizes[slot * 2] = b.w;
    sizes[slot * 2 + 1] = b.h;
    misc[slot * 4] = b.phase;
    misc[slot * 4 + 1] = b.period;
    misc[slot * 4 + 2] = b.tint[0];
    misc[slot * 4 + 3] = b.tint[1];
    if (centers[slot]) {
      (centers[slot] as THREE.Vector3).copy(dummy.position);
    } else {
      centers[slot] = dummy.position.clone();
    }
    driftX[slot] = b.x;
    boardR[slot] = Math.max(b.w, b.h) * 0.5;
  };
  for (let i = 0; i < NB; i++) {
    const b = boards[i] as CloudBoard;
    driftV[i] = b.driftV;
    writeInstance(i, b);
    order[i] = i;
  }
  for (let i = NB; i < MAXB; i++) {
    dummy.position.set(0, -100000, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    dummy.scale.setScalar(1);
    data[i * 4 + 3] = 0;
    sizes[i * 2] = 0.01;
    sizes[i * 2 + 1] = 0.01;
    centers[i] = dummy.position.clone();
    order[i] = i;
  }
  mesh.count = MAXB;
  geo.setAttribute("aData", new THREE.InstancedBufferAttribute(data, 4));
  geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(sizes, 2));
  geo.setAttribute("aMisc", new THREE.InstancedBufferAttribute(misc, 4));
  group.add(mesh);
  // N2: el atlas RGBA se muestrea en sRGB (color real del lienzo); el alfa
  // es cobertura — la compresión webp lo conserva (aceptación en el .webp).
  new THREE.TextureLoader().load(atlasUrl, (t: THREE.Texture) => {
    t.colorSpace = THREE.SRGBColorSpace;
    uniforms.uMap.value = t;
  });

  // V3: alpha-weighted coverage, recomputed every 6th frame (métrica
  // analítica; la puerta G24c es el medidor por PÍXELES __cloudCoverPx).
  let coverage = 0;
  let tick = 0;
  let lastT = -1;
  let lastSortMs = -1;
  const pv = new THREE.Vector3();
  const minX = meta.bbox.minx;
  const maxX = meta.bbox.maxx;
  // distancias² para el reordenado (se reutiliza el buffer)
  const sortDepth = new Float32Array(MAXB);
  return {
    group,
    mesh,
    centers,
    probeUniforms() {
      // N2b: uMult viaja colgado del objeto uAmtCumulus (__mult) para que el
      // probe copie draw+mult sin una quinta referencia que olvidar.
      const amtC = uniforms.uAmtCumulus as { value: number; __mult?: number };
      amtC.__mult = uniforms.uMult.value as number;
      return {
        uMap: uniforms.uMap as { value: THREE.Texture | null },
        uAmtCumulus: uniforms.uAmtCumulus as { value: number },
        uAmtMist: uniforms.uAmtMist as { value: number },
        uAmtCirrus: uniforms.uAmtCirrus as { value: number },
        uAmtFar: uniforms.uAmtFar as { value: number },
      };
    },
    setAmounts(a) {
      uniforms.uAmtCumulus.value = Math.min(1, Math.max(0, a.cumulus));
      uniforms.uAmtMist.value = Math.min(1, Math.max(0, a.mist));
      uniforms.uAmtCirrus.value = Math.min(1, Math.max(0, a.cirrus));
      uniforms.uAmtFar.value = Math.min(1, Math.max(0, a.far));
    },
    /** N2-compat: amount(h)×mult → uAmtCumulus (el anillo usa far). */
    setAmount(a) {
      uniforms.uAmtCumulus.value = Math.min(1, Math.max(0, a));
    },
    setMult(m) {
      uniforms.uMult.value = Math.min(2, Math.max(0, m));
    },
    setZenithFade(f: number) {
      uniforms.uZenithFade.value = Math.min(1, Math.max(0, f));
    },
    /** N1: dayF diario — smoothstep(−4°, 4°, elevación solar), escrito por
     * el viewer desde lightingAt (misma fuente que la niebla). Solo
     * multiplica el brillo neutro P; nunca tiñe. */
    setDayF(f: number) {
      uniforms.uDayF.value = Math.min(1, Math.max(0, f));
    },
    update(time, camera, vw, vh) {
      if (!group.visible) return; // T1.1: cut group ⇒ skip CPU work too
      uniforms.uTime.value = time;
      // N2/N2b: deriva en X con envoltura al borde del DEM
      // (x > maxx + R → x = minx − R). dt real del bucle; sin rotación
      // temporal, sin cambios de alfa por tiempo salvo el pulso de bruma
      // (continuo, G35) y P (G46: ningún alfa depende de una sonda).
      if (lastT < 0) lastT = time;
      const dt = Math.min(0.25, Math.max(0, time - lastT));
      lastT = time;
      if (dt > 0) {
        for (let i = 0; i < NB; i++) {
          let x = (driftX[i] as number) + (driftV[i] as number) * dt;
          const R = boardR[i] as number;
          if (x > maxX + R) x = minX - R;
          driftX[i] = x;
          const c = centers[i] as THREE.Vector3;
          c.x = x - cx;
          dummy.position.copy(c);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      // N2: reordenado lejos→cerca cada 10 frames (pintado de translúcidos,
      // TODAS las familias). Reescribe instanceMatrix + aData/aSize/aMisc
      // en ese orden; mide el tiempo (puerta N2b ≤ 0,4 ms).
      if ((tick % CLOUD_SORT_EVERY) === 0 && NB > 1) {
        const t0 = performance.now();
        for (let i = 0; i < NB; i++) {
          const c = centers[i] as THREE.Vector3;
          const dx = c.x - camera.position.x;
          const dy = c.y - camera.position.y;
          const dz = c.z - camera.position.z;
          sortDepth[i] = dx * dx + dy * dy + dz * dz;
        }
        const idx = Array.from(order.slice(0, NB) as Int32Array).sort(
          (a, b) => (sortDepth[b] as number) - (sortDepth[a] as number),
        );
        const m4 = new Float32Array(16);
        const d4 = new Float32Array(4);
        const s2 = new Float32Array(2);
        const q4 = new Float32Array(4);
        const im = mesh.instanceMatrix.array as Float32Array;
        const ad = (geo.getAttribute("aData") as THREE.InstancedBufferAttribute).array as Float32Array;
        const as = (geo.getAttribute("aSize") as THREE.InstancedBufferAttribute).array as Float32Array;
        const am = (geo.getAttribute("aMisc") as THREE.InstancedBufferAttribute).array as Float32Array;
        const mCopy = new Float32Array(im.slice(0, NB * 16));
        const dCopy = new Float32Array(ad.slice(0, NB * 4));
        const sCopy = new Float32Array(as.slice(0, NB * 2));
        const qCopy = new Float32Array(am.slice(0, NB * 4));
        for (let slot = 0; slot < NB; slot++) {
          const src = idx[slot] as number;
          m4.set(mCopy.subarray(src * 16, src * 16 + 16));
          im.set(m4, slot * 16);
          d4.set(dCopy.subarray(src * 4, src * 4 + 4));
          ad.set(d4, slot * 4);
          s2.set(sCopy.subarray(src * 2, src * 2 + 2));
          as.set(s2, slot * 2);
          q4.set(qCopy.subarray(src * 4, src * 4 + 4));
          am.set(q4, slot * 4);
        }
        mesh.instanceMatrix.needsUpdate = true;
        (geo.getAttribute("aData") as THREE.InstancedBufferAttribute).needsUpdate = true;
        (geo.getAttribute("aSize") as THREE.InstancedBufferAttribute).needsUpdate = true;
        (geo.getAttribute("aMisc") as THREE.InstancedBufferAttribute).needsUpdate = true;
        // centers[] + deriva siguen el mismo orden (el medidor usa NB fijos)
        const cCopy = centers.slice(0, NB);
        const xCopy = new Float32Array(driftX.slice(0, NB));
        const vCopy = new Float32Array(driftV.slice(0, NB));
        const rCopy = new Float32Array(boardR.slice(0, NB));
        for (let slot = 0; slot < NB; slot++) {
          const src = idx[slot] as number;
          centers[slot] = cCopy[src] as THREE.Vector3;
          driftX[slot] = xCopy[src] as number;
          driftV[slot] = vCopy[src] as number;
          boardR[slot] = rCopy[src] as number;
        }
        lastSortMs = performance.now() - t0;
        (window as unknown as { __cloudSortMs?: number }).__cloudSortMs = lastSortMs;
      }
      tick++;
      if ((tick % 6) !== 1 || vw <= 0 || vh <= 0) return;
      const persp = camera as THREE.PerspectiveCamera;
      const tanHalf = Math.tan(((persp.fov ?? 50) * Math.PI) / 180 / 2);
      const amtC = uniforms.uAmtCumulus.value as number;
      const amtM = uniforms.uAmtMist.value as number;
      const amtCi = uniforms.uAmtCirrus.value as number;
      const amtF = uniforms.uAmtFar.value as number;
      const mult = uniforms.uMult.value as number;
      const me = camera.matrixWorldInverse.elements;
      const fwdX = -(me[2] as number);
      const fwdY = -(me[6] as number);
      const fwdZ = -(me[10] as number);
      let area = 0;
      for (let i = 0; i < NB; i++) {
        const c = centers[i] as THREE.Vector3;
        if (
          (c.x - camera.position.x) * fwdX +
            (c.y - camera.position.y) * fwdY +
            (c.z - camera.position.z) * fwdZ <=
          0
        ) {
          continue;
        }
        pv.copy(c).project(camera);
        if (pv.z > 1 || pv.z < -1) continue;
        const dist = camera.position.distanceTo(centers[i] as THREE.Vector3);
        if (dist <= 0) continue;
        const wPx = ((sizes[i * 2] as number) / dist) * (vh / (2 * tanHalf));
        const hPx = ((sizes[i * 2 + 1] as number) / dist) * (vh / (2 * tanHalf));
        // N2b: alfa efectivo = textura(0,45 media) × base × cantidad(familia).
        const seed = data[i * 4 + 3] as number;
        const fam = data[i * 4 + 2] as number;
        const famAmt = fam < 0.5 ? amtC * mult : fam < 1.5 ? amtM : fam < 2.5 ? amtCi : amtF * mult;
        area += wPx * hPx * 0.45 * seed * famAmt;
      }
      coverage = Math.min(1, area / (vw * vh));
    },
    getCoverage() {
      return coverage;
    },
    sortMs() {
      return lastSortMs;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      htex.dispose();
    },
  };
}

/** N2: CLOUD_ACT_MULT por defecto (todos a 1,0) — el viewer lo interpola
 * con suavizado entre actos. */
export function actMult(actIndex: number): number {
  const i = Math.min(CLOUD_ACT_MULT.length - 1, Math.max(0, actIndex));
  return CLOUD_ACT_MULT[i] as number;
}
