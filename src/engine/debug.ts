// debug.ts — D10/S3: ?debug=1 overlay + window.__metrics + ?t=HH:MM&cam=.
//
// S3: the old msTerrain/msClouds numbers measured JS time around
// renderer.render — meaningless against 1.8M triangles (0.4 ms ≈ 2500 fps).
// Now: msFrame is a moving average of REAL rAF-to-rAF deltas (the actual
// frame), plus an EXT_disjoint_timer_query_webgl2 GPU split (terrain vs
// clouds) when the extension exists. JS slices stay as jsTerrain/jsLabels.
import type { ProgressState } from "../narrative/progress.ts";

export interface Metrics {
  msTerrain: number; // GPU terrain pass (timer query) or -1 if unavailable
  msClouds: number; // GPU clouds pass (timer query) or -1 if unavailable
  msPost: number;
  msLabels: number;
  msFrame: number; // real rAF-delta moving average
  jsTerrain: number;
  jsLabels: number;
  fps: number;
  cloudCoverage: number;
  zenithHex: string; // A1: sky-model zenith colour (computed, not read)
  fog10km: number; // A1: fog factor at 10 km with the live formula
  steep: boolean; // steep weight-map mode (?debug=steep)
  hasRock: number; // procedural grain active (1) — kept for overlay compat
  rockWeightShown: number; // live uRockWeight value
  drawCalls: number;
  triangles: number;
  /** §4b FASE 2b: renderer.render() calls per frame (1 main; +1 skymap blit;
   * probes run inside the 30-frame block and are NOT counted here). */
  passes: number;
  maxTextureSize: number;
  dpr: number;
  lod: number;
  texLevel: string;
  time: string;
  cam: string;
  // Phase 3A journey magnitudes (?debug=1 readable, no console needed).
  // G14: the FULL ProgressState is mirrored here — z, slopePct, climbM
  // included — so the audit can compare bar vs HUD vs track from outside.
  journey: ProgressState | null;
  s: number;
  d: number;
  hour: string;
  yaw: number;
  pitch: number;
  dist: number;
  holgura: number;
  /** G16 (pasada rig puro): damped H correction the camera flies with. */
  corrH: number;
  luma: number;
  /** §4b FASE 5 (G31/G32): sonda de sombra — luma lineal media del cuartil
   * más oscuro de píxeles de terreno (?luma=1, -1 = pendiente). */
  lumaShadow: number;
  /** §4b FASE 5: croma media (max-min)/max en ese cuartil (0 = gris). */
  chromaShadow: number;
  warn: string;
}

export interface BootQuery {
  debug: boolean;
  steep: boolean;
  path: boolean;
  t: string | null;
  cam: string | null;
  clouds: number;
  s: number | null;
  act: string | null;
  orbit: boolean;
  /** BLOQUEANTE isolation probe: draw the whole track (uProgressDist =
   * lengthM) without touching anything else. Answers geometry-vs-cut. */
  trackAll: boolean;
  /** Rastro invertido: vDist gradient probe (?debug=trackdist). One load,
   * one answer — blue Pradera / red Cola, or the inverse, or flat. */
  trackDist: boolean;
  /** Rastro enterrado: ghost pass to magenta at opacity 1 (?ghost=1).
   * The ghost draws exactly what lies behind the terrain. */
  ghost: boolean;
  /** §4b FASE 2: equirect sky-capture blit (?skymap=1, independent flag,
   * combinable with ?debug=1). The 64×32 capture target scaled ×6 in the
   * lower-left corner, own ortho scene, after main render + labels. */
  skymap: boolean;
  /** Rastro feedback-loop: skip the sky capture (?skycap=0 freezes zenith).
   * Isolation probe — if the track appears with the capture off, the loop
   * was in the capture. */
  skycap: boolean;
  /** ?lod=N: pin the terrain LOD and disable the frame-budget rule. */
  lod: number | null;
  /** N2: ?debug=atlas — blitea el atlas de nubes ×0,5 abajo a la izquierda. */
  atlas: boolean;
  /** N2b: ?family=N (0-3) u off — filtro del medidor de nubes por familia. */
  family: number;
  /** N2c: ?debug=cloudshadow — terreno en gris = factor de sombra (verlo). */
  cloudshadow: boolean;
  /** N2c: ?cloudshadow=0 — sombras desactivadas (G55: niebla intacta). */
  cloudshadowOff: boolean;
}

function parseSParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw.trim().replace(",", "."));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

export function parseBootQuery(): BootQuery {
  const q = new URLSearchParams(location.search);
  const rawClouds = q.get("clouds");
  let clouds = 1;
  if (rawClouds !== null && rawClouds !== "") {
    const v = Number(rawClouds);
    clouds = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  }
  const mode = q.get("debug");
  const rawLod = q.get("lod");
  const lodN = rawLod === null || rawLod.trim() === "" ? null : Number(rawLod.trim());
  // N2b: ?family=N (0-3) filtra el medidor por familia; ?family=off lo apaga
  // (medida del rastro sin nubes para G52). -1 = sin filtro.
  const rawFam = q.get("family");
  let family = -1;
  if (rawFam !== null) {
    if (rawFam === "off") family = -2;
    else {
      const v = Number(rawFam);
      family = v >= 0 && v <= 3 && Number.isInteger(v) ? v : -1;
    }
  }
  return {
    debug: mode === "1" || mode === "steep",
    steep: mode === "steep",
    path: mode === "path",
    t: q.get("t"),
    cam: q.get("cam"),
    clouds,
    s: parseSParam(q.get("s")),
    act: q.get("act"),
    orbit: q.has("orbit"),
    trackAll: q.get("track") === "all",
    trackDist: q.get("debug") === "trackdist",
    ghost: q.has("ghost"),
    skymap: q.get("skymap") === "1",
    skycap: q.get("skycap") !== "0",
    atlas: q.get("debug") === "atlas",
    family,
    cloudshadow: q.get("debug") === "cloudshadow",
    cloudshadowOff: q.get("cloudshadow") === "0",
    lod: lodN !== null && Number.isFinite(lodN) && [1, 2, 3].includes(lodN) ? lodN : null,
  };
}

export function mountDebug(): { metrics: Metrics; el: HTMLElement | null } {
  const metrics: Metrics = {
    msTerrain: -1,
    msClouds: -1,
    msPost: 0,
    msLabels: 0,
    msFrame: 0,
    jsTerrain: 0,
    jsLabels: 0,
    fps: 0,
    cloudCoverage: 0,
    // §4b FASE 3: written ONLY by the 30-frame capture probe (display
    // values). "—" until the probe first runs (G28: single writer).
    zenithHex: "—",
    fog10km: 0,
    steep: false,
    hasRock: 0,
    rockWeightShown: 1,
  drawCalls: 0,
  triangles: 0,
  passes: 1,
    maxTextureSize: 0,
    dpr: Math.min(window.devicePixelRatio, 2),
    lod: 2,
    texLevel: "",
    time: "",
    cam: "",
    // G14: frozen shape — progress.update() mutates the live object, so the
    // mirror is a COPY taken after update(), never the live reference.
    journey: null,
    s: 0,
    d: 0,
    hour: "",
    yaw: 0,
    pitch: 0,
    dist: 0,
    holgura: Infinity,
    corrH: 0,
    luma: -1,
    lumaShadow: -1,
    chromaShadow: -1,
    warn: "",
  };
  (window as unknown as { __metrics: Metrics }).__metrics = metrics;
  if (!parseBootQuery().debug) return { metrics, el: null };
  const el = document.createElement("div");
  el.className = "dbg";
  document.body.appendChild(el);
  let last = "";
  const id = window.setInterval(() => {
    // §4b FASE 2b: drawCalls/triangles are written by the LOOP right after
    // the main render (main pass only). The poll never reads renderer.info
    // (it would see the last probe/blit pass of the frame — "calls 1").
    const gpu = (v: number): string => (v < 0 ? "n/a" : `${v.toFixed(1)} ms`);
    const s =
      `frame ${metrics.msFrame.toFixed(1)} ms (${metrics.fps.toFixed(0)} fps) · js terr ${metrics.jsTerrain.toFixed(1)} · js etiq ${metrics.jsLabels.toFixed(1)}\n` +
      `gpu terr ${gpu(metrics.msTerrain)} · nub ${gpu(metrics.msClouds)} · cobertura ${(metrics.cloudCoverage * 100).toFixed(0)}%\n` +
      `calls ${metrics.drawCalls} · tris ${(metrics.triangles / 1e6).toFixed(2)}M · pases ${metrics.passes} · maxTex ${metrics.maxTextureSize} · dpr ${metrics.dpr} · lod ${metrics.lod} · ${metrics.texLevel}\n` +
      `${metrics.time} · cam ${metrics.cam} · cenit ${metrics.zenithHex} · niebla10km ${metrics.fog10km.toFixed(2)}\n` +
      // A10: yaw printed mod 360 (readable); unwrapped in parens for debug.
      // G16: corrH (damped H correction) rides along — nodding reads here.
      `s ${metrics.s.toFixed(4)} · d ${(metrics.d / 1000).toFixed(2)} km · hora ${metrics.hour} · yaw ${mod360(metrics.yaw).toFixed(1)}° (${metrics.yaw.toFixed(1)}°) · pitch ${metrics.pitch.toFixed(1)}° · dist ${metrics.dist.toFixed(0)} m · holgura ${Number.isFinite(metrics.holgura) ? metrics.holgura.toFixed(0) + " m" : "—"} · corrH ${metrics.corrH.toFixed(0)} m` +
      (metrics.luma >= 0 ? ` · luma ${metrics.luma.toFixed(3)}` : "") +
      // §4b FASE 5: "sombra L … C …" (HUD) = __lumaShadow/__chromaShadow.
      (metrics.lumaShadow >= 0 ? ` · sombra L ${metrics.lumaShadow.toFixed(3)} C ${metrics.chromaShadow.toFixed(2)}` : "") +
      (metrics.warn ? `\nAVISO ${metrics.warn}` : "") +
      (metrics.steep ? `\nsteep MAP · hasRock ${metrics.hasRock} · peso roca ${Math.round(metrics.rockWeightShown * 100)} %` : "");
    if (s !== last) {
      last = s;
      el.textContent = s;
    }
    void id;
  }, 250);
  return { metrics, el };
}

/** Rolling rAF-delta tracker — the only honest CPU-side frame clock. */
export function frameClock(metrics: Metrics, alpha = 0.08): () => void {
  let prev = -1;
  return () => {
    const now = performance.now();
    if (prev >= 0) {
      const dt = now - prev;
      metrics.msFrame += (dt - metrics.msFrame) * alpha;
      metrics.fps = 1000 / Math.max(1e-3, metrics.msFrame);
    }
    prev = now;
  };
}

// A10: readable yaw (0..360); the unwrapped value is printed alongside.
function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
