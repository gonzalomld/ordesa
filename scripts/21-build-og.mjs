// 21-build-og.mjs — generation tool (NOT part of `npm run build`/CI): captures
// the real entry gate (P11 "Umbral") over frame 0 of the intro flight from a
// local `dist/` build and writes the Open Graph / Twitter card image.
//
// Why a screenshot: the portada is WebGL-rendered, so the only faithful poster
// is the live first frame. Chrome's SwiftShader paints it headless; the gate
// parks the camera on introSample(0), so the shot is deterministic.
//
// Local only. Needs Google Chrome + the versioned `dist/` (run `npm run build`
// first). Output: public/assets/og-senda.jpg (1200x630, JPG, OG-safe weight).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import sharp from "sharp";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const OUT = process.env.OG_OUT
  ? (process.env.OG_OUT.startsWith("/")
      ? process.env.OG_OUT
      : join(ROOT, process.env.OG_OUT))
  : join(ROOT, "public", "assets", "og-senda.jpg");
const PORT = Number(process.env.OG_PORT ?? 4179);
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
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      let file = join(DIST, normalize(rel));
      if (!file.startsWith(DIST)) {
        res.writeHead(403).end();
        return;
      }
      let ok = false;
      try {
        const s = await stat(file);
        ok = s.isFile();
      } catch {
        ok = false;
      }
      if (!ok) {
        // SPA fallback (same intent as the vercel.json rewrite).
        file = join(DIST, "index.html");
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  if (!existsSync(DIST)) throw new Error(`no dist/ — run \`npm run build\` first`);
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);

  const server = await startStaticServer();
  const base = `http://127.0.0.1:${PORT}/`;
  // SwiftShader is the portable default (headless CI-ish boxes); on a real
  // desktop GPU the capture is faithful — set OG_GPU=1 to use the real card.
  const gpu = process.env.OG_GPU === "1";
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !gpu,
    args: gpu
      ? ["--no-sandbox"]
      : [
          "--no-sandbox",
          "--use-angle=swiftshader",
          "--enable-unsafe-swiftshader",
          "--disable-gpu-sandbox",
        ],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 630 },
      deviceScaleFactor: 1, // SwiftShader chokes on 2x full-scene captures
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base, { waitUntil: "load", timeout: 120_000 });

    // Gate stands until the whole scene is built: enabled === first painted
    // frame with the rig parked on introSample(0).
    await page.waitForFunction(
      () => {
        const b = document.querySelector(".gate-btn");
        return b instanceof HTMLButtonElement && !b.disabled;
      },
      {},
      { timeout: 180_000 },
    );
    await page.evaluate(() => document.fonts.ready.catch(() => {}));
    // veil fade (900ms) + label/data settle + a few real frames.
    await page.waitForTimeout(3000);

    const shot = await page.screenshot({ type: "png", timeout: 120_000 });
    await sharp(shot)
      .resize(1200, 630, { fit: "cover", kernel: "lanczos3" })
      .jpeg({ quality: 86, mozjpeg: true, progressive: true, chromaSubsampling: "4:4:4" })
      .toFile(OUT);

    const { size } = await stat(OUT);
    console.log(`og-senda.jpg ${(size / 1024).toFixed(1)} kB`);
    if (errors.length) console.log(`page errors: ${errors.join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
