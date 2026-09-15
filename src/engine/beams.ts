// beams.ts — §3: vertical milestone shafts on hito labels.
// One LineSegments2 with N loose segments (base z_ground -> tip
// z_ground + BEAM_H); the label hangs from the tip, like the reference.
// Rule: field `tipo === "hito"`, not the brief's name list — Monte Perdido
// and Tozal are `cumbre` and carry no beam. Uniform 0.7 opacity in §3 (no
// per-vertex alpha on LineMaterial); the base->tip fade lands with the §2
// bloom. The active (nearest-to-walker) hito reads opacity 1 + BEAM_H x1.3.
import * as THREE from "three";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { BEAM_ACTIVE_MULT, BEAM_H } from "../narrative/choreography.ts";
import { epsgToWorld, type World } from "./terrain.ts";
import type { LabelDef } from "./labels.ts";

export interface Beams {
  group: THREE.Group;
  /** Nearest hito to dM goes full opacity + taller; the rest stay dim. */
  setActive(dM: number): void;
  /** Currently active hito id (labels paint it with .lbl-active). */
  activeId(): string | null;
  setResolution(v: THREE.Vector2): void;
  dispose(): void;
}

export function buildBeams(defs: LabelDef[], world: World, resolution: THREE.Vector2): Beams {
  const group = new THREE.Group();
  const hitos = defs.filter((d) => d.tipo === "hito" && d.nombre && Number.isFinite(d.z));
  const mat = new LineMaterial({
    color: 0xf2e8d0,
    linewidth: 1.5,
    worldUnits: false,
    alphaToCoverage: false,
    transparent: true,
    opacity: 0.7,
    depthTest: true,
    depthWrite: false,
  });
  mat.resolution.copy(resolution);
  const geo = new LineSegmentsGeometry();
  // base positions (inactive height); setActive rewrites the active pair.
  // epsgToWorld maps (x, y, z) EPSG metres to world; the shaft is vertical
  // so both ends share plan and differ only in height.
  const base = (d: LabelDef, h: number): [number, number, number][] => {
    const [wx0, wy0, wz0] = epsgToWorld(d.x, d.y, d.z, world);
    const [, wy1] = epsgToWorld(d.x, d.y, d.z + h, world);
    return [[wx0, wy0, wz0], [wx0, wy1, wz0]];
  };
  const segs: number[] = [];
  for (const d of hitos) {
    const [b, t] = base(d, BEAM_H);
    segs.push(b[0], b[1], b[2], t[0], t[1], t[2]);
  }
  geo.setPositions(segs);
  const lines = new LineSegments2(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 7;
  group.add(lines);
  let active: string | null = null;
  return {
    group,
    setActive(dM: number) {
      let best: LabelDef | null = null;
      let bestDist = Infinity;
      for (const d of hitos) {
        const dd = Math.abs((d.d ?? Infinity) - dM);
        if (dd < bestDist) {
          bestDist = dd;
          best = d;
        }
      }
      const id = best?.id ?? null;
      if (id === active) return;
      active = id;
      // rewrite positions: active hito taller x1.3, rest at BEAM_H.
      const next: number[] = [];
      for (const d of hitos) {
        const h = d.id === active ? BEAM_H * BEAM_ACTIVE_MULT : BEAM_H;
        const [b, t] = base(d, h);
        next.push(b[0], b[1], b[2], t[0], t[1], t[2]);
      }
      geo.setPositions(next);
      mat.opacity = 0.7;
    },
    activeId() {
      return active;
    },
    setResolution(v: THREE.Vector2) {
      mat.resolution.copy(v);
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
