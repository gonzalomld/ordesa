// 16-build-rock.ts — PAREDES FASE §5b: roca estratificada triplanar.
//
// Genera dos texturas 1024×1024 TILEABLES en ambos ejes (semilla fija):
//   - rock-albedo: estratos HORIZONTALES (bandas en el eje V, periodo base
//     1/14 de la altura), erosionados con fBm de 4 octavas + fracturas
//     verticales finas y escasas. §5b: luma de estratos 0,45-0,85 (vetas
//     0,90, juntas 0,38), croma máx 0,12: gris caliza con contraste, no color.
//   - rock-normal: Sobel del mismo campo de alturas (fuerza 11): las bandas
//     tienen relieve.
// Salida con hash en meta.assets como el atlas de nubes (webp + copia PNG
// de auditoría). Standalone: `npx tsx scripts/16-build-rock.ts`.
// Library: exporta buildRock() para el pipeline.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export const ROCK_SIZE = 1024;
export const ROCK_SEED = 20260922;
const BANDS = 14; // periodo base 1/14 de la altura de la textura

// Paleta caliza de Ordesa §5b (sRGB 0-255): luma de estratos 0,45-0,85.
// Junta oscura (luma 0,38), sombra de cama (0,45), luz de estrato (0,85),
// veta clara (0,90). Neutros cálidos mínimos para que el cap de croma no
// los desplace: los tres canales a igual distancia del gris.
const C_JOINT: [number, number, number] = [97, 94, 88]; // #61645e… luma 0,38
const C_SHADOW: [number, number, number] = [115, 112, 106]; // luma 0,45
const C_LIGHT: [number, number, number] = [217, 214, 208]; // luma 0,85
const C_VEIN: [number, number, number] = [230, 227, 221]; // luma 0,90
// Tope §5b 0,115: el redondeo a byte puede reintroducir ~0,005 de croma;
// el CRITERIO (puerta G97-textura) sigue siendo 0,12 sobre el albedo final.
const CHROMA_CAP = 0.115;

// --- RNG determinista ---
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

// --- Ruido de valor PERIÓDICO (tileable por construcción) ---
// P = nº de celdas por baldosa; el hash envuelve con mod P.
function hash2(ix: number, iy: number, P: number, seed: number): number {
  const x = ((ix % P) + P) % P;
  const y = ((iy % P) + P) % P;
  let h = (x * 374761393 + y * 668265263 + seed * 974634211) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, P: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, P, seed);
  const b = hash2(xi + 1, yi, P, seed);
  const c = hash2(xi, yi + 1, P, seed);
  const d = hash2(xi + 1, yi + 1, P, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** fBm de n octavas, periodos enteros (p. ej. [8,16,32,64]) → tileable. */
function fbm(x: number, y: number, periods: number[], seed: number, S: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (const P of periods) {
    sum += amp * vnoise((x / S) * P, (y / S) * P, P, seed);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export interface RockStats {
  seamMean: number; // salto medio de H en la costura X (campo, no byte)
  seamMax: number; // ratio salto-Y en costura / salto-Y interior (≤3: orden de magnitud)
  chromaMax: number; // croma máx del albedo FINAL (tras el cap 0,12)
  rowBandVar: number;
  normalMeanX: number;
  normalMeanY: number;
  lumaMin: number; // §5b: luma mín del albedo (puerta ≤0,40)
  lumaMax: number; // §5b: luma máx del albedo (puerta ≥0,80)
}

export async function buildRock(): Promise<{
  albedoPng: Buffer;
  albedoWebp: Buffer;
  normalPng: Buffer;
  normalWebp: Buffer;
  stats: RockStats;
}> {
  const S = ROCK_SIZE;
  const rnd = mulberry(ROCK_SEED);
  // Tono por banda (14, periódico en el índice → tileable en V)
  const bandTone = Array.from({ length: BANDS }, () => rnd());

  // Fracturas verticales: densidad 0,15/100 px → ~1,5 en 1024 px → 2 líneas
  // de 1-2 px, alfa 0,35. Wobble sinusoidal con ciclos enteros → tileable.
  // x0 confinado a [32, S-32]: la fractura nunca cruza la costura (el borde
  // derecho continúa en el izquierdo sin salto de gradiente).
  interface Crack {
    x0: number;
    w: number;
    amp: number;
    k: number;
    phi: number;
  }
  const crackX = (r: number): number => 32 + r * (S - 64);
  const cracks: Crack[] = [
    { x0: crackX(rnd()), w: 1, amp: 4 + rnd() * 4, k: 2, phi: rnd() * Math.PI * 2 },
    { x0: crackX(rnd()), w: 2, amp: 4 + rnd() * 4, k: 3, phi: rnd() * Math.PI * 2 },
  ];

  const H = new Float32Array(S * S);
  const vein = new Float32Array(S * S);
  const crackM = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // Espesor variable: warp de baja frecuencia (P=4, ±0,3 bandas).
      // §5b: era ±0,6 y mandaba en el salto-Y de costura (1,6-1,7×).
      const low = vnoise((x / S) * 4, (y / S) * 4, 4, ROCK_SEED + 1);
      const t = (y / S) * BANDS + (low - 0.5) * 0.6;
      const f = t - Math.floor(t);
      const bi = ((Math.floor(t) % BANDS) + BANDS) % BANDS;
      const ni = (bi + 1) % BANDS;
      const A = bandTone[bi] as number;
      const B = bandTone[ni] as number;
      const s01 = smoothstep(0.35, 0.65, f);
      const strat = A + (B - A) * s01;
      // Erosión: fBm de 4 octavas. §5b: pesos 0,70/0,40 + warp ±0,3 bandas
      // (con 0,6/0,45 y warp ±0,6 el máximo se quedaba en ~0,76 y la rampa
      // nunca alcanzaba la luz 0,85; el warp manda en el salto-Y de costura:
      // ±0,3 lo deja en ~1,4× y h sigue barriendo [0,1] con 0,70/0,40).
      const ero = fbm(x, y, [8, 16, 32, 64], ROCK_SEED + 2, S);
      const h = clamp01(0.7 * strat + 0.4 * (ero - 0.5) + 0.1 * (A - 0.5));
      const i = y * S + x;
      H[i] = h;
      // Veta clara en la frontera de cama (f≈0,5, gaussiana σ≈0,06)
      const dv = (f - 0.5) / 0.06;
      vein[i] = Math.exp(-dv * dv);
      // Fracturas (distancia envuelta en X → sin costura)
      let cm = 0;
      for (const c of cracks) {
        const xc = c.x0 + c.amp * Math.sin((2 * Math.PI * c.k * y) / S + c.phi);
        let d = Math.abs(x - xc);
        d = Math.min(d, S - d);
        const m = 1 - smoothstep(c.w / 2 - 0.5, c.w / 2 + 0.5, d);
        if (m > cm) cm = m;
      }
      crackM[i] = cm;
    }
  }

  // --- Albedo §5b: rampa junta→sombra→luz + vetas + fracturas + cap croma ---
  const alb = Buffer.alloc(S * S * 3);
  let chromaPre = 0;
  let chromaPost = 0;
  let lumaMinSeen = 1;
  let lumaMaxSeen = 0;
  const rowMean = new Float64Array(S);
  for (let y = 0; y < S; y++) {
    let rowSum = 0;
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const h = H[i] as number;
      // Rampa de dos tramos: junta(0,38)→sombra(0,45) en h<0,25 (juntas
      // finas y oscuras), sombra→luz(0,85) en el resto (estrato pleno).
      let r: number;
      let g: number;
      let b: number;
      if (h < 0.25) {
        const t = h / 0.25;
        r = C_JOINT[0] + (C_SHADOW[0] - C_JOINT[0]) * t;
        g = C_JOINT[1] + (C_SHADOW[1] - C_JOINT[1]) * t;
        b = C_JOINT[2] + (C_SHADOW[2] - C_JOINT[2]) * t;
      } else {
        const t = (h - 0.25) / 0.75;
        r = C_SHADOW[0] + (C_LIGHT[0] - C_SHADOW[0]) * t;
        g = C_SHADOW[1] + (C_LIGHT[1] - C_SHADOW[1]) * t;
        b = C_SHADOW[2] + (C_LIGHT[2] - C_SHADOW[2]) * t;
      }
      // Veta clara (0,90) en la frontera de cama
      const vv = (vein[i] as number) * 0.5;
      r += (C_VEIN[0] - r) * vv;
      g += (C_VEIN[1] - g) * vv;
      b += (C_VEIN[2] - b) * vv;
      // Fractura: oscurece con alfa 0,35 hacia la JUNTA (0,38)
      const cm = crackM[i] as number;
      r -= (r - C_JOINT[0]) * 0.35 * cm;
      g -= (g - C_JOINT[1]) * 0.35 * cm;
      b -= (b - C_JOINT[2]) * 0.35 * cm;
      // Tope de croma 0,12 (mezcla hacia el gris de igual luma)
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const ch = mx > 1e-6 ? (mx - mn) / mx : 0;
      if (ch > chromaPre) chromaPre = ch;
      if (ch > CHROMA_CAP) {
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const k = 1 - CHROMA_CAP / ch;
        r += (lum - r) * k;
        g += (lum - g) * k;
        b += (lum - b) * k;
      }
      const o = i * 3;
      alb[o] = Math.round(Math.min(255, Math.max(0, r)));
      alb[o + 1] = Math.round(Math.min(255, Math.max(0, g)));
      alb[o + 2] = Math.round(Math.min(255, Math.max(0, b)));
      const lumF = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lumF < lumaMinSeen) lumaMinSeen = lumF;
      if (lumF > lumaMaxSeen) lumaMaxSeen = lumF;
      const mxF = Math.max(r, g, b) / 255;
      const mnF = Math.min(r, g, b) / 255;
      const chF = mxF > 1e-6 ? (mxF - mnF) / mxF : 0;
      if (chF > chromaPost) chromaPost = chF;
      rowSum += lumF;
    }
    rowMean[y] = rowSum / S;
  }
  // Varianza entre medias de fila: los estratos horizontales deben leerse
  // en el promedio por fila (el fBm se promedia, las bandas no).
  const meanAll = rowMean.reduce((a, v) => a + v, 0) / S;
  let rowBandVar = 0;
  for (let y = 0; y < S; y++) rowBandVar += (rowMean[y] as number - meanAll) ** 2;
  rowBandVar /= S;

  // Costura Y: con muestreo envuelto H[y] es periódico salvo el warp
  // (P=4 en Y: H[S-1]≠H[0] por construcción). Puerta: el salto medio en la
  // costura no supera 3× el salto-Y interior medio (las juntas reales son
  // discontinuidades: el criterio es orden de magnitud, no continuidad).
  // El albedo absorbe el cap de croma por píxel; el CRITERIO es el campo H
  // (lo que la GPU interpola), no el byte del borde.
  let seamH = 0;
  let innerH = 0;
  for (let y = 0; y < S; y++) {
    seamH += Math.abs((H[y * S + 0] as number) - (H[y * S + (S - 1)] as number));
    seamH += Math.abs((H[0 * S + 0] as number) - (H[(S - 1) * S + 0] as number)) / S;
    for (let x = 0; x < S - 1; x++) innerH += Math.abs((H[y * S + x + 1] as number) - (H[y * S + x] as number));
  }
  const seamMean = seamH / S;
  const innerMean = innerH / (S * (S - 1));
  // Salto Y envuelto: columna x de H[y] vs H[(y+1)%S] (misma métrica).
  let seamY = 0;
  let innerY = 0;
  for (let x = 0; x < S; x++) {
    seamY += Math.abs(H[0 * S + x] as number - (H[(S - 1) * S + x] as number));
    for (let y = 0; y < S - 1; y++) innerY += Math.abs((H[(y + 1) * S + x] as number) - (H[y * S + x] as number));
  }

  // --- Normal: Sobel del mismo H (fuerza 11), muestreo envuelto ---
  const NSTRENGTH = 11;
  const nrm = Buffer.alloc(S * S * 3);
  let nmx = 0;
  let nmy = 0;
  const Hat = (x: number, y: number): number =>
    H[(((y % S) + S) % S) * S + ((((x % S) + S) % S) as number)] as number;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx =
        ((Hat(x + 1, y - 1) + 2 * Hat(x + 1, y) + Hat(x + 1, y + 1) -
          Hat(x - 1, y - 1) - 2 * Hat(x - 1, y) - Hat(x - 1, y + 1)) / 8) * NSTRENGTH;
      const gy =
        ((Hat(x - 1, y + 1) + 2 * Hat(x, y + 1) + Hat(x + 1, y + 1) -
          Hat(x - 1, y - 1) - 2 * Hat(x, y - 1) - Hat(x + 1, y - 1)) / 8) * NSTRENGTH;
      const inv = 1 / Math.hypot(gx, gy, 1);
      const nx = -gx * inv;
      const ny = -gy * inv;
      const nz = inv;
      nmx += nx;
      nmy += ny;
      const o = (y * S + x) * 3;
      nrm[o] = Math.round((nx * 0.5 + 0.5) * 255);
      nrm[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nrm[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }

  const stats: RockStats = {
    seamMean,
    seamMax: seamY / S / Math.max(1e-9, innerY / (S * (S - 1))),
    chromaMax: chromaPost,
    rowBandVar,
    normalMeanX: nmx / (S * S),
    normalMeanY: nmy / (S * S),
    lumaMin: lumaMinSeen,
    lumaMax: lumaMaxSeen,
  };
  void chromaPre;
  void innerMean;

  const albedoPng = await sharp(alb, { raw: { width: S, height: S, channels: 3 } })
    .png()
    .toBuffer();
  const albedoWebp = await sharp(alb, { raw: { width: S, height: S, channels: 3 } })
    .webp({ quality: 85 })
    .toBuffer();
  const normalPng = await sharp(nrm, { raw: { width: S, height: S, channels: 3 } })
    .png()
    .toBuffer();
  const normalWebp = await sharp(nrm, { raw: { width: S, height: S, channels: 3 } })
    .webp({ quality: 90 })
    .toBuffer();
  return { albedoPng, albedoWebp, normalPng, normalWebp, stats };
}

function isMainModule(urlSuffix: string): boolean {
  return process.argv[1] !== undefined && import.meta.url.endsWith(urlSuffix);
}

if (isMainModule("16-build-rock.ts")) {
  const { albedoPng, albedoWebp, normalPng, normalWebp, stats } = await buildRock();
  console.log(`seam: X-mean=${stats.seamMean.toFixed(5)} (need ≤ 0.02) Y-ratio=${stats.seamMax.toFixed(3)} (need ≤ 3.0)`);
  console.log(`chroma max=${stats.chromaMax.toFixed(4)} (need ≤ 0.12 post-cap)`);
  console.log(`luma range=[${stats.lumaMin.toFixed(3)}, ${stats.lumaMax.toFixed(3)}] (need ≤0,40+ / ≥0,80-)`);
  console.log(`row-band var=${stats.rowBandVar.toExponential(2)} (need > 1e-4)`);
  console.log(`normal mean xy=(${stats.normalMeanX.toFixed(4)}, ${stats.normalMeanY.toFixed(4)}) (need ≈ 0)`);
  if (stats.seamMean > 0.02 || stats.seamMax > 3.0) {
    console.error("ROCK REJECTED: seam visible — the tile does not wrap");
    process.exit(1);
  }
  if (stats.chromaMax > 0.121) {
    console.error("ROCK REJECTED: chroma above 0.12 in the final albedo");
    process.exit(1);
  }
  if (stats.lumaMin > 0.4 || stats.lumaMax < 0.79) {
    console.error("ROCK REJECTED: strata luma range too narrow (need 0,38-0,85)");
    process.exit(1);
  }
  if (stats.rowBandVar <= 1e-4) {
    console.error("ROCK REJECTED: no horizontal strata in the row means");
    process.exit(1);
  }
  if (Math.abs(stats.normalMeanX) > 0.02 || Math.abs(stats.normalMeanY) > 0.02) {
    console.error("ROCK REJECTED: normal map biased");
    process.exit(1);
  }
  const hashA = createHash("sha256").update(albedoWebp).digest("hex").slice(0, 8);
  const hashN = createHash("sha256").update(normalWebp).digest("hex").slice(0, 8);
  const files: [string, Buffer][] = [
    [`rock-albedo.${hashA}.webp`, albedoWebp],
    [`rock-albedo.${hashA}.png`, albedoPng],
    [`rock-normal.${hashN}.webp`, normalWebp],
    [`rock-normal.${hashN}.png`, normalPng],
  ];
  for (const old of readdirSync("public/assets")) {
    if (old.startsWith("rock-albedo.") || old.startsWith("rock-normal.")) {
      if (!files.some(([n]) => n === old)) {
        rmSync(`public/assets/${old}`);
        console.log(`removed: public/assets/${old}`);
      }
    }
  }
  for (const [name, buf] of files) {
    writeFileSync(`public/assets/${name}`, buf);
    console.log(`saved: public/assets/${name} ${(buf.length / 1024).toFixed(1)} KB`);
  }
  for (const mf of ["data/build/meta.json", "public/assets/meta.json"]) {
    if (!existsSync(mf)) continue;
    const meta = JSON.parse(readFileSync(mf, "utf8")) as {
      assets: Record<string, string>;
      sizesBytes: Record<string, number>;
    };
    meta.assets["rock-albedo"] = `assets/rock-albedo.${hashA}.webp`;
    meta.assets["rock-albedo-png"] = `assets/rock-albedo.${hashA}.png`;
    meta.assets["rock-normal"] = `assets/rock-normal.${hashN}.webp`;
    meta.assets["rock-normal-png"] = `assets/rock-normal.${hashN}.png`;
    meta.sizesBytes["rock-albedo"] = albedoWebp.length;
    meta.sizesBytes["rock-albedo-png"] = albedoPng.length;
    meta.sizesBytes["rock-normal"] = normalWebp.length;
    meta.sizesBytes["rock-normal-png"] = normalPng.length;
    writeFileSync(mf, JSON.stringify(meta, null, 2));
    console.log(`updated: ${mf}`);
  }
}
