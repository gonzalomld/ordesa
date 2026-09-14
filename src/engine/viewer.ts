// viewer.ts — phase-2 viewer: gate + continuous sun/sky + height fog +
// clouds + Line2 track + telemetry + labels + derived camera.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Sky } from "three/addons/objects/Sky.js";
import { buildClouds } from "./clouds.ts";
import { mountDebug, parseBootQuery } from "./debug.ts";
import { buildGate, nextFrame } from "./gate.ts";
import { fogUniforms, patchTerrainMaterial } from "./height-fog.ts";
import {
  buildLabels,
  rayBlocked,
  updateLabels,
  type LabelDef,
} from "./labels.ts";
import { buildRouteLine2 } from "./route-line2.ts";
import { lightingAt, sunPosition } from "./sun.ts";
import {
  driveTelemetry,
  loadRouteData,
  projectCameraToS,
  telemetryAt,
  type RouteData,
  type TeleCells,
} from "./telemetry.ts";
import {
  buildTerrainGeometry,
  epsgToWorld,
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

async function fetchWithProgress(
  url: string,
  total: number,
  onBytes: (n: number) => void,
): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body) {
    const b = await res.blob();
    onBytes(b.size);
    return b;
  }
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    got += (value as Uint8Array).length;
    onBytes(got);
    void total;
  }
  return new Blob(chunks, { type: res.headers.get("content-type") ?? "" });
}

function hhmm(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function startViewer(canvas: HTMLCanvasElement): Promise<void> {
  const boot = parseBootQuery();
  const { metrics } = mountDebug();

  const meta = await loadMeta();
  const sizes = meta.sizesBytes ?? {};
  const world = worldFromMeta(meta);
  (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer = undefined;

  // --- renderer / scene / camera ---
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // R2: shadows ON, static map refreshed only when the sun moves.
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer = renderer;
  const maxTex = renderer.capabilities.maxTextureSize;
  metrics.maxTextureSize = maxTex;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e141b);
  scene.fog = null;

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 5, 80000);
  const camJson = (await fetch("/assets/camera.json").then((r) => r.json()).catch(() => null)) as {
    reference: { epsgX: number; epsgY: number; epsgZ: number };
  } | null;
  const CE = camJson?.reference ?? { epsgX: 738600, epsgY: 4725200, epsgZ: 4000 };
  const portrait = window.innerWidth < window.innerHeight;
  const back = portrait ? 1.35 : 1;
  const [cwx, cwy, cwz] = epsgToWorld(CE.epsgX, CE.epsgY, CE.epsgZ, world);
  camera.position.set(cwx * back, cwy, cwz * back);
  // R5: closer, steeper general framing — the canyon axis in depth, not the
  // plateau. Target sits ON the canyon floor mid-valley; the rest (faja,
  // rim, Perdido) falls above it in frame.
  const controls = new OrbitControls(camera, renderer.domElement);
  {
    const [tx, ty, tz] = epsgToWorld(743600, 4725600, 1650, world);
    controls.target.set(tx, ty, tz);
  }
  controls.enableDamping = true;
  if (boot.cam === "pradera") {
    const [px, py, pz] = epsgToWorld(741218, 4726062, 1321, world);
    camera.position.set(px - 1500, 2600, pz + 2500);
    controls.target.set(px, py, pz);
  } else if (boot.cam === "mirador") {
    const [px, py, pz] = epsgToWorld(741507, 4725203, 1960, world);
    camera.position.set(px - 800, 2900, pz + 1800);
    controls.target.set(px, py, pz);
  } else if (boot.cam === "circo") {
    // R5 reference framing: low inside the circo, Cola + strata readable.
    const [px, py, pz] = epsgToWorld(747191, 4726348, 1762, world);
    camera.position.set(px - 2600, 2600, pz + 2400);
    controls.target.set(px, py, pz);
  }
  controls.update();

  // --- sun + sky (R2: static 2048 shadow map over the whole frame) ---
  const sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
  sun.castShadow = true;
  {
    // 10.8 × 8.2 km frame → ±5.500 half-extent; near/far span the
    // 1.107–3.347 m relief seen from the sun position (r = 22000).
    const s = 5500;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 5000;
    sun.shadow.camera.far = 40000;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 3;
  }
  scene.add(sun, sun.target);
  let shadowNeedsUpdate = true;
  const hemi = new THREE.HemisphereLight(0xbdd3e6, 0x5c5648, 0.5);
  scene.add(hemi);
  const sky = new Sky();
  sky.scale.setScalar(60000);
  scene.add(sky);
  const skyU = sky.material.uniforms as Record<string, { value: unknown }>;
  const nightBg = new THREE.Color(0x05070f);

  let hour = boot.t ? Number(boot.t.split(":")[0]) + Number(boot.t.split(":")[1] ?? 0) / 60 : 8.7;
  metrics.time = hhmm(hour);
  metrics.cam = boot.cam ?? "general";

  let routeDim = 1;
  const sunDirV = new THREE.Vector3(0, 1, 0);
  let cloudDensity = 0.5;

  function applyLighting(h: number): void {
    const L = lightingAt(h);
    const sp = sunPosition(h);
    const az = (sp.azimuthDeg * Math.PI) / 180;
    const ev = (sp.elevationDeg * Math.PI) / 180;
    const r = 22000;
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(ev),
      Math.sin(ev),
      -Math.cos(az) * Math.cos(ev),
    );
    sun.position.copy(dir.clone().multiplyScalar(r));
    sun.color.setHex(L.sunColor);
    sun.intensity = L.sunIntensity;
    shadowNeedsUpdate = true;
    // sky: Preetham by day, fade to night below horizon
    (skyU["turbidity"] as { value: number }).value = L.turbidity;
    (skyU["rayleigh"] as { value: number }).value = L.rayleigh;
    (skyU["mieCoefficient"] as { value: number }).value = L.mieCoefficient;
    (skyU["mieDirectionalG"] as { value: number }).value = L.mieDirectionalG;
    (skyU["sunPosition"] as { value: THREE.Vector3 }).value.copy(dir);
    sky.visible = L.nightMix < 1;
    (scene.background as THREE.Color).copy(nightBg).lerp(new THREE.Color(0x0e141b), 1 - L.nightMix);
    if (L.nightMix >= 1) scene.background = nightBg;
    renderer.toneMappingExposure = L.exposure;
    // fog uniforms: sky-tinted haze colour sampled coarsely from sun height
    const warm = Math.max(0, 1 - Math.abs(sp.elevationDeg - 12) / 25);
    fogUniforms.uFogTop.value = L.fogTopM;
    fogUniforms.uFogDensity.value = 0.25 + L.fogDensity * 0.75;
    const top: [number, number, number] = L.nightMix > 0.5
      ? [0.02, 0.03, 0.07]
      : [0.55 + warm * 0.35, 0.6 + warm * 0.15, 0.72 - warm * 0.2];
    fogUniforms.uSkyColor.value = top;
    hemi.intensity = 0.25 + 0.35 * (1 - L.nightMix);
    // dim the track slightly at twilight
    routeDim = 1 - L.nightMix * 0.3;
    sunDirV.copy(dir);
    cloudDensity = L.cloudDensity;
  }

  // --- gate + progress (R0: global 45 s watchdog — never wait forever) ---
  const gate = buildGate(() => undefined);
  const watchdog = window.setTimeout(() => {
    gate.fail("la carga está tardando demasiado; comprueba tu conexión y recarga");
  }, 45000);
  const clearWatchdog = (): void => window.clearTimeout(watchdog);
  const totalBytes =
    (sizes["terrain-base-2048"] ?? 700_000) +
    (meta.width * meta.height * 0.4) +
    200_000;
  let gotBytes = 0;

  const group = new THREE.Group();
  scene.add(group);

  // texture level by maxTextureSize (base never above 4096 → mobile-safe)
  const texLevel = maxTex >= 8192 ? "full" : maxTex >= 4096 ? "mid" : "lite";
  metrics.texLevel = texLevel;
  const baseAsset = texLevel === "lite" ? meta.assets?.["terrain-base-2048"] : meta.assets?.["terrain-base"];
  const corrAsset = texLevel === "full"
    ? meta.assets?.["terrain-corridor"]
    : texLevel === "mid"
      ? meta.assets?.["terrain-corridor-4k"]
      : undefined;

  // --- load order: meta → heightmap(+mesh) → base → route → corridor/normal → clouds ---
  gate.setProgress(0.02, 0);
  const blobH = await fetchWithProgress(`/${meta.assets?.heightmap ?? "assets/heightmap.png"}`, 0, (n) => {
    gotBytes = Math.max(gotBytes, n * 0.2);
    gate.setProgress(Math.min(0.7, gotBytes / totalBytes), 0);
  }).catch((e) => {
    gate.fail(`no se ha podido cargar el terreno: ${e instanceof Error ? e.message : e}`);
    throw e;
  });
  await nextFrame();
  // R0: decode with try/catch + <img> fallback after 10 s. A silent stall
  // here is exactly what a user on a browser without
  // colorSpaceConversion:"none" would see.
  async function decodeHeightmap(blob: Blob): Promise<Float32Array> {
    const decode = async (bmp: ImageBitmap): Promise<Float32Array> => {
      const cv = document.createElement("canvas");
      cv.width = meta.width;
      cv.height = meta.height;
      const cx2 = cv.getContext("2d", { willReadFrequently: true });
      if (!cx2) throw new Error("2d context unavailable");
      cx2.drawImage(bmp, 0, 0);
      bmp.close();
      const img = cx2.getImageData(0, 0, meta.width, meta.height);
      const dd = img.data;
      const out = new Float32Array(meta.width * meta.height);
      for (let i = 0; i < out.length; i++) out[i] = meta.minZ + (dd[i * 4] as number) * 256 + (dd[i * 4 + 1] as number);
      return out;
    };
    const viaBitmap = async (): Promise<Float32Array> =>
      decode(await createImageBitmap(blob, { colorSpaceConversion: "none" }));
    const viaImg = async (): Promise<Float32Array> => {
      const url = URL.createObjectURL(blob);
      try {
        const img = document.createElement("img");
        img.decoding = "sync";
        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(() => reject(new Error("img decode timeout")), 20000);
          img.onload = () => {
            window.clearTimeout(t);
            resolve();
          };
          img.onerror = () => {
            window.clearTimeout(t);
            reject(new Error("img decode failed"));
          };
          img.src = url;
        });
        const cv = document.createElement("canvas");
        cv.width = meta.width;
        cv.height = meta.height;
        const cx2 = cv.getContext("2d", { willReadFrequently: true });
        if (!cx2) throw new Error("2d context unavailable");
        cx2.drawImage(img, 0, 0);
        const d = cx2.getImageData(0, 0, meta.width, meta.height).data;
        const out = new Float32Array(meta.width * meta.height);
        for (let i = 0; i < out.length; i++) out[i] = meta.minZ + (d[i * 4] as number) * 256 + (d[i * 4 + 1] as number);
        return out;
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    try {
      return await Promise.race([
        viaBitmap(),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error("bitmap-timeout")), 10000),
        ),
      ]);
    } catch (e1) {
      try {
        return await viaImg();
      } catch (e2) {
        const msg = `no se pudo decodificar el relieve (${e1 instanceof Error ? e1.message : e1} / ${e2 instanceof Error ? e2.message : e2})`;
        gate.fail(msg);
        throw new Error(msg);
      }
    }
  }
  let elev: Float32Array;
  try {
    elev = await decodeHeightmap(blobH);
  } catch {
    return; // gate.fail already shows the message
  }
  void loadElevations;
  gate.setProgress(0.5, 0);
  await nextFrame();

  let step = 2;
  metrics.lod = step;
  let terrain: THREE.Mesh | null = null;
  let terrainMat: THREE.MeshStandardMaterial | null = null;
  const texLoader = new THREE.TextureLoader();
  function loadTex(url: string, srgb: boolean): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => {
      texLoader.load(url, (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        resolve(t);
      }, undefined, reject);
    });
  }

  function rebuildTerrain(): void {
    if (terrain) {
      group.remove(terrain);
      terrain.geometry.dispose();
    }
    const geo = buildTerrainGeometry(elev, meta, world, step);
    if (!terrainMat) {
      terrainMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
      patchTerrainMaterial(terrainMat);
      const prev = terrainMat.onBeforeCompile.bind(terrainMat);
      terrainMat.onBeforeCompile = (s: {
        uniforms: Record<string, unknown>;
        fragmentShader: string;
        vertexShader: string;
      }) => {
        prev(s);
        s.uniforms["uCorridor"] = corridorUniform;
        s.uniforms["uNormalMap2"] = normalUniform;
        s.uniforms["uNormalStrength"] = normalStrength;
        s.uniforms["uRock"] = rockUniform;
        s.uniforms["uTriStart"] = triStart;
        s.uniforms["uTriScale"] = triScale;
        s.uniforms["uHasCorr"] = hasCorr;
        s.uniforms["uHasNormal"] = hasNormal;
        s.uniforms["uHasRock"] = hasRock;
        s.vertexShader = s.vertexShader
          .replace("#include <common>", "#include <common>\nattribute vec3 uv2c; varying vec3 vUv2c; varying vec3 vWPos2; varying vec3 vWNormal2;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvUv2c = uv2c;")
          .replace("#include <fog_vertex>", "#include <fog_vertex>\nvWPos2 = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal2 = normalize(mat3(modelMatrix) * objectNormal);");
        s.fragmentShader = s.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
uniform sampler2D uCorridor; uniform sampler2D uNormalMap2; uniform float uNormalStrength; varying vec3 vUv2c;
uniform sampler2D uRock; uniform float uTriStart; uniform float uTriScale;
uniform float uHasCorr; uniform float uHasNormal; uniform float uHasRock;
varying vec3 vWPos2; varying vec3 vWNormal2;`,
          )
          .replace(
            "#include <map_fragment>",
            `#include <map_fragment>
#ifdef USE_MAP
  vec4 corr = texture2D(uCorridor, vUv2c.xy);
  float wcorr = vUv2c.z * uHasCorr;
  vec3 alb = mix(diffuseColor.rgb, corr.rgb, wcorr);
  // R1 selective triplanar: steep faces sample the rock tile laterally
  // (world XZ/Y in metres, tile ≈ 60 m repeat, mirrored to hide seams).
  vec3 wn2 = normalize(vWNormal2);
  float steep = pow(clamp((1.0 - wn2.y - uTriStart) * uTriScale * 60.0, 0.0, 1.0), 4.0) * uHasRock;
  if (steep > 0.001) {
    float rep = 60.0;
    vec2 ruvX = vec2(vWPos2.z / rep, vWPos2.y / rep);
    vec2 ruvZ = vec2(vWPos2.x / rep, vWPos2.y / rep);
    float wx = pow(abs(wn2.x), 4.0);
    float wz = pow(abs(wn2.z), 4.0);
    float wsum = wx + wz;
    vec3 rock = vec3(0.0);
    if (wx > 0.001) rock += texture2D(uRock, ruvX).rgb * (wx / max(wsum, 1e-4));
    if (wz > 0.001) rock += texture2D(uRock, ruvZ).rgb * (wz / max(wsum, 1e-4));
    alb = mix(alb, rock, steep * (wsum > 0.001 ? 1.0 : 0.0));
  }
  diffuseColor.rgb = alb;
#endif`,
          )
          .replace(
            "#include <normal_fragment_maps>",
            `#include <normal_fragment_maps>
{
  vec3 nt2 = texture2D(uNormalMap2, vMapUv).rgb * 2.0 - 1.0;
  nt2.xy *= uNormalStrength * uHasNormal;
  normal = normalize(normal + vec3(nt2.x, nt2.y, 0.0) * 0.35);
}`,
          );
      };
      terrainMat.customProgramCacheKey = () => "ordesa-base+corridor";
    }
    terrain = new THREE.Mesh(geo, terrainMat);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    group.add(terrain);
  }
  const corridorUniform = { value: null as THREE.Texture | null };
  const normalUniform = { value: null as THREE.Texture | null };
  const normalStrength = { value: 1.0 };
  // R1: selective triplanar — rock tile projected laterally on steep faces.
  const rockUniform = { value: null as THREE.Texture | null };
  const triStart = { value: 1 - Math.cos((40 * Math.PI) / 180) };
  const triScale = { value: 1 / 120 };
  const hasCorr = { value: 0 };
  const hasNormal = { value: 0 };
  const hasRock = { value: 0 };

  rebuildTerrain();
  gate.setProgress(0.62, 1);
  applyLighting(hour);
  renderer.compile(scene, camera);
  renderer.shadowMap.needsUpdate = true;
  shadowNeedsUpdate = false;
  await nextFrame();

  // base texture
  try {
    const t = await loadTex(`/${baseAsset ?? "assets/terrain-2k.webp"}`, true);
    if (terrainMat) {
      terrainMat.map = t;
      terrainMat.needsUpdate = true;
    }
  } catch {
    gate.fail("no se ha podido cargar la ortofoto base; sigo con relieve");
  }
  gate.setProgress(0.68, 1);
  gate.ready();
  await nextFrame();

  // route (arrays-parallel) + Line2
  let route: RouteData;
  try {
    route = await loadRouteData();
  } catch (e) {
    gate.fail(`no se ha podido cargar la senda: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
  const res2 = new THREE.Vector2(
    renderer.domElement.width,
    renderer.domElement.height,
  );
  const line = buildRouteLine2(route, world, elev, meta, res2);
  group.add(line.group);
  gate.setProgress(0.72, 4);
  await nextFrame();

  // corridor + normal + rock behind (never block first paint)
  if (corrAsset) {
    loadTex(`/${corrAsset}`, true).then((t) => {
      corridorUniform.value = t;
      hasCorr.value = 1;
      if (terrainMat) terrainMat.needsUpdate = true;
    }).catch(() => undefined);
  }
  if (meta.assets?.["terrain-normal"] && texLevel !== "lite") {
    loadTex(`/${meta.assets["terrain-normal"]}`, false).then((t) => {
      normalUniform.value = t;
      hasNormal.value = 1;
      if (terrainMat) terrainMat.needsUpdate = true;
    }).catch(() => undefined);
  }
  if (meta.assets?.["terrain-rock"]) {
    loadTex(`/${meta.assets["terrain-rock"]}`, true).then((t) => {
      t.wrapS = THREE.MirroredRepeatWrapping;
      t.wrapT = THREE.MirroredRepeatWrapping;
      rockUniform.value = t;
      hasRock.value = 1;
      if (terrainMat) terrainMat.needsUpdate = true;
    }).catch(() => undefined);
  }

  // clouds
  const clouds = buildClouds(meta, `/${meta.assets?.["clouds-atlas"] ?? "assets/clouds-atlas.webp"}`);
  scene.add(clouds.group);
  gate.setProgress(0.8, 5);
  await nextFrame();

  // labels
  const labelLayer = el("div", "labels");
  document.body.appendChild(labelLayer);
  const labelDefs = (await fetch("/assets/labels.json").then((r) => r.json()).catch(() => ({ labels: [] }))) as {
    labels: LabelDef[];
  };
  const labelRts = buildLabels(labelDefs.labels, world.centerX, world.centerY, labelLayer);

  // --- telemetry bar (7 cols) ---
  const tele = el("div", "tele");
  const cells: TeleCells = {
    alt: el("div", "tele-v"),
    climb: el("div", "tele-v"),
    km: el("div", "tele-v"),
    slope: el("div", "tele-v"),
    hour: el("div", "tele-v"),
    sun: el("div", "tele-v"),
    act: el("div", "tele-v"),
  };
  const cols: [string, HTMLElement][] = [
    ["ALTITUD", cells.alt],
    ["DESNIVEL ACUM.", cells.climb],
    ["KM", cells.km],
    ["PENDIENTE", cells.slope],
    ["HORA", cells.hour],
    ["SOL", cells.sun],
    ["ACTO", cells.act],
  ];
  for (const [lab, v] of cols as [string, HTMLElement][]) {
    const c = el("div", "tele-c");
    const l = el("div", "tele-l", lab);
    c.append(l, v);
    tele.appendChild(c);
  }
  document.body.appendChild(tele);
  const lastTele: Record<string, string> = {};
  let sCur = 0;

  // --- HUD: time slider + normal strength + LOD ---
  const hud = el("div", "hud2");
  const timeLab = el("div", "hud-label", `hora ${hhmm(hour)}`);
  const time = document.createElement("input");
  time.type = "range";
  time.min = "6.5";
  time.max = "17.5";
  time.step = "0.05";
  time.value = String(hour);
  time.setAttribute("aria-label", "hora del día");
  time.addEventListener("input", () => {
    hour = Number(time.value);
    timeLab.textContent = `hora ${hhmm(hour)}`;
    metrics.time = hhmm(hour);
    applyLighting(hour);
  });
  const nLab = el("div", "hud-label", "detalle del normal map");
  const nIn = document.createElement("input");
  nIn.type = "range";
  nIn.min = "0";
  nIn.max = "2";
  nIn.step = "0.05";
  nIn.value = "1";
  nIn.setAttribute("aria-label", "intensidad del normal map");
  nIn.addEventListener("input", () => {
    normalStrength.value = Number(nIn.value);
  });
  // R1 calibration: slope threshold where lateral rock projection kicks in
  const tLab = el("div", "hud-label", "pared desde 40°");
  const tIn = document.createElement("input");
  tIn.type = "range";
  tIn.min = "20";
  tIn.max = "60";
  tIn.step = "1";
  tIn.value = "40";
  tIn.setAttribute("aria-label", "umbral de pendiente de proyección lateral");
  tIn.addEventListener("input", () => {
    const deg = Number(tIn.value);
    tLab.textContent = `pared desde ${deg}°`;
    triStart.value = 1 - Math.cos((deg * Math.PI) / 180);
  });
  const lodRow = el("div", "hud-row");
  for (const st of [1, 2, 4]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `paso ${st}`;
    b.className = st === step ? "hud-btn active" : "hud-btn";
    b.addEventListener("click", () => {
      step = st;
      metrics.lod = st;
      for (const c of lodRow.children) c.classList.remove("active");
      b.classList.add("active");
      rebuildTerrain();
      if (terrainMat?.map) terrainMat.needsUpdate = true;
    });
    lodRow.appendChild(b);
  }
  hud.append(timeLab, time, nLab, nIn, tLab, tIn, lodRow);
  document.body.appendChild(hud);

  gate.setProgress(1, 5);
  clearWatchdog();
  await nextFrame();
  applyLighting(hour);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    res2.set(renderer.domElement.width, renderer.domElement.height);
    for (const m of line.group.children) {
      const lm = (m as { material: { resolution: THREE.Vector2 } }).material;
      lm.resolution.copy(res2);
    }
  });

  const clock = new THREE.Clock();

  let frames = 0;
  renderer.setAnimationLoop(() => {
    const t0 = performance.now();
    controls.update();
    // s from camera (phase 2)
    sCur = projectCameraToS(route, world, camera.position.x, camera.position.y, camera.position.z, sCur);
    const t = telemetryAt(route, sCur);
    const sp = sunPosition(hour);
    driveTelemetry(cells, lastTele, t, hhmm(hour), sp.elevationDeg);
    clouds.setDensity(cloudDensity, sunDirV);
    clouds.update(clock.elapsedTime, camera);
    line.setDim(routeDim);
    const t1 = performance.now();
    if (shadowNeedsUpdate) {
      renderer.shadowMap.needsUpdate = true;
      shadowNeedsUpdate = false;
    }
    renderer.render(scene, camera);
    const t2 = performance.now();
    // labels every frame (project cheap), occlusion every ~6th frame
    if (frames % 6 === 0) {
      for (const rt of labelRts) {
        rt.occluded = rayBlocked(
          elev,
          meta,
          world.centerX,
          world.centerY,
          camera.position.x,
          camera.position.y,
          camera.position.z,
          rt as unknown as Parameters<typeof rayBlocked>[7],
        );
      }
    }
    updateLabels(labelRts, camera, window.innerWidth, window.innerHeight, 30000);
    const t3 = performance.now();
    metrics.msTerrain = Math.max(0, t2 - t1);
    metrics.msClouds = 0; // clouds render inside the main pass; isolated in ?debug via draw-call note
    metrics.msPost = 0;
    metrics.msLabels = Math.max(0, t3 - t2);
    metrics.msFrame = Math.max(0, t3 - t0);
    frames++;
  });
}
