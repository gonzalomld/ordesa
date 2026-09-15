// sky-capture.ts — S9: render the scene with terrain+clouds+line hidden
// into a 64×32 equirect target; the terrain fog shader samples it along the
// view ray (one sample per fragment, one 2k-pixel pass per sun move).
// Phase 3A: refreshIfNeeded(elevDeg) — recapture only when the solar
// elevation moved more than SKY_EPS_DEG; fog colour updates in the SAME
// event (viewer), never separately.
import * as THREE from "three";
import { SKY_EPS_DEG } from "../narrative/choreography.ts";
import { fogUniforms } from "./height-fog.ts";

export interface SkyCapture {
  refresh(): void;
  refreshIfNeeded(elevDeg: number): boolean;
  dispose(): void;
}

export function createSkyCapture(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): SkyCapture {
  const rt = new THREE.WebGLRenderTarget(64, 32, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
  });
  fogUniforms.uSkyMap.value = rt.texture;
  fogUniforms.uHasSkyMap.value = 1;
  let lastElev = Infinity;
  function doRefresh(): void {
    // hide everything but the dome: terrain group + clouds + line are
    // direct scene children alongside sun/hemi/sky targets
    const hidden: THREE.Object3D[] = [];
    for (const o of scene.children) {
      if ((o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.Line).isLine) {
        o.visible = false;
        hidden.push(o);
      }
    }
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    // Feedback-loop guard: back to canvas. setRenderTarget(null) unbinds
    // the framebuffer through the renderer so three's GL-state cache stays
    // in sync — never touch raw GL here.
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
    for (const o of hidden) o.visible = true;
  }
  return {
    refresh() {
      lastElev = Infinity; // force the next refreshIfNeeded through
      doRefresh();
    },
    refreshIfNeeded(elevDeg: number) {
      if (Math.abs(elevDeg - lastElev) <= SKY_EPS_DEG && lastElev !== Infinity) return false;
      lastElev = elevDeg;
      doRefresh();
      return true;
    },
    dispose() {
      rt.dispose();
      fogUniforms.uSkyMap.value = null;
      fogUniforms.uHasSkyMap.value = 0;
    },
  };
}
