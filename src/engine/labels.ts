// labels.ts — D7: hand-projected divs. translate3d with UNROUNDED pixels +
// write-if-unchanged (T2: left/top + Math.round jitter a whole pixel per
// frame while scrolling); CPU ray-march occlusion over the decoded
// heightmap; nearest-first overlap culling. No throttle: js etiq is
// 0.0-0.2 ms, there is nothing to save by updating every 2-3 frames.
import * as THREE from "three";

export interface LabelDef {
  id: string;
  tipo: "cumbre" | "hito";
  x: number;
  y: number;
  z: number;
  /** Path distance in metres (hitos only) — drives the active beam. */
  d?: number;
  nombre: string | null;
  fuente: string;
}

export interface LabelRuntime {
  def: LabelDef;
  el: HTMLElement;
  wx: number;
  wy: number;
  wz: number;
  lastX: number;
  lastY: number;
  lastOpacity: string;
  lastHidden: boolean;
  lastActive: boolean;
  occluded: boolean;
}

export function buildLabels(
  defs: LabelDef[],
  cx: number,
  cy: number,
  container: HTMLElement,
  /** §3: hito labels hang from the beam tip (z + beamTipM), not the ground. */
  beamTipM = 0,
): LabelRuntime[] {
  return defs
    .filter((d) => d.nombre)
    .map((def) => {
      const el = document.createElement("div");
      el.className = def.tipo === "cumbre" ? "lbl lbl-peak" : "lbl lbl-hito";
      const nm = document.createElement("span");
      nm.className = "lbl-name";
      nm.textContent = def.nombre as string;
      const z = document.createElement("span");
      z.className = "lbl-z";
      z.textContent = `${Math.round(def.z).toLocaleString("es-ES")} m`;
      el.append(nm, document.createTextNode(" · "), z);
      container.appendChild(el);
      const tipZ = def.tipo === "hito" ? def.z + beamTipM : def.z;
      return {
        def,
        el,
        wx: def.x - cx,
        wy: tipZ,
        wz: -(def.y - cy),
        lastX: -1,
        lastY: -1,
        lastOpacity: "",
        lastHidden: false,
        lastActive: false,
        occluded: false,
      };
    });
}

/** March camera→label over the heightmap grid; true = terrain blocks view. */
export function rayBlocked(
  elev: Float32Array,
  meta: { width: number; height: number; resX: number; resY: number; originX: number; originY: number },
  cx: number,
  cy: number,
  camWx: number,
  camWy: number,
  camWz: number,
  rt: LabelRuntime,
): boolean {
  // world → epsg
  const tx = rt.wx + cx;
  const ty = cy - rt.wz;
  const ox = camWx + cx;
  const oy = cy - camWz;
  const oz = camWy;
  const tz = rt.wy;
  const dist = Math.hypot(tx - ox, ty - oy);
  const steps = Math.min(200, Math.max(8, Math.floor(dist / 40)));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = ox + (tx - ox) * f;
    const y = oy + (ty - oy) * f;
    const z = oz + (tz - oz) * f;
    const col = (x - meta.originX) / meta.resX - 0.5;
    const row = (meta.originY - y) / meta.resY - 0.5;
    const c0 = Math.max(0, Math.min(meta.width - 2, Math.floor(col)));
    const r0 = Math.max(0, Math.min(meta.height - 2, Math.floor(row)));
    const a = elev[r0 * meta.width + c0] as number;
    if (a > z + 4) return true;
  }
  return false;
}

const _ndc = new THREE.Vector3();

export function updateLabels(
  rts: LabelRuntime[],
  camera: THREE.Camera,
  w: number,
  h: number,
  maxDist: number,
  /** §3: active hito id paints with .lbl-active (full emphasis). */
  activeId: string | null = null,
): void {
  // project all (S4: NDC and world position need SEPARATE vectors — the old
  // code overwrote _v with the world pos and read .x/.y as if they were NDC,
  // sending every label to absurd coordinates)
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const wp = new THREE.Vector3();
  const order = rts
    .map((rt) => {
      _ndc.set(rt.wx, rt.wy, rt.wz).project(camera);
      wp.set(rt.wx, rt.wy, rt.wz).applyMatrix4(camera.matrixWorldInverse);
      const behind = wp.z > -1;
      const dist = Math.hypot(rt.wx - camera.position.x, rt.wy - camera.position.y, rt.wz - camera.position.z);
      return { rt, behind, dist, nx: _ndc.x, ny: _ndc.y };
    })
    .sort((a, b) => a.dist - b.dist);
  for (const o of order) {
    const { rt } = o;
    let hidden = o.behind || o.dist > maxDist;
    let px = 0;
    let py = 0;
    if (!hidden) {
      // T2: NO Math.round — sub-pixel translate3d, snapped only for the
      // overlap test and the change check (0.01 px epsilon).
      px = (o.nx * 0.5 + 0.5) * w;
      py = (-o.ny * 0.5 + 0.5) * h;
      if (px < -100 || px > w + 100 || py < -40 || py > h + 40) hidden = true;
    }
    // overlap cull vs already-placed nearer labels
    if (!hidden) {
      const bw = rt.def.tipo === "cumbre" ? 170 : 220;
      const bh = 34;
      for (const p of placed) {
        if (Math.abs(px - p.x) < (bw + p.w) / 2 && Math.abs(py - p.y) < (bh + p.h) / 2) {
          hidden = true;
          break;
        }
      }
      if (!hidden) placed.push({ x: px, y: py, w: bw, h: bh });
    }
    if (hidden !== rt.lastHidden) {
      rt.lastHidden = hidden;
      rt.el.style.display = hidden ? "none" : "block";
    }
    if (hidden) continue;
    const op = rt.occluded ? "0.25" : "1";
    // §3: active hito emphasis (class swap, write-if-changed like the rest).
    const isActive = activeId !== null && rt.def.id === activeId;
    if (isActive !== rt.lastActive) {
      rt.lastActive = isActive;
      rt.el.classList.toggle("lbl-active", isActive);
    }
    // T2: compare with epsilon; write unrounded values into the transform.
    if (Math.abs(px - rt.lastX) > 0.01 || Math.abs(py - rt.lastY) > 0.01) {
      rt.lastX = px;
      rt.lastY = py;
      rt.el.style.transform = `translate3d(${px}px,${py}px,0) translate(-50%,-100%)`;
    }
    if (op !== rt.lastOpacity) {
      rt.lastOpacity = op;
      rt.el.style.opacity = op;
    }
  }
}
