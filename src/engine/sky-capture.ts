// sky-capture.ts — S9: render ONLY the sky dome into a 64×32 equirect
// target; the terrain fog shader samples it along the view ray (one sample
// per fragment, one 2k-pixel pass per sun move).
// Phase 3A: refreshIfNeeded(elevDeg) — recapture only when the solar
// elevation moved more than SKY_EPS_DEG; fog colour updates in the SAME
// event (viewer), never separately.
// Rastro (feedback loop): the capture renders its OWN scene holding just a
// second dome mesh (same geometry + material) — never the main scene.
// Rendering the main scene into rt while rt.texture was an input of that
// same scene's materials discarded draws (INVALID_OPERATION) and poisoned
// the frames after. No offscreen pass uses the main scene (AGENTS.md).
import * as THREE from "three";
import { SKY_EPS_DEG } from "../narrative/choreography.ts";
import { fogUniforms } from "./height-fog.ts";

export interface SkyCapture {
  refresh(): void;
  refreshIfNeeded(elevDeg: number): boolean;
  /** Rastro isolation (?skycap=0): skip the capture (zenith frozen). */
  setEnabled(on: boolean): void;
  /** G24: read zenith + horizon luma from the capture (renderer path only,
   * no raw GL). Zenith = top-centre of the 64×32 equirect, horizon =
   * vertical middle. Returns BYTES (Uint8Array view) — the gate needs a
   * hue band + a luma RATIO, not absolute HDR.
   * Precondition: the capture target is UnsignedByteType (readable). */
  readZenith(): { buf: Uint8Array; w: number; h: number };
  dispose(): void;
}

export function createSkyCapture(
  renderer: THREE.WebGLRenderer,
  /** The sky dome mesh of the main scene — cloned into the capture scene
   * (a Mesh lives in one scene only; geometry + material are shared). */
  skyDome: THREE.Mesh,
  camera: THREE.Camera,
): SkyCapture {
  // G24 target: readback-compatible by construction — UnsignedByteType +
  // RGBAFormat, the combination readRenderTargetPixels accepts. (HalfFloat
  // would render fine but refuse the read; the capture feeds the fog
  // shader, not a meter — 8 bit is plenty for a hue band + luma ratio.)
  const rt = new THREE.WebGLRenderTarget(64, 32, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    depthBuffer: false,
  });
  fogUniforms.uSkyMap.value = rt.texture;
  fogUniforms.uHasSkyMap.value = 1;
  // Own scene: the dome clone only. Sun/hemi lights stay out — the Sky
  // shader is unlit (uniform-driven); no other object may sample rt.texture
  // while it is the render destination.
  const skyScene = new THREE.Scene();
  const domeClone = new THREE.Mesh(skyDome.geometry, skyDome.material);
  domeClone.frustumCulled = false;
  domeClone.renderOrder = -10;
  skyScene.add(domeClone);
  let lastElev = Infinity;
  let enabled = true;
  // G24 readback: persistent buffer (no per-frame alloc), read through the
  // renderer — never raw gl. Rows: y=30/31 zenith, y=16 horizon (equirect:
  // v=1 top). Col x=32 faces away from the sun seam.
  const zenBuf = new Uint8Array(64 * 32 * 4);
  function readZenith(): { buf: Uint8Array; w: number; h: number } {
    renderer.readRenderTargetPixels(rt, 0, 0, 64, 32, zenBuf);
    return { buf: zenBuf, w: 64, h: 32 };
  }
  function doRefresh(): void {
    if (!enabled) return;
    // The dome clone shares geometry + material with the main dome, so the
    // sun position / turbidity / rayleigh the viewer sets are always live.
    domeClone.updateMatrixWorld(true);
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt);
    renderer.render(skyScene, camera);
    // Back to canvas through the renderer so three's GL-state cache stays
    // in sync — never touch raw GL here.
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
  }
  return {
    refresh() {
      lastElev = Infinity; // force the next refreshIfNeeded through
      doRefresh();
    },
    refreshIfNeeded(elevDeg: number) {
      if (!enabled) return false;
      if (Math.abs(elevDeg - lastElev) <= SKY_EPS_DEG && lastElev !== Infinity) return false;
      lastElev = elevDeg;
      doRefresh();
      return true;
    },
    setEnabled(on: boolean) {
      enabled = on;
    },
    readZenith,
    dispose() {
      rt.dispose();
      fogUniforms.uSkyMap.value = null;
      fogUniforms.uHasSkyMap.value = 0;
    },
  };
}
