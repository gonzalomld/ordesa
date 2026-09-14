// gpu-timer.ts — S3: EXT_disjoint_timer_query_webgl2 split (terrain vs
// clouds). Poll-based; results land 2-4 frames late, values stay -1 until
// the extension resolves. Zero cost when unavailable.
import * as THREE from "three";

interface QueryRec {
  query: WebGLQuery;
  target: "terrain" | "clouds";
}

export interface GpuTimer {
  available: boolean;
  begin(target: "terrain" | "clouds"): void;
  end(target: "terrain" | "clouds"): void;
  poll(msTerrain: { v: number }, msClouds: { v: number }): void;
}

export function createGpuTimer(renderer: THREE.WebGLRenderer): GpuTimer {
  const gl = renderer.getContext() as WebGL2RenderingContext & {
    createQuery(): WebGLQuery | null;
    beginQuery(t: number, q: WebGLQuery): void;
    endQuery(t: number): void;
    getQueryParameter(q: WebGLQuery, p: number): unknown;
    TIME_ELAPSED_EXT: number;
    QUERY_RESULT_AVAILABLE: number;
    QUERY_RESULT: number;
    GPU_DISJOINT_EXT: number;
  };
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (!ext) return { available: false, begin: () => undefined, end: () => undefined, poll: () => undefined };
  const TIME_ELAPSED = ext.TIME_ELAPSED_EXT as number;
  const AVAILABLE = ext.QUERY_RESULT_AVAILABLE as number;
  const RESULT = ext.QUERY_RESULT as number;
  const DISJOINT = ext.GPU_DISJOINT_EXT as number;
  const open = new Map<string, WebGLQuery>();
  const pending: QueryRec[] = [];
  const acc = { terrain: [] as number[], clouds: [] as number[] };
  return {
    available: true,
    begin(target) {
      if (open.has(target)) return;
      const q = gl.createQuery();
      if (!q) return;
      open.set(target, q);
      gl.beginQuery(TIME_ELAPSED, q);
    },
    end(target) {
      const q = open.get(target);
      if (!q) return;
      gl.endQuery(TIME_ELAPSED);
      open.delete(target);
      pending.push({ query: q, target });
    },
    poll(msTerrain, msClouds) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const rec = pending[i] as QueryRec;
        if (!gl.getQueryParameter(rec.query, AVAILABLE)) continue;
        pending.splice(i, 1);
        const disjoint = gl.getParameter(DISJOINT);
        const ns = Number(gl.getQueryParameter(rec.query, RESULT));
        gl.deleteQuery(rec.query);
        if (disjoint) continue;
        const ms = ns / 1e6;
        const arr = rec.target === "terrain" ? acc.terrain : acc.clouds;
        arr.push(ms);
        if (arr.length > 8) arr.shift();
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        if (rec.target === "terrain") msTerrain.v = avg;
        else msClouds.v = avg;
      }
    },
  };
}
