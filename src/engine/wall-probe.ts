// wall-probe.ts — §5d-ter INSTRUMENTO DE PARED (cero ajuste visual).
//
// Tras bandera ?debug=walls (modo 1: R=pendiente G=rockK B=b−r(ALBEDO,
// centrado 0,5)), ?debug=walls2 (modo 2: R=pendiente G=b−r(final,
// centrado 0,5) B=luma(final, sRGB — ver (4) abajo)) o modo 3 directo
// (round-trip por el CAMINO REAL). Carga diferida desde viewer.ts:
// producción ni lo importa ni lo llama.
//
// Diseño:
// - uWallProbe es UNIFORME (0=off · 1 · 2 · 3), declarado en el GLSL de la
//   pieza (G40). Cambiarlo NO recompila: renderer.info.programs constante.
// - El fragment de la pieza asigna gLumaF/gBRF ANTES de la escritura de
//   sonda y escribe las g* DESPUÉS de dithering (se salta tonemapping +
//   colorspace — ver (4): en three r170 colorspace_fragment ANTES de fog
//   es sRGB; el canvas guarda CRUDO y la sonda lee CRUDO).
// - render(): una pasada — frame limpio a negro (marcador R≥0,05), cielo,
//   nubes, haces, senda y etiquetas ocultos (visible=false), render, lectura
//   con readPixels del canvas, RESTAURADO después. Sin paso offscreen y sin
//   tocar estado GL (todo por el renderer: visible/render/readPixels-lectura).
// - readHist(mode): readPixels del buffer completo UNA vez bajo demanda
//   (los ~20 ms dan igual: no es producción), histogramas sobre píxeles de
//   terreno (R ≥ 0,04): slopeHist (18 cubos de 5°), slopeP50/P95, rockKbySlope,
//   rockKHist (10 cubos), brAbyS [modo 1: b−r del ALBEDO], brFbyS_srgb +
//   lumaFbyS_srgb [modo 2]. §5d-bis: cromaAbyS retirado (el cociente sobre
//   albedo oscuro se infla igual que infló G104 — dos veces).
// - §5d-bis (2/3): cada histograma publica uni = snapshot de los uniformes
//   LEÍDOS en el momento de la pasada (uWallProbe/uRockMix/uRockWeight/
//   uWallDeg/uHasRock) + programs (renderer.info.programs.length). La prueba
//   de que el modo llegó es uni.uWallProbe == mode, no una promesa.
// - §5d-ter (1) MODO 3: round-trip por el CAMINO REAL — en el MISMO sitio
//   del shader del terreno donde escribe la sonda, con uWallProbe = 3 y el
//   mismo readPixels que usa readHist. Publica los tres bytes.
//     [128, 64, 191] ± 1  → el canvas guarda en CRUDO. Los histogramas se
//       interpretan tal cual.
//     [188, 137, 224] ± 2 → el canvas CODIFICA a sRGB. Entonces TODOS los
//       histogramas de §5d están mal leídos y hay que linealizar cada canal
//       antes de binarlo: v = ((c/255 + 0.055)/1.055)^2.4.
//     otra cosa → parar y reportar, no interpretar nada.
//   Tres valores distintos a propósito: un solo 0,5 no distingue una
//   codificación de un escalado.
// - §5d-ter (4) ESPACIO DE COLOR — DECISIÓN ESCRITA:
//   gBRF/gLumaF se capturan en el chunk final ANTES de la escritura de
//   sonda, es decir DESPUÉS de tonemapping_fragment + colorspace_fragment
//   (en el meshphysical de three r170 el orden es opaque → tonemapping →
//   colorspace → fog → dithering; la niebla de height-fog se inyecta en
//   fog_fragment, que va DESPUÉS de colorspace) y DESPUÉS de la niebla
//   (height-fog los escribe en fog_fragment: color iluminado + niebla +
//   sombras de nube ya sumados). Por tanto gBRF/gLumaF SON sRGB DE PANTALLA
//   (post-tonemapping ACES, post-colorspace sRGB): la pregunta "¿se ve
//   azul?" se responde en pantalla, como pide el brief. Los campos se
//   llaman brFbyS_srgb / lumaFbyS_srgb para que nadie los compare con
//   lineal. El modo 3 decide si hay que sumarle una codificación extra
//   del canvas (caso CRUDO: no; caso sRGB: tampoco — ya vienen codificados
//   del propio shader).
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
  mode: 1 | 2 | 3;
  w: number;
  h: number;
  terrPx: number;
  /** §5d-ter (1): tres bytes del modo 3 por el CAMINO REAL ([R,G,B]).
   * En modos 1/2 es el veredicto ya clasificado (raw|srgb|unknown). */
  roundTrip: [number, number, number];
  /** Clasificación del modo 3: raw | srgb | unknown. */
  roundTripVerdict: "raw" | "srgb" | "unknown";
  uni: WallUniforms;
  slopeHist: number[];
  slopeP50: number;
  slopeP95: number;
  rockKbySlope: (number | null)[];
  rockKHist: number[];
  brAbyS: (number | null)[];
  /** §5d-ter (4): sRGB DE PANTALLA (post-ACES, post-colorspace) — el sufijo
   * lo deja escrito para que nadie los compare con lineal. */
  brFbyS_srgb: (number | null)[];
  lumaFbyS_srgb: (number | null)[];
  /** Retrocompat: alias de los _srgb (se retiran en la próxima fase). */
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
  render: () => { roundTrip: [number, number, number]; roundTripVerdict: "raw" | "srgb" | "unknown" } | null;
  readHist: (mode: 1 | 2 | 3) => WallHist | null;
  /** §5d-ter (diagnóstico): ¿el código de sonda está en el programa
   * COMPILADO? Todo lecturas GL (getAttachedShaders/getShaderSource — leer
   * no escribe estado, como getError/readPixels). Informa, no gobierna. */
  probeGLSL: () => { name: string; srcLen: number; marks: Record<string, boolean> }[];
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
  function renderProbe(mode: 1 | 2 | 3): { buf: Uint8Array; uni: WallUniforms } | null {
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

  // §5d-ter (1): clasifica los tres bytes del modo 3 según el brief.
  // NOTA: dithering_fragment (#include <dithering_fragment>) va DESPUÉS de
  // la escritura de sonda en el chunk: el dither añade ruido ±0,5/255, de
  // ahí la tolerancia ±1 (no ±0). Un veredicto "unknown" con bytes cerca
  // de [128,64,191] pero fuera de tolerancia seguiría siendo crudo con
  // dither fuerte: mirar los bytes antes de decidir.
  function classifyRoundTrip(px: [number, number, number]): "raw" | "srgb" | "unknown" {
    const [r, g, b] = px;
    const near = (v: number, t: number, tol: number): boolean => Math.abs(v - t) <= tol;
    if (near(r, 128, 1) && near(g, 64, 1) && near(b, 191, 1)) return "raw";
    if (near(r, 188, 2) && near(g, 137, 2) && near(b, 224, 2)) return "srgb";
    return "unknown";
  }

  // §5d-ter (1): MODO 3 por el CAMINO REAL — escena real al canvas con
  // uWallProbe = 3 + el mismo readPixels que usa readHist. Mediana del
  // píxel central 8×8 (robusto a un píxel suelto) + veredicto.
  function mode3RoundTrip(): { roundTrip: [number, number, number]; roundTripVerdict: "raw" | "srgb" | "unknown" } | null {
    const probe = renderProbe(3);
    if (!probe) return null;
    const { buf, uni } = probe;
    void uni;
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let y = cy - 4; y < cy + 4; y++) {
      for (let x = cx - 4; x < cx + 4; x++) {
        const o = (y * w + x) * 4;
        rs.push(buf[o] as number);
        gs.push(buf[o + 1] as number);
        bs.push(buf[o + 2] as number);
      }
    }
    rs.sort((a, b) => a - b);
    gs.sort((a, b) => a - b);
    bs.sort((a, b) => a - b);
    const med = (a: number[]): number => a[Math.floor(a.length / 2)] as number;
    const px: [number, number, number] = [med(rs), med(gs), med(bs)];
    return { roundTrip: px, roundTripVerdict: classifyRoundTrip(px) };
  }

  // §5d-ter (diagnóstico): vuelca el fragment COMPILADO de cada programa.
  // Marcas por etapa: decl (uniform declarado) · pre (writes ANTES del
  // if: gLumaF=, gBRF=) · m1/m2/m3 (vec4 de cada rama) · steep (línea steep
  // intacta: prueba de que el parche NO truncó el chunk). Todo son LECTURAS
  // GL. Informa, no gobierna.
  function probeGLSL(): { name: string; srcLen: number; marks: Record<string, boolean> }[] {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const out: { name: string; srcLen: number; marks: Record<string, boolean> }[] = [];
    const progs = renderer.info.programs as { name?: string; program?: unknown }[];
    for (const p of progs) {
      const prog = p.program;
      if (!(prog instanceof WebGLProgram)) {
        out.push({ name: p.name ?? "shader", srcLen: -1, marks: {} });
        continue;
      }
      const shaders = gl.getAttachedShaders(prog) ?? [];
      let frag = "";
      for (const s of shaders) {
        const type = gl.getShaderParameter(s, gl.SHADER_TYPE);
        if (type === gl.FRAGMENT_SHADER) frag += gl.getShaderSource(s) ?? "";
      }
      out.push({
        name: p.name ?? "shader",
        srcLen: frag.length,
        marks: {
          decl: frag.includes("uniform float uWallProbe"),
          pre: frag.includes("gLumaF = gluma(gl_FragColor.rgb)"),
          m1: frag.includes("clamp(grockMix, 0.0, 1.0), clamp(gBR * 0.5 + 0.5"),
          m2: frag.includes("clamp(gBRF * 0.5 + 0.5"),
          m3: frag.includes("vec4(0.5, 0.25, 0.75, 1.0)"),
          steep: frag.includes("clamp(grain + 0.5, 0.0, 1.0)"),
        },
      });
    }
    return out;
  }

  return {
    render(): { roundTrip: [number, number, number]; roundTripVerdict: "raw" | "srgb" | "unknown" } | null {
      // §5d-ter: el round-trip falso (quad propio 0,5 a un RT) está BORRADO:
      // no medía el camino real (canvas + sonda del terreno). Ahora es el
      // MODO 3 por el camino real.
      return mode3RoundTrip();
    },
    readHist(mode: 1 | 2 | 3): WallHist | null {
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
      // §5d-ter (1): el veredicto se publica en TODAS las pasadas (en modo
      // 3 es la medida; en 1/2, el recordatorio de cómo interpretarlas).
      const rt3 = mode3RoundTrip();
      const brSrgb = brAcc.map(mean);
      const lumaSrgb = lumaAcc.map(mean);
      return {
        mode,
        w,
        h,
        terrPx,
        roundTrip: rt3?.roundTrip ?? [0, 0, 0],
        roundTripVerdict: rt3?.roundTripVerdict ?? "unknown",
        uni,
        slopeHist: slopeHist.map((c) => (terrPx > 0 ? c / terrPx : 0)),
        slopeP50: pct(0.5),
        slopeP95: pct(0.95),
        rockKbySlope: rockKAcc.map(mean),
        rockKHist: rockKHist.map((c) => (terrPx > 0 ? c / terrPx : 0)),
        brAbyS: brAAcc.map(mean),
        brFbyS_srgb: brSrgb,
        lumaFbyS_srgb: lumaSrgb,
        brFbyS: brSrgb,
        lumaFbyS: lumaSrgb,
      };
    },
    probeGLSL,
  };
}
