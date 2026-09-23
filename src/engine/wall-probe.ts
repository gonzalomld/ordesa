// wall-probe.ts — §5d-bis INSTRUMENTO DE PARED (cero ajuste visual).
//
// Tras bandera ?debug=walls (modo 1: R=pendiente G=rockK B=b−r(ALBEDO,
// centrado 0,5)) o ?debug=walls2 (modo 2: R=pendiente G=b−r(final,
// centrado 0,5) B=luma(final)). Carga diferida desde viewer.ts:
// producción ni lo importa ni lo llama.
//
// Diseño:
// - uWallProbe es UNIFORME (0=off · 1 · 2), declarado en el GLSL de la pieza
//   (G40). Cambiarlo NO recompila: renderer.info.programs constante.
// - El fragment de la pieza asigna gLumaF/gBRF ANTES de la escritura de
//   sonda (niebla ya sumada, tonemapping+dithering todavía no) y escribe
//   las g* DESPUÉS de dithering (se salta tonemapping + colorspace: lo que
//   lee readPixels es el valor escrito).
// - render(): una pasada — frame limpio a negro (marcador R≥0,05), cielo,
//   nubes, haces, senda y etiquetas ocultos (visible=false), render, lectura
//   con readPixels del canvas, RESTAURADO después. Sin paso offscreen y sin
//   tocar estado GL (todo por el renderer: visible/render/readPixels-lectura).
// - readHist(mode): readPixels del buffer completo UNA vez bajo demanda
//   (los ~20 ms dan igual: no es producción), histogramas sobre píxeles de
//   terreno (R ≥ 0,04): slopeHist (18 cubos de 5°), slopeP50/P95, rockKbySlope,
//   rockKHist (10 cubos), brAbyS [modo 1: b−r del ALBEDO], brFbyS + lumaFbyS
//   [modo 2]. §5d-bis: cromaAbyS retirado (el cociente sobre albedo oscuro
//   se infla igual que infló G104 — dos veces).
// - §5d-bis (2/3): cada histograma publica uni = snapshot de los uniformes
//   LEÍDOS en el momento de la pasada (uWallProbe/uRockMix/uRockWeight/
//   uWallDeg/uHasRock) + programs (renderer.info.programs.length). La prueba
//   de que el modo llegó es uni.uWallProbe == mode, no una promesa.
// - AUTOCOMPROBACIÓN: roundTrip() fuerza el color plano 0,5 y devuelve los
//   tres canales leídos: deben ser 127 o 128 (188 = codificación sRGB por
//   medio → histogramas mal). No creerse ningún número hasta que cierre.
import * as THREE from "three";

export interface WallUniforms {
  uWallProbe: number;
  uRockMix: number;
  uRockWeight: number;
  uWallDeg: number;
  uHasRock: number;
  programs: number;
}

export interface WallHist {
  mode: 1 | 2;
  w: number;
  h: number;
  terrPx: number;
  roundTrip: [number, number, number];
  uni: WallUniforms;
  slopeHist: number[];
  slopeP50: number;
  slopeP95: number;
  rockKbySlope: (number | null)[];
  rockKHist: number[];
  brAbyS: (number | null)[];
  brFbyS: (number | null)[];
  lumaFbyS: (number | null)[];
}

interface Wire {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  sky: THREE.Object3D;
  lineGroup: THREE.Object3D;
  cloudsGroup: THREE.Object3D;
  beamsGroup: THREE.Object3D | null;
  labelLayer: HTMLElement;
  uWallProbe: { value: number };
  getLive: () => WallUniforms;
}

export function mountWallProbe(wire: Wire): {
  render: () => { roundTrip: [number, number, number] } | null;
  readHist: (mode: 1 | 2) => WallHist | null;
} {
  const { renderer, scene, camera, sky, lineGroup, cloudsGroup, beamsGroup, labelLayer, uWallProbe, getLive } = wire;
  const R_MARK = 0.04;

  function hideForProbe(): () => void {
    const vis = new Map<THREE.Object3D, boolean>();
    for (const o of [sky, lineGroup, cloudsGroup, beamsGroup]) {
      if (!o) continue;
      vis.set(o, o.visible);
      o.visible = false;
    }
    const prevDisplay = labelLayer.style.display;
    labelLayer.style.display = "none";
    return () => {
      for (const [o, v] of vis) o.visible = v;
      labelLayer.style.display = prevDisplay;
    };
  }

  // Una pasada de sonda: clear negro + render con uWallProbe=subido +
  // lectura del canvas completo con readPixels crudo (lectura permitida).
  // Devuelve buffer + snapshot de uniformes LEÍDOS tras la pasada.
  function renderProbe(mode: 1 | 2): { buf: Uint8Array; uni: WallUniforms } | null {
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    if (w < 1 || h < 1) return null;
    const restore = hideForProbe();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevU = uWallProbe.value;
    try {
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, true, false);
      uWallProbe.value = mode;
      renderer.render(scene, camera);
      const uni = { ...getLive(), uWallProbe: uWallProbe.value };
      return { buf: readCanvas(w, h), uni };
    } finally {
      uWallProbe.value = prevU;
      renderer.setClearColor(prevClear, prevAlpha);
      restore();
    }
  }

  function readCanvas(w: number, h: number): Uint8Array {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  return {
    render(): { roundTrip: [number, number, number] } | null {
      // Alias del round-trip plano (misma cadena de lectura que los
      // histogramas): 127/128 cierra, 188 = sRGB por medio (mal).
      return { roundTrip: flatRoundTrip() };
    },
    readHist(mode: 1 | 2): WallHist | null {
      const probe = renderProbe(mode);
      if (!probe) return null;
      const { buf, uni } = probe;
      const w = renderer.domElement.width;
      const h = renderer.domElement.height;
      const slopeHist = new Array<number>(18).fill(0);
      const rockKAcc: { sum: number; n: number }[] = Array.from({ length: 18 }, () => ({ sum: 0, n: 0 }));
      const rockKHist = new Array<number>(10).fill(0);
      const brAAcc: { sum: number; n: number }[] = Array.from({ length: 18 }, () => ({ sum: 0, n: 0 }));
      const brAcc: { sum: number; n: number }[] = Array.from({ length: 18 }, () => ({ sum: 0, n: 0 }));
      const lumaAcc: { sum: number; n: number }[] = Array.from({ length: 18 }, () => ({ sum: 0, n: 0 }));
      const slopes: number[] = [];
      let terrPx = 0;
      for (let i = 0; i < w * h; i++) {
        const rr = (buf[i * 4] as number) / 255;
        if (rr < R_MARK) continue; // no es terreno (cielo/nubes = negro)
        const gg = (buf[i * 4 + 1] as number) / 255;
        const bb = (buf[i * 4 + 2] as number) / 255;
        const slope = Math.min(90, Math.max(0, ((rr - 0.05) / 0.9) * 90));
        const bin = Math.min(17, Math.floor(slope / 5));
        (slopeHist[bin] as number)++;
        slopes.push(slope);
        terrPx++;
        if (mode === 1) {
          (rockKAcc[bin] as { sum: number; n: number }).sum += gg;
          ((rockKAcc[bin] as { sum: number; n: number }).n)++;
          const rk = Math.min(9, Math.floor(Math.min(1, Math.max(0, gg)) * 10));
          (rockKHist[rk] as number)++;
          // §5d-bis: B = b−r del ALBEDO (centrado 0,5), NO el cociente.
          const brA = bb * 2 - 1;
          (brAAcc[bin] as { sum: number; n: number }).sum += brA;
          ((brAAcc[bin] as { sum: number; n: number }).n)++;
        } else {
          const br = gg * 2 - 1; // G centrado en 0,5 (rango −1..1)
          (brAcc[bin] as { sum: number; n: number }).sum += br;
          ((brAcc[bin] as { sum: number; n: number }).n)++;
          (lumaAcc[bin] as { sum: number; n: number }).sum += bb;
          ((lumaAcc[bin] as { sum: number; n: number }).n)++;
        }
      }
      slopes.sort((a, b) => a - b);
      const pct = (q: number): number => (slopes.length > 0 ? (slopes[Math.min(slopes.length - 1, Math.floor(q * slopes.length))] as number) : -1);
      const mean = (a: { sum: number; n: number }): number | null => (a.n > 0 ? a.sum / a.n : null);
      return {
        mode,
        w,
        h,
        terrPx,
        roundTrip: flatRoundTrip(),
        uni,
        slopeHist: slopeHist.map((c) => (terrPx > 0 ? c / terrPx : 0)),
        slopeP50: pct(0.5),
        slopeP95: pct(0.95),
        rockKbySlope: rockKAcc.map(mean),
        rockKHist: rockKHist.map((c) => (terrPx > 0 ? c / terrPx : 0)),
        brAbyS: brAAcc.map(mean),
        brFbyS: brAcc.map(mean),
        lumaFbyS: lumaAcc.map(mean),
      };
    },
  };

  // AUTOCOMPROBACIÓN OBLIGATORIA: un quad propio a 0,5 plano leído con el
  // mismo readPixels — 127/128 cierra, 188 = sRGB por medio (mal).
  function flatRoundTrip(): [number, number, number] {
    const rt = new THREE.WebGLRenderTarget(8, 8);
    const flat = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) });
    mat.toneMapped = false;
    flat.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(flat, cam);
    const px = new Uint8Array(4 * 8 * 8);
    renderer.readRenderTargetPixels(rt, 0, 0, 8, 8, px);
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTone;
    rt.dispose();
    mat.dispose();
    return [(px[0] as number), (px[1] as number), (px[2] as number)];
  }
}
