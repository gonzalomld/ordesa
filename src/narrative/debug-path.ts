// debug-path.ts — ?debug=path instrument: 2D overlay with three panels:
// (a) s->d curve with the anchors marked, (b) plan view: track trace +
// camera trace + AIM trace (follow replan: the rope draws anchor/aim/camera,
// not a yaw trace), (c) camera height vs terrain profile with the 25 m
// clearance line. Look here first when the cornisa misbehaves —
// before touching a single number.
import { CAM_CLEARANCE_M } from "./choreography.ts";
import { buildPchip } from "./curve.ts";
import type { RouteLike } from "./anchors.ts";
import type { RigPose } from "./camera-rig.ts";
import type { ProgressHandle } from "./progress.ts";
import { sampleGrid, type Meta, type World } from "../engine/terrain.ts";

export interface PathOverlayDeps {
  route: RouteLike;
  world: World;
  elev: Float32Array;
  meta: Meta;
  progress: ProgressHandle;
  rig: { poseAt(s: number): RigPose };
}

const SAMPLES = 200;

export function mountPathOverlay(deps: PathOverlayDeps): { dispose(): void } {
  const { route, world, elev, meta, progress, rig } = deps;
  const cv = document.createElement("canvas");
  cv.className = "path-overlay";
  const W = (cv.width = Math.floor(window.innerWidth * 0.52));
  const H = (cv.height = Math.floor(window.innerHeight * 0.62));
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
  cv.style.right = "12px";
  cv.style.left = "auto";
  cv.style.top = "12px";
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d");
  if (!ctx) return { dispose: () => cv.remove() };

  const res = progress.resolved();
  // precompute static traces once (FOLLOW: camera + aim per sample)
  const camPos: [number, number, number][] = [];
  const camTgt: [number, number, number][] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const p = rig.poseAt(i / SAMPLES);
    camPos.push(p.pos);
    camTgt.push(p.target);
  }
  let xs: number[] = [];
  let ys: number[] = [];
  {
    const n = route.n;
    xs = new Array(n);
    ys = new Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = (route.x[i] as number) - world.centerX;
      ys[i] = -((route.y[i] as number) - world.centerY);
    }
  }

  let lastS = -1;
  let frame = 0;
  let raf = 0;
  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    frame++;
    const s = progress.getState().s;
    if (Math.abs(s - lastS) < 0.0005 && frame % 30 !== 0) return;
    lastS = s;
    draw(s);
  };

  function draw(s: number): void {
    if (!ctx) return;
    const c = ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "rgba(0,0,0,0.72)";
    c.fillRect(0, 0, W, H);
    c.strokeStyle = "rgba(244,241,234,0.25)";
    c.strokeRect(0.5, 0.5, W - 1, H - 1);
    const pad = 14;
    const pw = W - pad * 2;
    // --- (a) s->d, top strip ---
    {
      const h = Math.floor(H * 0.28);
      const x0 = pad;
      const y0 = pad;
      c.strokeStyle = "rgba(244,241,234,0.4)";
      c.strokeRect(x0, y0, pw, h);
      c.fillStyle = "#f4f1ea";
      c.font = "10px monospace";
      c.fillText("s->d", x0 + 4, y0 + 12);
      const X = (ss: number): number => x0 + ss * pw;
      const Y = (d: number): number => y0 + h - (d / route.lengthM) * (h - 4) - 2;
      c.strokeStyle = "#ffd9a8";
      c.beginPath();
      for (let i = 0; i <= SAMPLES; i++) {
        const ss = i / SAMPLES;
        const d = res.sAnchors.length
          ? evalSD(res.sAnchors, res.dAnchorsM, ss)
          : 0;
        const px = X(ss);
        const py = Y(d);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
      // anchors
      c.fillStyle = "#7dd3fc";
      for (let i = 0; i < res.sAnchors.length; i++) {
        c.fillRect(X(res.sAnchors[i] as number) - 1.5, Y(res.dAnchorsM[i] as number) - 1.5, 3, 3);
      }
      // now marker
      c.fillStyle = "#ff6b6b";
      c.fillRect(X(s) - 1, y0, 2, h);
    }
    // --- (b) plan view, middle ---
    {
      const h = Math.floor(H * 0.34);
      const y0 = pad + Math.floor(H * 0.28) + 8;
      c.strokeStyle = "rgba(244,241,234,0.4)";
      c.strokeRect(pad, y0, pw, h);
      c.fillStyle = "#f4f1ea";
      c.font = "10px monospace";
      c.fillText("planta: senda + camara + aim", pad + 4, y0 + 12);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        minX = Math.min(minX, xs[i] as number);
        maxX = Math.max(maxX, xs[i] as number);
        minY = Math.min(minY, ys[i] as number);
        maxY = Math.max(maxY, ys[i] as number);
      }
      for (const p of camPos) {
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[2]);
        maxY = Math.max(maxY, p[2]);
      }
      const sc = Math.min(pw / Math.max(1, maxX - minX), h / Math.max(1, maxY - minY)) * 0.92;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const X = (wx: number): number => pad + pw / 2 + (wx - cx) * sc;
      const Y = (wz: number): number => y0 + h / 2 + (wz - cy) * sc;
      c.strokeStyle = "#efe3c8";
      c.beginPath();
      for (let i = 0; i < xs.length; i += 2) {
        const px = X(xs[i] as number);
        const py = Y(ys[i] as number);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
      c.strokeStyle = "#7dd3fc";
      c.beginPath();
      for (let i = 0; i < camPos.length; i++) {
        const px = X(camPos[i]?.[0] as number);
        const py = Y(camPos[i]?.[2] as number);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
      // FOLLOW: aim trace (rope far end) in amber — P1 reads here.
      c.strokeStyle = "#ffd9a8";
      c.beginPath();
      for (let i = 0; i < camTgt.length; i++) {
        const px = X(camTgt[i]?.[0] as number);
        const py = Y(camTgt[i]?.[2] as number);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.stroke();
      const idx = Math.min(SAMPLES, Math.floor(s * SAMPLES));
      c.fillStyle = "#ff6b6b";
      c.fillRect(X(camPos[idx]?.[0] as number) - 2, Y(camPos[idx]?.[2] as number) - 2, 4, 4);
    }
    // --- (c) heights, bottom ---
    {
      const h = H - (pad + Math.floor(H * 0.28) + 8 + Math.floor(H * 0.34) + 8) - pad;
      const y0 = pad + Math.floor(H * 0.28) + 8 + Math.floor(H * 0.34) + 8;
      if (h > 30) {
        c.strokeStyle = "rgba(244,241,234,0.4)";
        c.strokeRect(pad, y0, pw, h);
        c.fillStyle = "#f4f1ea";
        c.font = "10px monospace";
        c.fillText(`altura camara vs terreno (+${CAM_CLEARANCE_M} m)`, pad + 4, y0 + 12);
        let lo = Infinity;
        let hi = -Infinity;
        const terr: number[] = new Array(SAMPLES + 1);
        for (let i = 0; i <= SAMPLES; i++) {
          const p = camPos[i] as [number, number, number];
          const ex = p[0] + world.centerX;
          const ey = world.centerY - p[2];
          const t = sampleGrid(elev, meta, ex, ey);
          terr[i] = t;
          lo = Math.min(lo, t, p[1]);
          hi = Math.max(hi, t + CAM_CLEARANCE_M, p[1]);
        }
        const span = Math.max(1, hi - lo);
        const X = (i: number): number => pad + (i / SAMPLES) * pw;
        const Y = (z: number): number => y0 + h - ((z - lo) / span) * (h - 6) - 3;
        c.strokeStyle = "#8a8578";
        c.beginPath();
        for (let i = 0; i <= SAMPLES; i++) {
          const px = X(i);
          const py = Y(terr[i] as number);
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.stroke();
        c.strokeStyle = "rgba(255,107,107,0.6)";
        c.setLineDash([4, 3]);
        c.beginPath();
        for (let i = 0; i <= SAMPLES; i++) {
          const px = X(i);
          const py = Y((terr[i] as number) + CAM_CLEARANCE_M);
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.stroke();
        c.setLineDash([]);
        c.strokeStyle = "#7dd3fc";
        c.beginPath();
        for (let i = 0; i <= SAMPLES; i++) {
          const px = X(i);
          const py = Y((camPos[i] as [number, number, number])[1]);
          if (i === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.stroke();
      }
    }
  }

  loop();
  return {
    dispose() {
      cancelAnimationFrame(raf);
      cv.remove();
    },
  };
}

// local s->d eval (same monotone PCHIP the journey uses, rebuilt here so the
// overlay stays dependency-light; verify:3a owns the canonical evaluation)
const pchipCache = new WeakMap<object, (s: number) => number>();
function evalSD(sAnchors: number[], dAnchorsM: number[], s: number): number {
  const key = sAnchors as unknown as object;
  let f = pchipCache.get(key);
  if (!f) {
    f = buildPchip(sAnchors.slice(), dAnchorsM.slice(), "s->d");
    pchipCache.set(key, f);
  }
  return (f as (s: number) => number)(s);
}
