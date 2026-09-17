// clouds.ts — S1 + §4b FASE 4c: convection billboards that sit ABOVE the
// terrain, with the production layout exported for the Node coverage
// predictor (scripts/predict-clouds.ts) so the meter and the drawing can
// never drift apart again.
//
// Coverage comes from NUMBER and SIZE of puffs, never transparency:
// per-puff alpha in [0.75, 0.95]; uDensity gates HOW MANY puffs are on
// (lowest seed-alpha first), never their opacity. Soft intersection fade
// comes from a real heightfield sample in the fragment shader (uHeightMap).
import * as THREE from "three";
import { CLOUD_BAND_DEPTH_M, CLOUD_BAND_LIFT_M, CLOUD_CORRIDOR_MIN_M, CLOUD_FAR_BAND_HI_M, CLOUD_FAR_BAND_LO_M, CLOUD_FAR_MARGIN_M, CLOUD_FAR_MIN_M, CLOUD_MASK, CLOUD_PUFF_SCALE } from "../narrative/choreography.ts";
import type { Meta } from "./terrain.ts";

/** §4b FASE 4: instance count (step b knob: +20% per step). */
export const CLOUD_COUNT = 160;
/** §4b FASE 4c: per-puff alpha floor/ceiling — coverage via number+size,
 * never transparency (≤0.55 made everything veil). */
export const CLOUD_ALPHA_LO = 0.75;
export const CLOUD_ALPHA_HI = 0.95;
/** §4b FASE 4c: distant-family share (horizon-only puffs for low acts). */
export const CLOUD_FAR_COUNT = 40;

export interface Clouds {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  centers: THREE.Vector3[];
  /** §4b FASE 4b: live material uniforms (uMap/uDensity/uMask) for
   * the pixel-meter's flat probe pass — same values, no copies. */
  probeUniforms(): {
    uMap: { value: THREE.Texture | null };
    uDensity: { value: number };
    uMask: { value: number };
  };
  setDensity(d: number): void;
  /** A9: 0 = eye-level (full density) .. 1 = straight down (fade). */
  setZenithFade(f: number): void;
  /** §4b FASE 4b: epilogue height fade — 1 = puff at/above the camera,
   * 0 = puff ≥ 500 m below (horizon puffs stay). Multiplies with A9. */
  setBelowFade(f: number): void;
  /** §4b FASE 4b: camera height for the per-puff below-fade. */
  setCamY(y: number): void;
  /** N1: dayF diario — smoothstep(−4°, 4°, elevación solar), escrito por
   * el viewer desde lightingAt (misma fuente que la niebla). Solo
   * multiplica el brillo neutro P; nunca tiñe. */
  setDayF(f: number): void;
  update(time: number, camera: THREE.Camera, vw: number, vh: number): void;
  getCoverage(): number;
  dispose(): void;
}

export interface CloudPuff {
  x: number;
  y: number;
  z: number;
  scale: number;
  alpha: number;
  quad: number;
  rot: number;
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

/** §4b FASE 4b: sampled camera poses — EPSG plan (x, y) + altitude z, i.e.
 * the SAME frame as CloudPuff (no world transform inside the layout:
 * viewer and predictor each convert consistently on their side). */
export interface CloudCamPose {
  x: number;
  y: number;
  z: number;
  /** journey s of the pose (s-aware gate; older callers may omit). */
  s?: number;
}

/** §4b FASE 4c: the production layout — MAIN band strictly above every
 * framing + distant horizon family for the low acts.
 * MAIN band = [camYmax + 250, +400] (as 4b required): the slab experiment
 * parked the camera INSIDE the band — fly-through + blind meter. Above
 * every lens, always.
 * DISTANT family (40): ≥ 3 km plan from EVERY pose, fixed low band
 * [2000, 2400]: horizon-only puffs the high main band cannot serve at
 * s < 0.10. Published in __cloudBand as both families.
 * The 3D gate (≥ 900 m near-in-s, ≥ 400 m far) keeps both out of lenses.
 * First quarter of MAIN (30): ORIGINAL uniform draws (mulberry(20260816),
 * same call order — background depth, unchanged numbers).
 * Rest of MAIN (90): corridor-biased (seed 20260418) — random route point
 * ±(900-1800 m) lateral. predict-clouds.ts imports this, never a copy. */
export function cloudLayout(
  meta: CloudLayoutMeta,
  elev: Float32Array,
  route?: CloudRoute,
  /** §4b FASE 4c: EPSG-plan camera samples ({x, y} ground coords, z =
   * altitude). MAIN band = [max(camY) + 250, +400]; DISTANT family in the
   * fixed low band, ≥ 3 km plan from every pose. Rejection is 3D
   * (no world transform — the layout never mixes frames). */
  camPoses?: CloudCamPose[],
): CloudPuff[] {
  const rnd = mulberry(20260816);
  const spanX = meta.bbox.maxx - meta.bbox.minx;
  const out: CloudPuff[] = [];
  // §4b FASE 4c: MAIN band above every lens — base = max(camY) + 250,
  // top = base + 400. The caller owns the geometry (viewer boot sweep
  // passes camYmax through camPoses z); the layout honours the band.
  let bandBase = 1900;
  let bandTop = 2300;
  if (camPoses && camPoses.length > 0) {
    let top = -Infinity;
    for (const c of camPoses) {
      if (c.z > top) top = c.z;
    }
    bandBase = top + CLOUD_BAND_LIFT_M;
    bandTop = bandBase + CLOUD_BAND_DEPTH_M;
  }
  // Anchor s of an arbitrary plan position ≈ nearest route fraction
  // (route is uniform-arc by construction). Lets uniform draws be graded
  // by the SAME near/far rule as corridor puffs — a uniform puff sitting
  // 500 m off the path is near-in-s to somebody and owes them 900 m.
  const anchorS = (x: number, y: number): number => {
    if (!route || route.n < 1) return -1;
    let bi = 0;
    let bd = Infinity;
    for (let i = 0; i < route.n; i += 4) {
      const dx = x - (route.x[i] as number);
      const dy = y - (route.y[i] as number);
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
    return bi / Math.max(1, route.n - 1);
  };
  // S1a: terrain-relative + slab floor — never buries a puff in a crest.
  const puffZ = (rr: () => number, x: number, y: number): number => {
    const ground = sampleElev(elev, meta as Meta, x, y);
    return Math.max(ground + 120, bandBase + rr() * (bandTop - bandBase));
  };
  // §4b FASE 4b: s-AWARE 3D gate. A puff anchored at route fraction
  // ps must clear ≥ 900 m 3D only against poses with |s − ps| ≤ 0.2
  // (the cameras that could ever see it large). Against the REST, 400 m
  // suffices (white-out needs angular size; far-in-s cameras are far in
  // space except at route folds — 400 m still keeps the lens clear).
  // A global ≥ 900 m vs ALL poses eats its own tail: a puff 1.5 km ahead
  // of the s=0.18 camera is ~600 m from the s=0.30 camera → rejected,
  // leaving s=0.18 with an empty sky (measured 0/160 in frame).
  const gate3D = (x: number, y: number, z: number, ps: number): boolean => {
    if (!camPoses || camPoses.length === 0) return true;
    for (const c of camPoses) {
      const cs = c.s ?? -1;
      const near = ps >= 0 && cs >= 0 && Math.abs(cs - ps) <= 0.2;
      const margin = near ? CLOUD_CORRIDOR_MIN_M : CLOUD_FAR_MARGIN_M;
      if (Math.hypot(x - c.x, y - c.y, z - c.z) < margin) return false;
    }
    return true;
  };
  const pushPuff = (rr: () => number, x: number, y: number, z: number): void => {
    const scale = (250 + rr() * 350) * CLOUD_PUFF_SCALE;
    out.push({
      x,
      y,
      z,
      scale,
      // §4b FASE 4c: coverage via NUMBER and SIZE, never transparency —
      // per-puff alpha in [0.75, 0.95] (≤0.55 made everything veil).
      alpha: CLOUD_ALPHA_LO + rr() * (CLOUD_ALPHA_HI - CLOUD_ALPHA_LO),
      quad: Math.floor(rr() * 4),
      rot: rr() * Math.PI * 2,
    });
  };
  const pushUniformAt = (rr: () => number, x: number, y: number): void => {
    pushPuff(rr, x, y, puffZ(rr, x, y));
  };
  const pushUniform = (rr: () => number): void => {
    const x = meta.bbox.minx + rr() * spanX;
    // convection band over the rim and valley edges, with gaps
    const y = meta.bbox.miny + (0.3 + rr() * 0.7) * (meta.bbox.maxy - meta.bbox.miny);
    pushUniformAt(rr, x, y);
  };
  // §4b FASE 4c: MAIN family = CLOUD_COUNT − CLOUD_FAR_COUNT. First
  // quarter of MAIN: ORIGINAL uniform draws (mulberry(20260816), same call
  // order — background depth, unchanged numbers). Rest of MAIN:
  // corridor-biased (seed 20260418). DISTANT family appended after.
  const mainCount = CLOUD_COUNT - CLOUD_FAR_COUNT;
  const half = Math.floor(mainCount / 4);
  for (let i = 0; i < half; i++) {
    if (camPoses && camPoses.length > 0) {
      // uniform draws are graded by POSITION anchor s (nearest route
      // fraction) — same near/far rule as corridor puffs. A uniform puff
      // 500 m off the path owes its neighbours 900 m like anyone else.
      let done = false;
      for (let attempt = 0; attempt < 24 && !done; attempt++) {
        const x = meta.bbox.minx + rnd() * spanX;
        const y = meta.bbox.miny + (0.3 + rnd() * 0.7) * (meta.bbox.maxy - meta.bbox.miny);
        const z = puffZ(rnd, x, y);
        if (!gate3D(x, y, z, anchorS(x, y))) continue;
        pushPuff(rnd, x, y, z);
        done = true;
      }
      if (!done) pushUniform(rnd);
    } else {
      pushUniform(rnd);
    }
  }
  // Corridor puffs: route point + lateral offset (own rng, so the uniform
  // draws above keep their EXACT original sequence).
  const rnd2 = mulberry(20260418);
  for (let i = half; i < mainCount; i++) {
    if (route && route.n > 1) {
      let placed = false;
      for (let attempt = 0; attempt < 24 && !placed; attempt++) {
        const k = Math.floor(rnd2() * route.n);
        const rx = route.x[k] as number;
        const ry = route.y[k] as number;
        const ang = rnd2() * Math.PI * 2;
        const off = CLOUD_CORRIDOR_MIN_M + rnd2() * CLOUD_CORRIDOR_MIN_M;
        const x = Math.min(meta.bbox.maxx - 100, Math.max(meta.bbox.minx + 100, rx + Math.cos(ang) * off));
        const y = Math.min(meta.bbox.maxy - 100, Math.max(meta.bbox.miny + 100, ry + Math.sin(ang) * off));
        const z = puffZ(rnd2, x, y);
        // Grade by POSITION anchor (nearest route s of the final, clamped
        // position) — the draw anchor drifts up to 1800 m plus bbox
        // clamping, so grading by k/(n−1) audited a different puff than
        // the one pushed (measured: 451 m near-gate violation from a draw
        // graded far). EPSG plan + altitude, no world transform.
        if (!gate3D(x, y, z, anchorS(x, y))) continue;
        pushPuff(rnd2, x, y, z);
        placed = true;
      }
      if (!placed) {
        // §4b FASE 4b: the fallback ALSO respects the 3D gate (retry with
        // fresh draws, bounded) — a sub-gate fallback would reintroduce
        // exactly the violation the 24 attempts just avoided.
        let done = false;
        for (let attempt = 0; attempt < 24 && !done; attempt++) {
          const x = meta.bbox.minx + rnd2() * spanX;
          const y = meta.bbox.miny + (0.3 + rnd2() * 0.7) * (meta.bbox.maxy - meta.bbox.miny);
          const z = puffZ(rnd2, x, y);
          if (!gate3D(x, y, z, anchorS(x, y))) continue;
          pushPuff(rnd2, x, y, z);
          done = true;
        }
        if (!done) pushUniform(rnd2);
      }
    } else {
      pushUniform(rnd2);
    }
  }
  // §4b FASE 4c: DISTANT family (horizon-only for low acts) — own rng
  // (seed 20260501), fixed low band, ≥ 3 km plan from EVERY pose. AIMED,
  // not uniform-random: 40 random-far puffs give ~1 in-frame by solid
  // angle (measured: 0/160 everywhere). Each puff picks a random pose,
  // steps 3.5-6 km along the TRAVEL direction (pose[i+1]−pose[i] ≈ view
  // dir, no new imports), jitters ±1 km lateral, and lands in the band.
  // Rejected candidates retry; EVERY fallback stays in the FAR band +
  // far gate (a main-slab pushUniform here would smuggle far puffs into
  // the main band and break the family audit — measured).
  const rnd3 = mulberry(20260501);
  const pushFarAt = (x: number, y: number): number => {
    const ground = sampleElev(elev, meta as Meta, x, y);
    return Math.max(ground + 120, CLOUD_FAR_BAND_LO_M + rnd3() * (CLOUD_FAR_BAND_HI_M - CLOUD_FAR_BAND_LO_M));
  };
  const farClear = (x: number, y: number): boolean => {
    if (!camPoses || camPoses.length === 0) return true;
    for (const c of camPoses) {
      if (Math.hypot(x - c.x, y - c.y) < CLOUD_FAR_MIN_M) return false;
    }
    return true;
  };
  const aimFar = (): { x: number; y: number } => {
    // random pose → forward along travel → 3.5-6 km out → ±1 km lateral
    const n = camPoses && camPoses.length > 1 ? camPoses.length : 0;
    if (n < 2) {
      return {
        x: meta.bbox.minx + rnd3() * spanX,
        y: meta.bbox.miny + rnd3() * (meta.bbox.maxy - meta.bbox.miny),
      };
    }
    const k = Math.floor(rnd3() * (n - 1));
    const a = camPoses[k] as CloudCamPose;
    const b = camPoses[k + 1] as CloudCamPose;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    const dist = 3500 + rnd3() * 2500;
    const lat = (rnd3() * 2 - 1) * 1000;
    return {
      x: a.x + dx * dist - dy * lat,
      y: a.y + dy * dist + dx * lat,
    };
  };
  for (let i = 0; i < CLOUD_FAR_COUNT; i++) {
    let placed = false;
    for (let attempt = 0; attempt < 24 && !placed; attempt++) {
      const { x: rx, y: ry } = aimFar();
      const x = Math.min(meta.bbox.maxx - 100, Math.max(meta.bbox.minx + 100, rx));
      const y = Math.min(meta.bbox.maxy - 100, Math.max(meta.bbox.miny + 100, ry));
      const z = pushFarAt(x, y);
      if (!farClear(x, y)) continue;
      pushPuff(rnd3, x, y, z);
      placed = true;
    }
    if (!placed) {
      // far-gated fallback (own draws, bounded, SAME band + gate)
      for (let attempt = 0; attempt < 24 && !placed; attempt++) {
        const { x: rx, y: ry } = aimFar();
        const x = Math.min(meta.bbox.maxx - 100, Math.max(meta.bbox.minx + 100, rx));
        const y = Math.min(meta.bbox.maxy - 100, Math.max(meta.bbox.miny + 100, ry));
        const z = pushFarAt(x, y);
        if (!farClear(x, y)) continue;
        pushPuff(rnd3, x, y, z);
        placed = true;
      }
      if (!placed) {
        // last resort: far corner of the bbox (still far-gated; if even
        // that fails the bbox is too small for 40 far puffs — loud).
        const x = meta.bbox.minx + 100;
        const y = meta.bbox.miny + 100;
        if (!farClear(x, y)) throw new Error("cloudLayout: bbox too small for CLOUD_FAR_COUNT far puffs");
        pushPuff(rnd3, x, y, pushFarAt(x, y));
        placed = true;
      }
    }
  }
  return out;
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
    uDensity: { value: 0.5 },
    uMask: { value: CLOUD_MASK },
    uZenithFade: { value: 0 },
    uBelowFade: { value: 1 },
    uCamY: { value: 0 },
    uHeightMap: { value: htex },
    uHMin: { value: new THREE.Vector2(meta.bbox.minx, meta.bbox.miny) },
    uHSize: { value: new THREE.Vector2(meta.bbox.maxx - meta.bbox.minx, meta.bbox.maxy - meta.bbox.miny) },
    uHMaxY: { value: meta.bbox.maxy },
    uHCenter: { value: new THREE.Vector2(cx, cy) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // N1: fog:true — el tinte cálido llega por la niebla (height-fog toma
    // el color de la captura del cielo). three solo aplica scene.fog a
    // materiales con fog:true; scene.fog es null, así que refreshFogUniforms
    // no toca nada: el flag queda como contrato para la F2 (niebla real).
    fog: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `
      attribute vec4 aData; // x: quadrant, y: rotation, z: scale, w: alpha seed
      varying vec2 vUv; varying float vAlpha; varying vec3 vWPos; varying float vAbove;
      varying float vSeed;
      uniform float uDensity; uniform float uMask;
      void main(){
        float quad = aData.x;
        vUv = vec2(mod(quad,2.0)*0.5 + uv.x*0.5, floor(quad/2.0)*0.5 + uv.y*0.5);
        // N1: rot fija (aData.y) — sin deriva rotacional por uTime.
        float rot = aData.y;
        vec2 p = position.xy * aData.z;
        vec2 rp = mat2(cos(rot),-sin(rot),sin(rot),cos(rot)) * p;
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c.xyz + right * rp.x + up * rp.y;
        vWPos = wp;
        // §4b FASE 4c: per-puff ABOVE fade — 1 when the puff is at/above
        // the camera, 0 when ≥ 400 m below (epilogue from above: the loop
        // stays clear, horizon puffs stay). Replaces belowFade (dead).
        vAbove = 1.0 - smoothstep(100.0, 400.0, cameraPosition.y - c.y);
        vSeed = aData.w;
        // §4b FASE 4c: uDensity gates HOW MANY puffs are on — seeds in
        // [0.75,0.95], threshold = 0.70+0.30·density (smooth 0.05 window,
        // never a pop): dawn (0.45) lights the low-seed half, noon lights
        // all. Alpha itself is NOT scaled (coverage via number+size).
        // N1: sin uCap — el alfa no depende de ninguna sonda (G46).
        float onF = smoothstep(vSeed - 0.05, vSeed + 0.05, 0.70 + 0.30 * uDensity);
        vAlpha = aData.w * onF;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vAlpha; varying vec3 vWPos; varying float vAbove;
      varying float vSeed;
      uniform sampler2D uMap; uniform sampler2D uHeightMap;
      uniform vec2 uHMin; uniform vec2 uHSize; uniform float uHMaxY; uniform vec2 uHCenter;
      uniform float uZenithFade; uniform float uMask; uniform float uBelowFade;
      uniform float uDayF;
      void main(){
        // soft particles: fade where the fragment meets the terrain
        vec2 epsg = vec2(vWPos.x + uHCenter.x, uHCenter.y - vWPos.z);
        vec2 huv = vec2((epsg.x - uHMin.x) / uHSize.x, (uHMaxY - epsg.y) / uHSize.y);
        float terr = texture2D(uHeightMap, huv).r;
        float soft = smoothstep(terr + 20.0, terr + 150.0, vWPos.y);
        // puff mask (atlas texel must clear uMask) — dense cores survive.
        float tex = texture2D(uMap, vUv).r;
        float m = smoothstep(uMask, uMask + 0.08, tex);
        // A9: from above, billboards read as stains — fade to zenith.
        // §4b FASE 4c: above-fade (from above, ≥400 m below vanishes).
        // N1: sin uCap (G46).
        float a = tex * m * vAlpha * soft * (1.0 - uZenithFade) * mix(1.0, vAbove, uBelowFade);
        if (a < 0.004) discard;
        // N1 color neutro: vec3(0.92, 0.96, 1.06) · P, P = 0.16+0.84·dayF;
        // panza sombreada solo por el atlas (vUv.y): mix(0.72, 1.0,
        // smoothstep(0.2, 0.7, vUv.y)). El cálido llega por la niebla
        // (fog:true), nunca por puff. De noche (dayF 0): P = 0.16.
        float P = 0.16 + 0.84 * uDayF;
        vec3 col = vec3(0.92, 0.96, 1.06) * P;
        col *= mix(0.72, 1.0, smoothstep(0.2, 0.7, vUv.y));
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, CLOUD_COUNT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  const dummy = new THREE.Object3D();
  const data = new Float32Array(CLOUD_COUNT * 4);
  const centers: THREE.Vector3[] = [];
  const scales: number[] = [];
  // N1: deriva en X sin aparición — EPSG x por puff + velocidad (m/s =
  // m/frame a 60 fps × 60, dt del propio bucle: sin factor fijo por frame).
  const driftX: number[] = [];
  const driftV: number[] = [];
  const driftMinX = meta.bbox.minx;
  const driftMaxX = meta.bbox.maxx;
  // driftRnd es posterior al layout: ni cloudLayout ni el predictor cambian.
  const driftRnd = mulberry(20260917);
  // Production layout (exported above for the Node predictor — same array).
  const layout = cloudLayout(meta, elev, route, camPoses);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const p = layout[i] as CloudPuff;
    dummy.position.set(p.x - cx, p.z, -(p.y - cy));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    data[i * 4] = p.quad;
    data[i * 4 + 1] = p.rot;
    data[i * 4 + 2] = p.scale;
    data[i * 4 + 3] = p.alpha;
    centers.push(dummy.position.clone());
    scales.push(p.scale);
    // N1: deriva 0,6-2,4 m/frame @60fps → 36-144 m/s (rng propia, tras el
    // layout: no toca la secuencia de cloudLayout ni el predictor).
    driftX.push(p.x);
    driftV.push(36 + driftRnd() * 108);
  }
  geo.setAttribute("aData", new THREE.InstancedBufferAttribute(data, 4));
  group.add(mesh);
  new THREE.TextureLoader().load(atlasUrl, (t: THREE.Texture) => {
    t.colorSpace = THREE.NoColorSpace;
    uniforms.uMap.value = t;
  });

  // N1: deriva en X con envoltura al borde del DEM — nada cambia de alfa
  // con el tiempo salvo P (uDayF). La rotación es fija (aData.y).
  // V3: alpha-weighted coverage, recomputed every 6th frame.
  let lastT = -1;
  // §4b FASE 4c: the analytic meter mirrors the DRAWN rule — per-puff
  // alpha (seed) × on-fraction (density gates count: smoothstep over the
  // 0.05 window) × texel 0.45 × mask kept-mass. uDensity NEVER scales
  // opacity directly (that made everything veil). N1: sin cap — G46.
  let coverage = 0;
  let tick = 0;
  const pv = new THREE.Vector3();
  // mean fragment alpha per instance ≈ seed alpha × current uniforms
  const seedAlpha: number[] = [];
  for (let i = 0; i < CLOUD_COUNT; i++) seedAlpha.push(data[i * 4 + 3] as number);
  // §4b FASE 4b: mean kept-mass fraction of the NEW fBm atlas at the live
  // uMask (measured on the encoded webp: 0.958 @0.12, 0.935 @0.16,
  // 0.922 @0.18, 0.907 @0.20, 0.875 @0.24). Linear fit over [0.12,0.24].
  // The metric multiplies by it so meter and drawing agree.
  const maskKept = (m: number): number => {
    if (m <= 0) return 1;
    return Math.max(0.5, 0.958 - Math.max(0, m - 0.12) * 0.69);
  };
  return {
    group,
    mesh,
    centers,
    probeUniforms() {
      return {
        uMap: uniforms.uMap as { value: THREE.Texture | null },
        uDensity: uniforms.uDensity as { value: number },
        uMask: uniforms.uMask as { value: number },
      };
    },
    setDensity(d) {
      // §4b FASE 4c/N1: uDensity gates HOW MANY puffs are on (vertex
      // smoothstep over the seed window) — never their opacity. d = 1 →
      // all on. N1: sin sunDir — la dirección del sol ya no tiñe puffs.
      uniforms.uDensity.value = Math.min(1, Math.max(0, d));
    },
    /** N1: setLight borrado — el color es neutro (constante × dayF). */
    setZenithFade(f: number) {
      uniforms.uZenithFade.value = Math.min(1, Math.max(0, f));
    },
    /** §4b FASE 4c: epilogue above-fade — on when the camera flies above
     * the band (puffs ≥ 400 m below vanish), off otherwise. Replaces the
     * dead belowFade (camY-relative smoothstep never engaged). */
    setBelowFade(f: number) {
      uniforms.uBelowFade.value = Math.min(1, Math.max(0, f));
    },
    /** N1: dayF diario — smoothstep(−4°, 4°, elevación solar), escrito por
     * el viewer desde lightingAt (misma fuente que la niebla). Solo
     * multiplica el brillo neutro P; nunca tiñe. */
    setDayF(f: number) {
      uniforms.uDayF.value = Math.min(1, Math.max(0, f));
    },
    /** DEAD (§4b FASE 4c): uCamY no longer feeds any fade — kept so call
     * sites don't churn. */
    setCamY(_y: number) {
      void _y;
    },
    update(time, camera, vw, vh) {
      if (!group.visible) return; // T1.1: cut group ⇒ skip CPU work too
      // N1: deriva en X con envoltura al borde del DEM (dt real del bucle:
      // 1 - exp no aplica aquí — es traslación lineal, no suavizado).
      if (lastT < 0) lastT = time;
      const dt = Math.min(0.25, Math.max(0, time - lastT));
      lastT = time;
      if (dt > 0) {
        for (let i = 0; i < CLOUD_COUNT; i++) {
          let x = (driftX[i] as number) + (driftV[i] as number) * dt;
          const R = (scales[i] as number) * 0.5;
          if (x > driftMaxX + R) x = driftMinX - R;
          driftX[i] = x;
          const c = centers[i] as THREE.Vector3;
          c.x = x - cx;
          dummy.position.copy(c);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }
      if ((tick++ % 6) !== 0 || vw <= 0 || vh <= 0) return;
      const persp = camera as THREE.PerspectiveCamera;
      const tanHalf = Math.tan(((persp.fov ?? 50) * Math.PI) / 180 / 2);
      const rawDens = uniforms.uDensity.value as number;
      const kept = maskKept(uniforms.uMask.value as number);
      // §4b FASE 4: behind-camera rejection. Vector3.project() mirrors
      // points behind the camera into NDC (w<0 flips) where they PASS the
      // pv.z check — the meter counted invisible puffs (s=0.18 read 14%
      // with 1 puff actually in frame). The GPU clips them; the meter must
      // too: camera forward = -Z column of the world-inverse rotation.
      const me = camera.matrixWorldInverse.elements;
      const fwdX = -(me[2] as number);
      const fwdY = -(me[6] as number);
      const fwdZ = -(me[10] as number);
      let area = 0;
      for (let i = 0; i < CLOUD_COUNT; i++) {
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
        const rPx = (((scales[i] as number) * 0.5) / dist) * (vh / (2 * tanHalf));
        // §4b FASE 4c: weight by the DRAWN rule — seed alpha × on-fraction
        // (threshold 0.70+0.30·density over a 0.05 window) × texel
        // 0.45 × mask kept-mass. uDensity never scales opacity (no veil).
        // N1: sin cap — el alfa no depende de ninguna sonda (G46).
        const seed = seedAlpha[i] as number;
        const thr = 0.7 + 0.3 * rawDens;
        const t = Math.min(1, Math.max(0, (thr - (seed - 0.05)) / 0.1));
        const onF = t * t * (3 - 2 * t);
        area += Math.PI * rPx * rPx * seed * onF * 0.45 * kept;
      }
      coverage = Math.min(1, area / (vw * vh));
    },
    getCoverage() {
      return coverage;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      htex.dispose();
    },
  };
}
