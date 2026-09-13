// altitude-readout.ts — elevation under the cursor. The render loop owns its
// data; this only writes the DOM when the visible value actually changes.
import * as THREE from "three";

export function attachAltitudeReadout(
  renderer: THREE.WebGLRenderer,
  camera: THREE.Camera,
  getTerrain: () => THREE.Mesh | null,
  el: HTMLElement,
): void {
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let lastShown = "";
  let pending: { clientX: number; clientY: number } | null = null;

  window.addEventListener("pointermove", (ev) => {
    pending = { clientX: ev.clientX, clientY: ev.clientY };
  });

  function tick(): void {
    requestAnimationFrame(tick);
    if (!pending) return;
    const { clientX, clientY } = pending;
    pending = null;
    const terrain = getTerrain();
    if (!terrain) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(terrain, false)[0];
    // Terrain group may carry vertical exaggeration on the Y scale; the
    // intersected world Y already includes it, so undo it for a true reading.
    const exagg = terrain.parent?.scale.y ?? 1;
    const text = hit
      ? `${Math.round((hit.point.y as number) / exagg)} m`
      : "—";
    if (text !== lastShown) {
      lastShown = text;
      el.textContent = text;
    }
  }
  tick();
}
