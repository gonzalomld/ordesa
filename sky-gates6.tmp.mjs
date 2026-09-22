// sky-gates6.mjs — §6: mapa de cielo a elevaciones fijas + pared en sombra
// + alba/ocaso + G88. Lee el blit ?skymap=1 (equirect 64×32 tras bandera).
import sharp from 'sharp';
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:8080';
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

// --- 1) mapa de cielo: captura del blit ?skymap=1 (canvas completo, el mapa
// va como overlay; lo recortamos por geometría conocida del blit NDC) ---
async function skymapBands(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/?debug=1&skymap=1&t=${t}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__luma !== undefined && window.__luma > 0, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(8000);
  // zenith leído de la sonda display-space (columna lejos del sol)
  const zen = await page.evaluate(() => window.__zenithHex ?? null);
  const hz = await page.evaluate(() => ({ sun: window.__hzSunHex ?? null, anti: window.__hzAntiHex ?? null }));
  await page.screenshot({ path: `/tmp/sky6-map-${t.replace(':', '')}.png` });
  console.log(`skymap t=${t} zenith=${zen} hzSun=${hz.sun} hzAnti=${hz.anti} ERR:`, errs.join('|') || '(none)');
  await page.close();
  return { zen, hz };
}

// --- 2) encuadres s=0.29/0.80 a las 12:00 + Acto V + pared en sombra ---
async function frame(s, t, name) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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

// --- 3) bandas del mapa: el blit equirect ocupa la esquina inferior
// (384×192 sobre 1280×800). Lo medimos directamente del PNG por posición.
for (const t of ['12:00', '07:00', '20:00']) {
  const p = `/tmp/sky6-map-${t.replace(':', '')}.png`;
  const { data, info } = await sharp(p).raw().toBuffer({ resolveWithObject: true });
  const W = info.width, Hh = info.height, C = info.channels;
  // buscar el blit: franja inferior-central, 384×192 → filas H-192..H, cols centradas
  console.log(p, `${W}x${Hh}`);
}
