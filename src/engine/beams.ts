// beams.ts — §3b HITOS Everest: cilindros instanciados con estado,
// latido en el vertex, pulso al cruzar y caminante naranja.
//
// UNA InstancedMesh (un draw call): un cilindro por hito de tipo !=
// "cumbre" (Ø24 m × 420 m) + UNA instancia más para el caminante
// (Ø12 m × 260 m). Geometría unitaria (radio 1, altura 1, base en y=0);
// el tamaño viaja en instanceMatrix (posición = base, escala = radio y
// altura). El pulso reescribe la escala Y; el caminante reescribe su
// matriz cada frame (P(d) del rastro real).
//
// Textura Everest literal: canvas 16×128, degradado vertical base→punta
// (0 → rgba(255,205,140,0) · 0,06 → rgba(255,210,150,0,7) ·
// 0,35 → rgba(255,205,140,0,22) · 1 → rgba(255,205,140,0)).
// Mezcla ADITIVA (único material aditivo junto al halo E3 — regla
// AGENTS.md: prohibida en la línea del rastro). depthTest true: lo tapa
// el terreno. Sin niebla (ShaderMaterial la ignora por construcción).
//
// Estado por hito: pasado = s >= s_hito − 0,0005 (s_hito resuelto desde
// d con la única fuente progress.ts) → verde 0x9FDDAC; pendiente →
// ámbar 0xFFCD96. El estado viaja en atributo por instancia (aState);
// el viewer lo escribe SOLO al cruzar (una vez por cruce en cada
// sentido, flanco, nunca por frame).
//
// Latido en el vertex con uTime (ms): opacidad =
// (0,5 + 0,24·sin(t·0,0016 + fase)) · clamp(1,4 − dist/6000),
// fase = índice·1,7. El caminante no late (aBeat = 0). Sin CPU por
// frame salvo el pulso: +45 % de altura durante 0,7 s
// (scale.y = 1 + sin(p·π)·0,45, p de 0 a 1).
//
// La etiqueta vuelve a la BASE (punto del terreno + 2 m), como Everest;
// el haz sube por detrás. Etiqueta ocluida → opacidad del haz ×0,25.
// Cumbres: sin haz (igual). Un solo rAF: sin rAF propio.
import * as THREE from "three";
import {
  BEAM_BASE_LIFT_M,
  BEAM_DIST_FAR_M,
  BEAM_HEART_A,
  BEAM_HEART_BASE,
  BEAM_HEART_K,
  BEAM_H_M,
  BEAM_OCCLUDE,
  BEAM_PASS_EPS_S,
  BEAM_PHASE_STEP,
  BEAM_PULSE_K,
  BEAM_PULSE_MS,
  BEAM_R_M,
  BEAM_WALK_H_M,
  BEAM_WALK_R_M,
} from "../narrative/choreography.ts";
import { anchorBeam, releaseBeam, type LabelRuntime } from "./labels.ts";
import { renderCount } from "./route-line.ts";

export interface BeamDef {
  /** índice del LabelRuntime correspondiente en labelRts */
  rtIndex: number;
  /** s del hito resuelto desde d con la única fuente progress.ts */
  s: number;
}

export interface Beams {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  /** nº de haces (hitos de tipo hito; el caminante es la instancia nº n) */
  count: number;
  /** índice de la instancia del caminante (= count) */
  walkerIndex: number;
  /** Estado por flanco: escribe aState + dispara el pulso SOLO al cruzar.
   * Devuelve { passed, next } (next = -1 si todos pasados). */
  setState(sNow: number): { passed: number; next: number };
  /** oclusión (rayBlocked): el haz rinde ×0,25. Ciclo de 6 frames. */
  setOccluded(i: number, occluded: boolean): void;
  /** luz del día N1 (cloudDayF): de noche el haz sigue, más tenue. */
  setDayF(f: number): void;
  /** ancla las etiquetas a la BASE (?beams=0 las suelta). */
  setAnchored(on: boolean): void;
  /** caminante: base del cilindro en P(d) del rastro real (mundo). */
  setWalker(wx: number, wy: number, wz: number): void;
  /** G81: base del haz del caminante en el mundo (para la sonda en metros). */
  walkerBase(): { x: number; y: number; z: number };
  /** cada frame: uTime + avance de pulsos (única CPU por frame). */
  tick(): void;
  /** G74: pase de ID con su propio idMat (como G15) -> píxeles por hito
   * + caminante al final [hito0 … hitoN-1, caminante]. */
  countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number[];
  /** G79/HUD: nombre del próximo hito (null si todos pasados). */
  activeName(): string | null;
  /** nº de hitos pasados (HUD). */
  passedCount(): number;
  /** Δs al próximo hito (HUD, NaN si todos pasados). */
  nextDeltaS(sNow: number): number;
  /** HUD ?debug=1. */
  beamHud(sNow: number, walkerOk: boolean, walkerGapM?: number): string;
  debugGlows(): number[];
  /** G80: factor de latido actual por hito (0,26…0,74, periodo ≈3,9 s). */
  debugBeats(): number[];
}

/** Textura Everest literal: canvas 16×128, degradado base→punta. */
function makeBeamTexture(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = 16;
  cv.height = 128;
  const ctx = cv.getContext("2d") as CanvasRenderingContext2D;
  // Canvas: fila 0 (arriba) = punta (v=1 con flipY), fila 128 = base.
  // Gradiente de base (offset 0, abajo) a punta (offset 1, arriba).
  const g = ctx.createLinearGradient(0, 128, 0, 0);
  g.addColorStop(0, "rgba(255,205,140,0)");
  g.addColorStop(0.06, "rgba(255,210,150,0.7)");
  g.addColorStop(0.35, "rgba(255,205,140,0.22)");
  g.addColorStop(1, "rgba(255,205,140,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

export function buildBeams(
  rts: LabelRuntime[],
  defs: BeamDef[],
): Beams {
  const n = defs.length;
  const total = n + 1; // + caminante
  const W = total;
  const group = new THREE.Group();
  // Cilindro unitario: radio 1, altura 1, base en y=0, abierto.
  const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  geo.translate(0, 0.5, 0);

  const baseX = new Float64Array(total);
  const baseY = new Float64Array(total);
  const baseZ = new Float64Array(total);
  const rad = new Float64Array(total);
  const hgt = new Float64Array(total);
  const phase = new Float32Array(total);
  const state = new Float32Array(total); // 0 ámbar · 1 verde · 2 caminante
  const beat = new Float32Array(total); // 1 hitos (laten) · 0 caminante
  const dim = new Float32Array(total).fill(1);
  const passed = new Array(n).fill(false) as boolean[];
  const pulseT0 = new Float64Array(n).fill(-1); // ms del cruce, -1 = quieto
  defs.forEach((d, i) => {
    const rt = rts[d.rtIndex] as LabelRuntime;
    baseX[i] = rt.wx;
    baseY[i] = rt.groundWy + BEAM_BASE_LIFT_M;
    baseZ[i] = rt.wz;
    rad[i] = BEAM_R_M;
    hgt[i] = BEAM_H_M;
    phase[i] = i * BEAM_PHASE_STEP;
    state[i] = 0;
    beat[i] = 1;
  });
  // Caminante: se coloca con setWalker (base en P(d)); escala propia.
  {
    const i = n;
    baseX[i] = 0;
    baseY[i] = -10000;
    baseZ[i] = 0;
    rad[i] = BEAM_WALK_R_M;
    hgt[i] = BEAM_WALK_H_M;
    phase[i] = 0;
    state[i] = 2;
    beat[i] = 0;
  }
  const aPhase = new THREE.InstancedBufferAttribute(phase, 1);
  const aState = new THREE.InstancedBufferAttribute(state, 1);
  const aBeat = new THREE.InstancedBufferAttribute(beat, 1);
  const aDim = new THREE.InstancedBufferAttribute(dim, 1);
  aState.setUsage(THREE.DynamicDrawUsage);
  aDim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aPhase", aPhase);
  geo.setAttribute("aState", aState);
  geo.setAttribute("aBeat", aBeat);
  geo.setAttribute("aDim", aDim);

  const uTime = { value: performance.now() };
  const uDayF = { value: 1 };
  const uMap = { value: makeBeamTexture() };
  const mat = new THREE.ShaderMaterial({
    // AGENTS.md: todo uniforme añadido se DECLARA en el GLSL (three sube
    // material.uniforms, no los declara). uMap/uTime/uDayF viajan aquí y
    // en el header — comprobación: __programs sin ok=false.
    uniforms: { uMap, uTime, uDayF },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    // §3b: aditivo permitido SOLO en haces (+ halo E3); prohibido en la
    // línea del rastro (regla AGENTS.md).
    blending: THREE.AdditiveBlending,
    vertexShader: `
      uniform float uTime;
      attribute float aPhase; attribute float aState; attribute float aBeat; attribute float aDim;
      varying vec2 vUv; varying float vAlpha; varying vec3 vColor;
      void main(){
        vUv = uv;
        vec4 wp4 = instanceMatrix * vec4(position, 1.0);
        vec3 wp = wp4.xyz;
        float dist = distance(cameraPosition, wp);
        float fade = clamp(1.4 - dist / ${BEAM_DIST_FAR_M.toFixed(1)}, 0.0, 1.0);
        float heart = ${BEAM_HEART_BASE.toFixed(2)} + ${BEAM_HEART_A.toFixed(2)} * sin(uTime * ${BEAM_HEART_K.toFixed(4)} + aPhase);
        float b = mix(1.0, heart, aBeat);
        vAlpha = b * fade * aDim;
        vec3 amber = vec3(1.0, 0.8039, 0.5882);
        vec3 green = vec3(0.6235, 0.8667, 0.6745);
        vec3 orange = vec3(1.0, 0.6392, 0.4000);
        vColor = aState < 0.5 ? amber : (aState < 1.5 ? green : orange);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D uMap; uniform float uDayF;
      varying vec2 vUv; varying float vAlpha; varying vec3 vColor;
      void main(){
        vec4 tex = texture2D(uMap, vUv);
        float a = tex.a * vAlpha;
        if (a < 0.004) discard;
        // Luz del día N1: P = 0.16+0.84·dayF (misma regla que las nubes).
        float P = 0.16 + 0.84 * uDayF;
        vec3 col = vColor * P;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, W));
  mesh.frustumCulled = false;
  mesh.renderOrder = 7; // tras el rastro (4-6), antes de las nubes (10)

  function writeMatrix(i: number, syScale: number): void {
    _p.set(baseX[i] as number, baseY[i] as number, baseZ[i] as number);
    _s.set(rad[i] as number, (hgt[i] as number) * syScale, rad[i] as number);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    idMesh.setMatrixAt(i, _m);
  }
  // ID pass: MISMA geometría cilíndrica instanciada, material plano por
  // hito (color = id codificado en R). Escena propia con solo lo que
  // necesita (regla AGENTS.md: ningún render a target usa la principal).
  const idGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  idGeo.translate(0, 0.5, 0);
  const idIdx = new Float32Array(Math.max(1, W));
  for (let i = 0; i < W; i++) idIdx[i] = i + 1;
  idGeo.setAttribute("aId", new THREE.InstancedBufferAttribute(idIdx, 1));
  const idMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aId;
      varying float vId;
      void main(){
        vId = aId;
        vec4 wp4 = instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp4;
      }`,
    fragmentShader: `
      varying float vId;
      void main(){ gl_FragColor = vec4(vId / 255.0, 0.0, 0.0, 1.0); }`,
  });
  const idMesh = new THREE.InstancedMesh(idGeo, idMat, Math.max(1, W));
  idMesh.frustumCulled = false;
  for (let i = 0; i < W; i++) writeMatrix(i, 1);
  mesh.instanceMatrix.needsUpdate = true;
  idMesh.instanceMatrix.needsUpdate = true;
  mesh.count = W;
  idMesh.count = W;
  group.add(mesh);
  const idScene = new THREE.Scene();
  idScene.add(idMesh);
  const idTarget = new THREE.WebGLRenderTarget(256, 144, { depthBuffer: true });
  const idBuf = new Uint8Array(256 * 144 * 4);

  let anchored = true;

  function baseWy(i: number): number {
    return baseY[i] as number;
  }

  function beatNow(i: number, tMs: number): number {
    return BEAM_HEART_BASE + BEAM_HEART_A * Math.sin(tMs * BEAM_HEART_K + (phase[i] as number));
  }

  return {
    group,
    mesh,
    count: n,
    walkerIndex: n,
    setState(sNow: number): { passed: number; next: number } {
      let k = 0;
      let next = -1;
      let dirty = false;
      const tMs = performance.now();
      defs.forEach((d, i) => {
        const isPassed = sNow >= d.s - BEAM_PASS_EPS_S;
        if (isPassed) k++;
        else if (next < 0) next = i;
        if (isPassed !== passed[i]) {
          passed[i] = isPassed;
          (geo.getAttribute("aState") as THREE.InstancedBufferAttribute).array[i] = isPassed ? 1 : 0;
          dirty = true;
          // Pulso: +45 % de altura durante 0,7 s, UNA vez por cruce.
          pulseT0[i] = tMs;
        }
      });
      if (dirty) (geo.getAttribute("aState") as THREE.InstancedBufferAttribute).needsUpdate = true;
      return { passed: k, next };
    },
    setOccluded(i: number, occluded: boolean): void {
      if (i < 0 || i >= n) return;
      const v = occluded ? BEAM_OCCLUDE : 1;
      if ((geo.getAttribute("aDim") as THREE.InstancedBufferAttribute).array[i] !== v) {
        (geo.getAttribute("aDim") as THREE.InstancedBufferAttribute).array[i] = v;
        (geo.getAttribute("aDim") as THREE.InstancedBufferAttribute).needsUpdate = true;
      }
    },
    setDayF(f: number): void {
      uDayF.value = f;
    },
    setAnchored(on: boolean): void {
      anchored = on;
      defs.forEach((d, i) => {
        const rt = rts[d.rtIndex] as LabelRuntime;
        if (on) anchorBeam(rt, baseWy(i));
        else releaseBeam(rt);
      });
    },
    setWalker(wx: number, wy: number, wz: number): void {
      const i = n;
      baseX[i] = wx;
      baseY[i] = wy;
      baseZ[i] = wz;
      writeMatrix(i, 1);
      mesh.instanceMatrix.needsUpdate = true;
      idMesh.instanceMatrix.needsUpdate = true;
    },
    walkerBase(): { x: number; y: number; z: number } {
      return { x: baseX[n] as number, y: baseY[n] as number, z: baseZ[n] as number };
    },
    tick(): void {
      const tMs = performance.now();
      uTime.value = tMs;
      // Pulsos activos: única CPU por frame (reescribe escala Y).
      let moved = false;
      for (let i = 0; i < n; i++) {
        const t0 = pulseT0[i] as number;
        if (t0 < 0) continue;
        const p = (tMs - t0) / BEAM_PULSE_MS;
        if (p >= 1) {
          pulseT0[i] = -1;
          writeMatrix(i, 1);
          moved = true;
        } else {
          writeMatrix(i, 1 + Math.sin(p * Math.PI) * BEAM_PULSE_K);
          moved = true;
        }
      }
      if (moved) {
        mesh.instanceMatrix.needsUpdate = true;
        idMesh.instanceMatrix.needsUpdate = true;
      }
      // G80: latido numérico para la auditoría (solo informa, no gobierna).
      (window as unknown as { __beamBeat?: number[] }).__beamBeat = defs.map((_, i) => beatNow(i, tMs));
    },
    countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number[] {
      const out = new Array(W).fill(0) as number[];
      if (W === 0) return out;
      renderCount(renderer, idTarget, idBuf, idScene, camera, 256, 144, () => true);
      for (let p = 0; p < 256 * 144; p++) {
        const r = idBuf[p * 4] as number;
        const id = Math.round((r / 255) * 255);
        if (id >= 1 && id <= W) (out[(id - 1) as number] as number)++;
      }
      return out;
    },
    activeName(): string | null {
      for (let i = 0; i < n; i++) {
        if (!passed[i]) return (rts[(defs[i] as BeamDef).rtIndex] as LabelRuntime).def.nombre;
      }
      return null;
    },
    passedCount(): number {
      let k = 0;
      for (let i = 0; i < n; i++) if (passed[i]) k++;
      return k;
    },
    nextDeltaS(sNow: number): number {
      for (let i = 0; i < n; i++) {
        if (!passed[i]) return (defs[i] as BeamDef).s - sNow;
      }
      return NaN;
    },
    beamHud(sNow: number, walkerOk: boolean, walkerGapM?: number): string {
      let k = 0;
      let nx: BeamDef | null = null;
      for (let i = 0; i < n; i++) {
        if (passed[i]) k++;
        else if (!nx) nx = defs[i] as BeamDef;
      }
      const nextTxt = nx
        ? `próximo ${(rts[(nx as BeamDef).rtIndex] as LabelRuntime).def.nombre ?? "—"} Δs=${((nx as BeamDef).s - sNow).toFixed(3)}`
        : "próximo —";
      void anchored;
      const gapTxt = walkerGapM !== undefined && Number.isFinite(walkerGapM) ? ` (gap ${walkerGapM.toFixed(1)} m)` : "";
      return `haces ${n} · pasados ${k} · ${nextTxt} · caminante P(d) ${walkerOk ? "ok" : "—"}${gapTxt}`;
    },
    debugGlows(): number[] {
      return defs.map((_, i) => (passed[i] ? 1 : 0));
    },
    debugBeats(): number[] {
      const tMs = performance.now();
      return defs.map((_, i) => beatNow(i, tMs));
    },
  };
}
