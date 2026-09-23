// wall-gates5dbis.tmp.mjs — §5d-bis ARREGLAR LA SONDA (cero ajuste visual).
// Scratch de medición (raíz, no versionado). Entrega:
//   a) __wallHist modo 1 y 2 con uni.* LEÍDOS (uWallProbe/uRockMix/uRockWeight/
//      uWallDeg/uHasRock/programs) en s=0.29/0.80/ActoV(0.97)
//   b) b−r del ALBEDO por cubo (brAbyS, modo 1)
//   c) G94 con 5 aserciones (a-e) vía __rockCtl (uniforme directo, nada de
//      deslizadores) o motivo de no-medida
//   d) G102 + G95 re-medidos tras (c) — ANULADOS (§5d) hasta que (4e) pase
//   e) G104 con regla fija: parche 128² en sombra, mediana del 50 % central
//      + histo luma 10 cubos (SIN UMBRAL)
//   + check __zenithHex vs blit 90° #3c74a0 (±8/canal)
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
const F = (a, d = 3) => (a ?? []).map((v) => v == null ? '·' : Number(v).toFixed(d)).join(' ');

// --- a+b) histogramas modo 1+2 con uni.* en la MISMA página (?debug=walls) ---
async function wallBoth(s, name) {
  const { page, errs } = await newPage(`?debug=walls&skyfrac=1&luma=1&t=12:00&s=${s}`);
  await page.waitForFunction(() => window.__wallProbe !== undefined && window.__rockCtl !== undefined, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(8000);
  const rt = await page.evaluate(() => window.__wallProbe?.roundTrip?.() ?? null);
  const h1 = await page.evaluate(() => window.__wallProbe?.hist?.(1) ?? null);
  const h2 = await page.evaluate(() => window.__wallProbe?.hist?.(2) ?? null);
  const ok1 = h1 && h1.uni.uWallProbe === 1;
  const ok2 = h2 && h2.uni.uWallProbe === 2;
  console.log(`${name}: roundTrip=${J(rt)} MODE1_ASSERT=${ok1 ? 'PASS' : 'FAIL'} MODE2_ASSERT=${ok2 ? 'PASS' : 'FAIL'} ERR:`, errs.join('|') || '(none)');
  for (const [tag, h] of [['m1', h1], ['m2', h2]]) {
    if (!h) { console.log(`  ${tag}: SIN HISTOGRAMA`); continue; }
    console.log(`  ${tag}: uni=${J(h.uni)} terrPx=${h.terrPx} p50=${h.slopeP50.toFixed(1)} p95=${h.slopeP95.toFixed(1)}`);
    if (tag === 'm1') {
      console.log(`    rockKbySlope: ${F(h.rockKbySlope)}`);
      console.log(`    rockKHist[%]: ${F(h.rockKHist.map((v) => v * 100), 1)}`);
      console.log(`    brAbyS: ${F(h.brAbyS)}`);
    } else {
      console.log(`    brFbyS: ${F(h.brFbyS)}`);
      console.log(`    lumaFbyS: ${F(h.lumaFbyS)}`);
    }
  }
  await page.close();
}

// --- c) G94 on/off vía __rockCtl (uniforme directo) + capturas ---
async function onoff(s, name) {
  const { page, errs } = await newPage(`?debug=walls&skyfrac=1&luma=1&t=12:00&s=${s}`);
  await page.waitForFunction(() => window.__rockCtl !== undefined && (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(6000);
  const pre = await page.evaluate(() => ({ mix: window.__rockCtl.getRockMix(), c: window.__rockCtl.rockMixConst, w: window.__rockCtl.getRockWeight(), deg: window.__rockCtl.getWallDeg(), hr: window.__rockCtl.getHasRock() }));
  const set0 = await page.evaluate(() => window.__rockCtl.setRockMix(0));
  const aOK = set0 === 0;
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/wallbis-${name}-off.png` });
  const setOn = await page.evaluate((c) => window.__rockCtl.setRockMix(c), pre.c);
  const cOK = setOn === pre.c;
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/wallbis-${name}-on.png` });
  console.log(`ONOFF ${name}: pre=${J(pre)} a[set0→${set0}]${aOK ? 'PASS' : 'FAIL'} c[set→${setOn}]${cOK ? 'PASS' : 'FAIL'} ERR:`, errs.join('|') || '(none)');
  await page.close();
  return { aOK, cOK };
}

// --- e) G104 regla fija + screenshots normales + zenith para check (7) ---
async function shadow104(s, name) {
  const { page, errs } = await newPage(`?debug=1&luma=1&skyfrac=1&s=${s}&t=12:00`);
  await page.waitForFunction(() => window.__luma !== undefined && window.__luma > 0, {}, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(10000);
  const zen = await page.evaluate(() => window.__zenithHex ?? window.__metrics?.zenithHex ?? null);
  await page.screenshot({ path: `/tmp/wallbis-shadow-${name}.png` });
  console.log(`SHADOW104 ${name}: zenith=${zen} ERR:`, errs.join('|') || '(none)');
  await page.close();
  return zen;
}

const P = { s029: '0.29', s080: '0.80', actoV: '0.97' };
for (const [name, s] of Object.entries(P)) await wallBoth(s, name);
const oo = {};
for (const [name, s] of [['s080', '0.80'], ['s029', '0.29']]) oo[name] = await onoff(s, name);
const zens = {};
for (const [name, s] of Object.entries(P)) zens[name] = await shadow104(s, name);
await browser.close();

// --- análisis Node: (4e) aserción ON/OFF, G94 banda, G102 dif, G95 lags ---
async function raw(p) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels };
}
const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
async function meanAbsDiff(pOn, pOff) {
  const a = await raw(pOn), b = await raw(pOff);
  let s = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) s += Math.abs(a.data[i * a.ch + c] - b.data[i * b.ch + c]) / 255;
  }
  return s / (n * 3);
}
let ePass = true;
for (const key of ['s080', 's029']) {
  const mad = await meanAbsDiff(`/tmp/wallbis-${key}-on.png`, `/tmp/wallbis-${key}-off.png`);
  const ok = oo[key].aOK && oo[key].cOK && mad > 0.001;
  ePass = ePass && ok;
  console.log(`ASSERT-4e ${key}: a=${oo[key].aOK ? 'PASS' : 'FAIL'} c=${oo[key].cOK ? 'PASS' : 'FAIL'} e[mad=${mad.toFixed(4)}>0.001]=${mad > 0.001 ? 'PASS' : 'FAIL'} → ${ok ? 'MEDIBLE' : 'NO-MEDIDA'}`);
}
const blur = (img, sigma) => img.clone().blur(sigma).raw().toBuffer({ resolveWithObject: true });
async function bandStats(p) {
  const img = sharp(p);
  const meta = await img.metadata();
  const [b2, b6] = await Promise.all([blur(img, 2), blur(img, 6)]);
  const n = meta.width * meta.height;
  const band = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const l2 = (b2.data[i * b2.info.channels] / 255 + b2.data[i * b2.info.channels + 1] / 255 + b2.data[i * b2.info.channels + 2] / 255) / 3;
    const l6 = (b6.data[i * b6.info.channels] / 255 + b6.data[i * b6.info.channels + 1] / 255 + b6.data[i * b6.info.channels + 2] / 255) / 3;
    band[i] = l2 - l6;
  }
  return { band, w: meta.width };
}
function rectStat(band, w, x0, y0, s) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) { const v = band[y * w + x]; sum += v; sum2 += v * v; n++; }
  return { rms: Math.sqrt(sum2 / n), mean: sum / n };
}
const PATCHES = { s080: [[180, 300], [760, 300]], s029: [[180, 300], [760, 300]] };
if (ePass) {
  for (const key of ['s080', 's029']) {
    const on = await bandStats(`/tmp/wallbis-${key}-on.png`);
    const off = await bandStats(`/tmp/wallbis-${key}-off.png`);
    console.log(`G94-banda ${key}:`);
    for (const [px, py] of PATCHES[key]) {
      const a = rectStat(on.band, on.w, px, py, 128);
      const b = rectStat(off.band, off.w, px, py, 128);
      const ratio = a.rms / Math.max(1e-9, b.rms);
      console.log(`  (${px},${py}): rms on=${a.rms.toFixed(4)} off=${b.rms.toFixed(4)} ratio=${ratio.toFixed(2)} (≥1.8) madDiffPatch=${Math.abs(a.mean - b.mean).toFixed(4)} (≥0.04) → ${ratio >= 1.8 ? 'PASS' : 'FAIL'}`);
    }
  }
  // G102 diferencial s080
  const on = await raw('/tmp/wallbis-s080-on.png'), off = await raw('/tmp/wallbis-s080-off.png');
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
  const corr = (a, b) => {
    const n = Math.min(a.length, b.length);
    const ma = a.slice(0, n).reduce((x, v) => x + v, 0) / n, mb = b.slice(0, n).reduce((x, v) => x + v, 0) / n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.max(1e-12, Math.sqrt(saa * sbb));
  };
  const [p1, p2] = PATCHES.s080;
  const d1 = prof(on, p1[0], p1[1], 128).map((v, i) => v - prof(off, p1[0], p1[1], 128)[i]);
  const d2 = prof(on, p2[0], p2[1], 128).map((v, i) => v - prof(off, p2[0], p2[1], 128)[i]);
  console.log(`G102-dif s080: corr=${corr(d1, d2).toFixed(3)} (≤0.35)`);
  // G95 lags 256²
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
  for (const lag of [145, 91]) {
    console.log(`G95 s080 256² lag ${lag}px: autocorr=${(await autocorrLag('/tmp/wallbis-s080-on.png', 180, 220, 256, lag)).toFixed(3)}`);
  }
} else {
  console.log('G94(4e) NO PASA → G102 y G95 de §5d quedan ANULADOS (no válidos); sin re-medida.');
}
// --- e) G104 regla fija: parche 128² más oscuro (luma media 0.03–0.30) ---
for (const key of ['s029', 's080', 'actoV']) {
  const { data, w, h, ch } = await raw(`/tmp/wallbis-shadow-${key}.png`);
  let best = null;
  for (let py = 0; py + 128 <= h; py += 32) for (let px = 0; px + 128 <= w; px += 32) {
    let m = 0, n = 0;
    for (let y = py; y < py + 128; y += 4) for (let x = px; x < px + 128; x += 4) {
      const o = (y * w + x) * ch;
      m += lumaOf(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255); n++;
    }
    m /= n;
    if (m >= 0.03 && m <= 0.30 && (!best || m < best.m)) best = { px, py, m };
  }
  if (!best) { console.log(`G104 ${key}: sin parche en sombra`); continue; }
  const pxs = [];
  for (let y = best.py; y < best.py + 128; y++) for (let x = best.px; x < best.px + 128; x++) {
    const o = (y * w + x) * ch;
    const r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
    pxs.push({ l: lumaOf(r, g, b), br: b - r });
  }
  pxs.sort((a, b) => a.l - b.l);
  const q1 = Math.floor(pxs.length / 4), q3 = Math.floor((3 * pxs.length) / 4);
  const mid = pxs.slice(q1, q3);
  const med = mid[Math.floor(mid.length / 2)];
  const hist = new Array(10).fill(0);
  for (const p of pxs) hist[Math.min(9, Math.floor(p.l * 10))]++;
  console.log(`G104 ${key}: parche (${best.px},${best.py}) mediana50 b−r=${med.br >= 0 ? '+' : ''}${med.br.toFixed(3)} luma=${med.l.toFixed(3)} histo=[${hist.join(' ')}]`);
}
// --- (7) zenith vs blit 90° #3c74a0 ---
{
  const ref = [0x3c, 0x74, 0xa0];
  for (const [k, z] of Object.entries(zens)) {
    if (!z || z === '—') { console.log(`ZENITH ${k}: ${z} (sin sonda)`); continue; }
    const c = [parseInt(z.slice(1, 3), 16), parseInt(z.slice(3, 5), 16), parseInt(z.slice(5, 7), 16)];
    const d = c.map((v, i) => Math.abs(v - ref[i]));
    console.log(`ZENITH ${k}: ${z} vs #3c74a0 Δ=[${d.join(',')}] → ${d.every((v) => v <= 8) ? 'CASAN' : 'UNO MIENTE'}`);
  }
}
