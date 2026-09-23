// wall-gates5d.tmp.mjs — §5d INSTRUMENTO DE PARED (cero ajuste visual).
// Scratch de medición (raíz, no versionado). Entrega:
//   a) __wallHist de ?debug=walls y ?debug=walls2 en s=0.29/0.80/ActoV(0.97)
//   b) p50/p95 de slopeDeg + resolución DEM (5 m/px en meta.json)
//   c) b−r y luma sRGB de pared en sombra en los tres (G104 sin umbral)
//   d) round-trip 0.5 → 127/128 confirmado
//   e) G94 HF de banda + G102 diferencial sobre el código ACTUAL
//   + programs constante 0→1→2 (uWallProbe no recompila)
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.SKY6_BASE ?? 'http://localhost:8080';

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
async function newPage(q) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/${q}`, { waitUntil: 'load', timeout: 60000 });
  return { page, errs };
}
const J = (o) => JSON.stringify(o);

// --- d) round-trip + a/b) histogramas: ?debug=walls/walls2 (?t=12:00) ---
const wallResults = {};
async function wallHist(s, name, mode) {
  const flag = mode === 1 ? 'walls' : 'walls2';
  const { page, errs } = await newPage(`?debug=${flag}&t=12:00&s=${s}`);
  await page.waitForFunction(() => window.__wallProbe !== undefined, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(8000);
  // programs antes/después (0→1→2 no debe recompilar: uWallProbe es uniforme)
  const nProg = () => page.evaluate(() => (window.__programs ?? []).length);
  const p0 = await nProg();
  const rt = await page.evaluate(() => window.__wallProbe?.roundTrip?.() ?? null);
  const p1 = await nProg();
  const hist = await page.evaluate((m) => window.__wallProbe?.hist?.(m) ?? null, mode);
  const p2 = await nProg();
  const zen = await page.evaluate(() => window.__zenithHex ?? window.__metrics?.zenithHex ?? null);
  console.log(`${name} mode=${mode} roundTrip=${J(rt)} programs=${p0}/${p1}/${p2} zenith=${zen} ERR:`, errs.join('|') || '(none)');
  if (hist) {
    const f = (a, d = 3) => (a ?? []).map((v) => v == null ? '·' : Number(v).toFixed(d)).join(' ');
    console.log(`  terrPx=${hist.terrPx} p50=${hist.slopeP50.toFixed(1)}° p95=${hist.slopeP95.toFixed(1)}°`);
    console.log(`  slopeHist[%]: ${f(hist.slopeHist.map((v) => v * 100), 1)}`);
    if (mode === 1) {
      console.log(`  rockKbySlope: ${f(hist.rockKbySlope)}`);
      console.log(`  rockKHist[%]: ${f(hist.rockKHist.map((v) => v * 100), 1)}`);
      console.log(`  cromaAbyS: ${f(hist.cromaAbyS)}`);
    } else {
      console.log(`  brFbyS: ${f(hist.brFbyS)}`);
      console.log(`  lumaFbyS: ${f(hist.lumaFbyS)}`);
    }
    wallResults[name + (mode === 1 ? '-w1' : '-w2')] = hist;
  } else {
    console.log(`  ${name} mode=${mode}: SIN HISTOGRAMA`);
  }
  await page.close();
}

// --- c) G104 reescrita: b−r + luma sRGB de pared en sombra (encuadre normal) ---
async function shadowBR(s, name) {
  const { page, errs } = await newPage(`?debug=1&luma=1&skyfrac=1&s=${s}&t=12:00`);
  await page.waitForFunction(() => window.__luma !== undefined && window.__luma > 0, {}, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `/tmp/wall5d-shadow-${name}.png` });
  const m = await page.evaluate(() => {
    const M = window.__metrics;
    return {
      luma: window.__luma, lumaShadow: window.__lumaShadow ?? null, chromaShadow: window.__chromaShadow ?? null,
      terr: window.__valleyTerr ?? null, zenith: window.__zenithHex ?? M?.zenithHex ?? null,
    };
  });
  console.log(`SHADOW ${name}: ${J(m)} ERR:`, errs.join('|') || '(none)');
  await page.close();
  return m;
}

// --- e) G94 banda + G102 diferencial sobre capturas con MEZCLA actual vs 0 ---
async function patchFrame(s, name, mix) {
  const { page, errs } = await newPage(`?debug=1&skyfrac=1&s=${s}&t=12:00`);
  await page.waitForFunction(() => (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  if (mix === 0) {
    // MEZCLA ROCA a 0: mismo deslizador que verify (aria-label "mezcla de roca triplanar")
    await page.evaluate(() => {
      const el = document.querySelector('input[aria-label="mezcla de roca triplanar"]');
      if (el) { el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
      return false;
    });
  }
  await page.waitForTimeout(6000);
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.screenshot({ path: `/tmp/wall5d-${name}-mix${mix === 0 ? '0' : 'on'}.png` });
  console.log(`patch ${name} mix=${mix} ERR:`, errs.join('|') || '(none)');
  await page.close();
}

const P = { s029: '0.29', s080: '0.80', actoV: '0.97' };
for (const [name, s] of Object.entries(P)) await wallHist(s, name, 1);
for (const [name, s] of Object.entries(P)) await wallHist(s, name, 2);
const sh = {};
for (const [name, s] of Object.entries(P)) sh[name] = await shadowBR(s, name);
await patchFrame('0.80', 's080', 1);
await patchFrame('0.80', 's080', 0);
await patchFrame('0.29', 's029', 1);
await patchFrame('0.29', 's029', 0);
await browser.close();

// --- análisis G94 (HF de banda) + G102 (diferencial) + G95 (2 lags, 256²) ---
const blur = (img, sigma) => img.clone().blur(sigma).raw().toBuffer({ resolveWithObject: true });
async function bandStats(p) {
  const img = sharp(p);
  const meta = await img.metadata();
  const [b2, b6] = await Promise.all([blur(img, 2), blur(img, 6)]);
  const n = meta.width * meta.height;
  const band = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // luma de la banda blur2−blur6 (canal R representativo; sRGB)
    const l2 = (b2.data[i * b2.info.channels] / 255 + b2.data[i * b2.info.channels + 1] / 255 + b2.data[i * b2.info.channels + 2] / 255) / 3;
    const l6 = (b6.data[i * b6.info.channels] / 255 + b6.data[i * b6.info.channels + 1] / 255 + b6.data[i * b6.info.channels + 2] / 255) / 3;
    band[i] = l2 - l6;
  }
  return { band, w: meta.width, h: meta.height };
}
function rectStat(band, w, x0, y0, s) {
  let sum = 0, sum2 = 0, n = 0;
  const vals = [];
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) { const v = band[y * w + x]; vals.push(v); sum += v; sum2 += v * v; n++; }
  const mean = sum / n;
  return { rms: Math.sqrt(sum2 / n), mad: vals.reduce((a, v) => a + Math.abs(v - mean), 0) / n, mean, vals };
}
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((x, v) => x + v, 0) / n;
  const mb = b.slice(0, n).reduce((x, v) => x + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return sab / Math.max(1e-12, Math.sqrt(saa * sbb));
}
// Parches 128² de pared: centro-izquierda y centro-derecha a media altura
// (misma fila, separados ≥500 px). Ajuste manual si caen en cielo.
const PATCHES = { s080: [[180, 300], [760, 300]], s029: [[180, 300], [760, 300]] };
for (const key of ['s080', 's029']) {
  const on = await bandStats(`/tmp/wall5d-${key}-mixon.png`);
  const off = await bandStats(`/tmp/wall5d-${key}-mix0.png`);
  console.log(`\nG94/G102 ${key} (rms de banda blur2−blur6, parches 128²):`);
  for (const [px, py] of PATCHES[key]) {
    const a = rectStat(on.band, on.w, px, py, 128);
    const b = rectStat(off.band, off.w, px, py, 128);
    console.log(`  parche (${px},${py}): rms on=${a.rms.toFixed(4)} off=${b.rms.toFixed(4)} ratio=${(a.rms / Math.max(1e-9, b.rms)).toFixed(2)} madDiff=${Math.abs(a.mean - b.mean).toFixed(4)}`);
  }
}
// G102 diferencial: perfiles verticales de luma (media por fila) on−off
async function lumaCol(p) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
for (const key of ['s080']) {
  const on = await lumaCol(`/tmp/wall5d-${key}-mixon.png`);
  const off = await lumaCol(`/tmp/wall5d-${key}-mix0.png`);
  const prof = (img, px, py, s) => {
    const v = [];
    for (let y = py; y < py + s; y++) {
      let m = 0;
      for (let x = px; x < px + s; x++) {
        const o = (y * img.w + x) * img.ch;
        m += (img.data[o] / 255 + img.data[o + 1] / 255 + img.data[o + 2] / 255) / 3;
      }
      v.push(m / s);
    }
    return v;
  };
  const [p1, p2] = PATCHES[key];
  const d1 = prof(on, p1[0], p1[1], 128).map((v, i) => v - prof(off, p1[0], p1[1], 128)[i]);
  const d2 = prof(on, p2[0], p2[1], 128).map((v, i) => v - prof(off, p2[0], p2[1], 128)[i]);
  console.log(`G102-dif ${key}: corr(P1on−P1off, P2on−P2off) = ${corr(d1, d2).toFixed(3)} (≤0.35)`);
}
// G95: autocorrelación a los dos lags (135 m y 85 m → px) en parches 256².
// Escala: dist focal 50°, 1280 px → px/m ≈ 1280/(2·d·tan25°); d≈600 m (pared s080).
async function autocorrLag(p, px, py, s, lagPx) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  const lum = [];
  for (let y = py; y < py + s; y++) {
    const row = [];
    for (let x = px; x < px + s; x++) {
      const o = (y * info.width + x) * info.channels;
      row.push((data[o] / 255 + data[o + 1] / 255 + data[o + 2] / 255) / 3);
    }
    lum.push(row);
  }
  const flat = lum.flat();
  const mean = flat.reduce((a, v) => a + v, 0) / flat.length;
  let num = 0, den = 0;
  for (let y = 0; y < s; y++) for (let x = 0; x < s - lagPx; x++) num += (lum[y][x] - mean) * (lum[y][x + lagPx] - mean);
  for (const v of flat) den += (v - mean) ** 2;
  return num / Math.max(1e-12, den);
}
{
  const p = '/tmp/wall5d-s080-mixon.png';
  // d≈600 m → 135 m ≈ 145 px (lag de baldosa que no cabía en 128²), 85 m ≈ 91 px
  for (const lag of [145, 91]) {
    const a = await autocorrLag(p, 180, 220, 256, lag);
    console.log(`G95 s080 parche 256² lag ${lag}px: autocorr = ${a.toFixed(3)}`);
  }
}
console.log('\nG104-shadow sRGB (b−r sobre píxeles de pantalla — calcular en §5e con brFbyS):');
for (const [k, m] of Object.entries(sh)) console.log(`  ${k}: ${J(m)}`);
