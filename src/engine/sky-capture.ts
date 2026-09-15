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
import { SKY_EPS_DEG, SKY_SCALE } from "../narrative/choreography.ts";
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
  /** ?debug=skymap blit source (live texture, no copy). */
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
// of vWorldPosition - cameraPosition) + SKY_SCALE inline + no tonemapping
// /colorspace includes (linear working data, like the dome pre-tonemap).
const CAPTURE_FRAG = (skyScale: string): string => /* glsl */ `
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

    // SAME dome dimming (SKY_SCALE) so haze matches drawn sky. Linear out:
    // no tonemapping/colorspace includes — working data, not display.
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
    fragmentShader: CAPTURE_FRAG((SKY_SCALE as number).toFixed(3)),
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
