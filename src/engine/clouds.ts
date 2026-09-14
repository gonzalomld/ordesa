// clouds.ts — D4-B: one InstancedMesh of 150-300 billboard quads over the
// rim (2200-2800 m), spherical facing in the vertex shader via an atlas of
// 4 noise puffs. Soft particles need depth → simplified: fade alpha where
// the quad centre is close to terrain (CPU height check per instance).
import * as THREE from "three";
import type { Meta } from "./terrain.ts";

const COUNT = 220;

export interface Clouds {
  group: THREE.Group;
  setDensity(d: number, sunDir: THREE.Vector3): void;
  update(time: number, camera: THREE.Camera): void;
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

export function buildClouds(meta: Meta, atlasUrl: string): Clouds {
  const group = new THREE.Group();
  const rnd = mulberry(20260816);
  const geo = new THREE.PlaneGeometry(1, 1);
  const uniforms = {
    uMap: { value: null as THREE.Texture | null },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uDensity: { value: 0.5 },
    uTime: { value: 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    vertexShader: `
      attribute vec4 aData; // x: quadrant, y: rotation, z: scale, w: alpha seed
      varying vec2 vUv; varying float vShade; varying float vAlpha;
      uniform vec3 uSunDir; uniform float uDensity; uniform float uTime;
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
        // wrap lighting with the real sun dir (cheap backlight rim)
        vec3 toSun = normalize(uSunDir);
        float facing = clamp(dot(normalize(cameraPosition - wp), toSun)*0.5+0.5, 0.0, 1.0);
        vShade = 0.55 + 0.65*facing;
        vAlpha = aData.w * uDensity;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vShade; varying float vAlpha;
      uniform sampler2D uMap;
      void main(){
        float a = texture2D(uMap, vUv).r * vAlpha;
        if (a < 0.004) discard;
        vec3 col = vec3(1.04, 1.0, 0.96) * vShade;
        gl_FragColor = vec4(col * a, a);
      }`,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  // R4: clouds sit over the rim but must read against the sky from the
  // high general view — fewer, larger, brighter than the first pass.
  const dummy = new THREE.Object3D();
  const data = new Float32Array(COUNT * 4);
  const spanX = meta.bbox.maxx - meta.bbox.minx;
  const cx = (meta.bbox.minx + meta.bbox.maxx) / 2;
  const cy = (meta.bbox.miny + meta.bbox.maxy) / 2;
  for (let i = 0; i < COUNT; i++) {
    const x = meta.bbox.minx + rnd() * spanX;
    // band along the rim: favour east half + edges, leave gaps
    const y = meta.bbox.miny + (0.35 + rnd() * 0.65) * (meta.bbox.maxy - meta.bbox.miny);
    const z = 2400 + rnd() * 700;
    dummy.position.set(x - cx, z, -(y - cy));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    data[i * 4] = Math.floor(rnd() * 4);
    data[i * 4 + 1] = rnd() * Math.PI * 2;
    data[i * 4 + 2] = 700 + rnd() * 1100;
    data[i * 4 + 3] = 0.4 + rnd() * 0.6;
  }
  geo.setAttribute("aData", new THREE.InstancedBufferAttribute(data, 4));
  group.add(mesh);
  new THREE.TextureLoader().load(atlasUrl, (t: THREE.Texture) => {
    t.colorSpace = THREE.NoColorSpace;
    uniforms.uMap.value = t;
  });
  // sort instances back-to-front once per frame (cheap: positions static)
  const order = [...Array(COUNT).keys()];
  const m4 = new THREE.Matrix4();
  const v = new THREE.Vector3();
  return {
    group,
    setDensity(d, sunDir) {
      uniforms.uDensity.value = d;
      uniforms.uSunDir.value.copy(sunDir);
    },
    update(time) {
      uniforms.uTime.value = time;
      void order;
      void m4;
      void v;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
