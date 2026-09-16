// sky-capture.ts — S9 + §4b FASE 1: TRUE equirectangular sky capture.
// The terrain fog shader (height-fog.ts) samples uSkyMap as an equirect
// map (u = atan(z,x)/2π + 0.5, v = y*0.5 + 0.5) — so the capture MUST be
// equirectangular. The old dome-clone was a 1 m box (scale 60000 never
// copied) rendered with the perspective main camera: black target, zenith
// #000000, black haze melting the far terrain. Never again.
//
// Design: own ShaderMaterial (Preetham math copied VERBATIM from three
// 0.170 Sky.js — same file the dome runs, checked into node_modules) with
// the SAME uniform objects by reference (any viewer write is live, zero
// copies). The vertex computes the uniform-only varyings (vSunDirection /
// vSunE / vSunfade / vBetaR / vBetaM); direction comes from the quad uv,
// never from a vertex position:
//   az = (uv.x - 0.5) * 2π,  el = (uv.y - 0.5) * π,
//   dir = (cos(el)·cos(az), sin(el), cos(el)·sin(az))
// — EXACTLY the convention height-fog.ts samples with. Geometry is a
// clip-space PlaneGeometry(2,2) under an own OrthographicCamera; the main
// camera is never touched. SKY_SCALE applies inline (same factor as the
// dome) so haze matches drawn sky. No tonemapping/colorspace includes:
// the target is linear working data for fog + meter.
// No offscreen pass uses the main scene; raw GL is never written (AGENTS.md).
import * as THREE from "three";
import { SKY_EPS_DEG, SKY_SAT, SKY_SCALE } from "../narrative/choreography.ts";
import { fogUniforms } from "./height-fog.ts";

export interface SkyCapture {
  refresh(): void;
  refreshIfNeeded(elevDeg: number): boolean;
  /** Rastro isolation (?skycap=0): skip the capture (zenith frozen). */
  setEnabled(on: boolean): void;
  /** §4b FASE 2: read zenith + horizon luma from the capture (renderer
   * path only, no raw GL). Zenith = top-centre of the 64×32 equirect,
   * horizon = vertical middle. Returns DISPLAY values: the capture bytes
   * through EXACTLY the three ACES filmic (exposure 1.0, /0.6) +
   * linear→sRGB the dome pixels take on screen — so the gate compares
   * what the user sees, not linear working data. raw = pre-tonemap bytes
   * (audit trail, kept for __zenithLinear).
   * Precondition: the capture target is UnsignedByteType (readable).
   * DEBUG-ONLY cadence (call site: every 30th frame with ?debug=1) — a
   * readRenderTargetPixels sync every frame costs ~3 ms for everyone. */
  readZenith(): {
    disp: { zen: [number, number, number]; hor: [number, number, number] };
    raw: { zen: [number, number, number]; hor: [number, number, number] };
  };
  /** ?skymap=1 blit source (live texture, no copy). */
  texture(): THREE.Texture;
  dispose(): void;
}

// --- Preetham, verbatim from three 0.170 Sky.SkyShader (node_modules) ---
// Vertex: uniform-only varyings (NO vWorldPosition — direction comes from uv).
const CAPTURE_VERT = /* glsl */ `
  uniform vec3 sunPosition;
  uniform float rayleigh;
  uniform float turbidity;
  uniform float mieCoefficient;
  uniform vec3 up;

  varying vec2 vUv;
  varying vec3 vSunDirection;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  const float e = 2.71828182845904523536028747135266249775724709369995957;
  const float pi = 3.141592653589793238462643383279502884197169;

  const vec3 lambda = vec3( 680E-9, 550E-9, 450E-9 );
  const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );

  const float v = 4.0;
  const vec3 K = vec3( 0.686, 0.678, 0.666 );
  const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );

  const float cutoffAngle = 1.6110731556870734;
  const float steepness = 1.5;
  const float EE = 1000.0;

  float sunIntensity( float zenithAngleCos ) {
    zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
    return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
  }

  vec3 totalMie( float T ) {
    float c = ( 0.2 * T ) * 10E-18;
    return 0.434 * c * MieConst;
  }

  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );

    vSunDirection = normalize( sunPosition );

    vSunE = sunIntensity( dot( vSunDirection, up ) );

    vSunfade = 1.0 - clamp( 1.0 - exp( ( sunPosition.y / 450000.0 ) ), 0.0, 1.0 );

    float rayleighCoefficient = rayleigh - ( 1.0 * ( 1.0 - vSunfade ) );

    vBetaR = totalRayleigh * rayleighCoefficient;

    vBetaM = totalMie( turbidity ) * mieCoefficient;
  }`;

// Fragment: Sky body verbatim; ONLY direction differs (uv equirect instead
// of vWorldPosition - cameraPosition) + SKY_SAT/SKY_SCALE inline + no
// tonemapping/colorspace includes (linear working data, like the dome
// pre-tonemap). The saturation block is IDENTICAL to the dome's (viewer.ts)
// so haze and probe see the same sky.
const CAPTURE_FRAG = (skySat: string, skyScale: string): string => /* glsl */ `
  varying vec2 vUv;
  varying vec3 vSunDirection;
  varying float vSunfade;
  varying vec3 vBetaR;
  varying vec3 vBetaM;
  varying float vSunE;

  uniform float mieDirectionalG;
  uniform vec3 up;

  const float pi = 3.141592653589793238462643383279502884197169;

  const float n = 1.0003;
  const float N = 2.545E25;

  const float rayleighZenithLength = 8.4E3;
  const float mieZenithLength = 1.25E3;
  const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

  const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
  const float ONE_OVER_FOURPI = 0.07957747154594767;

  float rayleighPhase( float cosTheta ) {
    return THREE_OVER_SIXTEENPI * ( 1.0 + pow( cosTheta, 2.0 ) );
  }

  float hgPhase( float cosTheta, float g ) {
    float g2 = pow( g, 2.0 );
    float inverse = 1.0 / pow( 1.0 - 2.0 * g * cosTheta + g2, 1.5 );
    return ONE_OVER_FOURPI * ( ( 1.0 - g2 ) * inverse );
  }

  void main() {
    // Equirect direction — the SAME convention height-fog.ts samples
    // uSkyMap with (u = atan(z,x)/2π + 0.5, v = y*0.5 + 0.5).
    float az = ( vUv.x - 0.5 ) * 6.2831853;
    float el = ( vUv.y - 0.5 ) * 3.1415927;
    vec3 direction = vec3( cos( el ) * cos( az ), sin( el ), cos( el ) * sin( az ) );

    float zenithAngle = acos( max( 0.0, dot( up, direction ) ) );
    float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
    float sR = rayleighZenithLength * inverse;
    float sM = mieZenithLength * inverse;

    vec3 Fex = exp( -( vBetaR * sR + vBetaM * sM ) );

    float cosTheta = dot( direction, vSunDirection );

    float rPhase = rayleighPhase( cosTheta * 0.5 + 0.5 );
    vec3 betaRTheta = vBetaR * rPhase;

    float mPhase = hgPhase( cosTheta, mieDirectionalG );
    vec3 betaMTheta = vBetaM * mPhase;

    vec3 Lin = pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * ( 1.0 - Fex ), vec3( 1.5 ) );
    Lin *= mix( vec3( 1.0 ), pow( vSunE * ( ( betaRTheta + betaMTheta ) / ( vBetaR + vBetaM ) ) * Fex, vec3( 1.0 / 2.0 ) ), clamp( pow( 1.0 - dot( up, vSunDirection ), 5.0 ), 0.0, 1.0 ) );

    float theta = acos( direction.y );
    float phi = atan( direction.z, direction.x );
    vec2 skuv = vec2( phi, theta ) / vec2( 2.0 * pi, pi ) + vec2( 0.5, 0.0 );
    vec3 L0 = vec3( 0.1 ) * Fex;

    float sundisk = smoothstep( sunAngularDiameterCos, sunAngularDiameterCos + 0.00002, cosTheta );
    L0 += ( vSunE * 19000.0 * Fex ) * sundisk;

    vec3 texColor = ( Lin + L0 ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );

    vec3 retColor = pow( texColor, vec3( 1.0 / ( 1.2 + ( 1.2 * vSunfade ) ) ) );

    // SAME dome dimming (SKY_SCALE) + saturation (SKY_SAT) so haze matches
    // drawn sky. Linear out: no tonemapping/colorspace includes — working
    // data, not display.
    float skyL = dot( retColor, vec3( 0.2126, 0.7152, 0.0722 ) );
    retColor = max( vec3( 0.0 ), mix( vec3( skyL ), retColor, ${skySat} ) );
    gl_FragColor = vec4( retColor * ${skyScale}, 1.0 );
  }`;

export function createSkyCapture(
  renderer: THREE.WebGLRenderer,
  /** Main-scene dome: ONLY its uniform objects are borrowed (by reference —
   * viewer writes stay live, zero copies). Geometry/material/scale/camera
   * of the dome are never touched. */
  skyDome: THREE.Mesh,
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
  // Own material: Preetham capture shader, uniform OBJECTS shared with the
  // dome (live by reference — turbidity/rayleigh/sunPosition edits in
  // applyLighting reach the capture with no copy step to forget).
  const domeU = (skyDome.material as THREE.ShaderMaterial).uniforms as Record<string, THREE.IUniform>;
  const capMat = new THREE.ShaderMaterial({
    uniforms: {
      sunPosition: domeU["sunPosition"],
      rayleigh: domeU["rayleigh"],
      turbidity: domeU["turbidity"],
      mieCoefficient: domeU["mieCoefficient"],
      mieDirectionalG: domeU["mieDirectionalG"],
      up: domeU["up"],
    },
    vertexShader: CAPTURE_VERT,
    fragmentShader: CAPTURE_FRAG((SKY_SAT as number).toFixed(2), (SKY_SCALE as number).toFixed(3)),
    depthTest: false,
    depthWrite: false,
  });
  // Own scene: clip-space quad only. Own camera: ortho (matrices unused —
  // the vertex writes clip pos directly — but a camera object is required
  // and it must NOT be the main one). Sun/hemi lights stay out.
  const skyScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), capMat);
  quad.frustumCulled = false;
  quad.renderOrder = -10;
  skyScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let lastElev = Infinity;
  let enabled = true;
  // §4b FASE 2 readback: persistent buffer (no per-frame alloc), read
  // through the renderer — never raw gl. Rows: y=30 zenith, y=16 horizon
  // (equirect: v=1 top), col x=32 (away from the sun seam).
  // The capture is LINEAR × SKY_SCALE without tonemapping (working data
  // for the fog). The gate compares what the USER sees (ACES + sRGB), so
  // the conversion below replicates EXACTLY three's ACESFilmicToneMapping
  // (tonemapping_pars_fragment: ACESInputMat/AP1 + RRTAndODTFit +
  // ACESOutputMat, exposure 1.0, /0.6) + linear→sRGB. Verified against the
  // three 0.170 source in node_modules — if three changes the fit, this
  // MUST change with it (grep RRTAndODTFit on upgrade).
  const zenBuf = new Uint8Array(64 * 32 * 4);
  const ACES_IN = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
  ];
  const ACES_OUT = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const rrtAndODTFit = (v: number): number => {
    const a = v * (v + 0.0245786) - 0.000090537;
    const b = v * (0.983729 * v + 0.432951) + 0.238081;
    return a / b;
  };
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  const aces = (c: [number, number, number]): [number, number, number] => {
    // exposure 1.0, /0.6 (three brighter-viewing-environment subjective scale)
    const e = [(c[0] / 0.6), (c[1] / 0.6), (c[2] / 0.6)];
    const ap1 = [
      ACES_IN[0][0] * (e[0] as number) + ACES_IN[0][1] * (e[1] as number) + ACES_IN[0][2] * (e[2] as number),
      ACES_IN[1][0] * (e[0] as number) + ACES_IN[1][1] * (e[1] as number) + ACES_IN[1][2] * (e[2] as number),
      ACES_IN[2][0] * (e[0] as number) + ACES_IN[2][1] * (e[1] as number) + ACES_IN[2][2] * (e[2] as number),
    ];
    const rrt = [rrtAndODTFit(ap1[0] as number), rrtAndODTFit(ap1[1] as number), rrtAndODTFit(ap1[2] as number)];
    return [
      clamp01(ACES_OUT[0][0] * (rrt[0] as number) + ACES_OUT[0][1] * (rrt[1] as number) + ACES_OUT[0][2] * (rrt[2] as number)),
      clamp01(ACES_OUT[1][0] * (rrt[0] as number) + ACES_OUT[1][1] * (rrt[1] as number) + ACES_OUT[1][2] * (rrt[2] as number)),
      clamp01(ACES_OUT[2][0] * (rrt[0] as number) + ACES_OUT[2][1] * (rrt[1] as number) + ACES_OUT[2][2] * (rrt[2] as number)),
    ];
  };
  const linToSrgb = (c: number): number =>
    c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  function readZenith(): {
    disp: { zen: [number, number, number]; hor: [number, number, number] };
    raw: { zen: [number, number, number]; hor: [number, number, number] };
  } {
    renderer.readRenderTargetPixels(rt, 0, 0, 64, 32, zenBuf);
    const raw = (x: number, y: number): [number, number, number] => {
      const o = (y * 64 + x) * 4;
      return [(zenBuf[o] as number) / 255, (zenBuf[o + 1] as number) / 255, (zenBuf[o + 2] as number) / 255];
    };
    const conv = (c: [number, number, number]): [number, number, number] => {
      const [r, g, b] = aces(c);
      return [linToSrgb(r), linToSrgb(g), linToSrgb(b)];
    };
    const zenRaw = raw(32, 30);
    const horRaw = raw(32, 16);
    return {
      disp: { zen: conv(zenRaw), hor: conv(horRaw) },
      raw: { zen: zenRaw, hor: horRaw },
    };
  }
  function doRefresh(): void {
    if (!enabled) return;
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt);
    renderer.render(skyScene, quadCam);
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
    texture() {
      return rt.texture;
    },
    dispose() {
      quad.geometry.dispose();
      capMat.dispose();
      rt.dispose();
      fogUniforms.uSkyMap.value = null;
      fogUniforms.uHasSkyMap.value = 0;
    },
  };
}
