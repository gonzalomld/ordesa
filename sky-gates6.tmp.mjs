// sky-gates6.tmp.mjs — §6b: mapa de cielo a elevaciones fijas + pared en sombra
// + alba/ocaso + G88. Lee el blit ?skymap=1 (equirect 384×192 tras bandera).
// Scratch de medición (raíz, no versionado). Cambios reales del proyecto §6b:
// SKY_RAYLEIGH 2.6→1.6 (desatura), SKY_SCALE 0.22→0.17 (ACES), HEMI_GRAY_MIX
// 0.75→0.6 (niebla baja), HEMI_LIGHT_GRAY 0.40 (luz hemisférica), rampa intacta.
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.SKY6_BASE ?? 'http://localhost:8080';
const H = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (mx === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: mx > 1e-9 ? d / mx : 0, v: mx, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b, bmr: b - r };
};

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

const mapResults = {};
const frameResults = {};

// --- 1) mapa de cielo: captura del blit ?skymap=1 (canvas completo, el mapa
// va como overlay; lo recortamos por geometría conocida del blit NDC) ---
async function skymapBands(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/?debug=1&skymap=1&skyfrac=1&t=${t}`, { waitUntil: 'load', timeout: 60000 });
  // skyfrac=1 abre la cadencia de 30 frames (lumaOn||skyfracOn||trackpxOn,
  // viewer.ts:2095): sin ella ni __zenithHex ni __skySunAz ni __skymapPx
  // existen (todas las sondas viven dentro de ese bloque).
  // __luma solo existe con ?luma=1 — aquí esperamos el px del blit (no negro).
  await page.waitForFunction(() => window.__skymapPx !== undefined && window.__skymapPx !== '#000000', {}, { timeout: 60000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  // Ocultar TODO el DOM salvo el canvas: el panel de ficha + barra inferior +
  // HUD cubren la región 384×192 del blit (run 1 midió píxeles del panel).
  // visibility:hidden + re-visible de la cadena del canvas → screenshot puro
  // WebGL. Los overlays no afectan al render (el blit ya está compuesto).
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) el.style.visibility = 'hidden';
    let n = document.querySelector('canvas');
    while (n) { n.style.visibility = 'visible'; n = n.parentElement; }
  });
  await page.waitForTimeout(8000);
  // zenith leído de la sonda display-space (columna lejos del sol)
  const zen = await page.evaluate(() => window.__zenithHex ?? null);
  const hz = await page.evaluate(() => ({ sun: window.__hzSunHex ?? null, anti: window.__hzAntiHex ?? null }));
  const sunAz = await page.evaluate(() => window.__skySunAz ?? null);
  const px = await page.evaluate(() => window.__skymapPx ?? null);
  await page.screenshot({ path: `/tmp/sky6-map-${t.replace(':', '')}.png` });
  console.log(`skymap t=${t} zenith=${zen} hzSun=${hz.sun} hzAnti=${hz.anti} sunAz=${sunAz} blitPx=${px} ERR:`, errs.join('|') || '(none)');
  mapResults[t] = { sunAz: Number(sunAz) };
  await page.close();
}

// --- 2) encuadres s=0.29/0.80 a las 12:00 + Acto V + pared en sombra ---
async function frame(s, t, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/?debug=1&luma=1&skyfrac=1&s=${s}&t=${t}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__luma !== undefined && window.__luma > 0, {}, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(10000);
  const pre = await page.evaluate(() => ({
    luma: window.__luma, sky: window.__skyFrac, programs: window.__programs ?? null,
    calls: window.__metrics?.drawCalls ?? null,
    lumaShadow: window.__lumaShadow ?? null, chromaShadow: window.__chromaShadow ?? null,
  }));
  await page.screenshot({ path: `/tmp/sky6-${name}.png` });
  console.log(name, JSON.stringify(pre), 'ERR:', errs.join('|') || '(none)');
  frameResults[name] = { s, t, lumaShadow: pre.lumaShadow, chromaShadow: pre.chromaShadow };
  // G88: niebla vs horizonte antisolar
  const g88 = await page.evaluate(() => ({ valley: window.__valleyFogDist ?? null, terr: window.__valleyTerr ?? null }));
  console.log(name, 'G88', JSON.stringify(g88));
  await page.close();
}

for (const t of ['12:00', '07:00', '20:00']) await skymapBands(t);
await frame('0.29', '12:00', 'frame-s029-1200');
await frame('0.80', '12:00', 'frame-s080-1200');
// Acto V ≈ s 0.97 (mismo plano que el usuario pasó)
await frame('0.97', '12:00', 'frame-actoV-1200');
await browser.close();

// --- 3) bandas del mapa: el blit equirect ocupa 384×192 CSS px en la esquina
// inferior-izquierda del canvas 1280×800 (PNG top-down: filas 608–800,
// columnas 0–384). Fila para elevación el: row = 608 + (0.5 − el/180)·192.
// Columnas excluidas: ±24 px alrededor de la columna solar (disco + halo mie)
// y 3 junto a cada borde (costura equirect + clamp). Métricas sobre el RGB
// medio: sat HSV = (max−min)/max, b−r, luma Rec.709.
const BW = 384, BH = 192, CW = 1280, CH = 800;
const TOP = CH - BH;
const bandRow = (el) => TOP + (0.5 - el / 180) * BH;

async function bandMetrics(p, t, els) {
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== CW || info.height !== CH) throw new Error(`${p}: esperado ${CW}x${CH}, llegado ${info.width}x${info.height}`);
  const C = info.channels;
  const az = mapResults[t]?.sunAz;
  if (az == null || !Number.isFinite(az)) throw new Error(`${t}: __skySunAz no disponible`);
  // capture: az = azApp − 90° → u = ((az−90)/360 + 0.5) mod 1
  const u = ((((az - 90) / 360) + 0.5) % 1 + 1) % 1;
  const sunCol = u * BW;
  const sunDist = (col) => {
    const d = Math.abs(col - sunCol);
    return Math.min(d, BW - d);
  };
  const antiCol = (sunCol + BW / 2) % BW;
  const antiDist = (col) => {
    const d = Math.abs(col - antiCol);
    return Math.min(d, BW - d);
  };
  const avgCols = (row, pred) => {
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let col = 0; col < BW; col++) {
      if (col <= 2 || col >= BW - 3 || !pred(col)) continue;
      const o = (row * CW + col) * C;
      rs += data[o]; gs += data[o + 1]; bs += data[o + 2]; n++;
    }
    return n > 0 ? [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)] : null;
  };
  const out = { sunCol, bands: {} };
  for (const el of els) {
    const rowC = Math.round(bandRow(el));
    let rs = 0, gs = 0, bs = 0, n = 0;
    // ventana de filas SIEMPRE dentro del mapa [608..799]: la fila 607 sería
    // cielo pálido del encuadre principal (contaminó la banda de 90°)
    for (let row = Math.max(TOP, rowC - 1); row <= Math.min(TOP + BH - 1, rowC + 1); row++) {
      for (let col = 0; col < BW; col++) {
        if (col <= 2 || col >= BW - 3 || sunDist(col) <= 24) continue;
        const o = (row * CW + col) * C;
        rs += data[o]; gs += data[o + 1]; bs += data[o + 2]; n++;
      }
    }
    const r = rs / n / 255, g = gs / n / 255, b = bs / n / 255;
    const m = H(r, g, b);
    out.bands[el] = {
      row: rowC, n,
      rgb: [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)],
      sat: m.s, bmr: m.bmr, luma: m.luma, hue: m.h,
      // contexto alba/ocaso: ventana solar (halo) y antisolar (±48 px, sin costuras)
      sun: avgCols(rowC, (c) => sunDist(c) <= 48),
      anti: avgCols(rowC, (c) => antiDist(c) <= 48),
    };
  }
  return out;
}

// bandas G103 §6b @12:00 (cinco elevaciones) + alba/ocaso (5° y 20°).
// sat = banda §6b; luma = objetivo ±0,06. El NIVEL lo mueve SKY_SCALE (ACES);
// Rayleigh NO (desatura). Si falla por abajo → SKY_SCALE 0.15; por arriba 0.19.
const ranges = { 5: [0.10, 0.20], 15: [0.40, 0.52], 30: [0.53, 0.66], 60: [0.60, 0.73], 90: [0.58, 0.71] };
const lumaTarget = { 5: 0.70, 15: 0.61, 30: 0.53, 60: 0.48, 90: 0.49 };
const LUMA_TOL = 0.06;
let sat30 = null, sat15 = null, sat60 = null;
for (const t of ['12:00', '07:00', '20:00']) {
  const els = t === '12:00' ? [5, 15, 30, 60, 90] : [5, 20];
  const b = await bandMetrics(`/tmp/sky6-map-${t.replace(':', '')}.png`, t, els);
  console.log(`\nBANDAS t=${t} (col solar ${b.sunCol.toFixed(1)} px):`);
  for (const el of els) {
    const m = b.bands[el];
    let verdict = '';
    if (t === '12:00' && ranges[el]) {
      const [lo, hi] = ranges[el];
      const okS = m.sat >= lo && m.sat <= hi;
      const okL = Math.abs(m.luma - lumaTarget[el]) <= LUMA_TOL;
      verdict = ` ${okS && okL ? 'PASS' : 'FAIL'} (sat ${lo}–${hi}, luma ${lumaTarget[el].toFixed(2)}±${LUMA_TOL})`;
    }
    console.log(`  ${String(el).padStart(2)}°  fila ${m.row}  RGB(${m.rgb.join(',')})  sat ${m.sat.toFixed(3)}  b−r ${m.bmr >= 0 ? '+' : ''}${m.bmr.toFixed(3)}  luma ${m.luma.toFixed(3)}  hue ${m.hue.toFixed(0)}°  (n=${m.n})${verdict}`);
    if (m.sun) console.log(`      sol RGB(${m.sun.join(',')})  anti RGB(${m.anti ? m.anti.join(',') : 'n/d'})`);
    if (t === '12:00') {
      if (el === 30) sat30 = m.sat;
      if (el === 15) sat15 = m.sat;
      if (el === 60) sat60 = m.sat;
    }
  }
}
if (sat15 != null && sat60 != null) {
  console.log(`\nRAMPA: sat15/sat60 = ${(sat15 / sat60).toFixed(3)} (relación mide la rampa; el nivel absoluto lo mide SKY_SCALE — Rayleigh desatura)`);
}

// --- 4) G104: croma/luma de la pared en sombra + coherencia con el cielo ---
console.log('\nG104 shadow-chroma @12:00:');
for (const [name, r] of Object.entries(frameResults)) {
  if (r.chromaShadow == null) { console.log(`  ${name}: sin sonda`); continue; }
  const okC = r.chromaShadow <= 0.28;
  const lim = sat30 != null ? sat30 * 1.1 : null;
  const coh = lim != null ? r.chromaShadow <= lim : null;
  console.log(`  ${name}: croma ${r.chromaShadow.toFixed(3)} (≤0.28 → ${okC ? 'PASS' : 'FAIL'})  luma ${r.lumaShadow?.toFixed(4)}  coherencia croma ≤ sat30×1.1${lim != null ? ` = ${lim.toFixed(3)}` : ' (sat30 n/d)'} → ${coh == null ? 'n/d' : coh ? 'PASS' : 'FAIL'}`);
}
