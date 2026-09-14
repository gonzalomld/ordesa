// debug.ts — D10: ?debug=1 overlay + window.__metrics + ?t=HH:MM&cam=.
import * as THREE from "three";

export interface Metrics {
  msTerrain: number;
  msClouds: number;
  msPost: number;
  msLabels: number;
  msFrame: number;
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
    msTerrain: 0,
    msClouds: 0,
    msPost: 0,
    msLabels: 0,
    msFrame: 0,
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
    const s =
      `frame ${metrics.msFrame.toFixed(1)} ms · terr ${metrics.msTerrain.toFixed(1)} · nub ${metrics.msClouds.toFixed(1)} · post ${metrics.msPost.toFixed(1)} · etiq ${metrics.msLabels.toFixed(1)}\n` +
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
