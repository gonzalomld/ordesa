// verify-m2.mjs — §M2 (el carrete): puertas que necesitan navegador real
// (Chrome headless + SwiftShader). Local only, no entra en `npm run build`.
//
//   1) M2-sin-fotos-no-abre   — photos.json vacío: el clic no monta carrete ni
//      para el scroll.
//   2) M2-scroll-devuelto     — abrir→cerrar deja el candado libre.
//   3) M2-una-sola-instancia  — abrir otra chapa sustituye, no apila.
//   4) M2-cero-texturas       — renderer.info.memory.textures igual antes/durante/
//      después.
//   5) M2-fotos-liberadas     — tras cerrar no quedan <img> del carrete.
//   6) M2-atribucion-visible  — autor + licencia (enlace) siempre visibles.
//   7) M2-salida-garantizada  — Esc, clic fuera y botón ≥44×44.
//   8) M2-foco-devuelto       — el foco vuelve a la chapa.
//   9) M2-entrada-por-rumbo   — con reduced-motion no hay desplazamiento.
//  10) M2-demo-abre           — ?fotos=demo rellena con marcos "sin foto todavía".
//
// Requiere `npm run build` antes (sirve dist/).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const PORT = Number(process.env.M2_PORT ?? 4183);
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

const TINY =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const FOTOS = {
  pradera: [
    {
      src: TINY,
      w: 1200,
      h: 800,
      titulo: "Hacia el circo desde la pradera",
      sujeto: "Tozal del Mallo",
      az: 29,
      el: 41.8,
      km: 1.0,
      exif: "ƒ/8 · 1/320 · 35 mm · 08:40",
      autor: "A. Bielsa",
      licencia: "CC BY-SA 4.0",
      licenciaUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      origen: "https://example.org/pradera",
    },
  ],
  soaso: [
    {
      src: TINY,
      w: 1200,
      h: 800,
      titulo: "El circo y la cascada",
      sujeto: "Monte Perdido",
      az: 26,
      el: 25.9,
      km: 3.3,
      exif: "ƒ/9 · 1/250 · 50 mm · 11:10",
      autor: "A. Bielsa",
      licencia: "CC BY-SA 4.0",
      licenciaUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      origen: "https://example.org/soaso",
    },
  ],
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

async function enter(page, query = "") {
  await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const b = document.querySelector(".gate-btn");
      return b instanceof HTMLButtonElement && !b.disabled;
    },
    {},
    { timeout: 180_000 },
  );
  await page.click(".gate-silent");
}

async function openMarker(page, id) {
  await page.evaluate((mid) => {
    const hit = document.querySelector(`.marker[data-id="${mid}"] .marker-hit`);
    if (hit) hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }, id);
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".carrete");
      return c instanceof HTMLElement && !c.hidden;
    },
    {},
    { timeout: 5_000 },
  );
}

async function waitClosed(page) {
  await page.waitForFunction(
    () => {
      const c = document.querySelector(".carrete");
      return !(c instanceof HTMLElement) || c.hidden;
    },
    {},
    { timeout: 5_000 },
  );
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
    // --- Contexto principal (móvil, reduced-motion: sin intro) ---
    const context = await browser.newContext({
      viewport: { width: 390, height: 664 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });

    // 1) sin fotos no abre -------------------------------------------------
    {
      const page = await context.newPage();
      await page.route("**/assets/photos.json", (r) =>
        r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fotos: {} }) }),
      );
      await enter(page);
      await page.waitForFunction(() => document.querySelectorAll(".marker").length === 8, {}, { timeout: 60_000 });
      await page.evaluate(() => {
        const hit = document.querySelector('.marker[data-id="pradera"] .marker-hit');
        if (hit) hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(400);
      const S = await page.evaluate(() => {
        const c = document.querySelector(".carrete");
        const cs = c ? getComputedStyle(c) : null;
        return {
          exists: !!c,
          visible: !!c && !c.hidden && cs?.display !== "none",
          stopped: window.__lock?.stopped ?? null,
          imgs: document.querySelectorAll(".carrete img").length,
        };
      });
      gate("M2-sin-fotos-no-abre", !S.visible && S.stopped === false && S.imgs === 0,
        `carrete visible=${S.visible} · existe shell=${S.exists} · scroll parado=${S.stopped} · imgs=${S.imgs}`);
      await page.close();
    }

    // Página con fotos enrutadas ------------------------------------------
    const page = await context.newPage();
    await page.route("**/assets/photos.json", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ fotos: FOTOS }) }),
    );
    await enter(page);
    await page.waitForFunction(() => document.querySelectorAll(".marker").length === 8, {}, { timeout: 60_000 });

    // 2) scroll devuelto ---------------------------------------------------
    {
      await openMarker(page, "pradera");
      const stopped = await page.evaluate(() => window.__lock?.stopped ?? null);
      await page.keyboard.press("Escape");
      await waitClosed(page);
      await page.waitForTimeout(60);
      const after = await page.evaluate(() => ({
        stopped: window.__lock?.stopped ?? null,
        overflow: document.body.style.overflow,
      }));
      gate("M2-scroll-devuelto", stopped === true && after.stopped === false && after.overflow === "",
        `abrir stop=${stopped} · cerrar stop=${after.stopped} · overflow="${after.overflow}"`);
    }

    // 3) una sola instancia ------------------------------------------------
    {
      await openMarker(page, "pradera");
      const t1 = await page.evaluate(() => document.querySelector(".carrete-titulo")?.textContent ?? "");
      await openMarker(page, "soaso");
      await page.waitForTimeout(300);
      const I = await page.evaluate(() => ({
        shells: document.querySelectorAll(".carrete").length,
        title: document.querySelector(".carrete-titulo")?.textContent ?? "",
      }));
      gate("M2-una-sola-instancia", I.shells === 1 && I.title !== t1 && I.title.includes("cascada"),
        `${I.shells} .carrete · título «${t1}» → «${I.title}»`);
      await page.keyboard.press("Escape");
      await waitClosed(page);
    }

    // 4) cero texturas -----------------------------------------------------
    {
      const before = await page.evaluate(() => window.__renderer?.info?.memory?.textures ?? -1);
      await openMarker(page, "pradera");
      await page.waitForTimeout(200);
      const during = await page.evaluate(() => window.__renderer?.info?.memory?.textures ?? -1);
      await page.keyboard.press("Escape");
      await waitClosed(page);
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => window.__renderer?.info?.memory?.textures ?? -1);
      gate("M2-cero-texturas", before >= 0 && before === during && during === after,
        `textures antes=${before} · abierto=${during} · cerrado=${after}`);
    }

    // 5) fotos liberadas ---------------------------------------------------
    {
      await openMarker(page, "pradera");
      await page.waitForTimeout(150);
      const openImgs = await page.evaluate(() => document.querySelectorAll(".carrete img").length);
      await page.keyboard.press("Escape");
      await waitClosed(page);
      await page.waitForTimeout(300);
      const afterImgs = await page.evaluate(() => ({
        carrete: document.querySelectorAll(".carrete img").length,
        data: document.querySelectorAll('img[src^="data:image"]').length,
      }));
      // abrir y cerrar varias veces no acumula nodos
      for (const id of ["pradera", "soaso", "pradera"]) {
        await openMarker(page, id);
        await page.keyboard.press("Escape");
        await waitClosed(page);
      }
      const many = await page.evaluate(() => document.querySelectorAll(".carrete img").length);
      gate("M2-fotos-liberadas", openImgs >= 1 && afterImgs.carrete === 0 && afterImgs.data === 0 && many === 0,
        `abierto imgs=${openImgs} · tras cerrar carrete=${afterImgs.carrete}/data=${afterImgs.data} · tras 3 ciclos=${many}`);
    }

    // 6) atribución visible ------------------------------------------------
    {
      await openMarker(page, "pradera");
      await page.waitForTimeout(150);
      const A = await page.evaluate(() => {
        const card = document.querySelector(".carrete-card.is-active");
        const credit = card?.querySelector(".cc-credit");
        const link = credit?.querySelector("a");
        const cs = credit ? getComputedStyle(credit) : null;
        const meta = document.querySelector(".carrete-meta");
        const metaLink = meta?.querySelector("a");
        return {
          cardText: credit?.textContent ?? "",
          cardHref: link?.getAttribute("href") ?? "",
          cardVisible: !!credit && cs?.display !== "none" && cs?.visibility !== "hidden",
          metaText: meta?.textContent ?? "",
          metaHref: metaLink?.getAttribute("href") ?? "",
        };
      });
      const ok =
        A.cardVisible &&
        A.cardText.includes("A. Bielsa") &&
        A.cardText.includes("CC BY-SA 4.0") &&
        A.cardHref === "https://creativecommons.org/licenses/by-sa/4.0/" &&
        A.metaText.includes("A. Bielsa") &&
        A.metaHref === "https://creativecommons.org/licenses/by-sa/4.0/";
      gate("M2-atribucion-visible", ok,
        `tarjeta visible=${A.cardVisible} «${A.cardText}» href=${A.cardHref} · pie «${A.metaText}» href=${A.metaHref}`);
      await page.keyboard.press("Escape");
      await waitClosed(page);
    }

    // 7) salida garantizada ------------------------------------------------
    {
      await openMarker(page, "pradera");
      const B = await page.evaluate(() => {
        const btn = document.querySelector(".carrete-close");
        if (!(btn instanceof HTMLElement)) return { found: false };
        const r = btn.getBoundingClientRect();
        return { found: true, w: r.width, h: r.height, inDom: true };
      });
      // Esc cierra
      await page.keyboard.press("Escape");
      await waitClosed(page);
      const escClosed = true;
      // clic fuera cierra
      await openMarker(page, "pradera");
      await page.evaluate(() => {
        const v = document.querySelector(".carrete-veil");
        v?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await waitClosed(page);
      gate("M2-salida-garantizada", B.found && B.w >= 44 && B.h >= 44 && escClosed,
        `botón ${B.found ? `${B.w.toFixed(0)}×${B.h.toFixed(0)}` : "no"} ≥44 · Esc cierra=${escClosed} · clic fuera cierra=true`);
    }

    // 8) foco devuelto -----------------------------------------------------
    {
      await openMarker(page, "pradera");
      await page.keyboard.press("Escape");
      await waitClosed(page);
      await page.waitForTimeout(350);
      const F = await page.evaluate(() => {
        const ae = document.activeElement;
        const marker = ae instanceof HTMLElement ? ae.closest(".marker") : null;
        return { tag: ae?.tagName ?? null, cls: ae instanceof HTMLElement ? ae.className : null, id: marker?.getAttribute("data-id") ?? null };
      });
      gate("M2-foco-devuelto", F.id === "pradera" && (F.cls ?? "").includes("marker-hit"),
        `activeElement=<${F.tag} class="${F.cls}"> · chapa=${F.id}`);
    }

    // 9) entrada por rumbo: reduced-motion sin desplazamiento --------------
    {
      await openMarker(page, "pradera");
      const R = await page.evaluate(() => {
        const card = document.querySelector(".carrete-card");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const tp = card ? getComputedStyle(card).transitionProperty : "";
        return { reduced, tp };
      });
      await page.keyboard.press("Escape");
      await waitClosed(page);
      gate("M2-entrada-por-rumbo", R.reduced && !R.tp.includes("transform"),
        `reduced-motion=${R.reduced} · transition-property="${R.tp}" (sin transform)`);
    }

    await page.close();

    // 10) demo -------------------------------------------------------------
    {
      const dp = await context.newPage();
      await enter(dp, "?fotos=demo");
      await dp.waitForFunction(() => document.querySelectorAll(".marker").length === 8, {}, { timeout: 60_000 });
      await openMarker(dp, "gradas");
      await dp.waitForTimeout(150);
      const D = await dp.evaluate(() => {
        const demo = document.querySelector(".carrete-card.is-active .cc-demo");
        return { text: demo?.textContent ?? "", corners: document.querySelectorAll(".carrete-card.is-active .cc-corner").length };
      });
      gate("M2-demo-abre", D.text.includes("sin foto todavía") && D.corners === 4,
        `demo «${D.text.replace(/\s+/g, " ").trim()}» · escuadras=${D.corners}`);
      await dp.close();
    }
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
