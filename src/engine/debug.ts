// debug.ts — D10/S3: ?debug=1 overlay + window.__metrics + ?t=HH:MM&cam=.
//
// S3: the old msTerrain/msClouds numbers measured JS time around
// renderer.render — meaningless against 1.8M triangles (0.4 ms ≈ 2500 fps).
// Now: msFrame is a moving average of REAL rAF-to-rAF deltas (the actual
// frame), plus an EXT_disjoint_timer_query_webgl2 GPU split (terrain vs
// clouds) when the extension exists. JS slices stay as jsTerrain/jsLabels.
import * as THREE from "three";

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
  drawCalls: number;
  triangles: number;
  maxTextureSize: number;
  dpr: number;
  lod: number;
  texLevel: string;
  time: string;
  cam: string;
}

export function parseBootQuery(): { debug: boolean; t: string | null; cam: string | null } {
  const q = new URLSearchParams(location.search);
  return {
    debug: q.get("debug") === "1",
    t: q.get("t"),
    cam: q.get("cam"),
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
    drawCalls: 0,
    triangles: 0,
    maxTextureSize: 0,
    dpr: Math.min(window.devicePixelRatio, 2),
    lod: 2,
    texLevel: "",
    time: "",
    cam: "",
  };
  (window as unknown as { __metrics: Metrics }).__metrics = metrics;
  if (!parseBootQuery().debug) return { metrics, el: null };
  const el = document.createElement("div");
  el.className = "dbg";
  document.body.appendChild(el);
  let last = "";
  const id = window.setInterval(() => {
    const r = (window as unknown as { __renderer?: THREE.WebGLRenderer }).__renderer;
    if (r) {
      metrics.drawCalls = r.info.render.calls;
      metrics.triangles = r.info.render.triangles;
    }
    const gpu = (v: number): string => (v < 0 ? "n/a" : `${v.toFixed(1)} ms`);
    const s =
      `frame ${metrics.msFrame.toFixed(1)} ms (${metrics.fps.toFixed(0)} fps) · js terr ${metrics.jsTerrain.toFixed(1)} · js etiq ${metrics.jsLabels.toFixed(1)}\n` +
      `gpu terr ${gpu(metrics.msTerrain)} · nub ${gpu(metrics.msClouds)} · cobertura ${(metrics.cloudCoverage * 100).toFixed(0)}%\n` +
      `calls ${metrics.drawCalls} · tris ${(metrics.triangles / 1e6).toFixed(2)}M · maxTex ${metrics.maxTextureSize} · dpr ${metrics.dpr} · lod ${metrics.lod} · ${metrics.texLevel}\n` +
      `${metrics.time} · cam ${metrics.cam}`;
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
