// verify-m1.mjs — §M1 fase 1 (la chapa): las puertas que necesitan un
// navegador real (Chrome headless + SwiftShader). Local only, no entra en
// `npm run build`.
//
//   1) M1-diez-marcadores — markers.json produce exactamente 10 runtimes (10
//      .marker con los 10 ids; §M4 añadió cazadores y sorores).
//   2) M1-toque-44      — el área de toque mide 44×44 px con independencia del
//      disco y el contenedor lleva touch-action: manipulation.
//   3) M1-sin-texturas  — renderer.info.memory.textures es igual con y sin
//      marcadores (?marcadores=0): DOM/SVG puro, ninguna textura nueva.
//   4) M1-clic-una-vez  — un clic emite exactamente un "marcador:abrir" con el
//      id correcto, llama a preventDefault/stopPropagation y no mueve el scroll.
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
const PORT = Number(process.env.M1_PORT ?? 4182);
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

const EXPECTED_IDS = [
  "pradera",
  "cazadores",
  "calcilarruego",
  "faja-pelay",
  "sorores",
  "soaso",
  "gradas",
  "estrecho",
  "cueva",
  "arripas",
];

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
      reducedMotion: "reduce",
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await enter(page);
    // Los marcadores se construyen durante el boot, antes del gate.
    await page.waitForFunction(() => document.querySelectorAll(".marker").length === 10, {}, { timeout: 60_000 });

    // --- Puerta 1: 10 runtimes con los 10 ids (§M4) ---
    const M = await page.evaluate(() => {
      const ms = [...document.querySelectorAll(".marker")];
      return { count: ms.length, ids: ms.map((m) => m.dataset.id) };
    });
    const allIds = EXPECTED_IDS.every((id) => M.ids.includes(id)) && new Set(M.ids).size === 10;
    gate(
      "M1-diez-marcadores",
      M.count === 10 && allIds,
      `${M.count} .marker · ids completos=${allIds} [${M.ids.join(", ")}]`,
    );

    // --- Puerta 2: toque 44×44 y touch-action ---
    const T = await page.evaluate(() => {
      const cont = document.querySelector(".markers");
      const hits = [...document.querySelectorAll(".marker-hit")];
      const sizes = hits.map((h) => {
        const s = getComputedStyle(h);
        return [s.width, s.height];
      });
      const vis = hits
        .map((h) => h.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => [r.width, r.height]);
      return { touchAction: getComputedStyle(cont).touchAction, sizes, vis };
    });
    const all44 = T.sizes.length === 10 && T.sizes.every(([w, h]) => w === "44px" && h === "44px");
    const vis44 = T.vis.every(([w, h]) => Math.abs(w - 44) <= 0.5 && Math.abs(h - 44) <= 0.5);
    gate(
      "M1-toque-44",
      T.touchAction === "manipulation" && all44 && vis44,
      `touch-action=${T.touchAction} · áreas 44×44=${all44} · visibles 44×44=${vis44} (${T.sizes.length} áreas, ${T.vis.length} visibles)`,
    );

    // --- Puerta 3: cero texturas nuevas (con vs sin ?marcadores=0) ---
    const texOn = await page.evaluate(() => window.__renderer?.info?.memory?.textures ?? -1);
    const page2 = await context.newPage();
    await enter(page2, "?marcadores=0");
    const noMarkers = await page2.evaluate(() => ({
      tex: window.__renderer?.info?.memory?.textures ?? -1,
      markers: document.querySelectorAll(".marker").length,
    }));
    await page2.close();
    gate(
      "M1-sin-texturas",
      texOn >= 0 && texOn === noMarkers.tex && noMarkers.markers === 0,
      `textures con marcadores=${texOn} · sin marcadores (${noMarkers.markers} .marker)=${noMarkers.tex} · iguales=${texOn === noMarkers.tex}`,
    );

    // --- Puerta 4: un clic = un evento, con id, preventDefault y sin scroll ---
    await page.evaluate(() => {
      window.__m1 = { count: 0, ids: [], pd: 0, sp: 0, scroll0: window.scrollY };
      window.addEventListener("marcador:abrir", (e) => {
        window.__m1.count++;
        window.__m1.ids.push(e.detail && e.detail.id);
      });
      const P = Event.prototype;
      const opd = P.preventDefault;
      const osp = P.stopPropagation;
      P.preventDefault = function () {
        window.__m1.pd++;
        return opd.apply(this, arguments);
      };
      P.stopPropagation = function () {
        window.__m1.sp++;
        return osp.apply(this, arguments);
      };
    });
    await page.evaluate(() => {
      const hit = document.querySelector('.marker[data-id="pradera"] .marker-hit');
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    const C = await page.evaluate(() => ({ ...window.__m1, scroll1: window.scrollY }));
    const oneEvent = C.count === 1 && C.ids[0] === "pradera";
    const noScroll = Math.abs(C.scroll1 - C.scroll0) <= 0;
    gate(
      "M1-clic-una-vez",
      oneEvent && C.pd > 0 && C.sp > 0 && noScroll,
      `eventos=${C.count} [${C.ids.join(",")}] · preventDefault=${C.pd} · stopPropagation=${C.sp} · scroll ${C.scroll0}->${C.scroll1}`,
    );

    // --- §M1-bis F: con ?s=0.34 la aguja de calcilarruego queda arriba a la
    // izquierda (≈ −62°), no abajo a la derecha (≈ +118°). ---
    const pagePose = await context.newPage();
    await enter(pagePose, "?s=0.34");
    await pagePose.waitForFunction(() => document.querySelectorAll(".marker").length === 8, {}, { timeout: 60_000 });
    await pagePose.waitForTimeout(400);
    const A = await pagePose.evaluate(() => {
      const el = document.querySelector('.marker[data-id="calcilarruego"]');
      if (!(el instanceof HTMLElement)) return { found: false };
      const cs = getComputedStyle(el);
      const needle = el.querySelector(".marker-needle");
      const x2 = Number(needle?.getAttribute("x2") ?? NaN);
      const y2 = Number(needle?.getAttribute("y2") ?? NaN);
      const angle = (Math.atan2(x2 - 20, -(y2 - 20)) * 180) / Math.PI;
      return { found: true, visible: cs.display !== "none" && Number(cs.opacity) > 0.05, x2, y2, angle };
    });
    await pagePose.close();
    const okAngle = A.found && A.visible && Math.abs(A.angle + 61.7) <= 4;
    gate(
      "M1-aguja-calcilarruego",
      okAngle,
      A.found
        ? `visible=${A.visible} · aguja=(${A.x2.toFixed(1)},${A.y2.toFixed(1)}) · ángulo=${A.angle.toFixed(1)}° (esperado -61.7±4)`
        : "marcador calcilarruego no encontrado",
    );

    // --- §M1-bis D: ningún disco visible pisa una etiqueta visible (0.34 y 0.62). ---
    const overlapAt = async (s) => {
      const p = await context.newPage();
      await enter(p, `?s=${s}`);
      await p.waitForFunction(() => document.querySelectorAll(".marker").length === 8, {}, { timeout: 60_000 });
      await p.waitForTimeout(400);
      const r = await p.evaluate(() => {
        const vis = (el) => {
          const cs = getComputedStyle(el);
          return cs.display !== "none" && Number(cs.opacity) > 0.05;
        };
        const markers = [...document.querySelectorAll(".marker")].filter(vis);
        const labels = [...document.querySelectorAll(".lbl")].filter(vis);
        let hits = 0;
        let worst = 0;
        const pairs = [];
        for (const m of markers) {
          const d = m.querySelector(".marker-disc").getBoundingClientRect();
          for (const l of labels) {
            const lr = l.getBoundingClientRect();
            const iw = Math.min(d.right, lr.right) - Math.max(d.left, lr.left);
            const ih = Math.min(d.bottom, lr.bottom) - Math.max(d.top, lr.top);
            if (iw > 0 && ih > 0) {
              hits++;
              worst = Math.max(worst, iw * ih);
              pairs.push(
                `${m.dataset.id}${getComputedStyle(m).getPropertyValue("--stem-extra")} vs «${(l.textContent ?? "").trim().slice(0, 18)}» ${iw.toFixed(0)}x${ih.toFixed(0)}`,
              );
            }
          }
        }
        return { hits, worst, discs: markers.length, labels: labels.length, pairs };
      });
      await p.close();
      return r;
    };
    const ov34 = await overlapAt("0.34");
    const ov62 = await overlapAt("0.62");
    gate(
      "M1-sin-solape-etiqueta",
      ov34.hits === 0 && ov62.hits === 0,
      `0.34: ${ov34.hits} solape(s) (máx ${ov34.worst.toFixed(0)} px², ${ov34.discs} discos/${ov34.labels} etiquetas) [${ov34.pairs.join(" | ")}] · 0.62: ${ov62.hits} (máx ${ov62.worst.toFixed(0)} px²)[${ov62.pairs.join(" | ")}]`,
    );
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
