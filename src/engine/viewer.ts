// viewer.ts — phase-1 minimal viewer: orbit + sun + LOD + exaggeration.
// No scroll narrative yet. No reactive state: plain DOM + a render loop that
// owns its own data.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { attachAltitudeReadout } from "./altitude-readout.ts";
import { createSun } from "./lighting.ts";
import { buildRouteLine, loadRoute } from "./route-line.ts";
import {
  buildTerrainGeometry,
  loadElevations,
  loadMeta,
  worldFromMeta,
} from "./terrain.ts";

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export async function startViewer(canvas: HTMLCanvasElement): Promise<void> {
  const status = el("div", "hud-status", "cargando meta…");
  document.body.appendChild(status);

  const meta = await loadMeta();
  const world = worldFromMeta(meta);
  status.textContent = "cargando relieve…";
  const elev = await loadElevations(meta);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e141b);

  const camera = new THREE.PerspectiveCamera(
    47,
    window.innerWidth / window.innerHeight,
    5,
    60000,
  );
  // Start above the valley floor looking north-east toward Monte Perdido.
  camera.position.set(-2500, 5200, 10500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(1500, 1800, -1500);
  controls.enableDamping = true;
  controls.update();

  const group = new THREE.Group();
  scene.add(group);

  const sun = createSun(scene);
  let azimuth = 135;
  let elevation = 38;
  sun.setSun(azimuth, elevation, 22000);

  // LOD steps 1/2/4, boot at step 2, step 1 behind a control.
  let step = 2;
  let exaggeration = 1.0;
  let terrain: THREE.Mesh | null = null;
  const texLoader = new THREE.TextureLoader();
  let texture: THREE.Texture | null = null;

  function refreshShadow(): void {
    renderer.shadowMap.needsUpdate = true;
  }

  function rebuildTerrain(): void {
    if (terrain) {
      group.remove(terrain);
      terrain.geometry.dispose();
      (terrain.material as THREE.Material).dispose();
    }
    const geo = buildTerrainGeometry(elev, meta, world, step);
    const mat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 1.0,
      metalness: 0.0,
    });
    terrain = new THREE.Mesh(geo, mat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    group.add(terrain);
    group.scale.y = exaggeration;
    refreshShadow();
  }

  // Texture in two passes: 2k first paint, 8k swapped in behind.
  function loadTexture(url: string): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      texLoader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = renderer.capabilities.getMaxAnisotropy();
          resolve(t);
        },
        undefined,
        reject,
      );
    });
  }

  let routeMesh: THREE.Mesh | null = null;

  // --- HUD ---
  const hud = el("div", "hud");
  const readout = el("div", "hud-readout", "—");
  const readoutLabel = el("div", "hud-label", "cota bajo el cursor");
  const readoutWrap = el("div", "hud-block");
  readoutWrap.append(readoutLabel, readout);
  hud.appendChild(readoutWrap);

  function slider(
    label: string,
    min: number,
    max: number,
    value: number,
    stepAttr: number,
    onInput: (v: number) => void,
  ): HTMLElement {
    const wrap = el("div", "hud-block");
    const lab = el("div", "hud-label", label);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(stepAttr);
    input.value = String(value);
    input.addEventListener("input", () => onInput(Number(input.value)));
    wrap.append(lab, input);
    return wrap;
  }

  hud.appendChild(
    slider("sol · azimut", 0, 360, azimuth, 1, (v) => {
      azimuth = v;
      sun.setSun(azimuth, elevation, 22000);
      refreshShadow();
    }),
  );
  hud.appendChild(
    slider("sol · altura", 5, 80, elevation, 1, (v) => {
      elevation = v;
      sun.setSun(azimuth, elevation, 22000);
      refreshShadow();
    }),
  );
  hud.appendChild(
    slider("exageración vertical", 1, 2, 1, 0.05, (v) => {
      exaggeration = v;
      group.scale.y = exaggeration;
      refreshShadow();
    }),
  );
  const lodWrap = el("div", "hud-block");
  lodWrap.appendChild(el("div", "hud-label", "detalle de malla"));
  const lodBtns = el("div", "hud-row");
  for (const s of [1, 2, 4]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `paso ${s}`;
    b.className = s === step ? "hud-btn active" : "hud-btn";
    b.addEventListener("click", () => {
      step = s;
      for (const c of lodBtns.children) c.classList.remove("active");
      b.classList.add("active");
      rebuildTerrain();
    });
    lodBtns.appendChild(b);
  }
  lodWrap.appendChild(lodBtns);
  hud.appendChild(lodWrap);
  document.body.appendChild(hud);

  // First build with no texture (relief: UV-mapped grey until 2k arrives),
  // then progressive texture. Single readout loop for the viewer lifetime.
  attachAltitudeReadout(renderer, camera, () => terrain, readout);
  rebuildTerrain();
  status.textContent = "cargando ortofoto 2k…";
  texture = await loadTexture("/assets/terrain-2k.webp");
  if (terrain) {
    (terrain.material as THREE.MeshStandardMaterial).map = texture;
    (terrain.material as THREE.MeshStandardMaterial).needsUpdate = true;
  }

  status.textContent = "cargando trazado…";
  const route = await loadRoute();
  routeMesh = buildRouteLine(route, world);
  group.add(routeMesh);

  status.textContent = "cargando ortofoto 8k…";
  try {
    const hi = await loadTexture("/assets/terrain-8k.webp");
    texture?.dispose();
    texture = hi;
    if (terrain) {
      (terrain.material as THREE.MeshStandardMaterial).map = texture;
      (terrain.material as THREE.MeshStandardMaterial).needsUpdate = true;
    }
  } catch {
    // 8k failed (mobile?): the 2k texture stays. Not fatal.
  }
  status.textContent = "";
  status.remove();
  refreshShadow();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}
