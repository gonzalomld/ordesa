// sky-capture.ts — S9: render the scene with terrain+clouds+line hidden
// into a 64×32 equirect target; the terrain fog shader samples it along the
// view ray (one sample per fragment, one 2k-pixel pass per sun move).
import * as THREE from "three";
import { fogUniforms } from "./height-fog.ts";

export interface SkyCapture {
  refresh(): void;
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
  return {
    refresh() {
      // hide everything but the dome: terrain group + clouds + line are
      // direct scene children alongside sun/hemi/sky targets
      const hidden: THREE.Object3D[] = [];
      for (const o of scene.children) {
        if ((o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.Line).isLine) {
          o.visible = false;
          hidden.push(o);
        }
      }
      const prev = renderer.getRenderTarget();
      const prevTone = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
      renderer.toneMapping = prevTone;
      for (const o of hidden) o.visible = true;
    },
    dispose() {
      rt.dispose();
      fogUniforms.uSkyMap.value = null;
      fogUniforms.uHasSkyMap.value = 0;
    },
  };
}
