// make-cloud-atlas.ts — N2 (Everest-style): procedural cumulus atlas, reproducible.
// Atlas 1024×1024:
//   - 4 cúmulos de 512×256 en las filas 0-511 (2 por fila),
//   - 2 variantes de bruma de 512×160 en la fila 512-671 (para N2b; se generan ya).
// Receta EXACTA por cúmulo (seed, n, w=512, h=256, sx, cy, sy):
//     for k in 0..n:
//       ang = rnd·2π;  A = rnd^1,6
//       x = w/2 + cos(ang)·A·w·sx
//       y = h·cy − |sin(ang)|·A·h·sy·(0,4 + rnd·0,6)
//       rad = (6 + rnd·26)·(1,25 − A·0,6)
//       gradiente radial (x,y,rad): 0 → rgba(255,255,255,a),
//         0,6 → rgba(252,253,255,a·0,5), 1 → rgba(250,252,255,0),
//         con a = 0,17 + rnd·0,2
//     luego source-atop: degradado lineal vertical de rgba(255,255,255,0)
//     en y=0,28·h a rgba(138,155,182,0,6) en y=0,80·h.
// El lienzo se pinta en RGBA (acumulación "lighter"-like por suma de alfas);
// el shader usa el CANAL R como densidad y el alfa N2 llega SOLO por
// uniformes (textura × opacidad_base × amount × mult) — nunca por la textura.
// Aceptación: a ×2 no hay agujeros en el núcleo ni bordes duros.
// Standalone: `npx tsx scripts/make-cloud-atlas.ts` regenera
// public/assets/clouds-atlas.<hash>.webp + la copia PNG de auditoría,
// actualiza data/build/meta.json (+ copia pública).
// Library: 13-build-terrain-assets.ts importa buildCloudAtlas() para que
// `npm run data` reproduzca los mismos bytes.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export const ATLAS_SIZE = 1024;

/** N2: variantes de cúmulo (seed, n, sx, cy, sy) + bruma (seed, n, 512×160). */
export interface CumulusSpec {
  seed: number;
  n: number;
  sx: number;
  cy: number;
  sy: number;
}
export const CUMULUS_SPECS: CumulusSpec[] = [
  { seed: 5, n: 140, sx: 0.34, cy: 0.62, sy: 0.34 },
  { seed: 77, n: 140, sx: 0.34, cy: 0.62, sy: 0.34 },
  { seed: 133, n: 150, sx: 0.46, cy: 0.70, sy: 0.24 },
  { seed: 211, n: 120, sx: 0.24, cy: 0.56, sy: 0.46 },
];
export const HAZE_SPECS: CumulusSpec[] = [
  { seed: 23, n: 90, sx: 0.40, cy: 0.60, sy: 0.30 },
  { seed: 23 + 101, n: 90, sx: 0.40, cy: 0.60, sy: 0.30 },
];
/** Posición de cada variante en el atlas (px): 4 cúmulos 512×256 arriba,
 * 2 brumas 512×160 en la fila 512-671. */
export const ATLAS_SLOTS = [
  { x: 0, y: 0, w: 512, h: 256 },
  { x: 512, y: 0, w: 512, h: 256 },
  { x: 0, y: 256, w: 512, h: 256 },
  { x: 512, y: 256, w: 512, h: 256 },
  { x: 0, y: 512, w: 512, h: 160 },
  { x: 512, y: 512, w: 512, h: 160 },
];

function mulberry(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pinta UN cúmulo en el buffer RGBA (acumulación por suma de alfa). */
function paintCumulus(
  buf: Buffer,
  stride: number,
  ox: number,
  oy: number,
  spec: CumulusSpec,
): void {
  const w = ATLAS_SLOTS[0]?.w ?? 512;
  const h = spec.n > 100 && spec.sy === 0.3 ? 160 : w === 512 ? 256 : 160;
  const W = w;
  const H = ATLAS_SLOTS[ox === 0 && oy === 512 ? 4 : 0]?.w === 512 && oy === 512 ? 160 : h;
  void H;
  const ww = oy >= 512 ? 512 : 512;
  const hh = oy >= 512 ? 160 : 256;
  const rnd = mulberry(spec.seed);
  // capa de trabajo float por variante (alfa acumulado + color premultiplicado)
  const tile = new Float32Array(ww * hh * 4);
  for (let k = 0; k < spec.n; k++) {
    const ang = rnd() * Math.PI * 2;
    const A = Math.pow(rnd(), 1.6);
    const x = ww / 2 + Math.cos(ang) * A * ww * spec.sx;
    const y = hh * spec.cy - Math.abs(Math.sin(ang)) * A * hh * spec.sy * (0.4 + rnd() * 0.6);
    const rad = (6 + rnd() * 26) * (1.25 - A * 0.6);
    const a = 0.17 + rnd() * 0.2;
    const x0 = Math.max(0, Math.floor(x - rad));
    const x1 = Math.min(ww - 1, Math.ceil(x + rad));
    const y0 = Math.max(0, Math.floor(y - rad));
    const y1 = Math.min(hh - 1, Math.ceil(y + rad));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / rad;
        if (d >= 1) continue;
        // gradiente radial: 0 → a, 0,6 → a·0,5, 1 → 0 (curva suave)
        const t = d < 0.6 ? 1 - (d / 0.6) * 0.5 : 0.5 * (1 - (d - 0.6) / 0.4);
        const srcA = a * t;
        // color del anillo (casi blanco, levísima deriva fría al borde)
        const sr = 255 - d * 5;
        const sg = 255 - d * 2;
        const sb = 255;
        const i = (yy * ww + xx) * 4;
        const dstA = tile[i + 3] as number;
        const outA = srcA + dstA * (1 - srcA);
        if (outA > 1e-6) {
          tile[i] = (sr * srcA + (tile[i] as number) * dstA * (1 - srcA)) / outA;
          tile[i + 1] = (sg * srcA + (tile[i + 1] as number) * dstA * (1 - srcA)) / outA;
          tile[i + 2] = (sb * srcA + (tile[i + 2] as number) * dstA * (1 - srcA)) / outA;
        }
        tile[i + 3] = outA;
      }
    }
  }
  void W;
  // source-atop: degradado vertical transparente (y=0,28·h) → azul-gris
  // rgba(138,155,182,0,6) (y=0,80·h) que sombrea la panza. Solo donde hay alfa.
  for (let yy = 0; yy < hh; yy++) {
    const f = Math.min(1, Math.max(0, (yy / hh - 0.28) / (0.8 - 0.28)));
    const shadeA = 0.6 * f;
    const shR = 138;
    const shG = 155;
    const shB = 182;
    for (let xx = 0; xx < ww; xx++) {
      const i = (yy * ww + xx) * 4;
      const dstA = tile[i + 3] as number;
      if (dstA <= 0) continue;
      const outA = shadeA + dstA * (1 - shadeA);
      tile[i] = (shR * shadeA + (tile[i] as number) * dstA * (1 - shadeA)) / outA;
      tile[i + 1] = (shG * shadeA + (tile[i + 1] as number) * dstA * (1 - shadeA)) / outA;
      tile[i + 2] = (shB * shadeA + (tile[i + 2] as number) * dstA * (1 - shadeA)) / outA;
      tile[i + 3] = outA * 1; // conserva cobertura, tiñe el color
      // N2: el alfa de cobertura se conserva; el sombreado solo tiñe.
      // Recomponer: el alfa final = dstA (cobertura intacta).
      tile[i + 3] = dstA;
    }
  }
  // volcar al atlas (RGBA, fila superior = y 0)
  for (let yy = 0; yy < hh; yy++) {
    for (let xx = 0; xx < ww; xx++) {
      const i = (yy * ww + xx) * 4;
      const o = ((oy + yy) * stride + (ox + xx)) * 4;
      buf[o] = Math.round(Math.min(255, Math.max(0, tile[i] as number)));
      buf[o + 1] = Math.round(Math.min(255, Math.max(0, tile[i + 1] as number)));
      buf[o + 2] = Math.round(Math.min(255, Math.max(0, tile[i + 2] as number)));
      buf[o + 3] = Math.round(Math.min(255, Math.max(0, (tile[i + 3] as number) * 255)));
    }
  }
}

export async function buildCloudAtlas(): Promise<{ png: Buffer; webp: Buffer }> {
  const S = ATLAS_SIZE;
  const buf = Buffer.alloc(S * S * 4, 0);
  for (let v = 0; v < 4; v++) {
    const slot = ATLAS_SLOTS[v] as { x: number; y: number };
    const spec = CUMULUS_SPECS[v] as CumulusSpec;
    paintCumulus(buf, S, slot.x, slot.y, spec);
  }
  for (let v = 0; v < 2; v++) {
    const slot = ATLAS_SLOTS[4 + v] as { x: number; y: number };
    const spec = HAZE_SPECS[v] as CumulusSpec;
    paintCumulus(buf, S, slot.x, slot.y, spec);
  }
  const png = await sharp(buf, { raw: { width: S, height: S, channels: 4 } })
    .png()
    .toBuffer();
  const webp = await sharp(buf, { raw: { width: S, height: S, channels: 4 } })
    .webp({ quality: 95 })
    .toBuffer();
  return { png, webp };
}

/** Aceptación N2 sobre el webp CODIFICADO (lo que muestrea la GPU):
 * núcleo sólido (a ×2 sin agujeros) + sin bordes duros en ninguna variante.
 * - coreFill: fracción de texels de la MASA (alfa > 0,12) con alfa > 0,30
 *   (necesita ≥ 60 %: el cuerpo es denso, no velo con motas).
 * - coreHole: mayor componente conexa VACÍA (alfa ≤ 0,12) interior (necesita
 *   < 144 px²: sin agujeros visibles a ×2; las bahías que tocan el exterior
 *   son borde, no agujero).
 * - edgeStep: máximo salto de alfa entre texels adyacentes en el borde
 *   exterior del slot (necesita ≤ 0,25: sin bordes duros).
 * - bgClean: alfa medio fuera de toda variante (necesita ≤ 0,02). */
export interface AtlasAccept {
  coreFill: number;
  coreHole: number;
  edgeStep: number;
  bgClean: number;
}
export async function acceptAtlas(webp: Buffer): Promise<AtlasAccept> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const ch = info.channels;
  const hasAlpha = ch === 4;
  const at = (x: number, y: number): number => {
    const o = (y * W + x) * ch;
    if (hasAlpha) return (data[o + 3] as number) / 255;
    return (data[o] as number) / 255;
  };
  let massN = 0;
  let massFull = 0;
  let worstHole = 0;
  let edgeStep = 0;
  const slots = [
    ...ATLAS_SLOTS.slice(0, 4).map((s) => ({ ...s, kind: "c" })),
    ...ATLAS_SLOTS.slice(4, 6).map((s) => ({ ...s, kind: "h" })),
  ];
  for (const s of slots) {
    for (let yy = s.y; yy < s.y + s.h; yy += 1) {
      for (let xx = s.x; xx < s.x + s.w; xx += 1) {
        const v = at(xx, yy);
        if (v > 0.12) {
          massN++;
          if (v > 0.30) massFull++;
        }
        if (xx + 1 < s.x + s.w) {
          const dv = Math.abs(at(xx + 1, yy) - v);
          if (dv > edgeStep) edgeStep = dv;
        }
      }
    }
    // agujeros: componentes conexas VACÍAS (alfa ≤ 0,12) COMPLETAMENTE
    // rodeadas de masa dentro del span ocupado del slot — BFS sobre la
    // máscara vacía recortada al bbox ocupado con 8 px de margen. Una
    // bahía que toca el exterior no es agujero (es borde).
    const occX0 = s.x + 8;
    const occX1 = s.x + s.w - 8;
    const occY0 = s.y + Math.floor(s.h * 0.2);
    const occY1 = s.y + Math.floor(s.h * 0.85);
    const bw = occX1 - occX0;
    const bh = occY1 - occY0;
    const empty = new Uint8Array(bw * bh);
    for (let yy = 0; yy < bh; yy++) {
      for (let xx = 0; xx < bw; xx++) {
        empty[yy * bw + xx] = at(occX0 + xx, occY0 + yy) <= 0.12 ? 1 : 0;
      }
    }
    // flood-fill desde el borde: lo alcanzable es exterior
    const seen = new Uint8Array(bw * bh);
    const stack: number[] = [];
    for (let xx = 0; xx < bw; xx++) {
      if (empty[xx] === 1) stack.push(xx);
      const bi = (bh - 1) * bw + xx;
      if (empty[bi] === 1) stack.push(bi);
    }
    for (let yy = 0; yy < bh; yy++) {
      if (empty[yy * bw] === 1) stack.push(yy * bw);
      const bi = yy * bw + (bw - 1);
      if (empty[bi] === 1) stack.push(bi);
    }
    while (stack.length > 0) {
      const i = stack.pop() as number;
      if (seen[i] === 1 || empty[i] !== 1) continue;
      seen[i] = 1;
      const x = i % bw;
      const y = Math.floor(i / bw);
      if (x > 0) stack.push(i - 1);
      if (x + 1 < bw) stack.push(i + 1);
      if (y > 0) stack.push(i - bw);
      if (y + 1 < bh) stack.push(i + bh);
    }
    // lo vacío no alcanzado = agujero interior: mide su mayor extensión
    let hole = 0;
    const seenH = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) {
      if (empty[i] !== 1 || seen[i] === 1 || seenH[i] === 1) continue;
      let n = 0;
      const st: number[] = [i];
      while (st.length > 0) {
        const j = st.pop() as number;
        if (seenH[j] === 1 || seen[j] === 1 || empty[j] !== 1) continue;
        seenH[j] = 1;
        n++;
        const x = j % bw;
        const y = Math.floor(j / bw);
        if (x > 0) st.push(j - 1);
        if (x + 1 < bw) st.push(j + 1);
        if (y > 0) st.push(j - bw);
        if (y + 1 < bh) st.push(j + bh);
      }
      if (n > hole) hole = n;
    }
    // un agujero visible a ×2 ≈ mancha de ≥ 12×12 px casi vacía
    if (hole >= 144 && hole > worstHole) worstHole = hole;
  }
  // fondo: todo lo que no es slot debe estar vacío
  let bgSum = 0;
  let bgN = 0;
  const inSlot = (x: number, y: number): boolean =>
    slots.some((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
  for (let y = 0; y < 1024; y += 4) {
    for (let x = 0; x < 1024; x += 4) {
      if (inSlot(x, y)) continue;
      bgSum += at(x, y);
      bgN++;
    }
  }
  return {
    coreFill: massN > 0 ? massFull / massN : 0,
    coreHole: worstHole,
    edgeStep,
    bgClean: bgN > 0 ? bgSum / bgN : 0,
  };
}

/** Histogram helper for tuning (not a gate): deciles of alpha in slot 0. */
export async function crownHist(webp: Buffer): Promise<number[]> {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const ch = info.channels;
  const at = (x: number, y: number): number => {
    const o = (y * W + x) * ch;
    return ch === 4 ? ((data[o + 3] as number) as number) / 255 : ((data[o] as number) as number) / 255;
  };
  const hist = new Array(10).fill(0) as number[];
  const s = ATLAS_SLOTS[0] as { x: number; y: number; w: number; h: number };
  for (let y = s.y; y < s.y + s.h; y += 2) {
    for (let x = s.x; x < s.x + s.w; x += 2) {
      hist[Math.min(9, Math.floor(at(x, y) * 10))]++;
    }
  }
  return hist;
}

function isMainModule(urlSuffix: string): boolean {
  return process.argv[1] !== undefined && import.meta.url.endsWith(urlSuffix);
}
if (isMainModule("make-cloud-atlas.ts")) {
  const { png, webp } = await buildCloudAtlas();
  const { coreFill, coreHole, edgeStep, bgClean } = await acceptAtlas(webp);
  console.log(`acceptance: mass density (>0.30 | >0.12) = ${(coreFill * 100).toFixed(1)}% (need ≥ 60%)`);
  console.log(`acceptance: worst interior hole = ${coreHole}px² (need < 144)`);
  console.log(`acceptance: max neighbour alpha step = ${edgeStep.toFixed(3)} (need ≤ 0.25)`);
  console.log(`acceptance: background mean alpha = ${bgClean.toFixed(4)} (need ≤ 0.02)`);
  if (coreFill < 0.60 || coreHole >= 144 || edgeStep > 0.25 || bgClean > 0.02) {
    console.error("ATLAS REJECTED: holes or hard edges at ×2");
    process.exit(1);
  }
  const hash = createHash("sha256").update(webp).digest("hex").slice(0, 8);
  const webpName = `clouds-atlas.${hash}.webp`;
  const pngName = `clouds-atlas.${hash}.png`;
  for (const old of readdirSync("public/assets")) {
    if (old.startsWith("clouds-atlas.") && old !== webpName && old !== pngName) {
      rmSync(`public/assets/${old}`);
      console.log(`removed: public/assets/${old}`);
    }
  }
  writeFileSync(`public/assets/${webpName}`, webp);
  writeFileSync(`public/assets/${pngName}`, png);
  console.log(`saved: public/assets/${webpName} ${(webp.length / 1024).toFixed(1)} KB`);
  console.log(`saved: public/assets/${pngName} ${(png.length / 1024).toFixed(1)} KB (audit copy)`);
  for (const mf of ["data/build/meta.json", "public/assets/meta.json"]) {
    if (!existsSync(mf)) continue;
    const meta = JSON.parse(readFileSync(mf, "utf8")) as {
      assets: Record<string, string>;
      sizesBytes: Record<string, number>;
    };
    meta.assets["clouds-atlas"] = `assets/${webpName}`;
    meta.assets["clouds-atlas-png"] = `assets/${pngName}`;
    meta.sizesBytes["clouds-atlas"] = webp.length;
    meta.sizesBytes["clouds-atlas-png"] = png.length;
    writeFileSync(mf, JSON.stringify(meta, null, 2));
    console.log(`updated: ${mf}`);
  }
}
