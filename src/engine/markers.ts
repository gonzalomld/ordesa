// markers.ts — §M1 fase 1: marcadores de foto (la chapa). Hermanos de
// labels.ts, no dentro: mismo patrón (divs proyectados a mano, translate3d sin
// redondear, escritura solo si cambia), módulo aparte. SOLO DOM + SVG inline:
// cero texturas, cero materiales, cero geometrías. La oclusión REUTILIZA
// rayBlocked de labels.ts (una sola implementación de trazado de rayos).
import { Vector3 } from "three";
import { placedBoxes, rayBlocked, type LabelRuntime, type PlacedBox } from "./labels.ts";

export interface MarkerEncuadre {
  sujeto: string;
  az: number;
  el: number;
  km: number;
  fov: number;
}

export interface MarkerDef {
  id: string;
  nombre: string;
  km: number;
  x: number;
  y: number;
  z: number;
  encuadre: MarkerEncuadre;
}

/** Cámara vista estructuralmente: markers.ts no importa three salvo Vector3. */
export interface CameraLike {
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
  getWorldDirection(target: Vector3): Vector3;
  matrixWorld: { elements: ArrayLike<number> };
  matrixWorldInverse: { elements: ArrayLike<number> };
  projectionMatrix: { elements: ArrayLike<number> };
  position: { x: number; y: number; z: number };
}

export interface RayMeta {
  width: number;
  height: number;
  resX: number;
  resY: number;
  originX: number;
  originY: number;
}

export interface MarkerRuntime {
  def: MarkerDef;
  el: HTMLElement;
  hitEl: HTMLElement;
  discEl: HTMLElement;
  sectorEl: SVGPathElement;
  needleEl: SVGLineElement;
  wx: number;
  wy: number;
  wz: number;
  lastX: number;
  lastY: number;
  lastOpacity: string;
  lastHidden: boolean;
  lastDiam: number;
  lastRel: number;
  lastSimple: boolean;
  lastExtra: number;
  occluded: boolean;
}

// --- §5 escalera de distancia (metros) ---
const NEAR_M = 150;
const FAR_M = 4000;
const HIDE_M = 6000;
const SIMPLE_M = 2500;
const NEAR_DIAM = 44;
const FAR_DIAM = 20;
const NEAR_OP = 1;
const FAR_OP = 0.55;

// --- dial (viewBox 0 0 40 40, centro 20,20) ---
const DIAL_R = 15;
const NEEDLE_R = 14.7;
const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------
// §3 LA GEOMETRÍA DEL RUMBO — funciones PURAS exportadas
// Norte = -z, Este = +x. 0° arriba, sentido horario.
// ---------------------------------------------------------------------------

/** Rumbo 0..360 desde el norte a partir del desplazamiento (dx,dz) en mundo. */
export function rumboA(dx: number, dz: number): number {
  return (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
}

/** Rumbo 0..360 de la dirección de vista de la cámara. La cámara de three
 * mira por su −Z: getWorldDirection ya devuelve (−col8,−col9,−col10). Leer la
 * columna +Z sin negar daba el rumbo de la nuca (180° desviado). */
const _fwd = new Vector3();
export function rumboCamara(camera: CameraLike): number {
  const f = camera.getWorldDirection(_fwd);
  return rumboA(f.x, f.z);
}

/** Ángulo relativo -180..180 del sujeto respecto al rumbo de la cámara. */
export function anguloRelativo(azSujeto: number, rumboCam: number): number {
  return ((azSujeto - rumboCam + 540) % 360) - 180;
}

/** Bordes angulares del sector de encuadre (0° arriba, horario). */
export function sectorEdges(rel: number, fov: number): [number, number] {
  return [rel - fov / 2, rel + fov / 2];
}

/** Punto del dial para `deg` y radio r (0° arriba, horario). Pura. */
export function polar(deg: number, r: number): { x: number; y: number } {
  const rad = deg * Math.PI / 180;
  return { x: 20 + r * Math.sin(rad), y: 20 - r * Math.cos(rad) };
}

/** Diámetro del disco en px: 44 (d<=150) → 20 (d>=4000), acotado. */
export function diametroMarcador(d: number): number {
  if (d <= NEAR_M) return NEAR_DIAM;
  if (d >= FAR_M) return FAR_DIAM;
  const t = (d - NEAR_M) / (FAR_M - NEAR_M);
  return NEAR_DIAM + (FAR_DIAM - NEAR_DIAM) * t;
}

/** Opacidad: 1 (d<=150) → 0,55 (d>=4000), acotada. */
export function opacidadMarcador(d: number): number {
  if (d <= NEAR_M) return NEAR_OP;
  if (d >= FAR_M) return FAR_OP;
  const t = (d - NEAR_M) / (FAR_M - NEAR_M);
  return NEAR_OP + (FAR_OP - NEAR_OP) * t;
}

/** Dial simplificado (solo circunferencia + punto central) a partir de 2500 m. */
export function dialSimplificado(d: number): boolean {
  return d >= SIMPLE_M;
}

/** Caja en pantalla: esquina superior izquierda (x,y) + tamaño (w,h), CSS px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CLEAR_MARGIN = 6;
const STEM_EXTRA_MAX = 48;

/** §M1-bis D.2 — altura mínima de vástago que deja el disco 6 px por encima de
 * la caja que estorba, acotada a base+48. Sin corte devuelve `base`. Pura. */
export function alturaVastago(base: number, cajaDisco: Box, cajas: Box[]): number {
  const discBottom = cajaDisco.y + cajaDisco.h;
  const discCx = cajaDisco.x + cajaDisco.w / 2;
  let extra = 0;
  for (const caja of cajas) {
    if (Math.abs(discCx - (caja.x + caja.w / 2)) >= (cajaDisco.w + caja.w) / 2) continue;
    const need = discBottom - caja.y + CLEAR_MARGIN;
    if (need > extra) extra = need;
  }
  if (extra <= 0) return base;
  return base + Math.min(STEM_EXTRA_MAX, extra);
}

// ---------------------------------------------------------------------------
// §7 intro — mismo contrato que labels.ts
// ---------------------------------------------------------------------------
let introHidden = false;
const liveRts: MarkerRuntime[] = [];
/** §M1-bis D.3: etiquetas cedidas al marcador en el último update. */
let suppressedLabels = new Set<HTMLElement>();
export function setMarkersHidden(on: boolean): void {
  introHidden = on;
  // Invalidar el cache de opacidad para que el próximo update reescriba.
  for (const rt of liveRts) rt.lastOpacity = "";
}

function svg(tag: string): SVGElement {
  return document.createElementNS(SVG_NS, tag);
}

/** §4 la chapa completa: anclaje + vástago + disco + dial. */
export function buildMarkers(
  defs: MarkerDef[],
  cx: number,
  cy: number,
  container: HTMLElement,
): MarkerRuntime[] {
  const rts = defs.map((def) => {
    const el = document.createElement("div");
    el.className = "marker";
    el.dataset.id = def.id;
    // Nace oculto si la intro está armada (igual que buildLabels).
    if (introHidden) el.style.opacity = "0";

    const anchor = document.createElement("div");
    anchor.className = "marker-anchor";

    const stem = document.createElement("div");
    stem.className = "marker-stem";

    // Área de toque 44×44, SIEMPRE 44 aunque el disco mida 20 (móvil).
    const hit = document.createElement("div");
    hit.className = "marker-hit";

    const disc = document.createElement("div");
    disc.className = "marker-disc";

    const s = svg("svg") as SVGSVGElement;
    s.setAttribute("viewBox", "0 0 40 40");
    s.setAttribute("class", "marker-dial");
    const ring = svg("circle");
    ring.setAttribute("cx", "20");
    ring.setAttribute("cy", "20");
    ring.setAttribute("r", String(DIAL_R));
    ring.setAttribute("class", "marker-ring");
    const sector = svg("path") as SVGPathElement;
    sector.setAttribute("class", "marker-sector");
    const needle = svg("line") as SVGLineElement;
    needle.setAttribute("class", "marker-needle");
    needle.setAttribute("x1", "20");
    needle.setAttribute("y1", "20");
    const north = svg("line");
    north.setAttribute("class", "marker-north");
    north.setAttribute("x1", "20");
    north.setAttribute("y1", "2.5");
    north.setAttribute("x2", "20");
    north.setAttribute("y2", "5.5");
    const center = svg("circle");
    center.setAttribute("cx", "20");
    center.setAttribute("cy", "20");
    center.setAttribute("r", "1.5");
    center.setAttribute("class", "marker-center");
    s.append(ring, sector, needle, north, center);
    disc.appendChild(s);

    // Orden DOM: hit ANTES del disco (el hermano ~ permite :hover/:active).
    el.append(hit, anchor, stem, disc);

    // §8 el clic — emite UNA vez y no mueve el scroll.
    const id = def.id;
    let lastTouch = 0;
    const emit = (): void => {
      window.dispatchEvent(new CustomEvent("marcador:abrir", { detail: { id } }));
    };
    const press = (): void => el.classList.add("is-pressed");
    const release = (): void => el.classList.remove("is-pressed");
    hit.addEventListener("pointerdown", press);
    hit.addEventListener("pointerup", release);
    hit.addEventListener("pointercancel", release);
    hit.addEventListener("pointerleave", release);
    hit.addEventListener(
      "touchstart",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        lastTouch = performance.now();
        press();
      },
      { passive: false },
    );
    hit.addEventListener("touchend", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      release();
      emit();
    });
    hit.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (performance.now() - lastTouch < 600) return;
      emit();
    });

    container.appendChild(el);
    return {
      def,
      el,
      hitEl: hit,
      discEl: disc,
      sectorEl: sector,
      needleEl: needle,
      // Conversión a mundo IDÉNTICA a buildLabels.
      wx: def.x - cx,
      wy: def.z,
      wz: -(def.y - cy),
      lastX: -1,
      lastY: -1,
      lastOpacity: introHidden ? "0" : "",
      lastHidden: false,
      lastDiam: -1,
      lastRel: NaN,
      lastSimple: false,
      lastExtra: -1,
      occluded: false,
    };
  });
  liveRts.length = 0;
  liveRts.push(...rts);
  return rts;
}

function project(
  x: number,
  y: number,
  z: number,
  view: ArrayLike<number>,
  proj: ArrayLike<number>,
  out: { x: number; y: number; z: number; viewZ: number },
): void {
  const vx = (view[0] as number) * x + (view[4] as number) * y + (view[8] as number) * z + (view[12] as number);
  const vy = (view[1] as number) * x + (view[5] as number) * y + (view[9] as number) * z + (view[13] as number);
  const vz = (view[2] as number) * x + (view[6] as number) * y + (view[10] as number) * z + (view[14] as number);
  const cw = (proj[3] as number) * vx + (proj[7] as number) * vy + (proj[11] as number) * vz + (proj[15] as number);
  const iw = cw !== 0 ? 1 / cw : 0;
  out.x = ((proj[0] as number) * vx + (proj[4] as number) * vy + (proj[8] as number) * vz + (proj[12] as number)) * iw;
  out.y = ((proj[1] as number) * vx + (proj[5] as number) * vy + (proj[9] as number) * vz + (proj[13] as number)) * iw;
  out.z = ((proj[2] as number) * vx + (proj[6] as number) * vy + (proj[10] as number) * vz + (proj[14] as number)) * iw;
  out.viewZ = vz;
}

const _out = { x: 0, y: 0, z: 0, viewZ: 0 };

function updateDial(rt: MarkerRuntime, rel: number, fov: number): void {
  const [a0, a1] = sectorEdges(rel, fov);
  const p0 = polar(a0, DIAL_R);
  const p1 = polar(a1, DIAL_R);
  const large = (((a1 - a0) % 360) + 360) % 360 > 180 ? 1 : 0;
  rt.sectorEl.setAttribute(
    "d",
    `M20 20 L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${DIAL_R} ${DIAL_R} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`,
  );
  const n = polar(rel, NEEDLE_R);
  rt.needleEl.setAttribute("x2", n.x.toFixed(2));
  rt.needleEl.setAttribute("y2", n.y.toFixed(2));
}

export function updateMarkers(
  rts: MarkerRuntime[],
  camera: CameraLike,
  w: number,
  h: number,
): void {
  const view = camera.matrixWorldInverse.elements;
  const proj = camera.projectionMatrix.elements;
  const rumboCam = rumboCamara(camera);
  const cpx = camera.position.x;
  const cpy = camera.position.y;
  const cpz = camera.position.z;
  const cajas: PlacedBox[] = placedBoxes();
  const stillSuppressed = new Set<HTMLElement>();
  for (const rt of rts) {
    const dist = Math.hypot(rt.wx - cpx, rt.wy - cpy, rt.wz - cpz);
    let hidden = dist > HIDE_M;
    let px = 0;
    let py = 0;
    if (!hidden) {
      project(rt.wx, rt.wy, rt.wz, view, proj, _out);
      if (_out.viewZ > -1) {
        hidden = true;
      } else {
        px = (_out.x * 0.5 + 0.5) * w;
        py = (-_out.y * 0.5 + 0.5) * h;
        if (px < -40 || px > w + 40 || py < -40 || py > h + 40) hidden = true;
      }
    }
    // §6 oclusión: tapado por el terreno = oculto.
    if (!hidden && rt.occluded) hidden = true;
    if (hidden !== rt.lastHidden) {
      rt.lastHidden = hidden;
      rt.el.style.display = hidden ? "none" : "block";
    }
    if (hidden) continue;
    const diam = diametroMarcador(dist);
    if (diam !== rt.lastDiam) {
      rt.lastDiam = diam;
      rt.el.style.setProperty("--md", `${diam}px`);
    }
    const op = introHidden ? "0" : String(opacidadMarcador(dist));
    if (op !== rt.lastOpacity) {
      rt.lastOpacity = op;
      rt.el.style.opacity = op;
    }
    // T2: sub-píxel, sin Math.round; escribe solo si cambia (epsilon).
    if (Math.abs(px - rt.lastX) > 0.01 || Math.abs(py - rt.lastY) > 0.01) {
      rt.lastX = px;
      rt.lastY = py;
      rt.el.style.transform = `translate3d(${px}px,${py}px,0) translate(-50%,-100%)`;
    }
    // §M1-bis D.2: el vástago crece lo justo para que el disco despeje las
    // etiquetas de hito (mismo punto del mundo en 3 de los 8 marcadores).
    const baseStem = diam * 0.62;
    const discTop = py - baseStem - diam;
    const stemH = cajas.length
      ? alturaVastago(baseStem, { x: px - diam / 2, y: discTop, w: diam, h: diam }, cajas)
      : baseStem;
    const extra = stemH - baseStem;
    if (extra !== rt.lastExtra) {
      rt.lastExtra = extra;
      rt.el.style.setProperty("--stem-extra", `${extra}px`);
    }
    // D.3: si aun con el tope sigue cortando, gana el marcador — la etiqueta
    // cede (target de clic perdido = marcador inutilizable).
    const grownTop = py - stemH - diam;
    const gx0 = px - diam / 2;
    const gx1 = gx0 + diam;
    const gy1 = grownTop + diam;
    for (const caja of cajas) {
      if (gx0 < caja.x + caja.w && gx1 > caja.x && grownTop < caja.y + caja.h && gy1 > caja.y) {
        stillSuppressed.add(caja.el);
      }
    }
    const simple = dialSimplificado(dist);
    if (simple !== rt.lastSimple) {
      rt.lastSimple = simple;
      rt.lastRel = NaN; // E: fuerza redibujo al volver el dial completo
      rt.sectorEl.style.display = simple ? "none" : "";
      rt.needleEl.style.display = simple ? "none" : "";
    }
    if (!simple) {
      const rel = anguloRelativo(rt.def.encuadre.az, rumboCam);
      if (rel !== rt.lastRel) {
        rt.lastRel = rel;
        updateDial(rt, rel, rt.def.encuadre.fov);
      }
    }
  }
  // D.3: restituir las etiquetas que ya no cede ningún marcador.
  for (const el2 of suppressedLabels) if (!stillSuppressed.has(el2)) el2.classList.remove("lbl-marker-hidden");
  for (const el2 of stillSuppressed) el2.classList.add("lbl-marker-hidden");
  suppressedLabels = stillSuppressed;
}

/** §6 oclusión reutilizando rayBlocked de labels.ts, misma cadencia (6 frames). */
export function occludeMarkers(
  rts: MarkerRuntime[],
  camera: CameraLike,
  elev: Float32Array,
  meta: RayMeta,
  cx: number,
  cy: number,
): void {
  for (const rt of rts) {
    rt.occluded = rayBlocked(
      elev,
      meta,
      cx,
      cy,
      camera.position.x,
      camera.position.y,
      camera.position.z,
      rt as unknown as LabelRuntime,
    );
  }
}
