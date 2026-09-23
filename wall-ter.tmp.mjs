// wall-ter.tmp.mjs — §5d-ter: (a) modo 3 camino real, (b) hist 1+2 con los
// cinco uniformes, (c) brAbyS. (+d solo si el veredicto es srgb: relectura
// linealizada.) Scratch, no versionado.
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.SKY6_BASE ?? 'http://localhost:8080';
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const J = (o) => JSON.stringify(o);
const F = (a, d = 3) => (a ?? []).map((v) => v == null ? '·' : Number(v).toFixed(d)).join(' ');

async function newPage(q) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${BASE}/${q}`, { waitUntil: 'load', timeout: 60000 });
  return { page, errs };
}

for (const [name, s] of [['s029', '0.29'], ['s080', '0.80'], ['actoV', '0.97']]) {
  const { page, errs } = await newPage(`?debug=walls&skyfrac=1&luma=1&t=12:00&s=${s}`);
  await page.waitForFunction(() => window.__wallProbe !== undefined && window.__rockCtl !== undefined, {}, { timeout: 180000 }).catch(() => {});
  await page.evaluate(() => { document.querySelector('.gate')?.remove(); });
  await page.waitForTimeout(8000);
  // (a) modo 3 por el CAMINO REAL (render() ahora es mode3RoundTrip)
  const rt = await page.evaluate(() => window.__wallProbe?.render?.() ?? null);
  // (b) hist 1 y 2 con uni.* (cada uno trae además su propio veredicto)
  const h1 = await page.evaluate(() => window.__wallProbe?.hist?.(1) ?? null);
  const h2 = await page.evaluate(() => window.__wallProbe?.hist?.(2) ?? null);
  const h3 = await page.evaluate(() => window.__wallProbe?.hist3?.() ?? null);
  console.log(`${name}: MODE3=${J(rt?.roundTrip)} verdict=${rt?.roundTripVerdict} ERR:`, errs.join('|') || '(none)');
  console.log(`  hist3: rt=${J(h3?.roundTrip)} verdict=${h3?.roundTripVerdict} uni=${J(h3?.uni)}`);
  for (const [tag, h] of [['m1', h1], ['m2', h2]]) {
    if (!h) { console.log(`  ${tag}: SIN HISTOGRAMA`); continue; }
    const okMode = h.uni.uWallProbe === (tag === 'm1' ? 1 : 2);
    console.log(`  ${tag}: uni=${J(h.uni)} MODE_ASSERT=${okMode ? 'PASS' : 'FAIL'} rt=${J(h.roundTrip)} verdict=${h.roundTripVerdict} terrPx=${h.terrPx} p50=${h.slopeP50.toFixed(1)} p95=${h.slopeP95.toFixed(1)}`);
    if (tag === 'm1') {
      console.log(`    rockKbySlope: ${F(h.rockKbySlope)}`);
      console.log(`    rockKHist[%]: ${F(h.rockKHist.map((v) => v * 100), 1)}`);
      console.log(`    brAbyS: ${F(h.brAbyS)}`);
    } else {
      console.log(`    brFbyS_srgb: ${F(h.brFbyS_srgb)}`);
      console.log(`    lumaFbyS_srgb: ${F(h.lumaFbyS_srgb)}`);
    }
  }
  await page.close();
}
await browser.close();
