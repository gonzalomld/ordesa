// viewer.ts — phase-3A viewer: scroll drives the journey via narrative/rig.
// The render loop is the project's SINGLE requestAnimationFrame: it pumps
// lenis, progress and rig.update(dt) — nothing else moves the camera.
// Instruments (OrbitControls, tuning HUD) live behind URL flags.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { createRig } from "../narrative/camera-rig.ts";
import {
  CAM_FAR,
  CAM_NEAR,
  CAM_PRESETS_S,
  CLOUD_FADE_START_DEG,
  CLOUD_ZENITH_FADE,
  CORRIDOR_HALF_M,
  EPILOGUE_S,
  G11_LUMA_MIN,
  GLOW_S_WINDOW,
  HEMI_DAY,
  HEMI_GROUND_RGB,
  HEMI_LUMA_FLOOR,
  HEMI_NIGHT,
  HEMI_SKY_RGB,
  LUMA_GRID,
  SHADOW_EPS_DEG,
  SHADOW_EXTENT_M,
  SHADOW_FAR_M,
  SHADOW_LIGHT_DIST_M,
  SHADOW_MIN_FRAMES,
  SHADOW_MOVE_EPS_M,
  SHADOW_NEAR_M,
  SUNSET_ELEV_DEG,
} from "../narrative/choreography.ts";
import { initProgress, type ProgressHandle } from "../narrative/progress.ts";
import { createScroll, type ScrollHandle } from "../narrative/scroll.ts";
import { buildClouds } from "./clouds.ts";
import { frameClock, mountDebug, parseBootQuery } from "./debug.ts";
import { buildGate, nextFrame } from "./gate.ts";
import { createSkyCapture, type SkyCapture } from "./sky-capture.ts";
import { fogUniforms, patchTerrainMaterial } from "./height-fog.ts";
import {
  buildLabels,
  rayBlocked,
  updateLabels,
  type LabelDef,
} from "./labels.ts";
import { buildRouteLine, renderCount } from "./route-line.ts";
import { lightingAt, sunPosition } from "./sun.ts";
import {
  driveTelemetry,
  loadRouteData,
  type RouteData,
  type TeleCells,
} from "./telemetry.ts";
import {
  buildTerrainGeometry,
  loadElevations,
  loadMeta,
  meshHeightAtStep2,
  worldFromMeta,
} from "./terrain.ts";

function el(tag: string, cls: string, text = ""): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** E3 uGlow: 1 at the milestone s, 0 outside +-GLOW_S_WINDOW. */
function glowNear(s: number, milestoneS: number): number {
  return Math.min(1, Math.max(0, (GLOW_S_WINDOW - Math.abs(s - milestoneS)) / GLOW_S_WINDOW));
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

// U3: hour keeps full precision; telemetry only mirrors it (1 min steps).
// hhmm rounds to the nearest minute so ?t=14:00 reads 14:00, not 13:56.
function hhmm(h: number): string {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export async function startViewer(canvas: HTMLCanvasElement): Promise<void> {
  const boot = parseBootQuery();
  const { metrics } = mountDebug();
  // ?debug=steep: false-colour steep-weight map (R = raw geometric weight,
  // G = effective weight, B = rock loaded) — ends the blind tuning.
  metrics.steep = boot.steep;

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
  // R2: shadows ON, static map refreshed only on sun/target moves (3A gate).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer = renderer;
  const maxTex = renderer.capabilities.maxTextureSize;
  metrics.maxTextureSize = maxTex;

  const scene = new THREE.Scene();
  // S2.1: while the Sky dome paints, background stays a dark fallback only.
  scene.background = new THREE.Color(0x0e141b);
  scene.fog = null;

  // T3: near 50 (never within 500 m of anything) + far 40000 (terrain
  // ends < 20 km). Two lines, strictly better depth precision, cannot hurt.
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, CAM_NEAR, CAM_FAR);

  // --- sun + sky (B4: light follows the rig target, 1800 m box) ---
  const sun = new THREE.DirectionalLight(0xfff3e2, 2.4);
  sun.castShadow = true;
  {
    const s = SHADOW_EXTENT_M / 2;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = SHADOW_NEAR_M;
    sun.shadow.camera.far = SHADOW_FAR_M;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 3;
  }
  scene.add(sun, sun.target);
  let shadowNeedsUpdate = true;
  let lastShadowAz = Infinity;
  let lastShadowEl = Infinity;
  let lastShadowTx = Infinity;
  let lastShadowTy = Infinity;
  let lastShadowTz = Infinity;
  let framesSinceShadow = SHADOW_MIN_FRAMES;
  const hemi = new THREE.HemisphereLight(0xbdd3e6, 0x5c5648, 0.5);
  scene.add(hemi);
  // R1b: the scene holds no three Light that the terrain shader reads —
  // the fill travels as uniforms (fogUniforms.uHemiSky/uHemiDay) into the
  // patched terrain material. The HemisphereLight stays for the route line
  // and any standard materials; the terrain ignores it by construction.
  const hemiSky = new THREE.Color(0x6b8cc7);
  const hemiGround = new THREE.Color(
    HEMI_GROUND_RGB[0] as number,
    HEMI_GROUND_RGB[1] as number,
    HEMI_GROUND_RGB[2] as number,
  );
  const sky = new Sky();
  sky.scale.setScalar(60000);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  const skyU = sky.material.uniforms as Record<string, { value: unknown }>;
  const nightBg = new THREE.Color(0x05070f);
  let skyCap: SkyCapture | null = null;

  let routeDim = 1;
  const sunDirV = new THREE.Vector3(0, 1, 0);
  let cloudDensity = 0.5;

  function applyLighting(h: number): void {
    const L = lightingAt(h);
    const sp = sunPosition(h);
    const az = (sp.azimuthDeg * Math.PI) / 180;
    const ev = (sp.elevationDeg * Math.PI) / 180;
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(ev),
      Math.sin(ev),
      -Math.cos(az) * Math.cos(ev),
    );
    // B4: position follows the rig target every frame (viewer loop sets
    // sun.position/target from the same dir); colours only here.
    sunDirV.copy(dir);
    sun.color.setHex(L.sunColor);
    sun.intensity = L.sunIntensity;
    (skyU["turbidity"] as { value: number }).value = L.turbidity;
    (skyU["rayleigh"] as { value: number }).value = L.rayleigh;
    (skyU["mieCoefficient"] as { value: number }).value = L.mieCoefficient;
    (skyU["mieDirectionalG"] as { value: number }).value = L.mieDirectionalG;
    (skyU["sunPosition"] as { value: THREE.Vector3 }).value.copy(dir);
    sky.visible = L.nightMix < 1;
    if (L.nightMix >= 1) {
      scene.background = nightBg;
    } else {
      scene.background = null;
    }
    renderer.toneMappingExposure = L.exposure;
    const warm = Math.max(0, 1 - Math.abs(sp.elevationDeg - 12) / 25);
    fogUniforms.uFogTop.value = L.fogTopM;
    fogUniforms.uFogDensity.value = 0.25 + L.fogDensity * 0.75;
    const top: [number, number, number] = L.nightMix > 0.5
      ? [0.02, 0.03, 0.07]
      : [0.55 + warm * 0.35, 0.6 + warm * 0.15, 0.72 - warm * 0.2];
    fogUniforms.uSkyColor.value = top;
    // A6/R1b: the valley in shadow is lit by the SKY, not the sun. Dome
    // colour from the same zenith estimate the overlay prints; it travels
    // as a terrain-shader uniform (no three Light reads it). The daylight
    // factor is 1 between sunrise and sunset — NEVER sin(altitude): at
    // 07:24 with the sun at 2.1 deg the valley still needs full sky light.
    // BLOCKER R1b floor: keep the real hue, lift only the level so the
    // early acts clear HEMI_LUMA_FLOOR instead of sitting at 0.009-0.037.
    {
      const ray = L.rayleigh;
      const elevF = Math.max(0, Math.min(1, sp.elevationDeg / 60));
      const zr = Math.min(1, Math.max(0, 0.12 + 0.1 * elevF + 0.05 * ray)) * (HEMI_SKY_RGB[0] as number) * 2;
      const zg = Math.min(1, Math.max(0, 0.32 + 0.22 * elevF)) * (HEMI_SKY_RGB[1] as number) * 2;
      const zb = Math.min(1, Math.max(0, 0.62 + 0.2 * elevF - 0.08 * ray)) * (HEMI_SKY_RGB[2] as number) * 2;
      const lumaSky = 0.2126 * zr + 0.7152 * zg + 0.0722 * zb;
      const lift = Math.max(1, HEMI_LUMA_FLOOR / Math.max(1e-6, lumaSky));
      hemiSky.setRGB(zr * lift, zg * lift, zb * lift);
      hemi.color.copy(hemiSky);
      hemi.groundColor.copy(hemiGround);
      const dayF = sp.elevationDeg > SUNSET_ELEV_DEG ? 1 : 0;
      hemi.intensity = HEMI_DAY * dayF + HEMI_NIGHT * (1 - dayF);
      (fogUniforms.uHemiSky.value as [number, number, number])[0] = zr * 0.5 * lift;
      (fogUniforms.uHemiSky.value as [number, number, number])[1] = zg * 0.5 * lift;
      (fogUniforms.uHemiSky.value as [number, number, number])[2] = zb * 0.5 * lift;
      (fogUniforms.uHemiDay as { value: number }).value = dayF;
    }
    routeDim = 1 - L.nightMix * 0.3;
    cloudDensity = L.cloudDensity;
    if (boot.debug) {
      const ray = L.rayleigh;
      const elevF = Math.max(0, Math.min(1, sp.elevationDeg / 60));
      const zr = Math.round(Math.min(255, Math.max(0, 255 * (0.12 + 0.1 * elevF + 0.05 * ray))));
      const zg = Math.round(Math.min(255, Math.max(0, 255 * (0.32 + 0.22 * elevF))));
      const zb = Math.round(Math.min(255, Math.max(0, 255 * (0.62 + 0.2 * elevF - 0.08 * ray))));
      metrics.zenithHex = `#${zr.toString(16).padStart(2, "0")}${zg.toString(16).padStart(2, "0")}${zb.toString(16).padStart(2, "0")}`;
      const dfog = fogUniforms.uFogDensity.value as number;
      const x10 = 10000 / 9000;
      const df10 = 1 - Math.exp(-x10 * x10 * x10 * x10 * 3.4);
      metrics.fog10km = Math.min(1, Math.max(0, df10 * (0.45 + 0.55 * dfog)));
    }
  }

  // --- gate + progress (R0: global 45 s watchdog — never wait forever) ---
  // P0/G20: after first render, a dead GL program must blame graphics, not
  // the network. renderer.info.programs[].diagnostics.runnable === false
  // means the shader never compiled — the gate message says so and
  // ?debug=1 prints the program diagnostics. The ?s= boot path compiles
  // the terrain program AFTER the first render (pose known only then), so
  // the check runs late (frame 60) to let the real texture arrive first.
  function checkGLPrograms(): string | null {
    try {
      const progs = renderer.info.programs as { diagnostics?: { runnable?: boolean }; name?: string }[];
      const dead = progs.filter((p) => p.diagnostics && p.diagnostics.runnable === false);
      if (dead.length > 0) {
        const names = dead.map((p) => p.name ?? "shader").join(", ");
        console.error(`[ordesa] dead GL program(s): ${names}`);
        return `error de gráficos (${names}); recarga la página`;
      }
    } catch {
      /* renderer.info unavailable — no verdict */
    }
    return null;
  }
  // B7: while the gate stands, body scroll is locked and lenis is stopped.
  // On enter: scrollTo(0,0), lenis.start(), unlock — in that order.
  let scroll: ScrollHandle | null = null;
  const gate = buildGate(() => {
    window.scrollTo(0, 0);
    scroll?.start();
  });
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
  // E4: set once route.json arrives (rebuildTerrain reads it for the corridor).
  let routeReady: RouteData | null = null;
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
    // E4: corridor around the track snaps to full res (route loaded after
    // the first build — rebuild once it arrives; no-op before that).
    const corridor = routeReady ? { x: routeReady.x, y: routeReady.y, halfM: CORRIDOR_HALF_M } : undefined;
    const geo = buildTerrainGeometry(elev, meta, world, step, corridor);
    if (!terrainMat) {
      terrainMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
      // P0: compile-proof material — a neutral 1x1 DataTexture as `map` so
      // the program compiles WITH map even if the base ortho hasn't arrived
      // (slow net + ?s= pose-at-boot used to compile mapless, and three only
      // declares vMapUv under USE_MAP, killing the program forever).
      // NOTE: `uv` itself is unconditional in WebGLProgram (line ~685), so
      // vTerrainUv = uv always compiles — the varying is ours, not three's.
      {
        const px = new Uint8Array([200, 195, 185, 255]);
        const neutral = new THREE.DataTexture(px, 1, 1, THREE.RGBAFormat);
        neutral.colorSpace = THREE.SRGBColorSpace;
        neutral.needsUpdate = true;
        terrainMat.map = neutral;
      }
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
        s.uniforms["uWallDeg"] = wallDeg;
        s.uniforms["uRockWeight"] = rockWeight;
        s.uniforms["uGrainK"] = grainK;
        s.uniforms["uHasCorr"] = hasCorr;
        s.uniforms["uHasNormal"] = hasNormal;
        s.vertexShader = s.vertexShader
          // P0: own varying (vTerrainUv = uv) — never vMapUv, which three
          // only declares under USE_MAP and vanishes mapless.
          .replace("#include <common>", "#include <common>\nattribute vec3 uv2c; varying vec3 vUv2c; varying vec3 vWPos2; varying vec3 vWNormal2; varying vec2 vTerrainUv;")
          .replace("#include <uv_vertex>", "#include <uv_vertex>\nvUv2c = uv2c;\nvTerrainUv = uv;")
          .replace("#include <fog_vertex>", "#include <fog_vertex>\nvWPos2 = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNormal2 = normalize(mat3(modelMatrix) * objectNormal);");
        s.fragmentShader = s.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
uniform sampler2D uCorridor; uniform sampler2D uNormalMap2; uniform float uNormalStrength; varying vec3 vUv2c;
uniform float uWallDeg; uniform float uRockWeight; uniform float uGrainK;
uniform float uHasCorr; uniform float uHasNormal;
varying vec3 vWPos2; varying vec3 vWNormal2; varying vec2 vTerrainUv;
float gSteep = 0.0;
float gRaw = 0.0;
float gGrain = 0.0;
float whash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float wnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), u.x),
             mix(whash(i + vec2(0, 1.0)), whash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wgrain(vec2 lp){
  vec2 p = vec2(lp.x / 2.5, lp.y);
  return wnoise(p) * 0.5714 + wnoise(p * 2.3) * 0.2857 + wnoise(p * 5.1) * 0.1429;
}`,
          )
          .replace(
            "#include <map_fragment>",
            `#include <map_fragment>
#ifdef USE_MAP
  vec4 corr = texture2D(uCorridor, vUv2c.xy);
  float wcorr = vUv2c.z * uHasCorr;
  vec3 alb = mix(diffuseColor.rgb, corr.rgb, wcorr);
  vec3 wn2 = normalize(vWNormal2);
  float slopeDeg = degrees(acos(clamp(wn2.y, 0.0, 1.0)));
  float rawSteep = smoothstep(uWallDeg, uWallDeg + 15.0, slopeDeg);
  gRaw = rawSteep;
  float steep = rawSteep * uRockWeight;
  gSteep = steep;
  if (steep > 0.001) {
    float rep = 38.0;
    float wx = pow(abs(wn2.x), 6.0);
    float wz = pow(abs(wn2.z), 6.0);
    float wsum = wx + wz;
    float grain = 0.0;
    if (wsum > 0.001) {
      float gx = wgrain(vec2(vWPos2.z / rep, vWPos2.y / rep));
      float gz = wgrain(vec2(vWPos2.x / rep, vWPos2.y / rep));
      grain = (gx * (wx / wsum) + gz * (wz / wsum)) - 0.5;
    }
    gGrain = grain;
    float grano = grain * uGrainK * steep;
    alb *= (1.0 + grano);
  }
  diffuseColor.rgb = alb;
#endif`,
          )
          .replace(
            "#include <normal_fragment_maps>",
            `#include <normal_fragment_maps>
{
  float eN = 0.6;
  vec3 wnN = normalize(vWNormal2);
  float repN = 38.0;
  float wxN = pow(abs(wnN.x), 6.0);
  float wzN = pow(abs(wnN.z), 6.0);
  float wsumN = wxN + wzN;
  vec2 latNV = vec2(0.0);
  if (wsumN > 0.001 && gSteep > 0.001) {
    vec2 pxX = vec2(vWPos2.z / repN, vWPos2.y / repN);
    vec2 pxZ = vec2(vWPos2.x / repN, vWPos2.y / repN);
    float hC = wgrain(pxX) * (wxN / wsumN) + wgrain(pxZ) * (wzN / wsumN);
    float hX = wgrain(pxX + vec2(eN / repN * 2.5, 0.0)) * (wxN / wsumN) + wgrain(pxZ + vec2(eN / repN * 2.5, 0.0)) * (wzN / wsumN);
    float hY = wgrain(pxX + vec2(0.0, eN / repN)) * (wxN / wsumN) + wgrain(pxZ + vec2(0.0, eN / repN)) * (wzN / wsumN);
    latNV = vec2(hX - hC, hY - hC) * (repN / max(eN, 1e-4)) * 0.02;
  }
  vec3 nt2 = texture2D(uNormalMap2, vTerrainUv).rgb * 2.0 - 1.0;
  vec2 mixN = mix(nt2.xy, latNV, clamp(gSteep, 0.0, 1.0));
  mixN *= uNormalStrength * max(uHasNormal, clamp(gSteep, 0.0, 1.0));
  normal = normalize(normal + vec3(mixN.x, mixN.y, 0.0) * 0.35);
}`,
          );
        if (boot.steep) {
          const prevSteep = terrainMat.onBeforeCompile.bind(terrainMat);
          terrainMat.onBeforeCompile = (s2: {
            uniforms: Record<string, unknown>;
            fragmentShader: string;
            vertexShader: string;
          }) => {
            prevSteep(s2);
            s2.fragmentShader = s2.fragmentShader.replace(
              "#include <dithering_fragment>",
              `gl_FragColor = vec4(clamp(gRaw, 0.0, 1.0), clamp(gSteep, 0.0, 1.0), clamp(gGrain + 0.5, 0.0, 1.0), 1.0);
#include <dithering_fragment>`,
            );
          };
        }
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
  const wallDeg = { value: 30 };
  const rockWeight = { value: 1.0 };
  const grainK = { value: 0.45 };
  const hasCorr = { value: 0 };
  const hasNormal = { value: 0 };

  rebuildTerrain();
  gate.setProgress(0.62, 1);
  let route: RouteData;
  try {
    route = await loadRouteData();
  } catch (e) {
    gate.fail(`no se ha podido cargar la senda: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
  // E4: the first mesh built without the corridor (route unknown then) —
  // rebuild once with the full-res strip along the track.
  routeReady = route;
  rebuildTerrain();
  if (terrainMat?.map) terrainMat.needsUpdate = true;

  // --- Phase 3A journey: scroll -> progress (single source) -> rig ---
  scroll = createScroll();
  scroll.stop(); // B7: locked until the gate opens
  let progress: ProgressHandle;
  try {
    // E5.2: branch choice runs inside initProgress, once, with the live
    // heightfield — the rig consumes the identical decided series.
    progress = initProgress(route, scroll, { elev, meta, cx: world.centerX, cy: world.centerY });
  } catch (e) {
    gate.fail(`no se pudo resolver el recorrido: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
  if (progress.getState().divergenceWarn && boot.debug) {
    metrics.warn = progress.getState().divergenceWarn as string;
  }
  const rig = createRig({ camera, route, world, elev, meta, progress });
  {
    // initial framing is simply rig.at(s=0) — no hardcoded default camera.
    const p0 = rig.poseAt(scroll.s);
    camera.position.set(p0.pos[0], p0.pos[1], p0.pos[2]);
    camera.lookAt(p0.target[0], p0.target[1], p0.target[2]);
  }

  // ?orbit=1: deferred OrbitControls, rig excluded. Orbit starts where the
  // rig would have put the camera for the given ?s= (inspect the framing).
  // A7: ?cam= overrides the POSE explicitly (same precedence ?t= has over
  // the hour): the rig does not compose, scroll does not move the camera.
  // FOLLOW replan: presets are rig poses at fixed s (CAM_PRESETS_S), not
  // hand-set EPSG framings. Unknown ?cam= falls back to the rig pose.
  let orbitControls: { update(): void } | null = null;
  if (boot.orbit || boot.cam !== null) {
    const mod = await import("three/examples/jsm/controls/OrbitControls.js");
    const oc = new mod.OrbitControls(camera, renderer.domElement);
    const camS = boot.cam !== null && CAM_PRESETS_S[boot.cam] !== undefined
      ? (CAM_PRESETS_S[boot.cam] as number)
      : scroll.s;
    const p = rig.poseAt(camS);
    oc.target.set(p.target[0], p.target[1], p.target[2]);
    camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
    oc.update();
    orbitControls = oc;
  }
  // Without the flag: zero mouse/touch listeners on the canvas — the canvas
  // must never compete with scroll.

  const res2 = new THREE.Vector2(
    renderer.domElement.width,
    renderer.domElement.height,
  );
  const line = buildRouteLine(route, world, elev, meta, res2, (x, y) => meshHeightAtStep2(elev, meta, x, y));
  group.add(line.group);
  // Rastro invertido, instrumento primero: ?debug=trackdist wins over
  // ?track=all (the gradient needs uProgressDist = lengthM anyway).
  if (boot.trackDist) {
    line.setTrackDistMode(true);
    line.setProgressDist(route.lengthM);
  }
  applyLighting(progress.getState().hourDec);
  renderer.compile(scene, camera);
  skyCap = createSkyCapture(renderer, scene, camera);
  skyCap.refresh();
  renderer.shadowMap.needsUpdate = true;
  shadowNeedsUpdate = false;
  await nextFrame();

  // base texture (replaces the neutral 1x1 probe from material creation —
  // the program was already compiled WITH map, so no recompile hazard)
  try {
    const t = await loadTex(`/${baseAsset ?? "assets/terrain-2k.webp"}`, true);
    if (terrainMat) {
      const old = terrainMat.map;
      terrainMat.map = t;
      terrainMat.needsUpdate = true;
      if (old && (old as THREE.DataTexture).image && (old as THREE.DataTexture).image.width === 1) old.dispose();
    }
  } catch {
    gate.fail("no se ha podido cargar la ortofoto base; sigo con relieve");
  }
  gate.setProgress(0.68, 1);
  gate.ready();
  skyCap?.refresh();
  await nextFrame();

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

  // clouds (S1: terrain-relative placement needs the decoded heightmap)
  const clouds = buildClouds(meta, elev, `/${meta.assets?.["clouds-atlas"] ?? "assets/clouds-atlas.webp"}`);
  scene.add(clouds.group);
  gate.setProgress(0.8, 5);
  await nextFrame();

  // labels
  const labelLayer = el("div", "labels");
  document.body.appendChild(labelLayer);
  // T1: user cloud multiplier 0..1 (default 1) — instrument, behind ?debug=1
  let cloudUser = boot.clouds;
  if (boot.steep) {
    clouds.group.visible = false;
    line.group.visible = false;
    labelLayer.style.display = "none";
  }
  const labelDefs = (await fetch("/assets/labels.json").then((r) => r.json()).catch(() => ({ labels: [] }))) as {
    labels: LabelDef[];
  };
  const labelRts = buildLabels(labelDefs.labels, world.centerX, world.centerY, labelLayer);

  // --- telemetry bar (7 cols, reads progress.getState()) ---
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

  // --- instruments: whole phase-2 HUD behind ?debug=1, extended with 3A ---
  // G14: the slider panel's HORA is a READOUT of st.hourDec (same source as
  // the bar). There is no hour control: with scroll driving time, a slider
  // that sets the hour would be a second source by definition.
  if (boot.debug) {
    const hud = el("div", "hud2");
    const timeLab = el("div", "hud-label", `hora ${hhmm(progress.getState().hourDec)}${progress.getState().hourFrozen ? " (fija ?t=)" : ""}`);
    const cloudLab = el("div", "hud-label", `nubes ${Math.round(cloudUser * 100)} %`);
    const cloudIn = document.createElement("input");
    cloudIn.type = "range";
    cloudIn.min = "0";
    cloudIn.max = "1";
    cloudIn.step = "0.01";
    cloudIn.value = String(cloudUser);
    cloudIn.setAttribute("aria-label", "densidad de nubes");
    cloudIn.addEventListener("input", () => {
      cloudUser = Number(cloudIn.value);
      cloudLab.textContent = `nubes ${Math.round(cloudUser * 100)} %`;
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
    const tLab = el("div", "hud-label", "pared desde 30°");
    const tIn = document.createElement("input");
    tIn.type = "range";
    tIn.min = "20";
    tIn.max = "60";
    tIn.step = "1";
    tIn.value = "30";
    tIn.setAttribute("aria-label", "umbral de pendiente de proyección lateral");
    tIn.addEventListener("input", () => {
      const deg = Number(tIn.value);
      tLab.textContent = `pared desde ${deg}°`;
      wallDeg.value = deg;
    });
    const wLab = el("div", "hud-label", "peso roca 100 %");
    const wIn = document.createElement("input");
    wIn.type = "range";
    wIn.min = "0";
    wIn.max = "1";
    wIn.step = "0.05";
    wIn.value = "1";
    wIn.setAttribute("aria-label", "peso de la roca lateral");
    wIn.addEventListener("input", () => {
      const w = Number(wIn.value);
      wLab.textContent = `peso roca ${Math.round(w * 100)} %`;
      rockWeight.value = w;
    });
    const gLab = el("div", "hud-label", "grano 0,45");
    const gIn = document.createElement("input");
    gIn.type = "range";
    gIn.min = "0";
    gIn.max = "1";
    gIn.step = "0.05";
    gIn.value = "0.45";
    gIn.setAttribute("aria-label", "intensidad del grano lateral");
    gIn.addEventListener("input", () => {
      const k = Number(gIn.value);
      gLab.textContent = `grano ${k.toFixed(2).replace(".", ",")}`;
      grainK.value = k;
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
    hud.append(timeLab, cloudLab, cloudIn, nLab, nIn, tLab, tIn, wLab, wIn, gLab, gIn, lodRow);
    if (boot.steep) {
      hud.append(el("div", "hud-label", "mapa: R = peso geo · G = efectivo · B = grano"));
    }
    document.body.appendChild(hud);
    // hour readout follows the journey (write-if-changed in the loop)
    const hourTick = window.setInterval(() => {
      const label = `hora ${hhmm(progress.getState().hourDec)}${progress.getState().hourFrozen ? " (fija ?t=)" : ""}`;
      if (timeLab.textContent !== label) timeLab.textContent = label;
    }, 500);
    void hourTick;
    // Rastro invertido: HUD audit — vDist samples + instance count + Line2
    // census. One load answers geometry-vs-cut (suspect 1: a second
    // buildRouteLine alive from E4 would show line2 != 4).
    const trackLab = el("div", "hud-label", "track …");
    hud.append(trackLab);
    const trackTick = window.setInterval(() => {
      const ids = line.debugIds();
      let nLine2 = 0;
      scene.traverse((o) => {
        if ((o as unknown as { isLine2?: boolean }).isLine2 === true) nLine2++;
      });
      const label = `track vDist[0]=${Number.isNaN(ids.first) ? "EMPTY" : ids.first.toFixed(1)} vDist[n-1]=${Number.isNaN(ids.last) ? "EMPTY" : ids.last.toFixed(1)} instances=${ids.count} line2=${nLine2} uProg=${line.debugProgressDist().toFixed(1)}`;
      if (trackLab.textContent !== label) trackLab.textContent = label;
    }, 500);
    void trackTick;
  }

  // ?debug=path instrument (3-panel overlay, lazy import keeps it out of the
  // entry chunk graph unless requested)
  if (boot.path) {
    const { mountPathOverlay } = await import("../narrative/debug-path.ts");
    mountPathOverlay({ route, world, elev, meta, progress, rig });
  }
  // G12/G17 occluder pass (respuesta G12): terrain ONLY — no dome, no
  // clouds, no track, no labels. overrideMaterial flat white, clear black:
  // black pixels ARE sky (nothing occludes). Clouds are not occluders
  // (cloudy sky is still sky for framing); fog is off (flat material has
  // none — far terrain reads white, correctly NOT sky). Same camera incl.
  // setViewOffset so the crop matches the user frame. Target persists.
  const occScene = new THREE.Scene();
  let occMesh: THREE.Mesh | null = null;
  const occTarget = new THREE.WebGLRenderTarget(256, 144, { depthBuffer: true });
  const occBuf = new Uint8Array(256 * 144 * 4);
  const occMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  // G11 probe flag (?luma=1 with ?s=0.10): luminance sampling in the loop.
  // The threshold lives in choreography.ts; the loop exposes window.__luma
  // and the HUD line so the audit reads a number, not an impression.
  // G12 rides the occluder pass (?skyfrac=1 -> window.__skyFrac): black
  // pixels ARE sky (only terrain occludes). G17 rides free: black pixels
  // in the LOWER half are void under the horizon.
  // G15 (?trackpx=1 -> window.__trackpx): ID pass WITH the cut — the solid
  // Line2 alone into 256x144, non-null pixels counted. Threshold: >= 40 px.
  const lumaOn = new URLSearchParams(location.search).has("luma");
  const skyfracOn = new URLSearchParams(location.search).has("skyfrac");
  const trackpxOn = new URLSearchParams(location.search).has("trackpx");
  void G11_LUMA_MIN;

  gate.setProgress(1, 5);
  clearWatchdog();
  await nextFrame();
  applyLighting(progress.getState().hourDec);

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

  // E1: far-plane budget watch — drone views pull in more triangles. If
  // msFrame breaks 24, drop the far LOD before touching the camera.
  let lodDropped = false;

  const clock = new THREE.Clock();
  const tickFrame = frameClock(metrics);

  let frames = 0;
  let prevMs = -1;
  renderer.setAnimationLoop(() => {
    tickFrame(); // S3: real rAF-delta frame clock
    const nowMs = performance.now();
    const dtMs = prevMs < 0 ? 16.7 : Math.min(250, nowMs - prevMs);
    prevMs = nowMs;
    const dt = dtMs / 1000;
    if (orbitControls) {
      orbitControls.update();
    } else {
      scroll.update(dtMs, nowMs);
      progress.update();
      rig.update(dt);
    }
    const st = progress.getState();
    const hour = st.hourDec;
    const t2 = performance.now();
    applyLighting(hour);
    // E2: progressive cut at the walker (epilogue draws the whole loop).
    // BLOQUEANTE ?track=all: isolation probe — uProgressDist = lengthM,
    // nothing else touched. Answers geometry-vs-cut in a single load.
    {
      const e = route.lengthM;
      if (boot.trackAll) line.setProgressDist(e);
      else line.setProgressDist(st.s >= EPILOGUE_S ? e : Math.min(st.d, e));
    }
    // E3: line width from plan camera->aim distance; halo glow at the
    // cirque + mirador milestones (follow replan: s-anchored, no hitos yaw).
    {
      const dg0 = rig.getDiag();
      const gA3 = glowNear(st.s, 0.3);
      const gA7 = glowNear(st.s, 0.745);
      const gA8 = glowNear(st.s, 0.86);
      line.setFraming(dg0.distPlan, Math.max(gA3, gA7, gA8));
    }
    // B4: sun station follows the rig target; shadow refresh has TWO
    // triggers (sun turned OR target moved), at most every N frames.
    {
      const tgt = rig.getTarget();
      sun.target.position.set(tgt[0], tgt[1], tgt[2]);
      sun.target.updateMatrixWorld();
      sun.position.set(
        tgt[0] + sunDirV.x * SHADOW_LIGHT_DIST_M,
        tgt[1] + sunDirV.y * SHADOW_LIGHT_DIST_M,
        tgt[2] + sunDirV.z * SHADOW_LIGHT_DIST_M,
      );
      const dAz = Math.abs(st.sunAzim - lastShadowAz);
      const dEl = Math.abs(st.sunElev - lastShadowEl);
      const dTgt = Math.hypot(tgt[0] - lastShadowTx, tgt[1] - lastShadowTy, tgt[2] - lastShadowTz);
      framesSinceShadow++;
      if ((dAz > SHADOW_EPS_DEG || dEl > SHADOW_EPS_DEG || dTgt > SHADOW_MOVE_EPS_M) && framesSinceShadow >= SHADOW_MIN_FRAMES) {
        shadowNeedsUpdate = true;
      }
      if (shadowNeedsUpdate) {
        renderer.shadowMap.needsUpdate = true;
        shadowNeedsUpdate = false;
        lastShadowAz = st.sunAzim;
        lastShadowEl = st.sunElev;
        lastShadowTx = tgt[0];
        lastShadowTy = tgt[1];
        lastShadowTz = tgt[2];
        framesSinceShadow = 0;
      }
    }
    // sky + fog colour refresh in the SAME event (gated by solar elevation)
    skyCap?.refreshIfNeeded(st.sunElev);
    metrics.time = hhmm(hour);
    // G14: mirror the FULL state (copy — the live object mutates next frame).
    // The audit reads z/slopePct/climbM from __metrics without touching DOM.
    metrics.journey = { ...st };
    if (boot.debug) {
      const dg = rig.getDiag();
      metrics.s = st.s;
      metrics.d = st.d;
      metrics.hour = hhmm(hour);
      metrics.yaw = dg.yaw;
      metrics.pitch = dg.pitch;
      metrics.dist = dg.distPlan;
      metrics.holgura = dg.holgura;
      metrics.corrH = dg.corrH;
      // A7: ?cam= poses report their own name, like phase 2 did.
      metrics.cam = boot.cam ?? (boot.orbit ? "orbit" : "rig");
    }
    driveTelemetry(cells, lastTele, st, hhmm(hour), st.sunElev);
    const effCloud = cloudDensity * cloudUser;
    if (boot.steep || effCloud <= 0.001) {
      clouds.group.visible = false;
      metrics.cloudCoverage = 0;
    } else {
      clouds.group.visible = true;
      clouds.setDensity(effCloud, sunDirV);
      // A9: fade the layer as the view ray steepens (epilogue from above).
      // Elevation of the camera->target ray above horizontal, deg.
      {
        const tgt = rig.getTarget();
        const dx = tgt[0] - camera.position.x;
        const dy = tgt[1] - camera.position.y;
        const dz = tgt[2] - camera.position.z;
        const horiz = Math.hypot(dx, dz);
        const elevDeg = (Math.atan2(-dy, horiz) * 180) / Math.PI;
        const f = Math.min(1, Math.max(0, (elevDeg - CLOUD_FADE_START_DEG) / (90 - CLOUD_FADE_START_DEG)));
        clouds.setZenithFade(f * CLOUD_ZENITH_FADE);
      }
      clouds.update(clock.elapsedTime, camera, renderer.domElement.width, renderer.domElement.height);
      metrics.cloudCoverage = clouds.getCoverage();
      clouds.setCap(clouds.getCoverage() > 0.2);
    }
    line.setDim(routeDim);
    metrics.hasRock = 1;
    metrics.rockWeightShown = rockWeight.value;
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
    // T1 (mandatory order): the rig already wrote position/quaternion above;
    // refresh the world matrix, render, then project the labels with the
    // SAME matrix that just rendered. Projecting before rig.update() trails
    // one frame behind the canvas — invisible when still, swimming on scroll.
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);
    // T1: labels AFTER render, every frame, no throttle (js etiq ~0.1 ms).
    updateLabels(labelRts, camera, window.innerWidth, window.innerHeight, 30000);
    const t3 = performance.now();
    metrics.jsTerrain = 0; // terrain JS slice is inside rebuilds, not the loop
    metrics.jsLabels = Math.max(0, t3 - t2);
    metrics.msPost = 0;
    // G11 (audit A6): mean linear luminance over a LUMA_GRID^2 readPixels
    // grid, every 30th frame, only with ?luma=1 (a per-frame readPixels
    // stall would eat the budget it is meant to protect). R1: sampled AFTER
    // renderer.render() — the presented frame, never the previous one.
    // G12 (E1): same pass counts sky rows — pixels whose NDC ray points
    // above the geometric horizon from the camera position.
    // G15 (BLOQUEANTE): same pass counts track-cream pixels (0xefe3c8) —
    // the trail must paint >0 pixels at s>=0.05.
    if ((lumaOn || skyfracOn || trackpxOn) && frames % 30 === 5) {
      const g = LUMA_GRID;
      const w = Math.max(1, Math.floor(renderer.domElement.width / 2));
      const h = Math.max(1, Math.floor(renderer.domElement.height / 2));
      const buf = new Uint8Array(w * h * 4);
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      let cnt = 0;
      const sx = Math.max(1, Math.floor(w / g));
      const sy = Math.max(1, Math.floor(h / g));
      for (let yy = 0; yy < h; yy += sy) {
        for (let xx = 0; xx < w; xx += sx) {
          const o = (yy * w + xx) * 4;
          const rr = (buf[o] as number) / 255;
          const gg = (buf[o + 1] as number) / 255;
          const bb = (buf[o + 2] as number) / 255;
          // sRGB -> linear approx + Rec.709 luma
          const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
          sum += 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
          cnt++;
        }
      }
      (window as unknown as { __luma?: number }).__luma = cnt > 0 ? sum / cnt : 0;
      if (boot.debug) metrics.luma = (window as unknown as { __luma?: number }).__luma ?? -1;
      // G12/G17: occluder pass — terrain only, flat white, clear black.
      // Black = sky (nothing occludes). Lower-half black = void (G17).
      // readPixels immediately after render (R1 lesson), same camera.
      if (skyfracOn && terrain) {
        if (!occMesh) {
          occMesh = new THREE.Mesh(terrain.geometry, occMat);
          occMesh.frustumCulled = false;
          occScene.add(occMesh);
        } else if (occMesh.geometry !== terrain.geometry) {
          occMesh.geometry = terrain.geometry;
        }
        const sky = renderCount(renderer, occTarget, occBuf, occScene, camera, 256, 144,
          (rr, gg, bb) => rr < 8 && gg < 8 && bb < 8);
        (window as unknown as { __skyFrac?: number }).__skyFrac = sky / (256 * 144);
        // G17 free: black pixels in the LOWER half (rows 0..71) = void under
        // the horizon. Same buffer just read — no second render.
        let voidPx = 0;
        for (let yy = 0; yy < 72; yy++) {
          for (let xx = 0; xx < 256; xx++) {
            const o = (yy * 256 + xx) * 4;
            if ((occBuf[o] as number) < 8 && (occBuf[o + 1] as number) < 8 && (occBuf[o + 2] as number) < 8) voidPx++;
          }
        }
        (window as unknown as { __voidPx?: number }).__voidPx = voidPx;
      }
      // G15: offscreen ID pass (solid Line2 alone, 256x144). Runs on the
      // same 30-frame cadence as G11/G12; result in window.__trackpx.
      if (trackpxOn) {
        try {
          (window as unknown as { __trackpx?: number }).__trackpx = line.countIdPixels(renderer, camera);
        } catch {
          (window as unknown as { __trackpx?: number }).__trackpx = -1;
        }
      }
    }
    frames++;
    // P0/G20: late check (frame 60) — the terrain program compiles after
    // first render on the ?s= path, so frame 8 would false-positive on the
    // neutral 1x1 probe still in flight.
    if (frames === 60) {
      const glErr = checkGLPrograms();
      if (glErr) gate.fail(glErr);
    }
    // E1 budget: sustained >24 ms frames drop the far LOD one notch (2->4),
    // once. The camera never pays for the triangle budget.
    if (!lodDropped && frames > 120 && metrics.msFrame > 24 && step === 2) {
      lodDropped = true;
      step = 4;
      metrics.lod = step;
      rebuildTerrain();
      if (terrainMat?.map) terrainMat.needsUpdate = true;
    }
  });
}
