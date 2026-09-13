// lighting.ts — one sun + one sky. Static shadow map (rendered once).
import * as THREE from "three";

export interface Sun {
  light: THREE.DirectionalLight;
  sky: THREE.HemisphereLight;
  setSun(azimuthDeg: number, elevationDeg: number, extent: number): void;
}

export function createSun(scene: THREE.Scene): Sun {
  const light = new THREE.DirectionalLight(0xfff2e0, 2.6);
  light.castShadow = true;
  const s = 8000;
  light.shadow.camera.left = -s;
  light.shadow.camera.right = s;
  light.shadow.camera.top = s;
  light.shadow.camera.bottom = -s;
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 50000;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.bias = -0.0004;
  const sky = new THREE.HemisphereLight(0xbdd3e6, 0x5c5648, 0.55);
  scene.add(light);
  scene.add(light.target);
  scene.add(sky);
  return {
    light,
    sky,
    setSun(azimuthDeg: number, elevationDeg: number, extent: number) {
      const az = (azimuthDeg * Math.PI) / 180;
      const el = (elevationDeg * Math.PI) / 180;
      const r = extent;
      light.position.set(
        Math.sin(az) * Math.cos(el) * r,
        Math.sin(el) * r,
        -Math.cos(az) * Math.cos(el) * r,
      );
    },
  };
}
