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
  SHADOW_INTENSITY,
  SHADOW_LIGHT_DIST_M,
  SHADOW_MIN_FRAMES,
  SHADOW_MOVE_EPS_M,
  SHADOW_NEAR_M,
  SKY_SAT,
  SKY_SCALE,
  SKY_SCALE_LOW,
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
  meshHeightAtStep,
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
    // §4b FASE 5 paso d: la sombra PROYECTADA nunca más oscura que la
    // ambiente de la ladera (LightShadow.intensity: mix en el shader entre
    // 1.0 y la sombra; 0 = sin sombra proyectada, 1 = plena).
    sun.shadow.intensity = SHADOW_INTENSITY;
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
  // §4b FASE 3c: uSkyScale is a SHARED uniform object (dome + capture hold
  // the same reference — one write in applyLighting reaches both, zero
  // copies to forget) + uSunElev for the solar-weighted saturation.
  // Below 2° solar elevation the dome keeps SKY_SCALE_LOW (0.60): Preetham
  // at 0° is already 5-8× dimmer than noon and ×0.22 turned low sun brown.
  // The 1.25 twilight exposure is untouched.
  const uSkyScaleShared = { value: SKY_SCALE };
  const uSunElevShared = { value: 50 };
  skyU["uSkyScale"] = uSkyScaleShared;
  skyU["uSunElev"] = uSunElevShared;
  // §4b FASE 3c: elevation-weighted saturation (view Y) × SOLAR-weighted
  // saturation (sun elevation): satEff = mix(1, SKY_SAT, sunF·viewF).
  // Below 5° sun the zenith is never saturated (avoids chemical
  // brown/violet); at noon nothing changes. uSkyScale/uSunElev ride on
  // material.uniforms (three declares `uniform float X;` for each entry
  // at compile — no string declaration needed); the × constant is gone.
  {
    const skym = sky.material as THREE.ShaderMaterial & { onBeforeCompile: (s: { fragmentShader: string }) => void };
    const prevSky = skym.onBeforeCompile.bind(skym);
    (sky.material as THREE.Material).onBeforeCompile = (s: { fragmentShader: string }) => {
      prevSky(s);
      s.fragmentShader = s.fragmentShader.replace(
        "gl_FragColor = vec4( retColor, 1.0 );",
        `float skyDirY = normalize( vWorldPosition - cameraPosition ).y;
        float skyViewF = smoothstep( 0.05, 0.45, skyDirY );
        float skySunF = smoothstep( 5.0, 25.0, uSunElev );
        float skySat = mix( 1.0, ${(SKY_SAT as number).toFixed(2)}, skyViewF * skySunF );
        float skyL = dot( retColor, vec3( 0.2126, 0.7152, 0.0722 ) );
        retColor = max( vec3( 0.0 ), mix( vec3( skyL ), retColor, skySat ) );
        gl_FragColor = vec4( retColor * uSkyScale, 1.0 );`,
      );
    };
    sky.material.needsUpdate = true;
  }
  const nightBg = new THREE.Color(0x05070f);
  let skyCap: SkyCapture | null = null;

  let routeDim = 1;
  const sunDirV = new THREE.Vector3(0, 1, 0);
  let cloudDensity = 0.5;
  let cloudDayF = 1;

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
    // §4b FASE 3c: uSkyScale follows the SUN (smoothstep 2°→20°), not the
    // clock: mix(SKY_SCALE_LOW, SKY_SCALE, f). At noon f = 1 → identical
    // pixels to before this phase (G24a/b intact by construction).
    {
      const t = Math.min(1, Math.max(0, (sp.elevationDeg - 2) / 18));
      const f = t * t * (3 - 2 * t);
      uSkyScaleShared.value = SKY_SCALE_LOW + (SKY_SCALE - SKY_SCALE_LOW) * f;
      uSunElevShared.value = sp.elevationDeg;
    }
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
    cloudDayF = L.cloudDayF;
    if (boot.debug) {
      // §4b FASE 3: metrics.zenithHex has ONE writer — the 30-frame capture
      // probe below (display-space ACES+sRGB, what the user sees). The old
      // analytic estimate wrote here too and raced the probe (G28): deleted.
      // Until the probe first runs, zenithHex stays "—" (mountDebug init).
      const dfog = fogUniforms.uFogDensity.value as number;
      const x10 = 10000 / 9000;
      const df10 = 1 - Math.exp(-x10 * x10 * x10 * x10 * 3.4);
      metrics.fog10km = Math.min(1, Math.max(0, df10 * (0.45 + 0.55 * dfog)));
    }
  }

  // --- gate + progress (R0: global 45 s watchdog — never wait forever) ---
  // P0-3: dead programs blame graphics with the full infoLog (see
  // checkGLPrograms below). Slow-net stalls are the watchdog's business.
  // P0-3 (higiene, sin urgencia): tras el primer render, un programa muerto
  // es error de gráficos, no de red. El cuelgue al 11 % era red lenta +
  // vigilante por tiempo, no la pieza (corregido en la pasada del rastro).
  function checkGLPrograms(): string | null {
    try {
      const progs = renderer.info.programs as {
        diagnostics?: { runnable?: boolean };
        name?: string;
        infoLog?: string;
      }[];
      const dead = progs.filter((p) => p.diagnostics && p.diagnostics.runnable === false);
      if (dead.length > 0) {
        for (const p of dead) {
          console.error(`[ordesa] dead GL program ${p.name ?? "shader"}:\n${p.infoLog ?? "(no log)"}`);
        }
        return `Error de gráficos. Recarga; si persiste, prueba otro navegador.`;
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
  // Higiene: el vigilante se pausa con la pestaña oculta — acusar a la
  // conexión cuando nadie mira no tiene sentido. 45 s VISIBLES, no 45 s de
  // reloj: cada tramo oculto deja de descontar hasta volver a primer plano.
  // (El removeEventListener nominal no desengancha la closure anónima; el
  // flag entered la neutraliza, que es lo que importa.)
  const enteredRef = { entered: false };
  let watchdogSlack = 45000;
  let watchdogStart = performance.now();
  let watchdog: number | undefined;
  const armWatchdog = (): void => {
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => {
      gate.fail("la carga está tardando demasiado; comprueba tu conexión y recarga");
    }, watchdogSlack);
    watchdogStart = performance.now();
  };
  const pauseWatchdog = (): void => {
    window.clearTimeout(watchdog);
    watchdogSlack = Math.max(0, watchdogSlack - (performance.now() - watchdogStart));
  };
  document.addEventListener("visibilitychange", () => {
    if (enteredRef.entered) return;
    if (document.hidden) pauseWatchdog();
    else armWatchdog();
  });
  armWatchdog();
  const clearWatchdog = (): void => {
    enteredRef.entered = true;
    window.clearTimeout(watchdog);
  };
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

  let step = boot.lod ?? 2;
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
    // Walker-framed pose: position + quaternion (never lookAt, which would
    // compute a pitch composePose just replaced).
    const p0 = rig.poseAt(scroll.s);
    camera.position.set(p0.pos[0], p0.pos[1], p0.pos[2]);
    camera.quaternion.set(p0.quaternion[0], p0.quaternion[1], p0.quaternion[2], p0.quaternion[3]);
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
    camera.quaternion.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]);
    oc.update();
    orbitControls = oc;
  }
  // Without the flag: zero mouse/touch listeners on the canvas — the canvas
  // must never compete with scroll.

  const res2 = renderer.getDrawingBufferSize(new THREE.Vector2());
  const line = buildRouteLine(route, world, elev, meta, res2,
    (x, y) => meshHeightAtStep(elev, meta, x, y, step), step);
  group.add(line.group);
  // Rastro enterrado, instrumento primero: ?ghost=1 — el pase fantasma a
  // magenta opaco dibuja exactamente lo que está detrás del terreno. Si el
  // rastro aparece en magenta, está enterrado bajo la malla, no cortado.
  if (boot.ghost) line.setGhostProbe(true);
  // Rastro invertido, instrumento primero: ?debug=trackdist wins over
  // ?track=all (the gradient needs uProgressDist = lengthM anyway).
  if (boot.trackDist) {
    line.setTrackDistMode(true);
    line.setProgressDist(route.lengthM);
  }
  applyLighting(progress.getState().hourDec);
  renderer.compile(scene, camera);
  skyCap = createSkyCapture(renderer, sky);
  skyCap.setEnabled(boot.skycap);
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

  // clouds (S1: terrain-relative placement needs the decoded heightmap).
  // §4b FASE 4b: band above the camera — camYmax from a poseAt sweep
  // (s ∈ [0, 0.97] step 0.005). Poses travel in EPSG plan + altitude
  // (CloudCamPose {x, y, z}): the layout never mixes frames.
  const cloudCams: { x: number; y: number; z: number }[] = [];
  {
    const w2eX = (wx: number): number => wx + world.centerX;
    const w2eY = (wz: number): number => world.centerY - wz;
    for (let s = 0; s <= 0.97; s += 0.005) {
      const sc = Math.min(0.97, s);
      const p = rig.poseAt(sc);
      cloudCams.push({ x: w2eX(p.pos[0]), y: w2eY(p.pos[2]), z: p.pos[1], s: sc });
    }
  }
  const clouds = buildClouds(
    meta,
    elev,
    `/${meta.assets?.["clouds-atlas"] ?? "assets/clouds-atlas.webp"}`,
    { n: route.n, x: route.x, y: route.y },
    cloudCams,
  );
  (window as unknown as { __cloudBand?: { base: number; top: number; camYmax: number; camYmin: number } }).__cloudBand = (() => {
    let m = -Infinity;
    let n = Infinity;
    for (const c of cloudCams) {
      if (c.z > m) m = c.z;
      if (c.z < n) n = c.z;
    }
    return { base: n + 300, top: m + 650, camYmax: m, camYmin: n };
  })();
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
  // ?ghost=1 and ?lod=N are read-only probes even without ?debug=1: they
  // only change what the ghost pass shows / which lattice the mesh draws.
  // No probe writes a state the piece also drives (setGhostProbe only
  // touches ghost colour/opacity; ?lod only pins the LOD step).
  // G22 (frame limpio): per-pass GL error ledger, live only with ?debug=1
  // (getError() drains the flag — never poll it in production). The loop
  // records capture/main/probe errors right after each renderer.render;
  // the HUD label reports them with the pass name.
  const glProbe = renderer.getContext() as WebGL2RenderingContext;
  const glPassErr = { capture: 0, main: 0, probe: 0, label: "" };
  // G14: the slider panel's HORA is a READOUT of st.hourDec (same source as
  // the bar). There is no hour control: with scroll driving time, a slider
  // that sets the hour would be a second source by definition.
  // Rastro enterrado (?lod=N): la fila de pasos refleja el LOD fijado por URL.
  const lodPinned = boot.lod;
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
    // §4 correction: ONE budget level — 2→3, never 2→4. Step 4 halves the
    // lattice twice (16x fewer vertices) and visibly terraces the walls;
    // step 3 is the measured middle (still 2.8x fewer than step 2).
    for (const st of [1, 2, 3]) {
      const b = document.createElement("button");
      b.type = "button";
      // ?lod=N pins the LOD: the matching step shows as active.
      b.textContent = lodPinned === st ? `paso ${st} (?lod)` : `paso ${st}`;
      b.className = st === step ? "hud-btn active" : "hud-btn";
      b.addEventListener("click", () => {
        step = st;
        metrics.lod = st;
        for (const c of lodRow.children) c.classList.remove("active");
        b.classList.add("active");
        rebuildTerrain();
        // Rastro enterrado: una línea, un LOD — la línea se re-drapea sobre
        // el lattice nuevo en el mismo sitio que cambia el LOD.
        line.redrape((x, y) => meshHeightAtStep(elev, meta, x, y, step), step);
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
    // Rastro gl_InstanceID: HUD audit — uStepM + instance count + Line2
    // census (no attribute left to sample; the index IS the distance).
    // G22 (frame limpio): getError() right after EACH renderer.render of
    // the frame — capture, main, probes — with the pass name. INVALID_
    // OPERATION after a pass means THAT pass fed its own destination
    // (feedback loop) and its draws were discarded by the driver.
    // glProbe/glPassErr live outside this block (created before the loop).
    const trackLab = el("div", "hud-label", "track …");
    hud.append(trackLab);
    const trackTick = window.setInterval(() => {
      const ids = line.debugIds();
      let nLine2 = 0;
      scene.traverse((o) => {
        if ((o as unknown as { isLine2?: boolean }).isLine2 === true) nLine2++;
      });
      // G22: the loop drains GL after every pass and keeps the per-frame
      // ledger — this poll only READS the ledger (never getError here:
      // polling would drain the flag the loop just recorded). Empty label =
      // clean frame; passes[...] names the failing pass.
      const passTxt = glPassErr.label !== "" ? ` passes[${glPassErr.label}]` : "";
      const skycapTxt = boot.skycap ? "" : " skycap=0";
      const label = `track uStepM=${ids.stepM} instances=${ids.count} line2=${nLine2} uProg=${line.debugProgressDist().toFixed(1)} lod=${metrics.lod} lineLod=${line.lineLod()}${skycapTxt}${passTxt}`;
      if (trackLab.textContent !== label) trackLab.textContent = label;
      trackLab.style.color = glPassErr.label !== "" ? "#ff6b6b" : "";
    }, 500);
    void trackTick;
  }

  // ?debug=path instrument (3-panel overlay, lazy import keeps it out of the
  // entry chunk graph unless requested)
  if (boot.path) {
    const { mountPathOverlay } = await import("../narrative/debug-path.ts");
    mountPathOverlay({ route, world, elev, meta, progress, rig });
  }
  // §4b FASE 2b (?skymap=1): blit the 64×32 capture target, 384×192 CSS px
  // bottom-left, own NDC ortho scene (never the main scene), after the main
  // render + labels. NDC camera (-1..1) is NEVER moved: the mesh is sized
  // and placed in NDC from CSS px (384/w, 192/h), recomputed on resize.
  // depthTest/Write off + renderOrder 999: composites over the frame.
  // autoClear=false around the pass (the default wiped the frame → black).
  let skymapBlit: {
    scene: THREE.Scene;
    cam: THREE.OrthographicCamera;
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  } | null = null;
  function layoutSkymapBlit(): void {
    if (!skymapBlit) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = (2 * 384) / w;
    const bh = (2 * 192) / h;
    skymapBlit.mesh.geometry.dispose();
    skymapBlit.mesh.geometry = new THREE.PlaneGeometry(bw, bh);
    skymapBlit.mesh.position.set(-1 + bw / 2, -1 + bh / 2, 0);
  }
  function ensureSkymapBlit(): void {
    if (skymapBlit || !skyCap) return;
    const bscene = new THREE.Scene();
    const bcam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const bmat = new THREE.MeshBasicMaterial({
      map: skyCap.texture(),
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
    });
    const bmesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bmat);
    bmesh.renderOrder = 999;
    bmesh.frustumCulled = false;
    bscene.add(bmesh);
    skymapBlit = { scene: bscene, cam: bcam, mesh: bmesh };
    layoutSkymapBlit();
  }
  window.addEventListener("resize", () => {
    layoutSkymapBlit();
  });
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
  // §4b FASE 4b: cloud pixel meter — the SAME InstancedMesh with a flat
  // probe material (atlas alpha × vAlpha only, no colour) into its own
  // 96×54 target. Counted inside the TERRAIN-sky mask (occBuf): only sky
  // pixels can be cloud-covered. Same camera, same frame, no extra scene.
  // The probe material borrows the LIVE uniform objects (uMap/uDensity/
  // uCap/uMask) — same values the draw uses, zero copies to forget.
  // §4b FASE 4b: the pixel meter renders the cloud mesh WITHOUT terrain
  // (own mini-scene holding just the mesh — terrain would paint the mask
  // white and hide the clouds). Same mesh object, probe material, same
  // camera: one draw, no state leaks (material restored right after).
  const cloudPxScene = new THREE.Scene();
  function occSceneOccless(): THREE.Scene {
    if (cloudPxScene.children.length === 0) cloudPxScene.add(clouds.mesh);
    return cloudPxScene;
  }
  const cloudPxTarget = new THREE.WebGLRenderTarget(96, 54, { depthBuffer: false });
  const cloudPxBuf = new Uint8Array(96 * 54 * 4);
  const cloudPxMat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute vec4 aData;
      varying vec2 vUv; varying float vAlpha;
      void main(){
        float quad = aData.x;
        vUv = vec2(mod(quad,2.0)*0.5 + uv.x*0.5, floor(quad/2.0)*0.5 + uv.y*0.5);
        vec2 p = position.xy * aData.z;
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vAlpha = aData.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(c.xyz + right * p.x + up * p.y, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vAlpha;
      uniform sampler2D uMap; uniform float uDensity; uniform float uCap; uniform float uMask;
      void main(){
        float tex = texture2D(uMap, vUv).r;
        float m = smoothstep(uMask, uMask + 0.08, tex);
        float a = tex * m * vAlpha * uDensity * uCap;
        if (a <= 0.15) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
      }`,
  });
  let cloudPxWired = false;
  // G11 probe flag (?luma=1 with ?s=0.10): luminance sampling in the loop.
  // The threshold lives in choreography.ts; the loop exposes window.__luma
  // and the HUD line so the audit reads a number, not an impression.
  // G12 rides the occluder pass (?skyfrac=1 -> window.__skyFrac): black
  // pixels ARE sky (only terrain occludes). G17 rides free: black pixels
  // in the LOWER half are void under the horizon.
  const lumaOn = new URLSearchParams(location.search).has("luma");
  // Occluder geometry feeds the luma-shadow probe (?luma=1), the sky
  // fraction + blue-sky + cloud-pixel probes (?skyfrac=1, G12/G30/G24c):
  // the mask source, not the flag.
  const occNeeded = ((): boolean => {
    const q = new URLSearchParams(location.search);
    return q.has("luma") || q.has("skyfrac");
  })();
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
    // LineMaterial.resolution is in pixels — the drawing buffer, not CSS px.
    renderer.getDrawingBufferSize(res2);
    for (const m of line.group.children) {
      const lm = (m as { material: { resolution: THREE.Vector2 } }).material;
      lm.resolution.copy(res2);
    }
  });

  // E1: far-plane budget watch — drone views pull in more triangles. If
  // msFrame breaks 24, drop the far LOD before touching the camera.
  let lodDropped = false;
  let lodHotFrames = 0;

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
    // sky + fog colour refresh in the SAME event (gated by solar elevation).
    // G22: getError() right after the capture render names the pass. Always
    // drains (getError clears the flag); the HUD poll reads the ledger, it
    // never polls GL itself.
    // §4b FASE 2: the zenith readPixels moved OUT of the hot loop (see the
    // 30-frame probe block below). refreshIfNeeded stays here (it only
    // renders on sun moves > 0.5°); the per-frame readback is gone, so
    // production pays ~0 ms for the probe (was ~3 ms: 20.7 vs 17.6).
    skyCap?.refreshIfNeeded(st.sunElev);
    if (boot.debug) glPassErr.capture = glProbe.getError();
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
      // §4b FASE 4b: cloud light follows presence (never gates it, G35).
      // uHemiSky (valley fill, same hue family) + sun colour + dayF.
      clouds.setLight(
        sun.color,
        hemiSky,
        cloudDayF,
      );
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
        // §4b FASE 4b: epilogue height fade — on when the camera flies
        // above the band, off otherwise (horizon puffs stay either way).
        const band = (window as unknown as { __cloudBand?: { base: number } }).__cloudBand;
        clouds.setBelowFade(camera.position.y > (band?.base ?? Infinity) ? 1 : 0);
        clouds.setCamY(camera.position.y);
      }
      clouds.update(clock.elapsedTime, camera, renderer.domElement.width, renderer.domElement.height);
      metrics.cloudCoverage = clouds.getCoverage();
      // §4: the 20% veil cap is GONE (T1 verdict belonged to the unweighted
      // metric). The cap now guards the CLOUD_COVERAGE target band instead:
      // halve global alpha only while visibly above 0.38 (upper edge).
      clouds.setCap(clouds.getCoverage() > 0.38);
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
    // Rastro/feedback-loop: FIXED FRAME ORDER, never interleaved.
    // 1. render(scene) to canvas FIRST (the user frame — nothing bound).
    // 2. probes (occluder / ID) only AFTER, each restoring setRenderTarget(null).
    // 3. readPixels inside the probe call (R1: same task, never next frame).
    // trackdist is LOOK-only: it skips every probe (see below) so nothing
    // can steal the canvas between the line passes and the screen.
    // T1 (mandatory order): the rig already wrote position/quaternion above;
    // refresh the world matrix, render, then project the labels with the
    // SAME matrix that just rendered. Projecting before rig.update() trails
    // one frame behind the canvas — invisible when still, swimming on scroll.
    camera.updateMatrixWorld(true);
    renderer.info.reset();
    renderer.render(scene, camera);
    // §4b FASE 2b: HUD counter reads the MAIN pass only — info.reset()
    // before the render zeroes the accumulator, so info.render.calls/tris
    // are the main pass even when probes/blits run later in the frame.
    // (renderer.info.autoReset resets per render() call; the blit/probes
    // after this point would otherwise overwrite the numbers with their
    // own — "calls 1" was the 2-triangle blit counted as the frame.)
    metrics.drawCalls = renderer.info.render.calls;
    metrics.triangles = renderer.info.render.triangles;
    metrics.passes = 1;
    if (boot.debug) {
      // G22: name the failing pass — capture recorded above, main here,
      // probes below (their own scenes). Always drains; the per-frame label
      // below is what the HUD poll reads.
      glPassErr.main = glProbe.getError();
    }
    // T1: labels AFTER render, every frame, no throttle (js etiq ~0.1 ms).
    // §4b FASE 5 (G33): el crono envuelve SOLO updateLabels — t2 se movía
    // antes de applyLighting, corte del rastro, sombra y renderer.render,
    // así que "js etiq" medía el render, no las etiquetas.
    const tl = performance.now();
    updateLabels(labelRts, camera, window.innerWidth, window.innerHeight, 30000);
    metrics.jsLabels = performance.now() - tl;
    // §4b FASE 2b (?skymap=1): 384×192 CSS px bottom-left, NDC scene,
    // AFTER main render + labels. autoClear=false: composites, never wipes.
    // Renderer path only, never raw GL.
    if (boot.skymap && skyCap && boot.skycap) {
      ensureSkymapBlit();
      if (skymapBlit) {
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.render(skymapBlit.scene, skymapBlit.cam);
        renderer.autoClear = prevAutoClear;
        metrics.passes = 2;
      }
    }
    metrics.jsTerrain = 0; // terrain JS slice is inside rebuilds, not the loop
    metrics.msPost = 0;
    // G11 (audit A6): mean linear luminance over a LUMA_GRID^2 readPixels
    // grid, every 30th frame, only with ?luma=1 (a per-frame readPixels
    // stall would eat the budget it is meant to protect). R1: sampled AFTER
    // renderer.render() — the presented frame, never the previous one.
    // trackdist LOOK-only (auditoría rastro): with the gradient flag, ALL
    // probes are skipped — there is nothing to measure, only to see, and
    // any extra render between the line passes and the screen risks the
    // feedback loop again.
    // G15 (?trackpx=1 -> window.__trackpx): offscreen ID pass — the solid
    // Line2 alone into 256x144, non-null pixels counted. Threshold: >= 40 px.
    if ((lumaOn || skyfracOn || trackpxOn) && !boot.trackDist && frames % 30 === 5) {
      // §4b FASE 2: zenith probe joins the 30-frame cadence (DEBUG ONLY —
      // readRenderTargetPixels syncs the GPU: ~3 ms/frame for everyone if
      // it runs in the hot loop. Without ?debug=1 this block never runs,
      // so production pays zero readPixels here).
      if (boot.debug && skyCap && boot.skycap) {
        try {
          const { disp, raw, sun, anti } = skyCap.readZenith();
          const toHex = (c: [number, number, number]): string =>
            `#${[c[0], c[1], c[2]].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
          // DISPLAY values (ACES + sRGB, what the user sees) drive the HUD
          // and the ratio. raw stays on window.__zenithLinear (audit trail).
          // §4b FASE 3c: sun-side + anti-sun horizon rows → __hzSunHex /
          // __hzAntiHex (the dusk has a direction: warm west, cool east).
          metrics.zenithHex = toHex(disp.zen);
          const luma = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
          (window as unknown as { __skyHzRatio?: number }).__skyHzRatio = luma(disp.hor) / Math.max(1e-6, luma(disp.zen));
          (window as unknown as { __zenithLinear?: string }).__zenithLinear = toHex(raw.zen);
          (window as unknown as { __hzSunHex?: string }).__hzSunHex = toHex(sun.hor);
          (window as unknown as { __hzAntiHex?: string }).__hzAntiHex = toHex(anti.hor);
        } catch {
          /* probe failed — computed estimate below stays */
        }
      }
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
      // §4b FASE 5: la sonda de sombra usa ESTA máscara con ?luma=1 (aunque
      // no esté ?skyfrac=1) para quedarse solo con píxeles de terreno; por
      // eso el pase corre con occNeeded (luma||skyfrac), no con skyfracOn.
      let occRan = false;
      if (occNeeded && terrain) {
        if (!occMesh) {
          occMesh = new THREE.Mesh(terrain.geometry, occMat);
          occMesh.frustumCulled = false;
          occScene.add(occMesh);
        } else if (occMesh.geometry !== terrain.geometry) {
          occMesh.geometry = terrain.geometry;
        }
        occRan = true;
        const sky = renderCount(renderer, occTarget, occBuf, occScene, camera, 256, 144,
          (rr, gg, bb) => rr < 8 && gg < 8 && bb < 8);
        if (skyfracOn) {
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
      }
      // §4b FASE 5 (G31/G32): sonda de sombra, solo con ?luma=1, misma
      // rejilla LUMA_GRID de readPixels que __luma. Sin oclusor no hay
      // máscara de terreno: publica -1 (pendiente) en vez de un número.
      // Cuartil más oscuro de píxeles de TERRENO (no-cielo según occBuf):
      // __lumaShadow = luma lineal media del cuartil; __chromaShadow =
      // media de (max-min)/max en ese cuartil (0 = gris, 1 = saturado).
      // El conteo de quemados viaja en la misma muestra: píxeles de
      // terreno con luma lineal >= 0,9 (puerta: 0).
      if (lumaOn) {
        if (occRan) {
          const lumOf = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
          const terrLumas: number[] = [];
          const terrChromas: number[] = [];
          let litOver = 0;
          const gridW = 256;
          const gridH = 144;
          // Misma rejilla conceptual que __luma (g×g sobre la imagen):
          // paso en píxeles del canvas -> paso proporcional en la máscara.
          for (let gy = 0; gy < g; gy++) {
            for (let gx = 0; gx < g; gx++) {
              const fx = Math.min(w - 1, Math.floor((gx + 0.5) * (w / g)));
              const fy = Math.min(h - 1, Math.floor((gy + 0.5) * (h / g)));
              const mx = Math.min(gridW - 1, Math.floor((fx / Math.max(1, w)) * gridW));
              const my = Math.min(gridH - 1, Math.floor((fy / Math.max(1, h)) * gridH));
              const mo = (my * gridW + mx) * 4;
              if ((occBuf[mo] as number) < 8 && (occBuf[mo + 1] as number) < 8 && (occBuf[mo + 2] as number) < 8) continue; // cielo
              const o = (fy * w + fx) * 4;
              const rr = (buf[o] as number) / 255;
              const gg = (buf[o + 1] as number) / 255;
              const bb = (buf[o + 2] as number) / 255;
              const lr = lumOf(rr);
              const lg = lumOf(gg);
              const lb = lumOf(bb);
              const luma = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
              const mxc = Math.max(lr, lg, lb);
              const mnc = Math.min(lr, lg, lb);
              terrLumas.push(luma);
              terrChromas.push(mxc > 1e-6 ? (mxc - mnc) / mxc : 0);
              if (luma >= 0.9) litOver++;
            }
          }
          if (terrLumas.length > 0) {
            const order = terrLumas.map((_, i) => i).sort((a, b) => (terrLumas[a] as number) - (terrLumas[b] as number));
            const q = Math.max(1, Math.floor(order.length / 4));
            let sumL = 0;
            let sumC = 0;
            for (let i = 0; i < q; i++) {
              sumL += terrLumas[order[i] as number] as number;
              sumC += terrChromas[order[i] as number] as number;
            }
            (window as unknown as { __lumaShadow?: number }).__lumaShadow = sumL / q;
            (window as unknown as { __chromaShadow?: number }).__chromaShadow = sumC / q;
            if (boot.debug) {
              metrics.lumaShadow = (window as unknown as { __lumaShadow?: number }).__lumaShadow ?? -1;
              metrics.chromaShadow = (window as unknown as { __chromaShadow?: number }).__chromaShadow ?? -1;
            }
            (window as unknown as { __litOver?: number }).__litOver = litOver;
          } else {
            (window as unknown as { __lumaShadow?: number }).__lumaShadow = -1;
            (window as unknown as { __chromaShadow?: number }).__chromaShadow = -1;
            (window as unknown as { __litOver?: number }).__litOver = -1;
          }
        } else {
          (window as unknown as { __lumaShadow?: number }).__lumaShadow = -1;
          (window as unknown as { __chromaShadow?: number }).__chromaShadow = -1;
          (window as unknown as { __litOver?: number }).__litOver = -1;
        }
      } // cierre if (lumaOn)
      // §4b FASE 2b (G26 medible) + G22: sin cambios — el blit y getError
      // ya viven en el bloque de 30 frames; la sonda de sombra no mueve
      // nada (misma rejilla, misma máscara, solo aritmética JS).
      // §4b FASE 4 (G30 cielo azul): con ?skyfrac=1, fracción de cielo NO
      // cubierta por nubes = píxeles de cielo (máscara oclusora) × (1 −
      // cobertura por PÍXELES). Sin oclusor no hay máscara: -1 (pendiente).
      if (skyfracOn) {
        // §4b FASE 4b: pixel meter — cloud mesh with the flat probe
        // material into 96×54, counted inside the terrain-sky mask.
        // Runs ONLY with ?skyfrac=1 on the 30-frame cadence (production
        // never pays it). Publishes __cloudCoverPx (sky fraction covered)
        // next to the analytic __metrics.cloudCoverage so the audit sees
        // how much the disc meter lies.
        if (occRan) {
          try {
            if (!cloudPxWired) {
              const pu = clouds.probeUniforms();
              (cloudPxMat.uniforms["uMap"] as { value: unknown }).value = pu.uMap;
              (cloudPxMat.uniforms["uDensity"] as { value: unknown }).value = pu.uDensity;
              (cloudPxMat.uniforms["uCap"] as { value: unknown }).value = pu.uCap;
              (cloudPxMat.uniforms["uMask"] as { value: unknown }).value = pu.uMask;
              cloudPxWired = true;
            }
            const prevColor = renderer.getClearColor(new THREE.Color());
            const prevAlpha = renderer.getClearAlpha();
            renderer.setRenderTarget(cloudPxTarget);
            renderer.setClearColor(0x000000, 1);
            renderer.clear(true, false, false);
            const prevMat = clouds.mesh.material;
            clouds.mesh.material = cloudPxMat;
            clouds.mesh.frustumCulled = false;
            renderer.render(occSceneOccless(), camera);
            clouds.mesh.material = prevMat;
            renderer.readRenderTargetPixels(cloudPxTarget, 0, 0, 96, 54, cloudPxBuf);
            renderer.setRenderTarget(null);
            renderer.setClearColor(prevColor, prevAlpha);
            // count white (cloud, a>0.15) inside the terrain-sky mask:
            // occBuf is 256×144, cloudPxBuf is 96×54 — nearest mapping.
            let skyN = 0;
            let cloudN = 0;
            for (let yy = 0; yy < 54; yy++) {
              for (let xx = 0; xx < 96; xx++) {
                const mx = Math.min(255, Math.floor((xx / 96) * 256));
                const my = Math.min(143, Math.floor((yy / 54) * 144));
                const mo = (my * 256 + mx) * 4;
                if ((occBuf[mo] as number) < 8 && (occBuf[mo + 1] as number) < 8 && (occBuf[mo + 2] as number) < 8) {
                  skyN++;
                  const co = (yy * 96 + xx) * 4;
                  if ((cloudPxBuf[co] as number) > 128) cloudN++;
                }
              }
            }
            const coverPx = skyN > 0 ? cloudN / skyN : 0;
            (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx = coverPx;
            const skyPx = (window as unknown as { __skyFrac?: number }).__skyFrac ?? -1;
            const blue = skyPx >= 0 ? Math.min(1, Math.max(0, skyPx * (1 - coverPx))) : -1;
            (window as unknown as { __blueSky?: number }).__blueSky = blue;
          } catch {
            (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx = -1;
            (window as unknown as { __blueSky?: number }).__blueSky = -1;
          }
        } else {
          (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx = -1;
          (window as unknown as { __blueSky?: number }).__blueSky = -1;
        }
      }
      // §4b FASE 4 (G19-nube): el bucle del rastro bajo las nubes — el ID
      // pass corre en escena propia (sin nubes): OFF = medida directa y
      // ON = OFF × (1 − cobertura por PÍXELES, __cloudCoverPx cuando hay;
      // si no, analítica). Misma cadencia de 30 frames, solo con
      // ?trackpx=1: publica __trackOcc = { on, off, frac }.
      if (trackpxOn) {
        try {
          const off = line.countIdPixels(renderer, camera);
          (window as unknown as { __trackpx?: number }).__trackpx = off;
          const covPx = (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx ?? -1;
          const cov = covPx >= 0 ? covPx : clouds.group.visible ? clouds.getCoverage() : 0;
          const frac = off > 0 ? Math.min(1, Math.max(0, 1 - cov)) : 1;
          (window as unknown as { __trackOcc?: { on: number; off: number; frac: number } }).__trackOcc = { on: Math.round(off * frac), off, frac };
        } catch {
          (window as unknown as { __trackpx?: number }).__trackpx = -1;
          (window as unknown as { __trackOcc?: { on: number; off: number; frac: number } }).__trackOcc = { on: -1, off: -1, frac: -1 };
        }
      }
      // §4b FASE 2b (G26 medible): one canvas pixel at (16, h-16) — inside
      // the 384×192 blit — read AFTER the blit, BEFORE present, same
      // mechanism as __luma. Only with ?skymap=1 (and debug cadence):
      // production never pays it. Must ≈ the capture's lower-centre pixel
      // (horizon), never #000000, never terrain colour.
      if (boot.skymap && skyCap && boot.skycap) {
        try {
          const gl = renderer.getContext() as WebGL2RenderingContext;
          const pxBuf = new Uint8Array(4);
          const dh = Math.max(1, Math.floor(renderer.domElement.height / (window.devicePixelRatio || 1)));
          gl.readPixels(16, dh - 16, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf);
          const hx = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
          (window as unknown as { __skymapPx?: string }).__skymapPx =
            `#${hx((pxBuf[0] as number) / 255)}${hx((pxBuf[1] as number) / 255)}${hx((pxBuf[2] as number) / 255)}`;
        } catch {
          (window as unknown as { __skymapPx?: string }).__skymapPx = "#000000";
        }
      }
      if (boot.debug && (skyfracOn || trackpxOn || lumaOn)) {
        glPassErr.probe = glProbe.getError();
      }
      if (boot.debug) {
        // G22 per-frame label: capture → main → probe, first error wins.
        // Rebuilt every frame (sticky would blame a pass fixed long ago);
        // the 500 ms HUD poll samples it, so a persistent loop stays visible
        // while a one-off flickers once and clears — which is the point.
        const bad = glPassErr.capture !== glProbe.NO_ERROR ? `capture:${glPassErr.capture}`
          : glPassErr.main !== glProbe.NO_ERROR ? `main:${glPassErr.main}`
            : glPassErr.probe !== glProbe.NO_ERROR ? `probe:${glPassErr.probe}` : "";
        glPassErr.label = bad === "" ? "" :
          bad.endsWith(`:${glProbe.INVALID_OPERATION}`) ? `${bad.slice(0, -String(glProbe.INVALID_OPERATION).length - 1)}:INVALID_OPERATION` : bad;
      }
      void frames;
    }
    frames++;
    // P0/G20: late check (frame 60) — the terrain program compiles after
    // first render on the ?s= path, so frame 8 would false-positive on the
    // neutral 1x1 probe still in flight.
    if (frames === 60) {
      const glErr = checkGLPrograms();
      if (glErr) gate.fail(glErr);
    }
    // E1 budget: SUSTAINED >24 ms frames drop one LOD notch (2->3), once.
    // Sustained = 120 consecutive frames above budget (msFrame is already a
    // moving average — a single slow frame must never trip it). The camera
    // never pays for the triangle budget.
    // ?lod=N pins the LOD and disables this rule (rastro enterrado probe).
    // §4 correction: one level (2→3), never two (2→4 halves the lattice
    // twice and terraces the walls).
    if (boot.lod === null && !lodDropped && step === 2 && metrics.msFrame > 24) {
      lodHotFrames++;
      if (lodHotFrames >= 120 && frames > 120) {
        lodDropped = true;
        step = 3;
        metrics.lod = step;
        rebuildTerrain();
        // Una línea, un LOD: re-drape sobre el lattice nuevo.
        line.redrape((x, y) => meshHeightAtStep(elev, meta, x, y, step), step);
        if (terrainMat?.map) terrainMat.needsUpdate = true;
      }
    } else {
      lodHotFrames = 0;
    }
  });
}
