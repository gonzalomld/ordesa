// wallbis-final.tmp.mjs — §5d-bis cierre: (i) test decisivo G==rockK con
// uRockMix=0; (ii) G104 dirigido con DOM oculto (el parche anterior cayó en
// el HUD). Scratch, no versionado.
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
const hideDOM = () => {
  for (const el of document.querySelectorAll('body *')) el.style.visibility = 'hidden';
  let n = document.querySelector('canvas');
  while (n) { n.style.visibility = 'visible'; n = n.parentElement; }
};

// (i) ¿G(mode1) es rockK? Con uRockMix=0 debe dar G≈0 en todos los cubos.
{
  const { page, errs } = await newPage(`?debug=walls&skyfrac=1&luma=1&t=12:00&s=0.80`);
  await page.waitForFunction(() => window.__rockCtl !== undefined && (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(6000);
  const set0 = await page.evaluate(() => window.__rockCtl.setRockMix(0));
  await page.waitForTimeout(3000);
  const h = await page.evaluate(() => window.__wallProbe?.hist?.(1) ?? null);
  const rk = h?.rockKbySlope ?? [];
  const mx = Math.max(...rk.filter((v) => v != null));
  console.log(`MIX0-TEST: set→${set0} uni=${JSON.stringify(h?.uni)} maxRockK=${mx.toFixed(3)} tailHist90=${(h?.rockKHist?.[9] ?? -1)}`);
  console.log(`  rockKbySlope: ${(rk).map((v) => v == null ? '·' : v.toFixed(3)).join(' ')}`);
  console.log(`  G==rockK → ${mx < 0.05 ? 'PROBADO (G colapsa con mix=0)' : 'REFUTADO (G no es rockK)'}`);
  await page.evaluate((c) => window.__rockCtl.setRockMix(c), 0.55);
  await page.close();
  console.log('ERR:', errs.join('|') || '(none)');
}

// (ii) G104 dirigido: DOM oculto, franja central y∈[200,600], luma~0.28 (base).
for (const [name, s] of [['s029', '0.29'], ['s080', '0.80'], ['actoV', '0.97']]) {
  const { page, errs } = await newPage(`?debug=1&luma=1&skyfrac=1&s=${s}&t=12:00`);
  await page.waitForFunction(() => window.__luma !== undefined && window.__luma > 0, {}, { timeout: 180000 }).catch(() => {});
  await page.waitForFunction(() => (window.__hasRock ?? 0) === 1, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(10000);
  await page.evaluate(hideDOM);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `/tmp/wallbis-g104-${name}.png`, timeout: 120000 });
  console.log(`G104SHOT ${name} ERR:`, errs.join('|') || '(none)');
  await page.close();
}
await browser.close();

const lumaOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
for (const name of ['s029', 's080', 'actoV']) {
  const { data, info } = await sharp(`/tmp/wallbis-g104-${name}.png`).raw().toBuffer({ resolveWithObject: true });
  const { data: d, w, h, ch } = { data, w: info.width, h: info.height, ch: info.channels };
  let best = null;
  for (let py = 200; py + 128 <= 600; py += 16) for (let px = 0; px + 128 <= w; px += 16) {
    let m = 0, n = 0;
    for (let y = py; y < py + 128; y += 4) for (let x = px; x < px + 128; x += 4) {
      const o = (y * w + x) * ch;
      m += lumaOf(d[o] / 255, d[o + 1] / 255, d[o + 2] / 255); n++;
    }
    m /= n;
    if (m >= 0.03 && m <= 0.30) {
      const score = Math.abs(m - 0.28);
      if (!best || score < best.score) best = { px, py, m, score };
    }
  }
  if (!best) { console.log(`G104 ${name}: sin parche en franja central`); continue; }
  const pxs = [];
  for (let y = best.py; y < best.py + 128; y++) for (let x = best.px; x < best.px + 128; x++) {
    const o = (y * w + x) * ch;
    const r = d[o] / 255, g = d[o + 1] / 255, b = d[o + 2] / 255;
    pxs.push({ l: lumaOf(r, g, b), br: b - r, r, g, b });
  }
  pxs.sort((a, b) => a.l - b.l);
  const mid = pxs.slice(Math.floor(pxs.length / 4), Math.floor((3 * pxs.length) / 4));
  const med = mid[Math.floor(mid.length / 2)];
  let mr = 0, mg = 0, mb = 0;
  for (const p of mid) { mr += p.r; mg += p.g; mb += p.b; }
  const hist = new Array(10).fill(0);
  for (const p of pxs) hist[Math.min(9, Math.floor(p.l * 10))]++;
  console.log(`G104 ${name}: parche (${best.px},${best.py}) lumaMedia=${best.m.toFixed(3)} mediana50 RGB(${Math.round(mr / mid.length * 255)},${Math.round(mg / mid.length * 255)},${Math.round(mb / mid.length * 255)}) b−r=${med.br >= 0 ? '+' : ''}${med.br.toFixed(3)} luma=${med.l.toFixed(3)} histo=[${hist.join(' ')}]`);
}
