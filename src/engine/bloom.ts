// bloom.ts — §2: the Everest glow is a BLOOM of the track, not a fat line.
// Minimal, no general post-processing (no EffectComposer):
//   1. the glow scene (track + milestone beams, flat paint on black) renders
//      at 1/4 resolution — its own scene, never the main one (AGENTS.md);
//   2. separable 9-tap gaussian, two passes, same target (ping-pong);
//   3. fullscreen composite quad, additive, GLOW_ALPHA_BLOOM (0.6 at milestones).
// Budget: 1 ms, measured in metrics.msPost (which finally measures something).
// If it overruns: drop to 1/8 resolution before touching the kernel.
import * as THREE from "three";
import { GLOW_ALPHA_BLOOM, GLOW_ALPHA_BLOOM_HITO } from "../narrative/choreography.ts";

// 9-tap gaussian, sigma ~2.0 px at quarter res (weights sum to 1).
const KERNEL = [0.028, 0.065, 0.121, 0.175, 0.221, 0.175, 0.121, 0.065, 0.028];

function blurMaterial(dir: THREE.Vector2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uDir: { value: dir },
      uKernel: { value: KERNEL },
    },
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D uMap; uniform vec2 uDir; uniform float uKernel[9];
      void main(){
        vec2 px = uDir * (1.0 / vec2(textureSize(uMap, 0)));
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 9; i++) {
          acc += texture2D(uMap, vUv + px * float(i - 4)).rgb * uKernel[i];
        }
        gl_FragColor = vec4(acc, 1.0);
      }`,
  });
}

export interface Bloom {
  /** Render the glow scene blurred + composite it over the frame. */
  render(glow01: number): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function createBloom(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  /** Own scene: track + beams flat paint (never the main scene). */
  glowScene: THREE.Scene,
): Bloom {
  const full = renderer.getDrawingBufferSize(new THREE.Vector2());
  const qw = Math.max(4, Math.floor(full.x / 4 / 4) * 4);
  const qh = Math.max(4, Math.floor(full.y / 4 / 4) * 4);
  const mkTarget = (): THREE.WebGLRenderTarget =>
    new THREE.WebGLRenderTarget(qw, qh, { depthBuffer: false });
  let a = mkTarget();
  let b = mkTarget();
  const blurH = blurMaterial(new THREE.Vector2(1, 0));
  const blurV = blurMaterial(new THREE.Vector2(0, 1));
  const compMat = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uAlpha: { value: GLOW_ALPHA_BLOOM },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `
      varying vec2 vUv; uniform sampler2D uMap; uniform float uAlpha;
      void main(){ gl_FragColor = vec4(texture2D(uMap, vUv).rgb * uAlpha, 1.0); }`,
  });
  // Fullscreen quads: positions in clip space, own scenes (never main).
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const blurScene = new THREE.Scene();
  const blurMesh = new THREE.Mesh(quadGeo, blurH);
  blurMesh.frustumCulled = false;
  blurScene.add(blurMesh);
  const compScene = new THREE.Scene();
  const compMesh = new THREE.Mesh(quadGeo, compMat);
  compMesh.frustumCulled = false;
  compScene.add(compMesh);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevColor = new THREE.Color();
  return {
    render(glow01: number) {
      const g = Math.min(1, Math.max(0, glow01));
      const alpha = g > 0.001 ? GLOW_ALPHA_BLOOM_HITO : GLOW_ALPHA_BLOOM;
      (compMat.uniforms["uAlpha"] as { value: number }).value = alpha;
      const prevAlpha = renderer.getClearAlpha();
      renderer.getClearColor(prevColor);
      renderer.setClearColor(0x000000, 1);
      // 1. glow scene at quarter res.
      renderer.setRenderTarget(a);
      renderer.clear(true, false, false);
      renderer.render(glowScene, camera);
      // 2. separable blur, ping-pong in place.
      blurMesh.material = blurH;
      (blurH.uniforms["uMap"] as { value: THREE.Texture | null }).value = a.texture;
      renderer.setRenderTarget(b);
      renderer.clear(true, false, false);
      renderer.render(blurScene, quadCam);
      blurMesh.material = blurV;
      (blurV.uniforms["uMap"] as { value: THREE.Texture | null }).value = b.texture;
      renderer.setRenderTarget(a);
      renderer.clear(true, false, false);
      renderer.render(blurScene, quadCam);
      // 3. composite over the frame, additive.
      renderer.setRenderTarget(null);
      (compMat.uniforms["uMap"] as { value: THREE.Texture | null }).value = a.texture;
      renderer.render(compScene, quadCam);
      renderer.setClearColor(prevColor, prevAlpha);
    },
    setSize(w: number, h: number) {
      const nw = Math.max(4, Math.floor(w / 4 / 4) * 4);
      const nh = Math.max(4, Math.floor(h / 4 / 4) * 4);
      a.setSize(nw, nh);
      b.setSize(nw, nh);
    },
    dispose() {
      a.dispose();
      b.dispose();
      blurH.dispose();
      blurV.dispose();
      compMat.dispose();
      quadGeo.dispose();
    },
  };
}
