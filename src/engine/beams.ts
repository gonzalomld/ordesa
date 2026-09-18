// beams.ts — §3 HITOS: haces verticales en los hitos (Everest reference).
// UNA InstancedMesh (un draw call) de quads verticales, uno por hito de
// tipo != "cumbre". Billboard cilíndrico: el quad gira solo sobre Y para
// mirar a la cámara (right = normalize(cross(up, camPos - base))).
// Base = punto del terreno + BEAM_BASE_LIFT_M; altura BEAM_H_M; anchura
// BEAM_W_M (todo en choreography.ts). La etiqueta cuelga de la punta
// (labels.ts anchorBeam). Sin aditivo: NormalBlending premultiplicado
// (misma regla que el rastro §1 cinta). depthTest true: lo tapa el terreno.
// labels.ts anchorBeam/releaseBeam/tipWy. Sin cámara, scroll ni panel:
// uGlow/intensidad la escribe el viewer cada 6 frames junto a rayBlocked.
import * as THREE from "three";
import {
  BEAM_BASE_LIFT_M,
  BEAM_COLOR,
  BEAM_DIM,
  BEAM_EPI,
  BEAM_H_M,
  BEAM_OCCLUDE,
  BEAM_W_M,
} from "../narrative/choreography.ts";
import { anchorBeam, releaseBeam, type LabelRuntime } from "./labels.ts";
import { renderCount } from "./route-line.ts";

export interface BeamDef {
  /** índice del LabelRuntime correspondiente en labelRts */
  rtIndex: number;
  /** s del hito para uGlow (A3/A7/A8 = 0.3/0.745/0.86; hitos sin s propio
   * lo heredan del más cercano — Pradera 0, Cola = A7). */
  s: number;
}

export interface Beams {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  /** nº de haces (hitos de tipo hito) */
  count: number;
  /** por instancia: intensidad subida (mix(DIM,1,uGlow) [×OCCLUDE] [EPI]).
   * El viewer la escribe cada 6 frames junto al ciclo de rayBlocked. */
  setGlow(i: number, g01: number, occluded: boolean, epilogue: boolean): void;
  /** luz del día N1 (cloudDayF): de noche el haz sigue, más tenue. */
  setDayF(f: number): void;
  /** ancla las etiquetas a la punta (?beams=0 las suelta). */
  setAnchored(on: boolean): void;
  /** G74: pase de ID con su propio idMat (como G15) -> píxeles por hito. */
  countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number[];
  /** G74/HUD: nombre del hito con más glow (activo). */
  activeName(): string | null;
  /** G74/HUD: glow máximo actual. */
  maxGlow(): number;
  debugGlows(): number[];
}

const _v = new THREE.Vector3();

export function buildBeams(
  rts: LabelRuntime[],
  defs: BeamDef[],
  cx: number,
  cy: number,
): Beams {
  const n = defs.length;
  const group = new THREE.Group();
  // Quad unitario: x en [-0.5, 0.5] (u), y en [0, 1] (v: base -> punta).
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);
  const base = new Float32Array(n * 3);
  const glow = new Float32Array(n).fill(BEAM_DIM);
  defs.forEach((d, i) => {
    const rt = rts[d.rtIndex] as LabelRuntime;
    base[i * 3] = rt.wx;
    base[i * 3 + 1] = rt.groundWy + BEAM_BASE_LIFT_M;
    base[i * 3 + 2] = rt.wz;
  });
  geo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base, 3));
  const aGlow = new THREE.InstancedBufferAttribute(glow, 1);
  aGlow.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aGlow", aGlow);
  void cx;
  void cy;
  void _v;

  const uColor = { value: new THREE.Color(BEAM_COLOR) };
  const uDayF = { value: 1 };
  const uW = { value: BEAM_W_M };
  const uH = { value: BEAM_H_M };
  const mat = new THREE.ShaderMaterial({
    // AGENTS.md: todo uniforme añadido se DECLARA en el GLSL (three sube
    // material.uniforms, no los declara). uW/uH/uColor/uDayF viajan aquí y
    // en el header — comprobación: __programs sin ok=false.
    uniforms: { uColor, uDayF, uW, uH },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // §1 cinta: nada aditivo — premultiplicado src-over (idempotente).
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `
      uniform float uW; uniform float uH;
      attribute vec3 aBase; attribute float aGlow;
      varying vec2 vUv; varying float vGlow;
      void main(){
        vUv = uv; vGlow = aGlow;
        // Billboard cilíndrico: right sobre Y hacia la cámara.
        vec3 toCam = cameraPosition - aBase;
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 wp = aBase + right * (position.x * uW) + vec3(0.0, 1.0, 0.0) * (position.y * uH);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vGlow;
      uniform vec3 uColor; uniform float uDayF;
      void main(){
        float u = vUv.x - 0.5;
        float gauss = exp(-u * u * 18.0);
        float v = vUv.y;
        // Perfil vertical: 0.9 base, 0.55 media, 0.25 punta + refuerzo
        // smoothstep(0.92, 1.0, v)·0.5 donde cuelga la etiqueta.
        float prof = mix(0.9, 0.25, v) + smoothstep(0.92, 1.0, v) * 0.5;
        float a = gauss * prof * vGlow;
        if (a < 0.004) discard;
        // Luz del día N1: P = 0.16+0.84·dayF (misma regla que las nubes).
        float P = 0.16 + 0.84 * uDayF;
        vec3 col = uColor * P;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  // uW/uH viajan como uniforms declarados (ver arriba).
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  mesh.frustumCulled = false;
  mesh.renderOrder = 7; // tras el rastro (4-6), antes de las nubes (10)
  // Instancias en identidad: la posición real viaja en aBase (billboard CPU-free).
  {
    const dummy = new THREE.Object3D();
    for (let i = 0; i < Math.max(1, n); i++) {
      dummy.position.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  mesh.count = n;
  group.add(mesh);

  // G74 ID pass: MISMA geometría instanciada, material plano por hito
  // (color = id codificado en R). Escena propia con solo lo que necesita
  // (regla AGENTS.md: ningún render a target usa la escena principal).
  const idGeo = new THREE.PlaneGeometry(1, 1);
  idGeo.translate(0, 0.5, 0);
  idGeo.setAttribute("aBase", new THREE.InstancedBufferAttribute(base.slice(), 3));
  const idIdx = new Float32Array(Math.max(1, n));
  for (let i = 0; i < n; i++) idIdx[i] = i + 1;
  idGeo.setAttribute("aId", new THREE.InstancedBufferAttribute(idIdx, 1));
  const idMat = new THREE.ShaderMaterial({
    uniforms: { uW: { value: BEAM_W_M }, uH: { value: BEAM_H_M } },
    vertexShader: `
      uniform float uW; uniform float uH;
      attribute vec3 aBase; attribute float aId;
      varying float vId;
      void main(){
        vId = aId;
        vec3 toCam = cameraPosition - aBase;
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 wp = aBase + right * (position.x * uW) + vec3(0.0, 1.0, 0.0) * (position.y * uH);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying float vId;
      void main(){ gl_FragColor = vec4(vId / 255.0, 0.0, 0.0, 1.0); }`,
  });
  const idMesh = new THREE.InstancedMesh(idGeo, idMat, Math.max(1, n));
  idMesh.frustumCulled = false;
  {
    const dummy = new THREE.Object3D();
    for (let i = 0; i < Math.max(1, n); i++) {
      dummy.position.set(0, 0, 0);
      dummy.updateMatrix();
      idMesh.setMatrixAt(i, dummy.matrix);
    }
    idMesh.instanceMatrix.needsUpdate = true;
  }
  idMesh.count = n;
  const idScene = new THREE.Scene();
  idScene.add(idMesh);
  const idTarget = new THREE.WebGLRenderTarget(256, 144, { depthBuffer: true });
  const idBuf = new Uint8Array(256 * 144 * 4);

  const glows = new Float32Array(Math.max(1, n)).fill(BEAM_DIM);
  let anchored = true;

  function tipWy(i: number): number {
    return (base[i * 3 + 1] as number) + BEAM_H_M;
  }

  return {
    group,
    mesh,
    count: n,
    setGlow(i: number, g01: number, occluded: boolean, epilogue: boolean): void {
      if (i < 0 || i >= n) return;
      let g = epilogue ? BEAM_EPI : g01;
      if (occluded) g *= BEAM_OCCLUDE;
      glows[i] = g;
      (geo.getAttribute("aGlow") as THREE.InstancedBufferAttribute).array[i] = g;
      (geo.getAttribute("aGlow") as THREE.InstancedBufferAttribute).needsUpdate = true;
    },
    setDayF(f: number): void {
      uDayF.value = f;
    },
    setAnchored(on: boolean): void {
      anchored = on;
      defs.forEach((d, i) => {
        const rt = rts[d.rtIndex] as LabelRuntime;
        if (on) anchorBeam(rt, tipWy(i));
        else releaseBeam(rt);
      });
    },
    countIdPixels(renderer: THREE.WebGLRenderer, camera: THREE.Camera): number[] {
      const out = new Array(n).fill(0) as number[];
      if (n === 0) return out;
      renderCount(renderer, idTarget, idBuf, idScene, camera, 256, 144, () => true);
      for (let p = 0; p < 256 * 144; p++) {
        const r = idBuf[p * 4] as number;
        // R codificado = round((i+1)/255*255) puede desviar ±1 por filtrado:
        // redondear al id más cercano en vez de truncar.
        const id = Math.round((r / 255) * 255);
        if (id >= 1 && id <= n) out[(id - 1) as number]++;
      }
      return out;
    },
    activeName(): string | null {
      // Activo = mayor glow (el hito en ventana uGlow; empate -> primero).
      let bi = -1;
      let bm = -1;
      for (let i = 0; i < n; i++) {
        if ((glows[i] as number) > bm) {
          bm = glows[i] as number;
          bi = i;
        }
      }
      if (bi < 0) return null;
      return (rts[(defs[bi] as BeamDef).rtIndex] as LabelRuntime).def.nombre;
    },
    maxGlow(): number {
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, glows[i] as number);
      return m;
    },
    debugGlows(): number[] {
      return [...glows.slice(0, n)];
    },
  };
}
