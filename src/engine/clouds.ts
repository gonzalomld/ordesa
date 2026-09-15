// clouds.ts — S1: convection billboards that sit ABOVE the terrain.
//
// Placement is terrain-relative (ground + 500-800 m, sampled bilinear from
// the decoded heightmap), quads are 250-600 m, alpha caps at 0.55, density
// is halved. Soft intersection fade comes from a real heightfield sample in
// the fragment shader (uHeightMap): alpha → 0 where the fragment is at or
// below the terrain, so no hard quad cuts against crests.
import * as THREE from "three";
import { CLOUD_MASK } from "../narrative/choreography.ts";
import type { Meta } from "./terrain.ts";

const COUNT = 160;
const ALPHA_CAP = 0.55;

export interface Clouds {
  group: THREE.Group;
  setDensity(d: number, sunDir: THREE.Vector3): void;
  setCap(on: boolean): void;
  /** A9: 0 = eye-level (full density) .. 1 = straight down (fade). */
  setZenithFade(f: number): void;
  update(time: number, camera: THREE.Camera, vw: number, vh: number): void;
  getCoverage(): number;
  dispose(): void;
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
): Clouds {
  const group = new THREE.Group();
  const rnd = mulberry(20260816);
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
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDensity: { value: 0.5 },
    uCap: { value: 1 },
    uMask: { value: CLOUD_MASK },
    uTime: { value: 0 },
    uZenithFade: { value: 0 },
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
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `
      attribute vec4 aData; // x: quadrant, y: rotation, z: scale, w: alpha seed
      varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vWPos;
      uniform vec3 uSunDir; uniform float uDensity; uniform float uTime; uniform float uCap; uniform float uMask;
      void main(){
        float quad = aData.x;
        vUv = vec2(mod(quad,2.0)*0.5 + uv.x*0.5, floor(quad/2.0)*0.5 + uv.y*0.5);
        float rot = aData.y + uTime*0.004;
        vec2 p = position.xy * aData.z;
        vec2 rp = mat2(cos(rot),-sin(rot),sin(rot),cos(rot)) * p;
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c.xyz + right * rp.x + up * rp.y;
        vWPos = wp;
        // wrap lighting with the real sun dir (cheap backlight rim)
        vec3 toSun = normalize(uSunDir);
        float facing = clamp(dot(normalize(cameraPosition - wp), toSun)*0.5+0.5, 0.0, 1.0);
        vShade = 0.55 + 0.65*facing;
        vAlpha = aData.w * uDensity * uCap;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vShade; varying float vAlpha; varying vec3 vWPos;
      uniform sampler2D uMap; uniform sampler2D uHeightMap;
      uniform vec2 uHMin; uniform vec2 uHSize; uniform float uHMaxY; uniform vec2 uHCenter;
      uniform float uZenithFade; uniform float uMask;
      void main(){
        // soft particles: fade where the fragment meets the terrain
        vec2 epsg = vec2(vWPos.x + uHCenter.x, uHCenter.y - vWPos.z);
        vec2 huv = vec2((epsg.x - uHMin.x) / uHSize.x, (uHMaxY - epsg.y) / uHSize.y);
        float terr = texture2D(uHeightMap, huv).r;
        float soft = smoothstep(terr + 20.0, terr + 150.0, vWPos.y);
        // §4 correction: puff MASK — the atlas texel must clear uMask
        // (smoothstep uMask..uMask+0.08) or the fragment dies. This is the
        // knob that sets the 0.30 coverage: raising the mask eats the faint
        // veil first (the 45% of texels below 0.012 go at any mask > 0) and
        // keeps the dense cores. uMask = CLOUD_MASK.
        float tex = texture2D(uMap, vUv).r;
        float m = smoothstep(uMask, uMask + 0.08, tex);
        // A9: from above, billboards read as stains on the ground, not
        // clouds. Fade toward the zenith; grazing views keep full density.
        float a = tex * m * vAlpha * soft * (1.0 - uZenithFade);
        if (a < 0.004) discard;
        vec3 col = vec3(1.04, 1.0, 0.96) * vShade;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  const dummy = new THREE.Object3D();
  const data = new Float32Array(COUNT * 4);
  const centers: THREE.Vector3[] = [];
  const scales: number[] = [];
  const spanX = meta.bbox.maxx - meta.bbox.minx;
  for (let i = 0; i < COUNT; i++) {
    const x = meta.bbox.minx + rnd() * spanX;
    // convection band over the rim and valley edges, with gaps
    const y = meta.bbox.miny + (0.3 + rnd() * 0.7) * (meta.bbox.maxy - meta.bbox.miny);
    // S1a: terrain-relative — what real convection does. §4: absolute
    // cumulus band 1900-2300 m; over high ridges the band rides up
    // (max(ground+120): never buries a puff inside a crest). No shadows
    // yet — the 512 texture on the directional light comes after §2 bloom
    // if msPost allows it.
    const ground = sampleElev(elev, meta, x, y);
    const z = Math.max(ground + 120, 1900 + rnd() * 400);
    dummy.position.set(x - cx, z, -(y - cy));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const scale = 250 + rnd() * 350;
    data[i * 4] = Math.floor(rnd() * 4);
    data[i * 4 + 1] = rnd() * Math.PI * 2;
    data[i * 4 + 2] = scale;
    data[i * 4 + 3] = Math.min(ALPHA_CAP, 0.15 + rnd() * 0.4);
    centers.push(dummy.position.clone());
    scales.push(scale);
  }
  geo.setAttribute("aData", new THREE.InstancedBufferAttribute(data, 4));
  group.add(mesh);
  new THREE.TextureLoader().load(atlasUrl, (t: THREE.Texture) => {
    t.colorSpace = THREE.NoColorSpace;
    uniforms.uMap.value = t;
  });

  // V3: alpha-weighted coverage, recomputed every 6th frame.
  // Old metric summed full quad discs (alpha 0.05 counted like 1.0 → 100%).
  // Now each disc contributes its mean fragment alpha, so the number tracks
  // what is actually seen and the 20% cap makes sense.
  // §4 correction: the metric ALSO applies the puff mask (mean kept-mass
  // fraction at uMask, measured on the real atlas) — otherwise the mask
  // would change the DRAWN sky while the meter stood still.
  let coverage = 0;
  let tick = 0;
  const pv = new THREE.Vector3();
  // mean fragment alpha per instance ≈ seed alpha × current uniforms
  const seedAlpha: number[] = [];
  for (let i = 0; i < COUNT; i++) seedAlpha.push(data[i * 4 + 3] as number);
  // §4: mean kept-mass fraction of the atlas at the live uMask (measured
  // 0.96 at mask 0.12 — the mask eats veil texels, not mass). The metric
  // multiplies by it so meter and drawing agree.
  const maskKept = (m: number): number => {
    if (m <= 0) return 1;
    if (m <= 0.06) return 1 - m * 0.7;
    return Math.max(0.5, 0.958 - (m - 0.06) * 0.55);
  };
  return {
    group,
    setDensity(d, sunDir) {
      uniforms.uDensity.value = Math.min(1, Math.max(0, d)) * 0.5;
      uniforms.uSunDir.value.copy(sunDir);
    },
    setCap(on) {
      // V3: with the alpha-weighted metric the 20% cap is a real control:
      // halve the global alpha while the visible veil exceeds it.
      uniforms.uCap.value = on ? 0.45 : 1;
    },
    setZenithFade(f) {
      uniforms.uZenithFade.value = Math.min(1, Math.max(0, f));
    },
    update(time, camera, vw, vh) {
      if (!group.visible) return; // T1.1: cut group ⇒ skip CPU work too
      uniforms.uTime.value = time;
      if ((tick++ % 6) !== 0 || vw <= 0 || vh <= 0) return;
      const persp = camera as THREE.PerspectiveCamera;
      const tanHalf = Math.tan(((persp.fov ?? 50) * Math.PI) / 180 / 2);
      const dens = (uniforms.uDensity.value as number) * (uniforms.uCap.value as number);
      const kept = maskKept(uniforms.uMask.value as number);
      let area = 0;
      for (let i = 0; i < COUNT; i++) {
        pv.copy(centers[i] as THREE.Vector3).project(camera);
        if (pv.z > 1 || pv.z < -1) continue;
        const dist = camera.position.distanceTo(centers[i] as THREE.Vector3);
        if (dist <= 0) continue;
        const rPx = (((scales[i] as number) * 0.5) / dist) * (vh / (2 * tanHalf));
        // V3: weight by the instance's effective alpha (seed × density × cap
        // × mean puff texel ≈ seed × density × cap × 0.45), times the mask
        // kept-mass fraction so the meter tracks the DRAWN puffs.
        area += Math.PI * rPx * rPx * (seedAlpha[i] as number) * dens * 0.45 * kept;
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
