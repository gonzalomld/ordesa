// height-fog.ts — valley-height fog + sky-tinted distance haze + cheap
// cloud-light modulation, injected via onBeforeCompile into the terrain's
// MeshStandardMaterial (keeps shadows, tonemapping, colorspace).
import type * as THREE from "three";

export interface FogParams {
  fogTopM: number; // ceiling: full fog below, fading above
  fogDensity: number; // 0..1 global amount (from lightingAt)
  skyColor: [number, number, number]; // linear-space horizon colour
  cloudShade: number; // 0..1 slow 2D noise dimming of the sun
  time: number; // seconds, for the slow drift
}

export const fogUniforms = {
  uFogTop: { value: 1700 },
  uFogDensity: { value: 0.5 },
  uSkyColor: { value: [0.6, 0.7, 0.85] as [number, number, number] },
  uSkyMap: { value: null as THREE.Texture | null },
  uHasSkyMap: { value: 0 },
  uCloudShade: { value: 0 },
  uTime: { value: 0 },
};

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
  float hf = hfrac * hfrac * uFogDensity;
  // U1: D8 condition — ≥80% attenuation at 10.8 km (the model edge behind
  // Monte Perdido) with Monte Perdido itself still readable as a silhouette.
  // Squared-exponential: slow start, steep finish.
  // 2 km → ~0.03, 4 km → ~0.13, 6 km → ~0.30, 8 km → ~0.55, 10.8 km → ~0.86.
  float x = camd / 9000.0;
  float df = 1.0 - exp(-x * x * x * x * 2.2);
  float f = clamp(hf * 0.85 + df * (0.35 + 0.55 * uFogDensity), 0.0, 1.0);
  float shade = 1.0 - uCloudShade * (0.5 + 0.5 * vnoise(vWPos.xz * 0.00035 + uTime * 0.004)) * 0.35;
  gl_FragColor.rgb *= shade;
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
