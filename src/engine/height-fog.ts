// height-fog.ts — valley-height fog + sky-tinted distance haze + cheap
// cloud-light modulation + sky-ambient valley fill (R1b), injected via
// onBeforeCompile into the terrain's MeshStandardMaterial (keeps shadows,
// tonemapping, colorspace).
//
// R1b: the scene holds NO three Light for the ambient — a HemisphereLight
// cannot work because nothing reads it. The fill enters as a uniform:
// dome colour (uHemiSky, linear) x daylight factor (uHemiDay 0..1) added to
// the outgoing fragment. Intensity NEVER scales with sin(solar altitude):
// at 07:24 with the sun at 2.1 deg the valley still needs full sky light.
import * as THREE from "three";
import { FOG_DAWN_DF_ADD, FOG_DAWN_HF_MULT, HEMI_GRAY_MIX } from "../narrative/choreography.ts";

export interface FogParams {
  fogTopM: number; // ceiling: full fog below, fading above
  fogDensity: number; // 0..1 global amount (from lightingAt)
  skyColor: [number, number, number]; // linear-space horizon colour
  cloudShade: number; // 0..1 slow 2D noise dimming of the sun
  time: number; // seconds, for the slow drift
  hemiSky: [number, number, number]; // R1b: sky dome colour (linear)
  hemiDay: number; // R1b: daylight factor — 1 sun-up, ~0 after sunset
}

export const fogUniforms = {
  uFogTop: { value: 1700 },
  uFogDensity: { value: 0.5 },
  uSkyColor: { value: [0.6, 0.7, 0.85] as [number, number, number] },
  uSkyMap: { value: null as THREE.Texture | null },
  uHasSkyMap: { value: 0 },
  uCloudShade: { value: 0 },
  uTime: { value: 0 },
  uHemiSky: { value: [0.42, 0.55, 0.78] as [number, number, number] },
  uHemiDay: { value: 1 },
  /** F1: factor de niebla de hora baja — 1 al alba/ocaso, 0 a mediodía.
   * Multiplica el término de valle y suma al de distancia. */
  uDawnF: { value: 0 },
  /** N2c: sombras de nube sobre el terreno (24 gaussianas + ruido a dos
   * escalas). Antes de la niebla: la distancia se funde con el cielo, no
   * con la sombra. uCloudDebug: 1 = gris = factor de sombra (verlo).
   * uClouds es vec4-array real (three exige .toArray() al subirlo). */
  uCloud: { value: null as THREE.Texture | null },
  uCloudK: { value: 0 },
  uDrift: { value: new THREE.Vector2(0, 0) },
  uClouds: {
    value: Array.from({ length: 24 }, () => new THREE.Vector4(0, 0, 1, 0)),
  },
  uCloudDebug: { value: 0 },
};

/** N2c: textura de ruido uCloud — lienzo 512×512 gris #c8c8c8 con 46
 * manchas radiales (radio 40-150 px, 55 % oscuras rgba(40,40,40,.5),
 * 45 % claras rgba(255,255,255,.42)), semilla fija (mulberry). Wrap en
 * mosaico, LinearMipmapLinear, NoColorSpace. */
export function makeCloudShadowTexture(
  THREE_NS: typeof import("three"),
): import("three").Texture {
  let s = 20260817;
  const rnd = (): number => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const S = 512;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#c8c8c8";
  ctx.fillRect(0, 0, S, S);
  for (let k = 0; k < 46; k++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const rad = 40 + rnd() * 110;
    const dark = rnd() < 0.55;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    if (dark) {
      g.addColorStop(0, "rgba(40,40,40,0.5)");
      g.addColorStop(1, "rgba(40,40,40,0)");
    } else {
      g.addColorStop(0, "rgba(255,255,255,0.42)");
      g.addColorStop(1, "rgba(255,255,255,0)");
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE_NS.CanvasTexture(cv);
  tex.wrapS = THREE_NS.RepeatWrapping;
  tex.wrapT = THREE_NS.RepeatWrapping;
  tex.magFilter = THREE_NS.LinearMipmapLinearFilter;
  tex.minFilter = THREE_NS.LinearMipmapLinearFilter;
  tex.colorSpace = THREE_NS.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function patchTerrainMaterial(mat: THREE.Material): void {
  const m = mat as unknown as {
    onBeforeCompile: (s: { uniforms: Record<string, unknown>; fragmentShader: string; vertexShader: string }) => void;
  };
  m.onBeforeCompile = (s) => {
    s.uniforms.uFogTop = fogUniforms.uFogTop;
    s.uniforms.uFogDensity = fogUniforms.uFogDensity;
    s.uniforms.uSkyColor = fogUniforms.uSkyColor;
    s.uniforms.uSkyMap = fogUniforms.uSkyMap;
    s.uniforms.uHasSkyMap = fogUniforms.uHasSkyMap;
    s.uniforms.uCloudShade = fogUniforms.uCloudShade;
    s.uniforms.uTime = fogUniforms.uTime;
    s.uniforms.uHemiSky = fogUniforms.uHemiSky;
    s.uniforms.uHemiDay = fogUniforms.uHemiDay;
    s.uniforms.uDawnF = fogUniforms.uDawnF;
    // N2c: sombras de nube (regla G40: todo uniforme se DECLARA en el GLSL
    // de abajo — three sube material.uniforms, no los declara).
    s.uniforms.uCloud = fogUniforms.uCloud;
    s.uniforms.uCloudK = fogUniforms.uCloudK;
    s.uniforms.uDrift = fogUniforms.uDrift;
    s.uniforms.uClouds = fogUniforms.uClouds;
    s.uniforms.uCloudDebug = fogUniforms.uCloudDebug;
    s.vertexShader = s.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWPos;")
      .replace("#include <fog_vertex>", "#include <fog_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;");
    s.fragmentShader = s.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWPos;
uniform float uFogTop; uniform float uFogDensity; uniform vec3 uSkyColor;
uniform sampler2D uSkyMap; uniform float uHasSkyMap;
uniform float uCloudShade; uniform float uTime;
uniform vec3 uHemiSky; uniform float uHemiDay; uniform float uDawnF;
uniform sampler2D uCloud; uniform float uCloudK; uniform vec2 uDrift; uniform vec4 uClouds[24]; uniform float uCloudDebug;
float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float vnoise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }`,
      )
      .replace(
        "#include <fog_fragment>",
        `#include <fog_fragment>
{
  float hfrac = clamp(1.0 - (vWPos.y - (uFogTop - 500.0)) / 500.0, 0.0, 1.0);
  float camd = length(vWPos - cameraPosition);
  // F1 niebla de valle: el término bajo se multiplica al alba/ocaso
  // (uDawnF = 1 − smoothstep(2°,20°,elev)) y el de distancia suma para
  // fundir el horizonte con el cielo. A mediodía uDawnF = 0: intacto.
  float hf = hfrac * hfrac * uFogDensity * (1.0 + uDawnF * ${FOG_DAWN_HF_MULT.toFixed(2)});
  // U1/V2: D8 condition — ≥80% attenuation at 10.8 km (the model edge
  // behind Monte Perdido) with Monte Perdido itself still readable.
  // Squared-exponential: slow start, steep finish.
  // k=3.4: 4 km → ~0.18, 8 km → ~0.66, 10 km → ~0.83, 10.8 km → ~0.90.
  float x = camd / 9000.0;
  float df = 1.0 - exp(-x * x * x * x * 3.4);
  float f = clamp(hf * 0.85 + df * (0.45 + 0.55 * uFogDensity + uDawnF * ${FOG_DAWN_DF_ADD.toFixed(2)}), 0.0, 1.0);
  float shade = 1.0 - uCloudShade * (0.5 + 0.5 * vnoise(vWPos.xz * 0.00035 + uTime * 0.004)) * 0.35;
  gl_FragColor.rgb *= shade;
  // N2c: SOMBRAS DE NUBE — ANTES de la niebla (la distancia se funde con
  // el cielo, no con la sombra) y DESPUÉS de la iluminación. Ruido a dos
  // escalas (periodos ~6 km y ~1,9 km) + 24 gaussianas de los grupos de
  // cúmulos N2 (anillo/bruma/cirros NO proyectan). Sin desaturación.
  float cloudShadowF = 1.0;
  {
    float cs = texture2D(uCloud, vWPos.xz * (1.0 / 6000.0) + uDrift).r * 0.72
      + texture2D(uCloud, vWPos.xz * (1.0 / 1900.0) + uDrift * 1.7).r * 0.28;
    float kNoise = mix(1.0, 0.45 + smoothstep(0.32, 0.66, cs), uCloudK);
    kNoise = min(kNoise, 1.10);
    float csh = 1.0;
    for (int i = 0; i < 24; i++) {
      vec2 dd = (vWPos.xz - uClouds[i].xy) / max(uClouds[i].z, 1.0);
      csh *= 1.0 - uClouds[i].w * exp(-dot(dd, dd) * 1.7);
    }
    csh = max(csh, 0.35);
    cloudShadowF = kNoise * csh;
    gl_FragColor.rgb *= cloudShadowF;
  }
  // N2c ?debug=cloudshadow: gris = factor de sombra (1 = blanco), sin
  // textura ni luz — para VERLO. Solo con el flag (uCloudDebug).
  if (uCloudDebug > 0.5) {
    gl_FragColor.rgb = vec3(cloudShadowF);
  }
  // R1b: sky-ambient valley fill. A shadowed valley under clear sky is
  // blue, not black — add dome light directly (no three Light in scene).
  // uHemiDay is 1 whenever the sun is up (never sin(altitude)), ~0 after
  // sunset. Reference: Everest 02:27 — night, yet perfectly legible.
  // §4: with a bluer sky the shadow goes violet — mix the sky toward
  // neutral grey of equal luma FIRST (HEMI_GRAY_MIX). Cool, not tinted.
  float hemiLuma = dot(uHemiSky, vec3(0.2126, 0.7152, 0.0722));
  vec3 hemiMix = mix(uHemiSky, vec3(hemiLuma), ${HEMI_GRAY_MIX.toFixed(2)});
  gl_FragColor.rgb += hemiMix * uHemiDay * 0.35;
  // S9: fog colour sampled from the 64×32 sky capture along the view ray —
  // the far terrain dissolves into the actual sky, dawn and dusk included.
  vec3 haze = uSkyColor;
  if (uHasSkyMap > 0.5) {
    vec3 vd = normalize(vWPos - cameraPosition);
    vec2 skuv = vec2(atan(vd.z, vd.x) / 6.2831853 + 0.5, clamp(vd.y * 0.5 + 0.5, 0.0, 1.0));
    haze = texture2D(uSkyMap, skuv).rgb;
  }
  gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, f);
}`,
      );
  };
  (mat as { customProgramCacheKey?: () => string }).customProgramCacheKey = () => "ordesa-height-fog";
}
