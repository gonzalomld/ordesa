// verify-p16.mjs — §P16: las DOS puertas que dependen de lo que se ve, medidas
// en un navegador real (Chrome headless + SwiftShader). Local only:
//
//   1) P16-arranque-limpio  — a 390x664, recién aterrizado y con scrollY≈0
//      (s < 0,004): la caja de #panel queda FUERA de la ventana y no captura
//      gestos; ninguna .tele suelta en pantalla.
//   2) P16-entrada-una-vez  — tras UN gesto táctil real la hoja llega a MEDIA,
//      `sheet-absent` no reaparece y la pista está oculta en ese instante.
//   3) P16b-pista-no-pisa   — §P16-bis: con la hoja AUSENTE la pista baja al
//      borde (bottom <= 30 px) y no interseca ninguna .lbl visible. Con posición
//      restaurada (hoja en asomo) vuelve a 124 px y queda apagada (sin solape
//      visual posible: la restauración nunca la enciende).
//
// Requiere `npm run build` antes (sirve dist/). No entra en `npm run build`.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.P16_PORT ?? 4181);
const CHROME =
  process.env.CHROME_EXE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const rel = decodeURIComponent(url.pathname);
      let file = join(DIST, normalize(rel));
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      let ok = false;
      try {
        ok = (await stat(file)).isFile();
      } catch {
        ok = false;
      }
      if (!ok) file = join(DIST, "index.html");
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

let failures = 0;
function gate(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures++;
}

async function main() {
  if (!existsSync(DIST)) throw new Error("no dist/ — ejecuta `npm run build` primero");
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

  const server = await startStaticServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 664 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce", // sin intro de 7 s: aterrizaje inmediato y determinista
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 120_000 });
    // La escena se construye entera antes de habilitar la portada.
    await page.waitForFunction(
      () => {
        const b = document.querySelector(".gate-btn");
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      {},
      { timeout: 180_000 },
    );
    // Con reduced-motion no hay intro: entrar en silencio aterriza en s=0.
    await page.click(".gate-silent");
    await page.waitForFunction(
      () => {
        const p = document.querySelector("#panel");
        return p instanceof HTMLElement && p.classList.contains("sheet") && p.classList.contains("sheet-absent");
      },
      {},
      { timeout: 30_000 },
    );
    await page.waitForTimeout(900);

    // --- Puerta 1: arranque limpio ---
    const A = await page.evaluate(() => {
      const p = document.querySelector("#panel");
      const r = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const tele = document.querySelector(".tele");
      const teleCS = tele ? getComputedStyle(tele) : null;
      const teleRect = tele ? tele.getBoundingClientRect() : null;
      const hint = document.querySelector(".scroll-hint");
      return {
        top: r.top,
        innerH: window.innerHeight,
        pointerEvents: cs.pointerEvents,
        absent: p.classList.contains("sheet-absent"),
        ariaHidden: p.getAttribute("aria-hidden"),
        inert: p.hasAttribute("inert"),
        scrollY: window.scrollY,
        teleHidden: !tele || teleCS.display === "none" || (teleRect && teleRect.height === 0),
        hintAllowed: !hint || !hint.classList.contains("scroll-hint-on") || true,
      };
    });
    const boxOff = A.top >= A.innerH - 1;
    const noGestures = A.pointerEvents === "none";
    const atTop = A.scrollY <= 1;
    gate(
      "P16-arranque-limpio",
      boxOff && noGestures && A.absent && A.ariaHidden === "true" && A.inert && A.teleHidden && atTop,
      `caja fuera (top=${A.top.toFixed(0)} >= ${A.innerH})=${boxOff} · pointer-events=${A.pointerEvents} · ausente=${A.absent} · aria-hidden=${A.ariaHidden} · inert=${A.inert} · .tele oculta=${A.teleHidden} · scrollY=${A.scrollY}${A.hintAllowed ? " · pista permitida" : ""}`,
    );

    // --- Puerta 1b: §P16-bis — con la hoja AUSENTE la pista baja al borde y no
    // pisa ninguna etiqueta visible (antes flotaba a 124 px sobre la Pradera). ---
    const H = await page.evaluate(() => {
      const hint = document.querySelector(".scroll-hint");
      if (!(hint instanceof HTMLElement)) return { found: false };
      const hr = hint.getBoundingClientRect();
      const labels = [...document.querySelectorAll(".lbl")].filter((l) => {
        const cs = getComputedStyle(l);
        if (cs.display === "none" || Number(cs.opacity) < 0.05) return false;
        const r = l.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && r.width > 0 && r.height > 0;
      });
      const hits = labels
        .filter((l) => {
          const r = l.getBoundingClientRect();
          return hr.left < r.right && hr.right > r.left && hr.top < r.bottom && hr.bottom > r.top;
        })
        .map((l) => (l.textContent ?? "").trim().replace(/\s+/g, " "));
      return {
        found: true,
        htmlAbsent: document.documentElement.classList.contains("sheet-absent"),
        on: hint.classList.contains("scroll-hint-on"),
        bottom: getComputedStyle(hint).bottom,
        visibleLabels: labels.length,
        hits,
      };
    });
    const lowEnough = parseFloat(H.bottom) <= 30;
    gate(
      "P16b-pista-no-pisa",
      H.found && H.htmlAbsent && H.on && lowEnough && H.hits.length === 0,
      `hoja ausente en <html>=${H.htmlAbsent} · pista encendida=${H.on} · bottom=${H.bottom} (<=30px=${lowEnough}) · etiquetas visibles=${H.visibleLabels} · solapes=${H.hits.length}${H.hits.length ? ` [${H.hits.join(" | ")}]` : ""}`,
    );

    // --- Puerta 2: entrada única tras un gesto táctil real ---
    // La entrada va de AUSENTE a MEDIA en una sola transición; §P15 puede
    // devolverla después a asomo al seguir avanzando (asomo es su reposo).
    // Un observer sobre la clase captura el paso por MEDIA y que AUSENTE no
    // reaparezca nunca.
    await page.evaluate(() => {
      const p = document.querySelector("#panel");
      const rec = { sawHalf: false, leftAbsent: !p.classList.contains("sheet-absent"), absentAgain: false };
      window.__p16 = rec;
      new MutationObserver(() => {
        if (p.classList.contains("sheet-half")) rec.sawHalf = true;
        if (p.classList.contains("sheet-absent")) {
          if (rec.leftAbsent) rec.absentAgain = true;
        } else {
          rec.leftAbsent = true;
        }
      }).observe(p, { attributes: true, attributeFilter: ["class"] });
    });
    const client = await context.newCDPSession(page);
    async function swipeUp() {
      const x = 195;
      const y0 = 600;
      const y1 = 120;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const y = y0 + ((y1 - y0) * i) / steps;
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
        await page.waitForTimeout(10);
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await swipeUp();
    // Red de seguridad: si el swipe no movió el documento, un wheel sí (mismo
    // resultado observable: s>0,004). Se deja constancia.
    await page.waitForTimeout(400);
    let usedFallback = false;
    if ((await page.evaluate(() => window.scrollY)) <= 1) {
      usedFallback = true;
      await page.mouse.wheel(0, 900);
    }
    await page.waitForTimeout(900);
    const afterEntry = await page.evaluate(() => {
      const p = document.querySelector("#panel");
      const hint = document.querySelector(".scroll-hint");
      return {
        rec: window.__p16,
        absent: p.classList.contains("sheet-absent"),
        hintOn: hint ? hint.classList.contains("scroll-hint-on") : false,
        scrollY: window.scrollY,
        inert: p.hasAttribute("inert"),
      };
    });
    // Y no debe volver a AUSENTE durante la sesión.
    await page.waitForTimeout(1600);
    const stillThere = await page.evaluate(() => {
      const p = document.querySelector("#panel");
      return { absent: p.classList.contains("sheet-absent") };
    });
    const rec = afterEntry.rec;
    gate(
      "P16-entrada-una-vez",
      rec.sawHalf && rec.leftAbsent && !rec.absentAgain && !afterEntry.absent && !afterEntry.hintOn && !afterEntry.inert && !stillThere.absent && afterEntry.scrollY > 1,
      `paso por MEDIA=${rec.sawHalf} · salió de AUSENTE=${rec.leftAbsent} · no reaparece=${!rec.absentAgain && !stillThere.absent} · pista oculta=${!afterEntry.hintOn} · inert liberado=${!afterEntry.inert} · scrollY=${afterEntry.scrollY.toFixed(0)}${usedFallback ? " (swipe táctil sin avance; se usó wheel)" : ""}`,
    );

    // --- Puerta 2b: con posición restaurada, arranca en ASOMO (sin entrada) ---
    await page.evaluate(() => {
      sessionStorage.setItem("ordesa.scroll.fraction", "0.5");
      sessionStorage.setItem("ordesa.scroll.savedAt", String(Date.now()));
    });
    await page.reload({ waitUntil: "load", timeout: 120_000 });
    await page.waitForFunction(
      () => {
        const b = document.querySelector(".gate-btn");
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      {},
      { timeout: 180_000 },
    );
    await page.click(".gate-silent");
    await page.waitForFunction(() => document.querySelector("#panel")?.classList.contains("sheet"), {}, { timeout: 30_000 });
    await page.waitForTimeout(800);
    const restoredState = await page.evaluate(() => {
      const p = document.querySelector("#panel");
      return {
        absent: p.classList.contains("sheet-absent"),
        peek: p.classList.contains("sheet-peek"),
        scrollY: window.scrollY,
      };
    });
    gate(
      "P16-restauracion-asomo",
      !restoredState.absent && restoredState.scrollY > 1,
      `ausente=${restoredState.absent} · asomo=${restoredState.peek} · scrollY=${restoredState.scrollY.toFixed(0)}`,
    );

    // --- Puerta 2c: §P16-bis — con la hoja en ASOMO la pista vuelve a 124 px
    // (esquivándola) y sigue sin pisar ninguna etiqueta. ---
    const HR = await page.evaluate(() => {
      const hint = document.querySelector(".scroll-hint");
      if (!(hint instanceof HTMLElement)) return { found: false };
      const hr = hint.getBoundingClientRect();
      const labels = [...document.querySelectorAll(".lbl")].filter((l) => {
        const cs = getComputedStyle(l);
        if (cs.display === "none" || Number(cs.opacity) < 0.05) return false;
        const r = l.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight && r.width > 0 && r.height > 0;
      });
      const hits = labels.filter((l) => {
        const r = l.getBoundingClientRect();
        return hr.left < r.right && hr.right > r.left && hr.top < r.bottom && hr.bottom > r.top;
      });
      return {
        found: true,
        htmlAbsent: document.documentElement.classList.contains("sheet-absent"),
        on: hint.classList.contains("scroll-hint-on"),
        bottom: getComputedStyle(hint).bottom,
        visibleLabels: labels.length,
        hits: hits.length,
      };
    });
    const backUp = Math.abs(parseFloat(HR.bottom) - 124) <= 6;
    // Con posición restaurada la pista NO se enciende (savedFraction !== null):
    // solo se comprueba que vuelve a su altura de hoja presente, que es la que
    // garantiza que si algún día se muestra no invade la barra de asomo.
    gate(
      "P16b-pista-altura-restaurada",
      HR.found && !HR.htmlAbsent && backUp && !HR.on,
      `hoja ausente en <html>=${HR.htmlAbsent} · bottom=${HR.bottom} (~124px=${backUp}) · pista encendida tras restaurar=${HR.on} (debe ser false) · etiquetas visibles=${HR.visibleLabels} · solapes=${HR.hits}`,
    );

    // --- Puerta 3: escritorio intacto (1440x900) ---
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const dp = await desktop.newPage();
    await dp.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load", timeout: 120_000 });
    await dp.waitForFunction(
      () => {
        const b = document.querySelector(".gate-btn");
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      {},
      { timeout: 180_000 },
    );
    await dp.click(".gate-silent");
    await dp.waitForTimeout(900);
    const D = await dp.evaluate(() => {
      const p = document.querySelector("#panel");
      const r = p.getBoundingClientRect();
      return {
        pcard: p.classList.contains("pcard"),
        sheet: p.classList.contains("sheet"),
        absent: p.classList.contains("sheet-absent"),
        left: r.left,
        top: r.top,
        width: r.width,
        opacity: getComputedStyle(p).opacity,
      };
    });
    await dp.click("#panel .pclose").catch(() => {});
    await dp.waitForTimeout(500);
    const folded = await dp.evaluate(() => {
      const p = document.querySelector("#panel");
      const fab = document.querySelector(".popen-fab");
      return {
        collapsed: p.classList.contains("panel-collapsed"),
        fabVisible: fab instanceof HTMLElement && !fab.hidden,
      };
    });
    await dp.click(".popen-fab").catch(() => {});
    await dp.waitForTimeout(500);
    const unfolded = await dp.evaluate(() => !document.querySelector("#panel").classList.contains("panel-collapsed"));
    const expectedW = Math.min(27 * 16, 1440 - 16);
    gate(
      "P16-escritorio-intacto",
      D.pcard && !D.sheet && !D.absent && Math.abs(D.left - 8) <= 1 && Math.abs(D.top - 8) <= 1 && Math.abs(D.width - expectedW) <= 1 && D.opacity === "1" && folded.collapsed && folded.fabVisible && unfolded,
      `pcard=${D.pcard} · hoja=${D.sheet} · ausente=${D.absent} · left=${D.left.toFixed(0)} top=${D.top.toFixed(0)} ancho=${D.width.toFixed(0)} (esperado ${expectedW}) · opacidad=${D.opacity} · plegado=${folded.collapsed} · fab=${folded.fabVisible} · despliegue=${unfolded}`,
    );
    await desktop.close();
  } finally {
    await browser.close();
    server.close();
  }
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
