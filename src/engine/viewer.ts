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
  CLOUD_ACT_MULT,
  CLOUD_FADE_START_DEG,
  CLOUD_MULT_SMOOTH_K,
  CLOUD_SHADOW_DRIFT_X_MS,
  CLOUD_SHADOW_DRIFT_Y_MS,
  CLOUD_SHADOW_GROUPS,
  CLOUD_SHADOW_K,
  CLOUD_SHADOW_SUN_HI_DEG,
  CLOUD_SHADOW_SUN_LO_DEG,
  CLOUD_SHADOW_W,
  CLOUD_ZENITH_FADE,
  CORRIDOR_HALF_M,
  EPILOGUE_S,
  G11_LUMA_MIN,
  GLOW_S_WINDOW,
  HEMI_DAY,
  HEMI_GROUND_RGB,
  HEMI_LIGHT_GRAY,
  HEMI_LUMA_FLOOR,
  HEMI_NIGHT,
  HEMI_SKY_RGB,
  LUMA_GRID,
  ROCK_CHROMA_CAP,
  ROCK_CONTRAST,
  ROCK_CORRIDOR_K,
  ROCK_DIP,
  ROCK_FAR_M,
  ROCK_GRAIN_K,
  ROCK_MASK_SCALE,
  ROCK_MEAN,
  ROCK_MIX,
  ROCK_NEAR_M,
  ROCK_NORMAL_W,
  ROCK_SCALE_A,
  ROCK_SCALE_B,
  ROCK_STEEP_HI,
  ROCK_STEEP_LO,
  ROCK_TONE_W,
  ROCK_WALL_POW,
  ROCK_WARP_M,
  ROCK_WARP_SCALE_M,
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
} from "../narrative/choreography.ts";
import { initProgress, type ProgressHandle } from "../narrative/progress.ts";
import { createScroll, type ScrollHandle } from "../narrative/scroll.ts";
import { buildBeams, type BeamDef, type Beams } from "./beams.ts";
import { buildClouds } from "./clouds.ts";
import { cloudAmount, mistAmount } from "./sun.ts";
import { frameClock, mountDebug, parseBootQuery } from "./debug.ts";
import { buildGate, nextFrame } from "./gate.ts";
import { createSkyCapture, type SkyCapture } from "./sky-capture.ts";
import { fogUniforms, makeCloudShadowTexture, patchTerrainMaterial } from "./height-fog.ts";
import {
  buildLabels,
  rayBlocked,
  releaseBeam,
  updateLabels,
  type LabelDef,
} from "./labels.ts";
import { trackAt } from "../narrative/anchors.ts";
import { buildRouteLine, renderCount } from "./route-line.ts";
import { epsgToWorld } from "./terrain.ts";
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
  sampleGrid,
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

/** JS smoothstep (viewer-local; mirrors the GLSL one). */
function smoothstepJS(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
  // §4b FASE 3c-fix: three does NOT declare material.uniforms entries in
  // GLSL — it only uploads them. Every uniform added here MUST be declared
  // in the injected string (AGENTS.md rule). Prepended BEFORE any other
  // code (three's prefix with #version/precision comes from the program
  // assembler, not from fragmentShader — onBeforeCompile text starts with
  // plain #defines, so a header prepend is safe).
  {
    const skym = sky.material as THREE.ShaderMaterial & { onBeforeCompile: (s: { fragmentShader: string }) => void };
    const prevSky = skym.onBeforeCompile.bind(skym);
    (sky.material as THREE.Material).onBeforeCompile = (s: { fragmentShader: string }) => {
      prevSky(s);
      s.fragmentShader =
        "uniform float uSkyScale;\nuniform float uSunElev;\n" + s.fragmentShader;
      s.fragmentShader = s.fragmentShader.replace(
        "gl_FragColor = vec4( retColor, 1.0 );",
        `float skyDirY = normalize( vWorldPosition - cameraPosition ).y;
        // §6: rampa 0.02→0.24 (plena sobre 13,9°): el día se ve de 0° a 14°
        // de elevación — la franja más pálida de cualquier cielo real. El
        // alba/ocaso NO dependen de esta rampa: los protege skySunF (5°→25°
        // de elevación SOLAR), que sigue igual.
        float skyViewF = smoothstep( 0.02, 0.24, skyDirY );
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
  // N2: cloudUser = multiplicador del usuario (?clouds=); amount viene de
  // sun.cloudAmount(hora) y mult de CLOUD_ACT_MULT[acto] suavizado.
  // Dawn-smoothing: sunElevSm is the 1−exp(−k·dt) state for every
  // elevation-driven term (warm haze, uDawnF): scroll notches move the raw
  // elevation ±0.3°/frame and the whole scene's warmth used to jump.
  // k=1.2/s: ~2 s to converge, invisible lag against a minutes-long dawn.
  let sunElevSm = 50;
  let sunElevInit = false;
  let cloudDayF = 1;
  let cloudMultSm = 1;
  // N2c-fix: valores de sombra SUBIDOS a uniformes (misma escritura, no
  // recálculo) — el HUD los lee cada frame (letra a-f del diagnóstico).
  const shadowHud = { k: 0, sunF: 0, dayF: 0, amt: 0, mult: 1, user: 1, wMax: 0, alive: 0, noise: false };

  function applyLighting(h: number, dt = -1): void {
    const sp = sunPosition(h);
    // Dawn-smoothing: elevation-driven terms (warm haze, uDawnF) read the
    // 1−exp(−k·dt) state, never the raw notch — a scroll step moves the sun
    // ±0.3° and the whole scene's warmth used to jump. k=1.2/s converges
    // in ~2 s, invisible lag against a minutes-long dawn. dt<0 (boot
    // probes before the loop) snaps instead of easing from the 50° seed.
    if (dt < 0 || !sunElevInit) {
      sunElevSm = sp.elevationDeg;
      sunElevInit = true;
    } else {
      sunElevSm += (sp.elevationDeg - sunElevSm) * (1 - Math.exp(-1.2 * dt));
    }
    const elevSmU = sunElevSm;
    // lightingAt reads the SMOOTHED elevation (sun colour/intensity,
    // exposure, day factors, nightMix) — hour-driven terms (fog, clouds)
    // still read the clock inside. One writer for the dawn state.
    const L = lightingAt(h, elevSmU);
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
    // F2: la niebla baja mira al sol (uSunDirW compartido con el shader).
    (fogUniforms.uSunDirW.value as THREE.Vector3).copy(dir);
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
    // F1 niebla de valle: uDawnF = 1 − smoothstep(2°,20°,elev) — al
    // alba/ocaso la niebla baja multiplica y el horizonte funde; a las
    // 12:00 vale 0 y el mediodía queda intacto por construcción.
    // Dawn-smoothing: reads the eased elevation (same state as warmTop).
    {
      const t = Math.min(1, Math.max(0, (elevSmU - 2) / 18));
      const f = t * t * (3 - 2 * t);
      (fogUniforms.uDawnF as { value: number }).value = 1 - f;
    }
    // Warm drift around 12° solar elevation (dawn/dusk glow on the haze).
    // Shaped like the sun's own low arc: flat top ±6° (no kink at the
    // peak), smoothstep falloff to zero at 12±18° — the old |e − 12|/25 V
    // peaked at 12° and switched the whole scene's warmth in a scroll
    // step at dawn. At 12:00 (elev ≈ 50.7°) warm is 0, as before.
    const warmTop = 1 - smoothstepJS(6, 18, Math.abs(elevSmU - 12));
    fogUniforms.uFogTop.value = L.fogTopM;
    fogUniforms.uFogDensity.value = 0.25 + L.fogDensity * 0.75;
    const top: [number, number, number] = L.nightMix > 0.5
      ? [0.02, 0.03, 0.07]
      : [0.55 + warmTop * 0.35, 0.6 + warmTop * 0.15, 0.72 - warmTop * 0.2];
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
      // §6b HEMI_LIGHT_GRAY: la LUZ hemisférica se acerca a gris preservando
      // luma — el azul de las paredes en sombra, en su sitio. SOLO hemi.color:
      // uHemiSky no (ahí ya actúa HEMI_GRAY_MIX → se grisaría dos veces).
      const zrH = zr + (lumaSky - zr) * HEMI_LIGHT_GRAY;
      const zgH = zg + (lumaSky - zg) * HEMI_LIGHT_GRAY;
      const zbH = zb + (lumaSky - zb) * HEMI_LIGHT_GRAY;
      const lift = Math.max(1, HEMI_LUMA_FLOOR / Math.max(1e-6, lumaSky));
      hemiSky.setRGB(zrH * lift, zgH * lift, zbH * lift);
      hemi.color.copy(hemiSky);
      hemi.groundColor.copy(hemiGround);
      // Dawn continuity: the old `elev > SUNSET_ELEV_DEG ? 1 : 0` jumped the      // whole valley fill HEMI_NIGHT→HEMI_DAY in one scroll step at sunrise.
      // Eased over −2°→0° like the sun/exposure ramps (nightMix already is).
      const dayF = smoothstepJS(-2, 0, elevSmU);
      hemi.intensity = HEMI_DAY * dayF + HEMI_NIGHT * (1 - dayF);
      (fogUniforms.uHemiSky.value as [number, number, number])[0] = zr * 0.5 * lift;
      (fogUniforms.uHemiSky.value as [number, number, number])[1] = zg * 0.5 * lift;
      (fogUniforms.uHemiSky.value as [number, number, number])[2] = zb * 0.5 * lift;
      (fogUniforms.uHemiDay as { value: number }).value = dayF;
    }
    routeDim = 1 - L.nightMix * 0.3;
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
    // §4b FASE 3c-fix: P0-3 looks at what it must look at. renderer.info
    // .programs[].diagnostics only flags what three CHECKED — a dome with
    // undeclared identifiers linked false and nobody asked. So: once the
    // loop has rendered (framesLive ≥ 2), walk the REAL GL programs
    // (getProgramParameter LINK_STATUS, the driver's verdict) + three's
    // diagnostics, publish window.__programs = [{name, ok, log}] with
    // ?debug=1, and fail loudly.
    // READ-ONLY GL (getProgramParameter/getShaderInfoLog are reads —
    // AGENTS.md allows them); no state is written.
    try {
      if (framesLive < 2) return null;
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const progs = renderer.info.programs as {
        diagnostics?: { runnable?: boolean };
        name?: string;
        program?: WebGLProgram | { id?: number };
      }[];
      const report: { name: string; ok: boolean; log: string }[] = [];
      let bad: string | null = null;
      for (const p of progs) {
        const prog = (p as { program?: unknown }).program;
        let ok = p.diagnostics?.runnable !== false;
        let log = "";
        if (prog instanceof WebGLProgram) {
          const linked = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
          ok = ok && linked;
          if (!linked) {
            const shaders = gl.getAttachedShaders(prog) ?? [];
            const logs = shaders.map((s) => gl.getShaderInfoLog(s) ?? "");
            log = logs.filter((l) => l !== "").join("\n") || gl.getProgramInfoLog(prog) || "(no log)";
          }
        }
        const nm = p.name ?? "shader";
        report.push({ name: nm, ok, log: log.slice(0, 2000) });
        if (!ok) {
          console.error(`[ordesa] dead GL program ${nm}:\n${log || p.diagnostics ? "(diagnostics)" : "(no log)"}\n${log}`);
          bad = `Error de gráficos (${nm}). Recarga; si persiste, prueba otro navegador.`;
        }
      }
      if (boot.debug) {
        (window as unknown as { __programs?: { name: string; ok: boolean; log: string }[] }).__programs = report;
      }
      return bad;
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
    // §5d-ter: customProgramCacheKey incluye la bandera de sonda (+wallprobe):
    // three decide "mismo programa, no recompilo" SOLO por la clave. Con
    // clave única, el programa se compilaba una vez y el parche de sonda
    // posterior NUNCA entraba al GL (GLSL compilado: decl SÍ, ramas NO —
    // medido con probeGLSL). Con la bandera en la clave, ?debug=walls nace
    // CON sonda y el GLSL trae las tres ramas. Sigue sin recompilar en
    // runtime (la clave no cambia 0→1→2→3: uWallProbe es uniforme).
    const probeKey = boot.steep || boot.walls || boot.walls2 ? "+wallprobe" : "";
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
        s.uniforms["uRockMix"] = rockMix;
        s.uniforms["uRockDebug"] = rockDebug;
        s.uniforms["uGrainK"] = grainK;
        s.uniforms["uHasCorr"] = hasCorr;
        s.uniforms["uHasNormal"] = hasNormal;
  s.uniforms["uRock"] = rockUniform;
  s.uniforms["uRockNormal"] = rockNormalUniform;
  s.uniforms["uHasRock"] = hasRock;
  s.uniforms["uWallProbe"] = wallProbe;
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
uniform float uWallDeg; uniform float uRockWeight; uniform float uRockMix; uniform float uRockDebug; uniform float uGrainK;
uniform float uHasCorr; uniform float uHasNormal;
uniform float uWallProbe; // §5d-ter: wall probe (0=off · 1=slope/rockK/b−r(albedo) · 2=b−r(final)/luma(final) · 3=round-trip camino real), declared (G40)
uniform sampler2D uRock; uniform sampler2D uRockNormal; uniform float uHasRock;
varying vec3 vWPos2; varying vec3 vWNormal2; varying vec2 vTerrainUv;
float gSteep = 0.0;
float gRaw = 0.0;
float grockMix = 0.0;
float gSlope = 0.0;
// §5d-bis: gCroma/gCromaF/gGrain retirados (muertos: los cocientes se inflan
// sobre albedo oscuro — G104 dos veces). La sonda publica b−r (gBR/gBRF)
// + luma (gLumaF). ?debug=steep sigue pintando su propio B (+0,5 inline).
float gBR = 0.0;
float gLumaF = 0.0;
float gBRF = 0.0;
float gluma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float whash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float wnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(whash(i), whash(i + vec2(1.0, 0.0)), u.x),
             mix(whash(i + vec2(0, 1.0)), whash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float wgrain(vec2 lp){
  vec2 p = vec2(lp.x / 2.5, lp.y);
  return wnoise(p) * 0.5714 + wnoise(p * 2.3) * 0.2857 + wnoise(p * 5.1) * 0.1429;
}
// §5c: roca estratificada triplanar (solo planos verticales).
// V corregida IDÉNTICA en ambos planos y en albedo y normal: el lecho es
// y + buzamiento·x + buzamiento·z + alabeo = constante (geología correcta:
// localmente horizontal, globalmente sin isolínea que cruce el circo).
// ws con suelo 0,05 (no 1e-4): al normalizar por ~0 la pared escupe
// cortinas verticales estiradas (triplanar degenerado).
vec3 rockTriplanar(vec3 wp, vec3 wn){
  float wx = pow(abs(wn.x), ${(ROCK_WALL_POW as number).toFixed(1)});
  float wz = pow(abs(wn.z), ${(ROCK_WALL_POW as number).toFixed(1)});
  float ws = max(wx + wz, 0.05);
  float yAdj = wp.x * ${(ROCK_DIP as number).toFixed(3)} + wp.z * ${(ROCK_DIP as number).toFixed(3)}
             + (wnoise(wp.xz / ${(ROCK_WARP_SCALE_M as number).toFixed(1)}) - 0.5) * 2.0 * ${(ROCK_WARP_M as number).toFixed(1)};
  float vy = wp.y + yAdj;
  vec3 r1 = texture2D(uRock, vec2(wp.z, vy) / ${(ROCK_SCALE_A as number).toFixed(1)}).rgb * (wx / ws)
          + texture2D(uRock, vec2(wp.x, vy) / ${(ROCK_SCALE_A as number).toFixed(1)}).rgb * (wz / ws);
  vec3 r2 = texture2D(uRock, vec2(wp.z, vy) / ${(ROCK_SCALE_B as number).toFixed(1)} + 0.5).rgb * (wx / ws)
          + texture2D(uRock, vec2(wp.x, vy) / ${(ROCK_SCALE_B as number).toFixed(1)} + 0.5).rgb * (wz / ws);
  float rmx = smoothstep(0.35, 0.65, wnoise(wp.xz / ${(ROCK_MASK_SCALE as number).toFixed(1)}));
  vec3 rock = mix(r1, r2, rmx);
  // §5c: la distancia aplana el CONTRASTE hacia ROCK_MEAN (no desatura:
  // la textura ya es neutra; lo que raya el fondo es el contraste).
  float dfa = smoothstep(${(ROCK_FAR_M as number).toFixed(1)}, ${(ROCK_NEAR_M as number).toFixed(1)}, length(wp - cameraPosition));
  rock = mix(vec3(${(ROCK_MEAN as number).toFixed(2)}), rock, ${(ROCK_CONTRAST as number).toFixed(2)} * (0.15 + 0.85 * dfa));
  return rock;
}
vec3 rockNormalTriplanar(vec3 wp, vec3 wn){
  float wx = pow(abs(wn.x), ${(ROCK_WALL_POW as number).toFixed(1)});
  float wz = pow(abs(wn.z), ${(ROCK_WALL_POW as number).toFixed(1)});
  float ws = max(wx + wz, 0.05);
  float yAdj = wp.x * ${(ROCK_DIP as number).toFixed(3)} + wp.z * ${(ROCK_DIP as number).toFixed(3)}
             + (wnoise(wp.xz / ${(ROCK_WARP_SCALE_M as number).toFixed(1)}) - 0.5) * 2.0 * ${(ROCK_WARP_M as number).toFixed(1)};
  float vy = wp.y + yAdj;
  vec3 n1 = texture2D(uRockNormal, vec2(wp.z, vy) / ${(ROCK_SCALE_A as number).toFixed(1)}).rgb * (wx / ws)
          + texture2D(uRockNormal, vec2(wp.x, vy) / ${(ROCK_SCALE_A as number).toFixed(1)}).rgb * (wz / ws);
  vec3 n2 = texture2D(uRockNormal, vec2(wp.z, vy) / ${(ROCK_SCALE_B as number).toFixed(1)} + 0.5).rgb * (wx / ws)
          + texture2D(uRockNormal, vec2(wp.x, vy) / ${(ROCK_SCALE_B as number).toFixed(1)} + 0.5).rgb * (wz / ws);
  float rmx = smoothstep(0.35, 0.65, wnoise(wp.xz / ${(ROCK_MASK_SCALE as number).toFixed(1)}));
  // Espacio tangente (x, y, z≈1), como nt2: el bloque de normales la suma
  // en el mismo espacio que el grano existente (vec3(x, y, 0)).
  return mix(n1, n2, rmx) * 2.0 - 1.0;
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
  gSlope = slopeDeg;
  float rawSteep = smoothstep(uWallDeg, uWallDeg + 15.0, slopeDeg);
  gRaw = rawSteep;
  float steep = rawSteep * uRockWeight;
  gSteep = steep;
  // §5c: roca triplanar sobre la ortofoto (solo pared de verdad: rampa
  // propia 42°→58° relativa a uWallDeg; rawSteep sigue gobernando grano y
  // normales tal cual). Tono desaturado (brillo de la ortofoto, no su azul)
  // + cap de croma sobre el RESULTADO ponderado por k (k=0: suelo intacto).
  float rockSteep = smoothstep(uWallDeg + ${(ROCK_STEEP_LO as number).toFixed(1)}, uWallDeg + ${(ROCK_STEEP_HI as number).toFixed(1)}, slopeDeg);
  float rockK = rockSteep * uRockWeight * uRockMix * uHasRock * mix(1.0, ${(ROCK_CORRIDOR_K as number).toFixed(2)}, wcorr);
  grockMix = rockK;
  if (rockK > 0.001) {
    vec3 rock = rockTriplanar(vWPos2, wn2);
    if (uRockDebug > 0.5) {
      // §5d ?debug=rock: la CONTRIBUCIÓN real — el mix ponderado por k
      // (antes: roca a plena intensidad con k=0,01, mintiendo dos fases).
      alb = mix(vec3(0.5), rock * (alb / max(gluma(alb), 1e-3)), clamp(rockK, 0.0, 1.0));
    } else {
      vec3 tono = alb / max(gluma(alb), 1e-3);
      tono = mix(vec3(1.0), tono, ${(ROCK_TONE_W as number).toFixed(2)});
      float kk = clamp(rockK, 0.0, 1.0);
      vec3 mixed = mix(alb, rock * tono, kk);
      float Lm = gluma(mixed);
      vec3 dev = mixed - vec3(Lm);
      float cro = length(dev) / max(Lm, 1e-3);
      float scl = min(1.0, ${(ROCK_CHROMA_CAP as number).toFixed(2)} / max(cro, 1e-4));
      alb = vec3(Lm) + dev * mix(1.0, scl, kk);
    }
  }
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
    float grano = grain * uGrainK * steep;
    if (uRockDebug > 0.5) {
      alb = alb * 1.0;
    } else {
      alb *= (1.0 + grano);
    }
  }
  diffuseColor.rgb = alb;
  // §5d: métricas de pared sobre el albedo YA mezclado (al final del bloque).
  // gBR = b−r del ALBEDO (acotado, estable); el cociente gCroma se fue en
  // §5d-bis (sobre albedo oscuro se infla igual que infló G104 — dos veces).
  gBR = alb.b - alb.r;
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
  // §5: la normal de roca se suma con peso steep · 0,6 (solo pared).
  vec3 rockPert = vec3(0.0);
  if (uHasRock > 0.5 && gSteep > 0.001) {
    float dfaN = smoothstep(${(ROCK_FAR_M as number).toFixed(1)}, ${(ROCK_NEAR_M as number).toFixed(1)}, length(vWPos2 - cameraPosition));
    vec3 rnT = rockNormalTriplanar(vWPos2, wnN);
    rockPert = vec3(rnT.x, rnT.y, 0.0) * (${(ROCK_NORMAL_W as number).toFixed(2)} * dfaN);
  }
  vec3 nt2 = texture2D(uNormalMap2, vTerrainUv).rgb * 2.0 - 1.0;
  vec2 mixN = mix(nt2.xy, latNV, clamp(gSteep, 0.0, 1.0));
  mixN *= uNormalStrength * max(uHasNormal, clamp(gSteep, 0.0, 1.0));
  normal = normalize(normal + vec3(mixN.x, mixN.y, 0.0) * 0.35 + rockPert * clamp(gSteep, 0.0, 1.0));
}`,
          );
        // §5 sonda (informa, no gobierna): ¿entró el GLSL de roca al programa?
        // Solo tras bandera (debug/rock/steep); producción no la lee.
        // hasRockVal lee el UNIFORME VIVO (no el valor capturado en compile:
        // ese es siempre el de arranque). G101 lo compara con __hasRock.
        if (boot.debug || boot.rock || boot.steep || boot.walls || boot.walls2) {
          (window as unknown as { __rockGLSL?: unknown }).__rockGLSL = {
            hasRockFn: s.fragmentShader.includes("rockTriplanar(vec3"),
            hasRockCall: s.fragmentShader.includes("rockTriplanar(vWPos2"),
            hasDebug: s.fragmentShader.includes("uRockDebug"),
            hasWallProbe: s.fragmentShader.includes("uniform float uWallProbe"),
            wallProbeLive: () => (wallProbe as { value: number }).value,
            hasSteepMap: s.fragmentShader.includes("dithering_fragment") && s.fragmentShader.includes("gRaw"),
            rockMixVal: (rockMix as { value: number }).value,
            hasRockLive: () => (hasRock as { value: number }).value,
            grainVal: (grainK as { value: number }).value,
            wallDegVal: (wallDeg as { value: number }).value,
          };
        }
        if ((boot.steep || boot.walls || boot.walls2) && !boot.rock) {
          const prevDither = terrainMat.onBeforeCompile.bind(terrainMat);
          terrainMat.onBeforeCompile = (s2: {
            uniforms: Record<string, unknown>;
            fragmentShader: string;
            vertexShader: string;
          }) => {
            prevDither(s2);
            // §5d-ter: MODO 3 = round-trip por el CAMINO REAL — en el MISMO
            // sitio del shader del terreno donde escribe la sonda (después
            // de dithering: se salta tonemapping + colorspace, como los
            // modos 1/2). Tres valores distintos a propósito: un solo 0,5
            // no distingue una codificación sRGB de un escalado.
            //   [128, 64, 191] ± 1  → el canvas guarda en CRUDO.
            //   [188, 137, 224] ± 2 → el canvas CODIFICA a sRGB (entonces
            //     TODOS los histogramas de §5d están mal leídos: linealizar
            //     cada canal antes de binarlo, v=((c/255+.055)/1.055)^2.4).
            //   otra cosa → parar y reportar, no interpretar nada.
            // gLumaF/gBRF se asignan SIEMPRE aquí (el chunk de niebla nunca
            // corre: ?debug=steep no parchea fog; walls se salta
            // tonemapping+colorspace pero NO la niebla — la niebla YA está
            // sumada en gl_FragColor a esta altura del chunk final).
            // El cociente se fue: sobre albedo oscuro se infla igual que
            // infló G104 (dos veces).
            s2.fragmentShader = s2.fragmentShader
              .replace(
                "#include <dithering_fragment>",
                `#include <dithering_fragment>
gLumaF = gluma(gl_FragColor.rgb);
gBRF = gl_FragColor.b - gl_FragColor.r;
if (uWallProbe > 0.5) {
  float wsm = 0.05 + 0.9 * clamp(gSlope / 90.0, 0.0, 1.0);
  if (uWallProbe < 1.5)
    gl_FragColor = vec4(wsm, clamp(grockMix, 0.0, 1.0), clamp(gBR * 0.5 + 0.5, 0.0, 1.0), 1.0);
  else if (uWallProbe < 2.5)
    gl_FragColor = vec4(wsm, clamp(gBRF * 0.5 + 0.5, 0.0, 1.0), clamp(gLumaF, 0.0, 1.0), 1.0);
  else if (uWallProbe < 3.5)
    gl_FragColor = vec4(0.5, 0.25, 0.75, 1.0);
}`,
              )
              .replace(
                "gl_FragColor = vec4(clamp(gRaw, 0.0, 1.0), clamp(gSteep, 0.0, 1.0), clamp(grain + 0.5, 0.0, 1.0), 1.0);",
                `gLumaF = gluma(gl_FragColor.rgb);
gBRF = gl_FragColor.b - gl_FragColor.r;
if (uWallProbe > 0.5) {
  float wsm2 = 0.05 + 0.9 * clamp(gSlope / 90.0, 0.0, 1.0);
  if (uWallProbe < 1.5)
    gl_FragColor = vec4(wsm2, clamp(grockMix, 0.0, 1.0), clamp(gBR * 0.5 + 0.5, 0.0, 1.0), 1.0);
  else if (uWallProbe < 2.5)
    gl_FragColor = vec4(wsm2, clamp(gBRF * 0.5 + 0.5, 0.0, 1.0), clamp(gLumaF, 0.0, 1.0), 1.0);
  else if (uWallProbe < 3.5)
    gl_FragColor = vec4(0.5, 0.25, 0.75, 1.0);
} else {
  gl_FragColor = vec4(clamp(gRaw, 0.0, 1.0), clamp(gSteep, 0.0, 1.0), clamp(grain + 0.5, 0.0, 1.0), 1.0);
}`,
              );
          };
        }
      };
      terrainMat.customProgramCacheKey = () => `ordesa-base+corridor+n2c${probeKey}`;
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
  const grainK = { value: ROCK_GRAIN_K };
  const rockMix = { value: ROCK_MIX };
  const rockDebug = { value: boot.rock ? 1 : 0 };
  // §5d: wall probe (UNIFORME — NO constante de compilación: 0→3 no
  // recompila). El modo lo pone renderWallProbe durante su pasada; aquí
  // arranca en 0 (off) para no secuestrar ?debug=steep (?debug=rock intacto).
  // Modos: 1=slope/rockK/b−r(albedo) · 2=b−r(final)/luma(final) ·
  // 3=round-trip camino real (0.5, 0.25, 0.75).
  const wallProbe = { value: 0.0 };
  const hasCorr = { value: 0 };
  const hasNormal = { value: 0 };
  const rockUniform = { value: null as THREE.Texture | null };
  const rockNormalUniform = { value: null as THREE.Texture | null };
  const hasRock = { value: 0 };
  function armRockTex(t: THREE.Texture): void {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    // §5c: en pared rasante, con anisotropía 1 el mip se elige por la
    // derivada mayor: emborrona en un eje y sigue aliaseando en el otro.
    try {
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    } catch {
      /* sin anisotropía: la roca sigue funcionando */
    }
  }

  rebuildTerrain();
  gate.setProgress(0.62, 1);
  // N2c: textura de ruido de sombras (canvas 512², semilla fija) — se crea
  // una vez; el material la toma vía fogUniforms (objeto vivo compartido).
  if (!fogUniforms.uCloud.value) {
    try {
      fogUniforms.uCloud.value = makeCloudShadowTexture(THREE);
    } catch {
      /* sin ruido: las gaussianas siguen sombreando */
    }
  }
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
  // N3: ?wheeltest=1 cam plumbing — the deferred probe samples the live
  // camera position per frame via this getter (read-only, drives nothing).
  scroll.setCamProbe(() => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }));
  let progress: ProgressHandle;
  try {
    // E5.2: branch choice runs inside initProgress, once, with the live
    // heightfield — the rig consumes the identical decided series.
    progress = initProgress(route, scroll, { elev, meta, cx: world.centerX, cy: world.centerY });
    // N3b: hand the live act bounds (s at act boundaries) to the span
    // mapper — the s->d map never changes under it (single source intact).
    scroll.setActBounds(progress.actBounds());
  } catch (e) {
    gate.fail(`no se pudo resolver el recorrido: ${e instanceof Error ? e.message : e}`);
    throw e;
  }
  if (progress.getState().divergenceWarn && boot.debug) {
    metrics.warn = progress.getState().divergenceWarn as string;
  }
  const rig = createRig({ camera, route, world, elev, meta, progress });
  // C1: orientation plumbing — baked yaw/pitch the rig flies (diag mirror,
  // read-only; the deferred ?wheeltest=1 probe logs it per frame).
  scroll.setOriProbe(() => ({ yaw: rig.getDiag().yaw, pitch: rig.getDiag().pitch }));
  {
    // initial framing is simply rig.at(s=0) — no hardcoded default camera.
    // Walker-framed pose: position + quaternion (never lookAt, which would
    // compute a pitch composePose just replaced).
    const p0 = rig.poseAt(scroll.s);
    camera.position.set(p0.pos[0], p0.pos[1], p0.pos[2]);
    camera.quaternion.set(p0.quaternion[0], p0.quaternion[1], p0.quaternion[2], p0.quaternion[3]);
  }

  // --- 3B panel de los actos (Everest reference): text shell, the JSON
  // carries the words. Mounted unless the rig is excluded (?orbit=1 / ?cam=
  // override the pose explicitly — no panel framing then). URL comes from
  // the bundled meta (content hash, G57: nothing unhashed over the net).
  let panel: { setAct(act: string, f: number): void } | null = null;
  let panelMountFailed = false;
  async function ensurePanel(): Promise<void> {
    if (panel || panelMountFailed || boot.orbit || boot.cam !== null) return;
    try {
      const { mountPanel } = await import("../narrative/panel.ts");
      const h = mountPanel({ actsUrl: `/${meta.assets?.["acts"] ?? "assets/acts.json"}` });
      if (h) panel = { setAct: (a, f) => h.setAct(a as never, f) };
    } catch {
      panelMountFailed = true;
    }
  }
  // Mount early (fetch in flight while the gate stands); first setAct is a
  // no-op until the JSON arrives.
  void ensurePanel();
  if (boot.orbit || boot.cam !== null) {
    rig.setSubjectClosed(true);
  } else if (window.innerWidth < 900) {
    // <900px the panel hides for the 3D (CSS): framing stays centred.
    rig.setSubjectClosed(true);
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
  // §5: la roca entra por UNIFORMES (uRock/uRockNormal/uHasRock), no por
  // código: el programa es el mismo con y sin textura (?debug=rock solo
  // mueve uRockDebug, que también es uniforme). Clave de caché única.
  // uHasRock es UNIFORME VIVO (objeto compartido, como uHasCorr): la GPU lo
  // lee cada draw sin recompilar — NO necesita needsUpdate. (needsUpdate
  // recrea el programa CON el valor viejo: esa era la carrera que dejaba
  // rockK = 0 para siempre. Lección: los flags de textura son valores, no
  // código; viajan como los demás pesos.)
  async function armTex(
    asset: string | undefined,
    srgb: boolean,
    apply: (t: THREE.Texture) => void,
  ): Promise<void> {
    if (!asset) return;
    try {
      const t = await loadTex(`/${asset}`, srgb);
      armRockTex(t);
      apply(t);
      // El flag es valor de uniforme: la GPU lo lee en el próximo draw.
      // needsUpdate SOLO si el MATERIAL lo pide (map nuevo, no pesos).
    } catch {
      /* sin textura: la neutra 1×1 sigue armada */
    }
  }
  // §5 sonda (informa, no gobierna): 1 cuando albedo+normal de roca están
  // subidos. La escribe armTex, no los .then.
  (window as unknown as { __hasRock?: number }).__hasRock = 0;
  if (corrAsset) {
    void armTex(corrAsset, true, (t) => {
      corridorUniform.value = t;
      hasCorr.value = 1;
    });
  }
  if (meta.assets?.["terrain-normal"] && texLevel !== "lite") {
    void armTex(meta.assets["terrain-normal"], false, (t) => {
      normalUniform.value = t;
      hasNormal.value = 1;
    });
  }
  // §5: roca estratificada (albedo + normal, RepeatWrapping — el mosaico
  // vive en world-xz, no en UV). Detrás del primer pintado, como el resto.
  // Neutras 1×1 desde el arranque + uHasRock = 1 SOLO cuando las DOS reales
  // están subidas (el programa ya existe: sin bifurcación de shader).
  {
    const pxR = new Uint8Array([185, 178, 164, 255]);
    const neutralR = new THREE.DataTexture(pxR, 1, 1, THREE.RGBAFormat);
    neutralR.colorSpace = THREE.SRGBColorSpace;
    neutralR.wrapS = THREE.RepeatWrapping;
    neutralR.wrapT = THREE.RepeatWrapping;
    neutralR.needsUpdate = true;
    rockUniform.value = neutralR;
    const pxN = new Uint8Array([128, 128, 255, 255]);
    const neutralN = new THREE.DataTexture(pxN, 1, 1, THREE.RGBAFormat);
    neutralN.wrapS = THREE.RepeatWrapping;
    neutralN.wrapT = THREE.RepeatWrapping;
    neutralN.needsUpdate = true;
    rockNormalUniform.value = neutralN;
  }
  if (meta.assets?.["rock-albedo"] && meta.assets?.["rock-normal"] && texLevel !== "lite") {
    const rockA = meta.assets["rock-albedo"];
    const rockN = meta.assets["rock-normal"];
    // Las DOS reales se suben por el mismo camino que corridor/normal:
    // el flag es el valor del uniforme (sin needsUpdate, sin carrera).
    void armTex(rockA, true, (t) => {
      const oldA = rockUniform.value;
      rockUniform.value = t;
      if ((rockNormalUniform.value as THREE.DataTexture).image?.width !== 1) {
        hasRock.value = 1;
        (window as unknown as { __hasRock?: number }).__hasRock = 1;
      }
      if (oldA && (oldA as THREE.DataTexture).image?.width === 1) oldA.dispose();
    });
    void armTex(rockN, false, (t) => {
      const oldN = rockNormalUniform.value;
      rockNormalUniform.value = t;
      if ((rockUniform.value as THREE.DataTexture).image?.width !== 1) {
        hasRock.value = 1;
        (window as unknown as { __hasRock?: number }).__hasRock = 1;
      }
      if (oldN && (oldN as THREE.DataTexture).image?.width === 1) oldN.dispose();
    });
  }

  // clouds (N2-fix: barrido s ∈ [0, 0,97] SIN epílogo — la cámara del
  // epílogo (4,5 km) subía camYmax y ponía los cúmulos a 5 km. La banda
  // vive a ~2900; el epílogo se resuelve con fade por altura (uCamY)).
  // Poses travel EPSG + altitude.
  const cloudCams: { x: number; y: number; z: number; s: number }[] = [];
  {
    const w2eX = (wx: number): number => wx + world.centerX;
    const w2eY = (wz: number): number => world.centerY - wz;
    for (let s = 0; s <= 0.97; s += 0.005) {
      const sc = Math.min(0.97, s);
      const p = rig.poseAt(sc);
      cloudCams.push({ x: w2eX(p.pos[0]), y: w2eY(p.pos[2]), z: p.pos[1], s: sc });
    }
  }
  // N2-fix: camYEpi (altura de la cámara del epílogo) a la vista — el fade
  // por altura la usa; el informe la muestra junto a camYmax de sendero.
  const camYEpi = rig.poseAt(1).pos[1];
  const clouds = buildClouds(
    meta,
    elev,
    `/${meta.assets?.["clouds-atlas"] ?? "assets/clouds-atlas.webp"}`,
    { n: route.n, x: route.x, y: route.y },
    cloudCams,
  );
  // N2-fix: banda publicada — camYmax de SENDERO (s ∈ [0,0,97]) y, aparte,
  // camYEpi (epílogo) para tenerlo a la vista. cloudLayout es la única
  // fuente del detalle por familia (__cloudBandFam).
  (window as unknown as { __cloudBand?: unknown }).__cloudBand = (() => {
    let m = -Infinity;
    for (const c of cloudCams) if (c.z > m) m = c.z;
    return {
      base: Math.max(m + 300, 2900),
      top: Math.max(m + 300, 2900) + 600,
      camYmax: m,
      camYEpi,
      poses: cloudCams.length,
    };
  })();
  // N2-fix: la bruma de nubes comparte la captura del cielo con la niebla
  // del terreno (MISMO objeto vivo: un write llega a ambos, cero copias).
  // Menos marrón, más gris-azul al amanecer (G49 croma ≤ 0,15).
  (clouds as unknown as { setSkyMap?: (t: THREE.Texture | null) => void }).setSkyMap?.(
    fogUniforms.uSkyMap.value as THREE.Texture | null,
  );
  scene.add(clouds.group);
  gate.setProgress(0.8, 5);
  await nextFrame();

  // labels
  const labelLayer = el("div", "labels");
  document.body.appendChild(labelLayer);
  if (boot.steep) {
    clouds.group.visible = false;
    line.group.visible = false;
    labelLayer.style.display = "none";
  }
  const labelDefs = (await fetch("/assets/labels.json").then((r) => r.json()).catch(() => ({ labels: [] }))) as {
    labels: LabelDef[];
  };
  const labelRts = buildLabels(labelDefs.labels, world.centerX, world.centerY, labelLayer);

  // --- §3b haces Everest en los hitos: UNA InstancedMesh de cilindros
  // (Ø24 m × 420 m) + instancia del caminante (Ø12 m × 260 m, naranja).
  // s_hito resuelto desde d del hito con la única fuente progress.ts
  // (bisección sobre la PCHIP s->d viva, como actBounds). Estado pasado =
  // s >= s_hito − 0,0005 → verde; pendiente → ámbar. Pulso +45 % 0,7 s
  // una vez por cruce (flanco en beams.setState). La etiqueta vuelve a
  // la BASE (terreno + 2 m); el haz sube por detrás. ?beams=0 los apaga
  // (comparativa) y suelta las etiquetas al suelo.
  const BEAM_S: Record<string, number> = {
    pradera: 0,
    "cota-maxima": 0.3,
    "cola-caballo": 0.745,
  };
  // d del hito (m): labels.json la trae cuando el pipeline la escribe.
  const BEAM_D: Record<string, number> = {
    pradera: 0,
    "cota-maxima": 2440.1,
    "cola-caballo": 9670.5,
  };
  let beams: Beams | null = null;
  const beamDefs: BeamDef[] = [];
  if (boot.beams) {
    labelRts.forEach((rt, rtIndex) => {
      if (!rt.hasBeam) return;
      const id = rt.def.id;
      const dd = (rt.def as { d?: number }).d ?? BEAM_D[id] ?? null;
      // §3b: s_hito desde d con la única fuente progress.ts (sFromD sobre
      // la PCHIP viva); el fallback a BEAM_S solo si el hito no trae d.
      const s = dd !== null && Number.isFinite(dd) ? progress.sFromD(dd) : (BEAM_S[id] ?? 0.86);
      void BEAM_S;
      beamDefs.push({ rtIndex, s });
    });
    beams = buildBeams(labelRts, beamDefs);
    beams.setAnchored(true);
    scene.add(beams.group);
    // ?debug=steep: mapa de pesos, sin haces (como nubes/rastro/etiquetas).
    if (boot.steep) beams.group.visible = false;
  } else {
    // Apagados: etiquetas al suelo (mismo anclaje que antes de §3).
    for (const rt of labelRts) releaseBeam(rt);
  }
  // §5d: la sonda de pared vive en su propio módulo (carga diferida —
  // producción no lo carga ni lo llama); el cableado vive aquí porque la
  // pieza es dueña de sky, line, clouds, beams, labelLayer y wallProbe.
  // Va DESPUÉS de haces/etiquetas (beams y labelRts ya existen).
  let renderWallProbe: (() => unknown) | null = null;
  let readWallHist: ((mode: 1 | 2 | 3) => unknown) | null = null;
  let probeWallGLSL: (() => unknown) | null = null;
  if (boot.walls || boot.walls2) {
    const mod = await import("./wall-probe.ts");
    // §5d-ter: la cadena que monta el programa es terrainMat.onBeforeCompile
    // (aquí arriba, ~línea 617); el bloque de abajo la ENVUELVE vía .bind
    // (NO se reasigna — reasignar mataría el parche de niebla de
    // patchTerrainMaterial). prevDither = cadena completa (niebla+roca+…);
    // la sonda se añade DESPUÉS de dithering, MISMO programa, MISMA pasada.
    // Y terrainMat nace en el PRIMER rebuildTerrain y NUNCA se recrea (los
    // rebuilds solo cambian la geometría): el onBeforeCompile envuelto
    // sigue vivo en todos los re-drapes.
    const wired = mod.mountWallProbe({
      renderer, scene, camera, sky, lineGroup: line.group, cloudsGroup: clouds.group,
      beamsGroup: beams?.group ?? null, labelLayer, uWallProbe: wallProbe,
      // §5d-bis (2/3): snapshot de uniformes LEÍDOS en la pasada + programs.
      getLive: () => ({
        uWallProbe: wallProbe.value,
        uRockMix: rockMix.value,
        uRockWeight: rockWeight.value,
        uWallDeg: wallDeg.value,
        uHasRock: hasRock.value,
        programs: renderer.info.programs.length,
      }),
    });
    renderWallProbe = wired.render;
    readWallHist = wired.readHist;
    probeWallGLSL = wired.probeGLSL;
    // §5d-bis (3): el harness escribe uniformes directamente y los LEE
    // después para confirmar (nada de deslizadores). __rockCtl publica
    // escritores que devuelven el valor LEÍDO tras escribir + lectores.
    // uRockMix puede escribirse también vía __rockUniforms (mismo objeto
    // vivo que la GPU lee cada draw — sin recompilar, sin needsUpdate).
    const rockCtl = {
      setRockMix: (v: number): number => { rockMix.value = v; return rockMix.value; },
      getRockMix: (): number => rockMix.value,
      setRockWeight: (v: number): number => { rockWeight.value = v; return rockWeight.value; },
      getRockWeight: (): number => rockWeight.value,
      getWallDeg: (): number => wallDeg.value,
      getHasRock: (): number => hasRock.value,
      getWallProbe: (): number => wallProbe.value,
      setWallProbe: (v: number): number => { wallProbe.value = v; return wallProbe.value; },
      rockMixConst: ROCK_MIX,
    };
    // §5d-bis: getLive también público (el harness lo usa para ASERTAR
    // valores sin depender del histograma).
    const rockLive = (): unknown => ({
      uWallProbe: wallProbe.value,
      uRockMix: rockMix.value,
      uRockWeight: rockWeight.value,
      uWallDeg: wallDeg.value,
      uHasRock: hasRock.value,
      programs: renderer.info.programs.length,
    });
    (window as unknown as { __wallProbe?: unknown }).__wallProbe = {
      roundTrip: () => renderWallProbe?.() ?? null,
      hist: (mode?: number) => readWallHist?.(mode === 2 ? 2 : 1) ?? null,
      hist3: () => readWallHist?.(3) ?? null,
      glsl: () => probeWallGLSL?.() ?? null,
    };
    (window as unknown as { __rockCtl?: unknown }).__rockCtl = rockCtl;
    (window as unknown as { __rockUniforms?: unknown }).__rockUniforms = {
      uRockMix: rockMix,
      uRockWeight: rockWeight,
      uHasRock: hasRock,
    };
    (window as unknown as { __rockLive?: unknown }).__rockLive = rockLive;
  }

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
  // T1: user cloud multiplier 0..1 (default 1) — instrument, behind ?debug=1.
  // (Vive aquí, antes del HUD: el panel lo lee al montar.)
  let cloudUser = boot.clouds;
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
    const gLab = el("div", "hud-label", "grano 0,25");
    const gIn = document.createElement("input");
    gIn.type = "range";
    gIn.min = "0";
    gIn.max = "1";
    gIn.step = "0.05";
    gIn.value = String(ROCK_GRAIN_K);
    gIn.setAttribute("aria-label", "intensidad del grano lateral");
    gIn.addEventListener("input", () => {
      const k = Number(gIn.value);
      gLab.textContent = `grano ${k.toFixed(2).replace(".", ",")}`;
      grainK.value = k;
    });
    // §5: MEZCLA ROCA (ROCK_MIX) — instrumento tras ?debug=1, como el resto.
    const rLab = el("div", "hud-label", `mezcla roca ${Math.round(ROCK_MIX * 100)} %`);
    const rIn = document.createElement("input");
    rIn.type = "range";
    rIn.min = "0";
    rIn.max = "1";
    rIn.step = "0.05";
    rIn.value = String(ROCK_MIX);
    rIn.setAttribute("aria-label", "mezcla de roca triplanar");
    rIn.addEventListener("input", () => {
      const k = Number(rIn.value);
      rLab.textContent = `mezcla roca ${Math.round(k * 100)} %`;
      rockMix.value = k;
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
    hud.append(timeLab, cloudLab, cloudIn, nLab, nIn, tLab, tIn, wLab, wIn, gLab, gIn, rLab, rIn, lodRow);
    if (boot.steep) {
      hud.append(el("div", "hud-label", "mapa: R = peso geo · G = efectivo · B = grano"));
    }
    if (boot.walls || boot.walls2) {
      hud.append(el("div", "hud-label", boot.walls2
        ? "sonda: R = pendiente · G = b−r final (0,5) · B = luma final sRGB"
        : "sonda: R = pendiente · G = rockK · B = b−r albedo (0,5)"));
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

  // §8b ?debug=gaps: straight-trace overlay (magenta over the normal
  // line). Detection = perpendicular deviation of the resampled+smoothed
  // route off each raw-GPX chord (≤0.25 m interior, runs ≥100 m) — computed
  // LIVE from route.json + the raw vertices (no generated file: the
  // criterion is geometric, not an interval list). Lazy chunk — never in
  // the production bundle. Draws the whole runs regardless of progress
  // (it measures the trace, not the walk).
  let gapsOverlay:
    | { group: THREE.Group; inventedM: number; inventedRuns: number }
    | null = null;
  // gapsRanges kept for the LOD-redrape rebuild (same closure inputs).
  let gapsRanges: Array<readonly [number, number]> = [];
  let gapsBuild: {
    buildGapsOverlay: typeof import("./gaps-overlay.ts").buildGapsOverlay;
  } | null = null;
  const rebuildGapsOverlay = (): void => {
    if (!gapsOverlay || gapsRanges.length === 0 || !gapsBuild) return;
    for (const o of [...gapsOverlay.group.children]) {
      const l = o as unknown as {
        geometry?: { dispose(): void };
        material?: { dispose(): void };
      };
      l.geometry?.dispose();
      l.material?.dispose();
      gapsOverlay.group.remove(o);
    }
    const { buildGapsOverlay } = gapsBuild;
    const fresh = buildGapsOverlay(line.linePositions(), route, gapsRanges, res2);
    for (const o of [...fresh.group.children]) gapsOverlay.group.add(o);
    gapsOverlay.inventedM = fresh.inventedM;
    gapsOverlay.inventedRuns = fresh.inventedRuns;
  };
  if (boot.gaps) {
    try {
      const gapsMod = await import("./gaps-overlay.ts");
      const rawMod = await import("../generated/gaps.ts");
      gapsBuild = { buildGapsOverlay: gapsMod.buildGapsOverlay };
      const rawPairs = rawMod.GAP_RAW as Array<readonly [number, number]>;
      const rawCum = rawMod.GAP_CUM as number[];
      gapsRanges = gapsMod.straightRuns(
        route,
        rawPairs.map(([x, y]) => ({ x, y })),
        rawCum,
      );
      gapsOverlay = gapsBuild.buildGapsOverlay(line.linePositions(), route, gapsRanges, res2);
      group.add(gapsOverlay.group);
      // §8: the overlay copies the line's positions — LOD redrape rebuilds it.
      line.onRedrape(rebuildGapsOverlay);
      line.setProgressDist(route.lengthM);
      (window as unknown as { __gaps?: unknown }).__gaps = {
        runs: gapsOverlay.inventedRuns,
        inventedM: Math.round(gapsOverlay.inventedM),
        ranges: gapsRanges,
      };
    } catch (e) {
      // Instrument, never silent: publish the failure so the capture
      // reports it instead of a clean frame with no magenta.
      (window as unknown as { __gapsError?: unknown }).__gapsError = String(e).slice(0, 300);
    }
  }
  // ?debug=path instrument (3-panel overlay, lazy import keeps it out of the
  // entry chunk graph unless requested)
  // §8c ?debug=retrace: current route (white over the normal line) +
  // OSM candidate (orange), side by side, nothing replaced. Lazy chunk —
  // never in the production bundle. Draws both whole regardless of
  // progress (it compares traces, not the walk). Rebuilt on LOD redrape
  // via line.onRedrape (same hook as ?debug=gaps).
  if (boot.retrace) {
    try {
      const retraceMod = await import("./gaps-overlay.ts");
      const candMod = await import("../generated/retrace.ts");
      const cx = candMod.RETRACE_X as number[];
      const cy = candMod.RETRACE_Y as number[];
      const cd = candMod.RETRACE_D as number[];
      const candPts = cx.map((x, i) => ({ x, y: cy[i] as number }));
      const rebuildRetrace = (): void => {
        const cur = retraceMod.buildRunsOverlay(line.linePositions(), route.d, [[0, route.lengthM]], res2, {
          color: 0xffffff,
          linewidth: 4.5,
          opacity: 0.95,
          renderOrder: 7,
        });
        const cand = retraceMod.buildRunsOverlay(
          line.drapePoints(candPts),
          cd,
          [[0, cd[cd.length - 1] as number]],
          res2,
          { color: 0xff7f1a, linewidth: 4.5, opacity: 0.95, renderOrder: 8 },
        );
        for (const o of [...retraceGroup.children]) {
          const l = o as unknown as {
            geometry?: { dispose(): void };
            material?: { dispose(): void };
          };
          l.geometry?.dispose();
          l.material?.dispose();
          retraceGroup.remove(o);
        }
        for (const o of [...cur.group.children]) retraceGroup.add(o);
        for (const o of [...cand.group.children]) retraceGroup.add(o);
        (window as unknown as { __retrace?: unknown }).__retrace = {
          curM: Math.round(cur.paintedM),
          candM: Math.round(cand.paintedM),
          candN: cx.length,
          meta: candMod.RETRACE_META,
        };
      };
      const retraceGroup = new THREE.Group();
      group.add(retraceGroup);
      // Reuse the gaps rebuild slot when both flags coincide; otherwise own hook.
      if (boot.gaps) {
        const prev = rebuildGapsOverlay;
        line.onRedrape(() => {
          prev();
          rebuildRetrace();
        });
      } else {
        line.onRedrape(rebuildRetrace);
      }
      rebuildRetrace();
      line.setProgressDist(route.lengthM);
      window.addEventListener("resize", () => {
        renderer.getDrawingBufferSize(res2);
        for (const o of retraceGroup.children) {
          const lm = (o as unknown as { material: { resolution: THREE.Vector2 } }).material;
          lm.resolution.copy(res2);
        }
      });
    } catch (e) {
      (window as unknown as { __retraceError?: unknown }).__retraceError = String(e).slice(0, 300);
    }
  }
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
  // N2 (?debug=atlas): blitea el atlas de nubes ×0,5 abajo a la izquierda
  // para verlo (instrumento diferido: la textura se carga bajo demanda y el
  // pase solo existe con el flag — producción no lo paga).
  let atlasBlit: {
    scene: THREE.Scene;
    cam: THREE.OrthographicCamera;
    mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  } | null = null;
  function layoutAtlasBlit(): void {
    if (!atlasBlit) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const bw = 2 / w / (window.devicePixelRatio || 1);
    void bw;
    // ×0,5 del atlas: 512 CSS px de ancho abajo a la izquierda
    const cw = (2 * 512) / w;
    const ch = (2 * 512) / h;
    atlasBlit.mesh.geometry.dispose();
    atlasBlit.mesh.geometry = new THREE.PlaneGeometry(cw, ch);
    atlasBlit.mesh.position.set(-1 + cw / 2, -1 + ch / 2, 0);
  }
  async function ensureAtlasBlit(): Promise<void> {
    if (atlasBlit) return;
    try {
      const tex = await new Promise<THREE.Texture>((resolve, reject) => {
        new THREE.TextureLoader().load(
          `/${meta.assets?.["clouds-atlas-png"] ?? meta.assets?.["clouds-atlas"] ?? "assets/clouds-atlas.webp"}`,
          (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            resolve(t);
          },
          undefined,
          reject,
        );
      });
      const bscene = new THREE.Scene();
      const bcam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
      const bmat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      });
      const bmesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bmat);
      bmesh.renderOrder = 999;
      bmesh.frustumCulled = false;
      bscene.add(bmesh);
      atlasBlit = { scene: bscene, cam: bcam, mesh: bmesh };
      layoutAtlasBlit();
    } catch {
      /* sin atlas visible — el informe lo dirá */
    }
  }
  if (boot.atlas) {
    void ensureAtlasBlit();
    window.addEventListener("resize", () => {
      layoutAtlasBlit();
    });
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
  // §4b FASE 4c (G42 color): mean canvas colour of the cloud pixels from
  // the SAME meter pass (no re-render): display luma ≥ 0.72, chroma ≤ 0.10
  // (white, not grey veils or salmon shreds). Reads the flat RT ALPHA
  // mask + the presented frame buf (both already read this frame); the
  // meter grid is 96×54, the frame buf is w×h — nearest mapping.
  function publishCloudColor(
    buf: Uint8Array, w: number, h: number,
  ): void {
    let n = 0;
    let sl = 0;
    let sc = 0;
    for (let yy = 0; yy < 54; yy++) {
      for (let xx = 0; xx < 96; xx++) {
        const co = (yy * 96 + xx) * 4;
        if ((cloudPxBuf[co] as number) <= 128) continue;
        const fx = Math.min(w - 1, Math.floor(((xx + 0.5) / 96) * w));
        const fy = Math.min(h - 1, Math.floor(((yy + 0.5) / 54) * h));
        const o = (fy * w + fx) * 4;
        const rr = (buf[o] as number) / 255;
        const gg = (buf[o + 1] as number) / 255;
        const bb = (buf[o + 2] as number) / 255;
        const mxc = Math.max(rr, gg, bb);
        const mnc = Math.min(rr, gg, bb);
        sl += 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
        sc += mxc > 1e-6 ? (mxc - mnc) / mxc : 0;
        n++;
      }
    }
    const W = window as unknown as { __cloudLuma?: number; __cloudChroma?: number };
    if (n > 0) {
      W.__cloudLuma = sl / n;
      W.__cloudChroma = sc / n;
    } else {
      W.__cloudLuma = -1;
      W.__cloudChroma = -1;
    }
  }
    // N2: cloud pixel meter — the SAME InstancedMesh with a flat probe  // material (atlas ALPHA × vAlpha only, no colour) into its own 96×54
  // target. Counted inside the TERRAIN-sky mask (occBuf): only sky pixels
  // can be cloud-covered. Same camera, same frame, no extra scene.
  // The probe material borrows the LIVE uniform objects (uMap/uAmount/
  // uMult/uZenithFade) — same values the draw uses, zero copies to forget.
  // La sonda informa, no gobierna (N1/G46).
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
    uniforms: {
      uMap: { value: null },
      uAmtCumulus: { value: 0 },
      uAmtMist: { value: 0 },
      uAmtCirrus: { value: 0 },
      uAmtFar: { value: 0 },
      uMult: { value: 1 },
      uZenithFade: { value: 0 },
      uTime: { value: 0 },
      uFamFilter: { value: -1 },
      uCamY: { value: 0 },
    },
    vertexShader: `
      attribute vec4 aData; // x: tile, y: rot, z: family, w: alpha base
      attribute vec2 aSize; // w,h del billboard en m
      attribute vec4 aMisc; // x: phase, y: period (bruma)
      varying vec2 vUv; varying float vAlpha; varying float vFamily;
      uniform float uAmtCumulus; uniform float uAmtMist; uniform float uAmtCirrus; uniform float uAmtFar;
      uniform float uMult; uniform float uZenithFade; uniform float uTime; uniform float uFamFilter; uniform float uCamY;
      void main(){
        float tile = aData.x;
        float family = aData.z;
        vFamily = family;
        vec2 tileMin = tile < 0.5 ? vec2(0.0, 0.75) : tile < 1.5 ? vec2(0.5, 0.75)
          : tile < 2.5 ? vec2(0.0, 0.5) : tile < 3.5 ? vec2(0.5, 0.5)
          : tile < 4.5 ? vec2(0.0, 0.34375) : vec2(0.5, 0.34375);
        vec2 tileMax = tile < 0.5 ? vec2(0.5, 1.0) : tile < 1.5 ? vec2(1.0, 1.0)
          : tile < 2.5 ? vec2(0.5, 0.75) : tile < 3.5 ? vec2(1.0, 0.75)
          : tile < 4.5 ? vec2(0.5, 0.5) : vec2(1.0, 0.5);
        vUv = mix(tileMin, tileMax, uv);
        float rot = aData.y;
        vec2 p = vec2(position.x * aSize.x, position.y * aSize.y);
        // N2b: el filtro de familia (?family=N / off) vive en el vertex: las
        // instancias filtradas colapsan a área cero (mismo draw, calls intacto).
        float keepFam = uFamFilter < -0.5 ? 1.0 : (abs(family - uFamFilter) < 0.5 ? 1.0 : 0.0);
        float pulse = 1.0;
        if (family > 0.5 && family < 1.5) {
          pulse = 0.75 + 0.25 * sin(uTime * 0.02 + aMisc.x);
        }
        float fam = family < 0.5 ? uAmtCumulus * uMult
          : family < 1.5 ? uAmtMist * pulse
          : family < 2.5 ? uAmtCirrus
          : uAmtFar * uMult;
        vAlpha = aData.w * fam * (1.0 - uZenithFade) * keepFam;
        // billboard en vista: reconstruye como el draw (rot fija)
        vec4 c = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
        // N2-fix: mismo fade del epílogo que el draw (mundo-y = altitud).
        float relH = uCamY - c.y;
        float epiFade = family < 0.5 ? 1.0 - smoothstep(300.0, 900.0, relH)
          : family < 1.5 ? 1.0 - smoothstep(300.0, 900.0, relH)
          : family < 2.5 ? 1.0
          : 1.0 - smoothstep(600.0, 1400.0, relH);
        vAlpha *= epiFade;
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec2 rp = mat2(cos(rot),-sin(rot),sin(rot),cos(rot)) * p * keepFam;
        gl_Position = projectionMatrix * viewMatrix * vec4(c.xyz + right * rp.x + up * rp.y, 1.0);
      }`,
    fragmentShader: `
      varying vec2 vUv; varying float vAlpha; varying float vFamily;
      uniform sampler2D uMap; uniform float uFamFilter;
      void main(){
        // N2: alfa de la TEXTURA (canal A) × alfa efectivo — sin máscara.
        float texA = texture2D(uMap, vUv).a;
        float a = texA * vAlpha;
        if (a <= 0.15) discard;
        gl_FragColor = vec4(1.0, 1.0, 1.0, a);
      }`,
  });
  let cloudPxWired = false;
  // C2b (G93): la sonda de luma corre bajo lumaOn sobre un downsample
  // 32×32 del frame presentado, calculado con generateMipmaps del propio
  // renderer (puertos públicos — el blit crudo default→FBO-propio dejaba
  // INVALID_OPERATION en el ledger G22: three re-ata sus FBOs por render
  // y el DRAW atado a mano no sobrevive). readPixels lee 4 KB, no 27 MB.
  // Todo creado una vez; lumaBuf persiste: cero asignaciones por pasada.
  // Sin WebGL2: fallback al readPixels de celda central (mismo contrato).
  const lumaBuf = new Uint8Array(LUMA_GRID * LUMA_GRID * 4);
  // RT auxiliar g×g con textura de mipmaps: el renderer dibuja el frame
  // presentado reescalado con un quad propio (escena aparte, un draw) y
  // los mipmaps promedian cada región; la lectura va por
  // readRenderTargetPixels (three ata el framebuffer él mismo).
  // C2b-fix: DataTexture con tamaño REAL del canvas (no 1×1): con 1×1 el
  // copyFramebufferToTexture vuelca solo 1 px y el quad interpola un
  // color plano (luma 0,22 fantasma o negro). Se redimensiona por pasada
  // solo si w/h cambian (resize): newData dég. persistente, cero allocs
  // en estado estacionario.
  const lumaCopyTex = new THREE.DataTexture(
    new Uint8Array(Math.max(4, renderer.domElement.width * renderer.domElement.height * 4)),
    Math.max(1, renderer.domElement.width),
    Math.max(1, renderer.domElement.height),
  );
  lumaCopyTex.minFilter = THREE.LinearFilter;
  lumaCopyTex.magFilter = THREE.LinearFilter;
  lumaCopyTex.generateMipmaps = false;
  lumaCopyTex.needsUpdate = true;
  // Escena propia del downsample (REGLA: ningún render a target usa la
  // escena principal): quad fullscreen + cámara ortográfica, un draw.
  const lumaScene = new THREE.Scene();
  const lumaCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const lumaCopyMat = new THREE.MeshBasicMaterial({ map: lumaCopyTex, toneMapped: false });
  const lumaQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lumaCopyMat);
  lumaQuad.frustumCulled = false;
  lumaScene.add(lumaQuad);
  const lumaRT = new THREE.WebGLRenderTarget(LUMA_GRID, LUMA_GRID, { depthBuffer: false });
  lumaRT.texture.minFilter = THREE.LinearFilter;
  lumaRT.texture.magFilter = THREE.LinearFilter;
  lumaRT.texture.generateMipmaps = false;
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
  // N2c: ?cloudshadow=0 desactiva las sombras (G55); ?debug=cloudshadow las
  // pinta en gris (uCloudDebug). Solo instrumentos tras bandera de URL.
  const cloudShadowOff = boot.cloudshadowOff;
  (fogUniforms.uCloudDebug as { value: number }).value = boot.cloudshadow ? 1 : 0;
  // N2b: filtro de familia del medidor (?family=N / off). -2 (off) = el rastro
  // se mide sin nubes (G52: ?family=off); el probe pinta cero instancias.
  const famFilter = boot.family === -2 ? -3 : boot.family;
  void G11_LUMA_MIN;
  // C2b-nota: cloudPxScene (línea ~1327) PRESTA clouds.mesh al medidor de
  // nubes y lo devuelve a su padre (prevParent.add). La sonda de luma NO
  // toca clouds.mesh: escena propia + DataTexture propia, cero préstamo.

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
  // §4b FASE 3c-fix: frames rendered by the loop (checkGLPrograms needs
  // "after the first frame" — declared before it, bumped at loop end).
  let framesLive = 0;
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
      // 3B: the panel follows __scroll.act (same span lookup the loop owns
      // — no recompute). Write-if-changed inside; ~0 when the act holds.
      if (panel) {
        const an = scroll.actNow();
        panel.setAct(an.act, an.f);
      }
    }
    const st = progress.getState();
    const hour = st.hourDec;
    applyLighting(hour, dt);
    // E2: progressive cut at the walker (epilogue draws the whole loop).
    // BLOQUEANTE ?track=all: isolation probe — uProgressDist = lengthM,
    // nothing else touched. Answers geometry-vs-cut in a single load.
    // §8 ?debug=gaps owns the cut (whole invented trace always visible);
    // every other mode keeps the walking cut.
    {
      const e = route.lengthM;
      if (boot.trackAll || boot.gaps) line.setProgressDist(e);
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
    // N2c-fix: línea de sombra del HUD — desde shadowHud (lo SUBIDO a
    // uniformes este mismo frame), con ?debug=1 o ?debug=cloudshadow.
    if (boot.debug || boot.cloudshadow) {
      const h = shadowHud;
      metrics.shadowHud = `sombra K=${h.k.toFixed(2)} sunF=${h.sunF.toFixed(2)} dayF=${h.dayF.toFixed(2)} amt=${h.amt.toFixed(2)} mult=${h.mult.toFixed(2)} user=${h.user.toFixed(2)} wMax=${h.wMax.toFixed(2)} vivas=${h.alive}/24 noise=${h.noise ? "sí" : "no"}`;
    } else {
      metrics.shadowHud = "";
    }
    // N2b: alfa efectivo por familia = base × cantidad(familia) [× mult 0/3].
    // cumulus/far: amount(h)×mult · mist: mistAmount(hora, dayF) · cirrus: 1.
    // Todo continuo en hora (G35); ningún alfa depende de una sonda (G46).
    const amtCumulus = cloudAmount(hour) * cloudUser;
    const amtFar = amtCumulus;
    // mult suavizado hacia el acto actual (k = CLOUD_MULT_SMOOTH_K)
    {
      const wantM = (CLOUD_ACT_MULT[Math.min(CLOUD_ACT_MULT.length - 1, Math.max(0, st.actIndex))] as number) * 1;
      const kM = CLOUD_MULT_SMOOTH_K * dt;
      cloudMultSm += (wantM - cloudMultSm) * (1 - Math.exp(-kM));
    }
    const amtMist = mistAmount(hour, cloudDayF) * cloudUser;
    const amtCirrus = 1 * cloudUser;
    const anyCloud = amtCumulus * cloudMultSm + amtMist + amtCirrus + amtFar * cloudMultSm;
    // N2c: SOMBRAS DE NUBE — junto a applyLighting (colores), un bloque JS
    // por frame. Solo toca fogUniforms (material del terreno): cielo, nubes,
    // cámara, rastro y etiquetas intactos.
    // sunF = smoothstep(8°, 25°, elev): sol bajo = sombra alargada y lavada.
    const sunElevNow = st.sunElev;
    const sunFT = Math.min(1, Math.max(0, (sunElevNow - CLOUD_SHADOW_SUN_LO_DEG) / (CLOUD_SHADOW_SUN_HI_DEG - CLOUD_SHADOW_SUN_LO_DEG)));
    const sunF = sunFT * sunFT * (3 - 2 * sunFT);
    (fogUniforms.uCloudK as { value: number }).value =
      cloudShadowOff ? 0 : CLOUD_SHADOW_K * amtCumulus * cloudDayF * sunF;
    shadowHud.k = (fogUniforms.uCloudK as { value: number }).value;
    shadowHud.sunF = sunF;
    shadowHud.dayF = cloudDayF;
    shadowHud.amt = amtCumulus;
    shadowHud.mult = cloudMultSm;
    shadowHud.user = cloudUser;
    // uDrift += dt · (3/6000, 5/6000) — coherente con la deriva de nubes.
    {
      const du = fogUniforms.uDrift.value as THREE.Vector2;
      du.x += (dt * CLOUD_SHADOW_DRIFT_X_MS) / 6000;
      du.y += (dt * CLOUD_SHADOW_DRIFT_Y_MS) / 6000;
    }
    // 24 gaussianas = los 24 grupos de cúmulos (anillo/bruma/cirros NO).
    // Centro con deriva aplicada + desplazamiento solar:
    // off = (cy − ySuelo) · (sunDir.xz / max(sunDir.y, 0.15)).
    {
      const groups = clouds.group.visible ? clouds.shadowGroups() : [];
      const arr = fogUniforms.uClouds.value as THREE.Vector4[];
      const sy = Math.max(sunDirV.y, 0.15);
      const ox = sunDirV.x / sy;
      const oz = sunDirV.z / sy;
      // sunDirV está en mundo (x, y, z=mundo); EPSG: x=easting, y=northing.
      // mundo→EPSG: ex = wx + centerX, ey = centerY − wz.
      for (let i = 0; i < CLOUD_SHADOW_GROUPS; i++) {
        const dst = arr[i] as THREE.Vector4;
        const g = groups[i] as { x: number; y: number; z: number; r: number; w: number } | undefined;
        if (!g || g.w <= 0 || cloudShadowOff) {
          dst.set(0, 0, 1, 0);
          continue;
        }
        const ground = sampleGrid(elev, meta, g.x, g.y);
        const hgt = Math.max(0, g.z - ground);
        // EPSG→mundo-xz del shader: vWPos.xz es mundo (x, −(ey−centerY))…
        // el shader muestrea uClouds en vWPos.xz (mundo): convierte el
        // centro EPSG a mundo: wx = ex − centerX, wz = −(ey − centerY).
        const wx = g.x - world.centerX;
        const wz = -(g.y - world.centerY);
        const shx = wx - hgt * ox;
        const shz = wz - hgt * oz;
        const wgt = cloudShadowOff
          ? 0
          : CLOUD_SHADOW_W * amtCumulus * cloudMultSm * cloudDayF * sunF * Math.min(1, (g.w as number) / Math.max(1e-6, 0.5));
        dst.set(shx, shz, (g.r as number) * 0.62, Math.min(1, Math.max(0, wgt)));
      }
      // N2c-fix: HUD desde lo SUBIDO (máximo peso + gaussianas vivas).
      {
        let wMax = 0;
        let alive = 0;
        for (const v of arr) {
          if ((v.w as number) > wMax) wMax = v.w as number;
          if ((v.w as number) > 0) alive++;
        }
        shadowHud.wMax = wMax;
        shadowHud.alive = alive;
        shadowHud.noise = !!fogUniforms.uCloud.value;
      }
      // G54/G56: publica las gaussianas vivas + centros de nube para la
      // comprobación numérica (offset sol + deriva en pantalla).
      // N2-fix: __cloudShadow agregado (uCloudK, sunF, dayF, amount, pesos
      // y centros) — localiza por qué el factor sería 1 (peso/uCloudK 0,
      // offset fuera del DEM, o el debug antes de multiplicar).
      if (boot.debug) {
        (window as unknown as { __cloudShadows?: { x: number; y: number; r: number; w: number }[] }).__cloudShadows =
          arr.map((v) => ({ x: v.x, y: v.y, r: v.z, w: v.w }));
        (window as unknown as { __cloudShadow?: unknown }).__cloudShadow = {
          uCloudK: (fogUniforms.uCloudK as { value: number }).value,
          sunF,
          dayF: cloudDayF,
          amount: amtCumulus,
          mult: cloudMultSm,
          drift: {
            x: (fogUniforms.uDrift.value as THREE.Vector2).x,
            y: (fogUniforms.uDrift.value as THREE.Vector2).y,
          },
          pesos: arr.map((v) => v.w),
          centros: arr.map((v) => ({ x: v.x, z: v.y, r: v.z })),
          hasNoise: !!fogUniforms.uCloud.value,
        };
      }
    }
    if (boot.steep || anyCloud <= 0.001) {
      clouds.group.visible = false;
      metrics.cloudCoverage = 0;
    } else {
      clouds.group.visible = true;
      clouds.setAmounts({ cumulus: amtCumulus, mist: amtMist, cirrus: amtCirrus, far: amtFar });
      clouds.setMult(cloudMultSm);
      // N2-fix: altura de cámara al draw Y al probe (mismo fade del epílogo).
      clouds.setCamY(camera.position.y);
      // N1/N2: color neutro (blanco × dayF); el cálido llega por la niebla.
      clouds.setDayF(cloudDayF);
      // A9 (solo seguro): fade de la capa al mirar hacia abajo.
      // N2: aboveFade/belowFade eliminados (la base ya está sobre el epílogo).
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
    }
    line.setDim(routeDim);
    metrics.hasRock = (window as unknown as { __hasRock?: number }).__hasRock ?? 0;
    metrics.rockWeightShown = rockWeight.value;
    // §3b: haces Everest — cada frame: uTime + pulsos (única CPU) +
    // caminante sobre P(d) del rastro real. Cada 6 frames: estado por
    // flanco (una vez por cruce) + oclusión rayBlocked (×0,25).
    if (beams) {
      beams.setDayF(cloudDayF);
      {
        // Caminante: P(d) del rastro real (trackAt sobre route), no del
        // rail de cámara. Epílogo: final del bucle. Base en P(d): el
        // cilindro (260 m, base en y=0) queda centrado a +130 m.
        const dw = st.s >= EPILOGUE_S ? route.lengthM : Math.min(st.d, route.lengthM);
        const pw = trackAt(route, dw);
        const [wwx, wwy, wwz] = epsgToWorld(pw.x, pw.y, pw.z, world);
        beams.setWalker(wwx, wwy, wwz);
      }
      beams.tick();
      // G81: base del haz del caminante a ≤2 m de P(d) en planta y en
      // cota, en METROS y en el mundo. Solo informa (?debug=1), no gobierna.
      if (boot.debug) {
        const dw = st.s >= EPILOGUE_S ? route.lengthM : Math.min(st.d, route.lengthM);
        const pw = trackAt(route, dw);
        const [px, py, pz] = epsgToWorld(pw.x, pw.y, pw.z, world);
        const base = beams.walkerBase();
        const gapM = Math.hypot(base.x - px, base.z - pz);
        const gapY = Math.abs(base.y - py);
        (window as unknown as { __walkerGapM?: number }).__walkerGapM = gapM;
        (window as unknown as { __walkerGapY?: number }).__walkerGapY = gapY;
        (window as unknown as { __walkerOk?: boolean }).__walkerOk = gapM <= 2 && gapY <= 2;
      }
    }
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
      // §3b: estado SOLO por flanco (setState escribe aState + pulso solo
      // al cruzar) + oclusión ×0,25. La etiqueta sigue costando lo mismo
      // (solo cambió wy a la base).
      if (beams) {
        const { passed, next } = beams.setState(st.s);
        void passed;
        void next;
        beamDefs.forEach((d, i) => {
          beams?.setOccluded(i, (labelRts[d.rtIndex] as (typeof labelRts)[number]).occluded);
        });
        if (boot.debug) {
          const wok = (window as unknown as { __walkerOk?: boolean }).__walkerOk ?? true;
          const gapM = (window as unknown as { __walkerGapM?: number }).__walkerGapM;
          metrics.beamHud = beams.beamHud(st.s, wok, gapM);
        }
        (window as unknown as { __beamGlow?: number[] }).__beamGlow = beams.debugGlows();
        (window as unknown as { __beamPassed?: number }).__beamPassed = beams.passedCount();
      } else if (boot.debug) {
        metrics.beamHud = "haces 0 (?beams=0)";
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
    // N2 (?debug=atlas): el atlas ×0,5 abajo a la IZQUIERDA, en su lugar
    // (mismo pase compuesto, autoClear=false, sin writes de estado).
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
    if (boot.atlas && atlasBlit) {
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(atlasBlit.scene, atlasBlit.cam);
      renderer.autoClear = prevAutoClear;
      metrics.passes += 1;
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
    // C2b: el bloque exterior sigue corriendo para skyfrac/trackpx; la
    // sonda de LUMA corre solo bajo lumaOn (G93: con ?skyfrac=1 sin
    // ?luma=1 no corre). El oclusor sigue bajo occNeeded (la sonda de
    // sombra lo necesita con ?luma=1).
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
          // §5d: __zenithHex salía null — la sonda solo escribía
          // metrics.zenithHex (vía __metrics) pero nunca publicaba la
          // global directa que lee el instrumento. Mismo escritor, mismo
          // valor (G28: single writer intacto).
          (window as unknown as { __zenithHex?: string }).__zenithHex = metrics.zenithHex;
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
      // C2b (G93): downsample por DRAW con puertos del renderer (el blit
      // crudo default→FBO dejaba INVALID_OPERATION en el ledger G22).
      // copyFramebufferToTexture vuelca el frame presentado a lumaCopyTex
      // (misma resolución del canvas, creada una vez); el quad la dibuja
      // reescalada al RT g×g (LINEAR = cada celda es la media filtrada de
      // su región) y se lee con readRenderTargetPixels (4 KB, no 27 MB).
      // Todo persiste: cero asignaciones por pasada. Sin WebGL2/copy:
      // fallback al readPixels de celda central (mismo contrato, GL crudo
      // de LECTURA — permitido: getError/getShaderSource/readPixels son
      // lecturas, nunca escriben estado).
      // Solo bajo lumaOn: con ?skyfrac=1/?trackpx=1 sin ?luma=1 no corre
      // (G93); la sonda de sombra de abajo SÍ corre con ?luma=1 y necesita
      // buf+bw+bh+occBuf — ambos caminos los rellenan (bw=bh=g siempre).
      const w = Math.max(1, renderer.domElement.width);
      const h = Math.max(1, renderer.domElement.height);
      const buf: Uint8Array = lumaBuf;
      const bw = g;
      const bh = g;
      let lumaMs = 0;
      let lumaBlit = false;
      if (lumaOn) {
        const tL0 = performance.now();
        const gl = renderer.getContext() as WebGL2RenderingContext;
        let down = false;
        try {
          if (typeof renderer.copyFramebufferToTexture === "function") {
            if (lumaCopyTex.image.width !== w || lumaCopyTex.image.height !== h) {
              // Resize real: reasigna el buffer (única alloc, solo en resize).
              const nd = new Uint8Array(Math.max(4, w * h * 4));
              (lumaCopyTex.image as { data: Uint8Array; width: number; height: number }).data = nd;
              lumaCopyTex.image.width = w;
              lumaCopyTex.image.height = h;
              lumaCopyTex.needsUpdate = true;
            }
            // Vuelca el framebuffer presentado (READ = default) a la
            // textura propia. Puerto público: three ata lo que necesite.
            renderer.copyFramebufferToTexture(lumaCopyTex);
            // Dibuja la textura reescalada al RT g×g (escena propia: ni la
            // escena principal ni sus targets se tocan).
            lumaCopyMat.map = lumaCopyTex;
            lumaCopyMat.needsUpdate = true;
            const prevTarget = renderer.getRenderTarget();
            renderer.setRenderTarget(lumaRT);
            renderer.render(lumaScene, lumaCam);
            renderer.readRenderTargetPixels(lumaRT, 0, 0, g, g, lumaBuf);
            renderer.setRenderTarget(prevTarget);
            down = true;
          }
        } catch {
          down = false;
        }
        if (!down) {
          // Fallback: la celda central de cada región (contrato L1 intacto).
          const full = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, full);
          for (let gy = 0; gy < g; gy++) {
            for (let gx = 0; gx < g; gx++) {
              const fx = Math.min(w - 1, Math.floor((gx + 0.5) * (w / g)));
              const fy = Math.min(h - 1, Math.floor((gy + 0.5) * (h / g)));
              const si = (fy * w + fx) * 4;
              const di = (gy * g + gx) * 4;
              lumaBuf[di] = full[si] as number;
              lumaBuf[di + 1] = full[si + 1] as number;
              lumaBuf[di + 2] = full[si + 2] as number;
              lumaBuf[di + 3] = full[si + 3] as number;
            }
          }
        }
        lumaBlit = down;
        lumaMs = performance.now() - tL0;
      }
      let sum = 0;
      const lumaGrid: number[] = lumaOn ? [] : ((window as unknown as { __lumaGrid?: number[] }).__lumaGrid ?? []);
      const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      if (lumaOn) {
        for (let gy = 0; gy < g; gy++) {
          for (let gx = 0; gx < g; gx++) {
            const o = (gy * bw + gx) * 4;
            const rr = (buf[o] as number) / 255;
            const gg = (buf[o + 1] as number) / 255;
            const bb = (buf[o + 2] as number) / 255;
            // sRGB -> linear approx + Rec.709 luma
            const l = 0.2126 * lin(rr) + 0.7152 * lin(gg) + 0.0722 * lin(bb);
            sum += l;
            lumaGrid.push(l);
          }
        }
      }
      (window as unknown as { __luma?: number }).__luma = lumaOn && lumaGrid.length > 0 ? sum / lumaGrid.length : ((window as unknown as { __luma?: number }).__luma ?? -1);
      (window as unknown as { __lumaGrid?: number[] }).__lumaGrid = lumaGrid;
      (window as unknown as { __lumaRect?: { x: number; y: number; w: number; h: number } }).__lumaRect = { x: 0, y: 0, w, h };
      (window as unknown as { __lumaMs?: number }).__lumaMs = lumaOn ? lumaMs : -1;
      (window as unknown as { __lumaBlit?: boolean }).__lumaBlit = lumaOn ? lumaBlit : false;
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
          // F1 niebla (G45): el fondo del valle = píxeles de terreno del
          // TERCIO SUPERIOR de la imagen (banda del horizonte). Se guarda
          // su RGB display medio (__valleyTerr) para compararlo con el
          // horizonte de la captura (__hzSunHex/__hzAntiHex).
          const valleyRGB: [number, number, number][] = [];
          let litOver = 0;
          const gridW = 256;
          const gridH = 144;
          // Misma rejilla conceptual que __luma (g×g sobre la imagen):
          // paso en píxeles del canvas -> paso proporcional en la máscara.
          // C2b: las celdas de __luma son MEDIAS del blit 32×32; la sonda
          // de sombra lee las MISMAS celdas (buf ya es g×g: bw=bh=g).
          for (let gy = 0; gy < g; gy++) {
            for (let gx = 0; gx < g; gx++) {
              const fx = Math.min(bw - 1, gx);
              const fy = Math.min(bh - 1, gy);
              const mx = Math.min(gridW - 1, Math.floor((fx / Math.max(1, bw)) * gridW));
              const my = Math.min(gridH - 1, Math.floor((fy / Math.max(1, bh)) * gridH));
              const mo = (my * gridW + mx) * 4;
              if ((occBuf[mo] as number) < 8 && (occBuf[mo + 1] as number) < 8 && (occBuf[mo + 2] as number) < 8) continue; // cielo
              const o = (fy * bw + fx) * 4;
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
              // F1: el píxel está en el tercio superior (fy < bh/3 → lejos,
              // banda del horizonte) y es terreno: candidato a fondo de valle.
              if (fy < bh / 3) valleyRGB.push([rr, gg, bb]);
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
            // N2c G53 (presencia): con ?debug=cloudshadow el terreno se pinta
            // en gris = factor de sombra (misma rejilla/rejilla y buf YA
            // leídos — sin segundo readPixels). Fracción de píxeles de
            // TERRENO con luma lineal < 0,8: [0,10,0,35] @12:00, ≤mitad
            // @08:30, 0 @20:30. Sin el flag: -1 (pendiente).
            // N2c G55 (niebla intacta): luma lineal media del fondo del valle
            // (valleyRGB = tercio superior, banda del horizonte) con y sin
            // sombras (?cloudshadow=0). G55 compara dos cargas; aquí se
            // publica el valor CON sombras.
            {
              const W53 = window as unknown as { __cloudShadowFrac?: number; __cloudShadowFarLuma?: number };
              if (boot.cloudshadow) {
                let dark = 0;
                for (const l of terrLumas) if ((l as number) < 0.8) dark++;
                W53.__cloudShadowFrac = terrLumas.length > 0 ? dark / terrLumas.length : 0;
                if (valleyRGB.length > 0) {
                  let s = 0;
                  for (const c of valleyRGB) {
                    s += 0.2126 * lumOf(c[0] as number) + 0.7152 * lumOf(c[1] as number) + 0.0722 * lumOf(c[2] as number);
                  }
                  W53.__cloudShadowFarLuma = s / valleyRGB.length;
                } else {
                  W53.__cloudShadowFarLuma = -1;
                }
              } else {
                W53.__cloudShadowFrac = -1;
                W53.__cloudShadowFarLuma = -1;
              }
            }
            // F1 niebla (G45): media display del fondo del valle + distancia
            // RGB al horizonte de la captura (lado del sol). dist ≤ 0.12 al
            // alba/ocaso (funde con el cielo), ≥ 0.2 a mediodía (legible).
            if (valleyRGB.length > 0) {
              let vR = 0;
              let vG = 0;
              let vB = 0;
              for (const c of valleyRGB) {
                vR += c[0] as number;
                vG += c[1] as number;
                vB += c[2] as number;
              }
              vR /= valleyRGB.length;
              vG /= valleyRGB.length;
              vB /= valleyRGB.length;
              const hx = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
              (window as unknown as { __valleyTerr?: string }).__valleyTerr = `#${hx(vR)}${hx(vG)}${hx(vB)}`;
              const hzHex = (window as unknown as { __hzSunHex?: string }).__hzSunHex ?? "#000000";
              const hr = parseInt(hzHex.slice(1, 3), 16) / 255;
              const hg = parseInt(hzHex.slice(3, 5), 16) / 255;
              const hb = parseInt(hzHex.slice(5, 7), 16) / 255;
              (window as unknown as { __valleyFogDist?: number }).__valleyFogDist = Math.hypot(vR - hr, vG - hg, vB - hb) / Math.sqrt(3);
            } else {
              (window as unknown as { __valleyTerr?: string }).__valleyTerr = "—";
              (window as unknown as { __valleyFogDist?: number }).__valleyFogDist = -1;
            }
          } else {
            (window as unknown as { __lumaShadow?: number }).__lumaShadow = -1;
            (window as unknown as { __chromaShadow?: number }).__chromaShadow = -1;
            (window as unknown as { __litOver?: number }).__litOver = -1;
            (window as unknown as { __valleyTerr?: string }).__valleyTerr = "—";
            (window as unknown as { __valleyFogDist?: number }).__valleyFogDist = -1;
          }
        } else {
          (window as unknown as { __lumaShadow?: number }).__lumaShadow = -1;
          (window as unknown as { __chromaShadow?: number }).__chromaShadow = -1;
          (window as unknown as { __litOver?: number }).__litOver = -1;
          (window as unknown as { __valleyTerr?: string }).__valleyTerr = "—";
          (window as unknown as { __valleyFogDist?: number }).__valleyFogDist = -1;
        }
      } // cierre if (lumaOn)
      // §4b FASE 2b (G26 medible) + G22: sin cambios — el blit y getError
      // ya viven en el bloque de 30 frames; la sonda de sombra no mueve
      // nada (misma rejilla, misma máscara, solo aritmética JS).
      // §4b FASE 4c (G24c/G41/G43): pixel meter — cloud mesh with the flat
      // probe material into 96×54, counted inside the terrain-sky mask.
      // Runs ONLY with ?skyfrac=1 on the 30-frame cadence (production
      // never pays it). No try/catch: a failure throws under ?debug=1
      // (loud) and publishes __cloudCoverPxErr (G24c gate reads it).
      // Publishes __cloudCoverPx (sky fraction covered) next to the
      // analytic metrics.cloudCoverage so the audit sees how much the
      // disc meter lies. ALSO accumulates the meter RT into __cloudRT
      // (G41 density decile + G43 terrain overlap read it, no re-render).
      if (skyfracOn) {
        // §4b FASE 4c: pixel meter — cloud mesh with the flat probe
        // material into 96×54, counted inside the terrain-sky mask.
        // Runs ONLY with ?skyfrac=1 on the 30-frame cadence (production
        // never pays it). Publishes __cloudCoverPx (sky fraction covered)
        // next to the analytic metrics.cloudCoverage so the audit sees
        // how much the disc meter lies. ALSO accumulates the meter RT
        // into __cloudRT (G41 density decile + G43 terrain overlap read
        // it, no re-render). Failures throw under ?debug=1 (loud) and
        // publish __cloudCoverPxErr.
        if (occRan) {
          if (!cloudPxWired) {
            const pu = clouds.probeUniforms();
            (cloudPxMat.uniforms["uMap"] as { value: unknown }).value = pu.uMap;
            (cloudPxMat.uniforms["uAmtCumulus"] as { value: unknown }).value = pu.uAmtCumulus;
            (cloudPxMat.uniforms["uAmtMist"] as { value: unknown }).value = pu.uAmtMist;
            (cloudPxMat.uniforms["uAmtCirrus"] as { value: unknown }).value = pu.uAmtCirrus;
            (cloudPxMat.uniforms["uAmtFar"] as { value: unknown }).value = pu.uAmtFar;
            // N2b: uMult/uZenithFade/uTime/uFamFilter/uCamY del probe: objetos
            // propios (el probe NO comparte el material de nubes; copia los
            // valores cada pase — la sonda informa, no gobierna).
            (cloudPxMat.uniforms["uMult"] as { value: number }).value = 1;
            (cloudPxMat.uniforms["uZenithFade"] as { value: number }).value = 0;
            (cloudPxMat.uniforms["uTime"] as { value: number }).value = 0;
            (cloudPxMat.uniforms["uFamFilter"] as { value: number }).value = -1;
            (cloudPxMat.uniforms["uCamY"] as { value: number }).value = 0;
            cloudPxWired = true;
          }
          // N2b: el probe copia los valores vivos (mismo frame, cero deriva)
          // + uTime (pulso de bruma) + filtro de familia (?family=N/off).
          // N2-fix: + uCamY (mismo fade del epílogo que el draw).
          {
            const pu = clouds.probeUniforms();
            (cloudPxMat.uniforms["uMult"] as { value: number }).value =
              (pu.uAmtCumulus as unknown as { __mult?: number }).__mult ?? 1;
            (cloudPxMat.uniforms["uTime"] as { value: number }).value = clock.elapsedTime;
            (cloudPxMat.uniforms["uFamFilter"] as { value: number }).value = famFilter;
            (cloudPxMat.uniforms["uCamY"] as { value: number }).value =
              (pu.uAmtCumulus as unknown as { __camY?: number }).__camY ?? camera.position.y;
          }
          // cloudPxScene HOLDS clouds.mesh across frames (added once) —
          // restore the parent after the probe render (scene graph hygiene:
          // the main scene must own the mesh for the user frame).
          const prevParent = clouds.mesh.parent;
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
          if (prevParent) prevParent.add(clouds.mesh);
          // N2 G44: componentes conexas de nube (alfa > 0,15) en el RT del
          // medidor (96×54, 4-vecindad) + G41/G43 en el mismo bucle.
          // N2b: la bruma (fam 1) se mide sobre TERRENO; las otras tres
          // sobre cielo. El conteo por defecto (sin ?family=) es el total:
          // cielo para fams 0/2/3 + terreno para fam 1.
          const famOnly = famFilter < -0.5 ? -1 : Math.round(famFilter);
          let skyN = 0;
          let cloudN = 0;
          let terrN = 0;
          let cloudOnTerr = 0;
          // N2b G49: bruma sobre terreno (puerta: [0,08,0,25] @07:30).
          let mistOnTerr = 0;
          // N2-fix: croma medio de los píxeles de bruma (≤0,15 gris-azul).
          const mistChromas: number[] = [];
          // N2b G50: franja inferior del cielo (15 % más cercano al horizonte
          // ≈ filas 0..7 del RT 96×54, el RT tiene y=0 abajo) vs resto.
          let lowSkyN = 0;
          let lowSkyCloud = 0;
          let highSkyN = 0;
          let highSkyCloud = 0;
          // N2b G51: alfa máxima en pantalla (familia 2, cirros).
          let maxAlphaSeen = 0;
          const denseAlphas: number[] = [];
          // G44: BFS sobre la máscara de nube (solo píxeles de cielo).
          const visited = new Uint8Array(96 * 54);
          let compCount = 0;
          let compSmall = 0;
          const isCloudAt = (xx: number, yy: number): boolean => {
            const co = (yy * 96 + xx) * 4;
            const mx = Math.min(255, Math.floor((xx / 96) * 256));
            const my = Math.min(143, Math.floor((yy / 54) * 144));
            const mo = (my * 256 + mx) * 4;
            const sky = (occBuf[mo] as number) < 8 && (occBuf[mo + 1] as number) < 8 && (occBuf[mo + 2] as number) < 8;
            return sky && (cloudPxBuf[co] as number) > 128;
          };
          for (let yy = 0; yy < 54; yy++) {
            for (let xx = 0; xx < 96; xx++) {
              const mx = Math.min(255, Math.floor((xx / 96) * 256));
              const my = Math.min(143, Math.floor((yy / 54) * 144));
              const mo = (my * 256 + mx) * 4;
              const co = (yy * 96 + xx) * 4;
              const isSky = (occBuf[mo] as number) < 8 && (occBuf[mo + 1] as number) < 8 && (occBuf[mo + 2] as number) < 8;
              const isCloud = (cloudPxBuf[co] as number) > 128;
              const pxAlpha = (cloudPxBuf[co + 3] as number) / 255;
              if (isSky) {
                skyN++;
                if (isCloud) {
                  cloudN++;
                  denseAlphas.push(pxAlpha);
                  if (pxAlpha > maxAlphaSeen) maxAlphaSeen = pxAlpha;
                  // G50: franja inferior (filas 0..7) vs resto del cielo.
                  if (yy < 8) {
                    lowSkyN++;
                    lowSkyCloud++;
                  } else {
                    highSkyN++;
                    highSkyCloud++;
                  }
                } else if (yy < 8) {
                  lowSkyN++;
                } else {
                  highSkyN++;
                }
              } else {
                terrN++;
                if (isCloud) {
                  cloudOnTerr++;
                  // N2b: con filtro fam=1 el RT solo trae bruma → bruma/terreno.
                  // N2-fix: croma de bruma (G49: ≤0,15 gris-azul, no marrón)
                  // sobre el frame PRESENTADO (buf+raster ya leídos C2b, sin
                  // re-render). Sin ?luma=1 no hay raster: bruma −1.
                  if (famOnly === 1) {
                    mistOnTerr++;
                    if (lumaOn) {
                      const fx = Math.min(bw - 1, Math.floor(((xx + 0.5) / 96) * bw));
                      const fy = Math.min(bh - 1, Math.floor(((yy + 0.5) / 54) * bh));
                      const o = (fy * bw + fx) * 4;
                      const mr = (buf[o] as number) / 255;
                      const mg = (buf[o + 1] as number) / 255;
                      const mb = (buf[o + 2] as number) / 255;
                      const mxc = Math.max(mr, mg, mb);
                      const mnc = Math.min(mr, mg, mb);
                      mistChromas.push(mxc > 1e-6 ? (mxc - mnc) / mxc : 0);
                    }
                  }
                  denseAlphas.push(pxAlpha);
                  if (pxAlpha > maxAlphaSeen) maxAlphaSeen = pxAlpha;
                }
              }
              // G44 BFS (4-vecindad, solo cielo)
              const gi = yy * 96 + xx;
              if (isSky && isCloud && visited[gi] === 0) {
                let size = 0;
                const stack: number[] = [gi];
                while (stack.length > 0) {
                  const j = stack.pop() as number;
                  if (visited[j] === 1) continue;
                  visited[j] = 1;
                  const jx = j % 96;
                  const jy = Math.floor(j / 96);
                  if (!isCloudAt(jx, jy)) continue;
                  size++;
                  if (jx > 0) stack.push(j - 1);
                  if (jx + 1 < 96) stack.push(j + 1);
                  if (jy > 0) stack.push(j - 96);
                  if (jy + 1 < 54) stack.push(j + 96);
                }
                if (size > 0) {
                  compCount++;
                  if (size / Math.max(1, skyN > 0 ? skyN : 5184) < 0.004) compSmall++;
                }
              }
            }
          }
          (window as unknown as { __cloudComps?: number }).__cloudComps = compCount;
          (window as unknown as { __cloudCompsSmall?: number }).__cloudCompsSmall = compSmall;
          const coverPx = skyN > 0 ? cloudN / skyN : 0;
          (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx = coverPx;
          (window as unknown as { __cloudCoverPxErr?: string }).__cloudCoverPxErr = "";
          // N2b G49/G50/G51: lecturas por familia sobre el MISMO pase.
          (window as unknown as { __cloudMistTerr?: number }).__cloudMistTerr =
            famOnly === 1 && terrN > 0 ? mistOnTerr / terrN : terrN > 0 ? cloudOnTerr / terrN : 0;
          // N2-fix: croma medio de bruma (gris-azul ≤0,15, no marrón).
          (window as unknown as { __cloudMistChroma?: number }).__cloudMistChroma =
            mistChromas.length > 0 ? mistChromas.reduce((t, v) => t + v, 0) / mistChromas.length : -1;
          (window as unknown as { __cloudLowSky?: number }).__cloudLowSky = lowSkyN > 0 ? lowSkyCloud / lowSkyN : 0;
          (window as unknown as { __cloudHighSky?: number }).__cloudHighSky = highSkyN > 0 ? highSkyCloud / highSkyN : 0;
          (window as unknown as { __cloudMaxAlpha?: number }).__cloudMaxAlpha = maxAlphaSeen;
          const skyPx = (window as unknown as { __skyFrac?: number }).__skyFrac ?? -1;
          const blue = skyPx >= 0 ? Math.min(1, Math.max(0, skyPx * (1 - coverPx))) : -1;
          (window as unknown as { __blueSky?: number }).__blueSky = blue;
          // C2b: G42 lee el raster del blit (ya leído para __luma — mismo
          // buffer, sin segundo readPixels). Sin ?luma=1 no hay raster.
          if (lumaOn) publishCloudColor(buf, bw, bh);
          else {
            (window as unknown as { __cloudLuma?: number }).__cloudLuma = -1;
            (window as unknown as { __cloudChroma?: number }).__cloudChroma = -1;
          }
          // G41: density decile — 10% densest cloud px alpha (must be ≥0.8:
          // cores, not veil). G43: cloud-on-terrain fraction (≤0.05).
          denseAlphas.sort((a, b) => b - a);
          const g41 = denseAlphas.length >= 10
            ? denseAlphas.slice(0, Math.max(1, Math.floor(denseAlphas.length / 10))).reduce((t, v) => t + v, 0) / Math.max(1, Math.floor(denseAlphas.length / 10))
            : -1;
          (window as unknown as { __cloudDense?: number }).__cloudDense = g41;
          (window as unknown as { __cloudOnTerr?: number }).__cloudOnTerr = terrN > 0 ? cloudOnTerr / terrN : 0;
          // N2b: tabla por familia en el MISMO pase — el filtro ?family=N se
          // aplica por pase; __cloudCoverPxFam acumula la última lectura de
          // cada familia (el auditor barre family=0..3 + sin filtro).
          {
            const W = window as unknown as { __cloudCoverPxFam?: number[] };
            if (!W.__cloudCoverPxFam) W.__cloudCoverPxFam = [-1, -1, -1, -1];
            const fam = W.__cloudCoverPxFam;
            if (famOnly >= 0 && famOnly <= 3) {
              // fam 1 (bruma) sobre terreno; 0/2/3 sobre cielo.
              fam[famOnly] = famOnly === 1
                ? (terrN > 0 ? mistOnTerr / terrN : 0)
                : coverPx;
            } else {
              // sin filtro: fam 0/2/3 leen cielo total, fam 1 lee terreno.
              // (aprox: el total mezcla; el auditor usa ?family=N por familia).
              fam[0] = coverPx;
              fam[1] = terrN > 0 ? cloudOnTerr / terrN : 0;
              fam[2] = coverPx;
              fam[3] = coverPx;
            }
          }
        } else {
          (window as unknown as { __cloudCoverPx?: number }).__cloudCoverPx = -1;
          (window as unknown as { __blueSky?: number }).__blueSky = -1;
          (window as unknown as { __cloudDense?: number }).__cloudDense = -1;
          (window as unknown as { __cloudOnTerr?: number }).__cloudOnTerr = -1;
          (window as unknown as { __cloudLuma?: number }).__cloudLuma = -1;
          (window as unknown as { __cloudChroma?: number }).__cloudChroma = -1;
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
        // §3 G74 (?trackpx=1 -> __beampx): pase de ID de haces (idMat
        // propio, como G15) -> píxeles por hito [pradera, cota, cola].
        // Misma cadencia de 30 frames, escena propia, producción intacta.
        try {
          (window as unknown as { __beampx?: number[] }).__beampx = beams ? beams.countIdPixels(renderer, camera) : [];
        } catch {
          (window as unknown as { __beampx?: number[] }).__beampx = [];
        }
      }
      // §4b FASE 2b (G26 medible): one canvas pixel at (16, h-16) — inside
      // the 384×192 blit — read AFTER the blit, BEFORE present, same
      // mechanism as __luma. Only with ?skymap=1 (and debug cadence):
      // production never pays it. Must ≈ the capture's lower-centre pixel
      // (horizon), never #000000, never terrain colour.
      if (boot.skymap && skyCap && boot.skycap) {
        // §6: sun azimuth (deg) driving the last capture — the band meter
        // needs it to exclude the sun column (disk + mie halo) per row.
        (window as unknown as { __skySunAz?: number }).__skySunAz = skyCap.sunAzimuthDeg();
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
    framesLive++;
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
