// progress.ts — SINGLE source of journey state: s, d, z, hour, slope, climb.
// No module recomputes travelled distance. Everything reads getState().
// Anchor tables come from anchors.ts (pure); PCHIP from curve.ts.
import { bisectSunset, resolveAnchors, resolveFollowProfile, trackAt, zRawAt, alongTrackRun, type ResolvedAnchors, type RouteLike } from "./anchors.ts";
import { ACT_BOUND_D_M, ACT_ORDER, EPILOGUE_S, SLOPE_WINDOW_M, type ActKey } from "./choreography.ts";
import { buildPchip, type PchipFn } from "./curve.ts";
import { actForDistance, sunPosition } from "../engine/sun.ts";
import type { Meta } from "../engine/terrain.ts";
import type { ScrollHandle } from "./scroll.ts";

export interface ProgressState {
  s: number;
  d: number;
  z: number;
  hourDec: number;
  slopePct: number;
  climbM: number;
  actIndex: number;
  actName: string;
  sunElev: number;
  sunAzim: number;
  sunsetHourDec: number;
  hourFrozen: boolean;
  divergenceWarn: string | null;
}

export interface ProgressHandle {
  getState(): ProgressState;
  update(): void;
  resolved(): ResolvedAnchors;
  /** N3b: s at each ACT_S_BOUND_D_M boundary (inverted from the live s->d
   * PCHIP by bisection) + route end at EPILOGUE_S exactly + 1.0.
   * scroll.ts reads this via setActBounds() at boot. */
  actBounds(): number[];
  /** §3b: inversa s(d) sobre la PCHIP s->d viva (misma bisección que
   * actBounds — la PCHIP es la única fuente de s↔d). G79 resuelve s_hito
   * desde d del hito sin segunda fuente. */
  sFromD(dTarget: number): number;
}

export function parseHourParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const s = raw.trim();
  if (s.includes(":")) {
    const [hs, ms] = s.split(":");
    const h = Number(hs);
    const m = Number(ms ?? 0);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h + m / 60;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

export function initProgress(
  route: RouteLike,
  scroll: ScrollHandle,
  /** FOLLOW replan: grid no longer needed (no LOS vote). Kept as an
   * optional ignored param so viewer.ts call sites don't churn. */
  grid?: { elev: Float32Array; meta: Meta; cx: number; cy: number },
): ProgressHandle {
  const res = resolveAnchors(route);
  void grid;
  // FOLLOW profile (rope model): built once, shared with the rig.
  res.follow = resolveFollowProfile(route);
  const pchipSD: PchipFn = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
  const pchipTD: PchipFn = buildPchip(res.timeD, res.timeH, "time");
  // N3b: act limits in s — the inverse of the s->d map at the act-boundary
  // distances (bisection over the LIVE PCHIP, monotone by construction:
  // 100 iterations pin it to ~1e-30, far below any audit tolerance).
  // Last two spans are "V" and "epilogue": the route end sits at EPILOGUE_S
  // EXACTLY (G65 needs the full loop drawn over the 5-screen EPI section,
  // not over s in [0.98, 1.00] of a longer span).
  function actBounds(): number[] {
    const out: number[] = [];
    for (const dTarget of ACT_BOUND_D_M) {
      const dC = Math.min(dTarget, route.lengthM);
      let lo = 0;
      let hi = EPILOGUE_S;
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (pchipSD(mid) < dC) lo = mid;
        else hi = mid;
      }
      out.push((lo + hi) / 2);
    }
    out.push(EPILOGUE_S, 1.0);
    return out;
  }
  void ACT_ORDER;
  const sunsetHourDec = bisectSunset((h) => sunPosition(h).elevationDeg);
  // Epilogue: pchipTD is flat 16:40 over s in [0.98, 1.00] because d is
  // constant there, so blending to the NOAA sunset joins with no jump.
  const epilogueBase = pchipTD(res.dAnchorsM[res.dAnchorsM.length - 2] as number);

  // G13: ?t= freezes the hour, which would make G1/G5 pass trivially.
  // verify:3a never passes ?t= (node has no location: frozenHour stays null).
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
  const frozenHour = parseHourParam(q?.get("t") ?? null);

  const st: ProgressState = {
    s: 0,
    d: 0,
    z: 0,
    hourDec: frozenHour ?? 7 + 10 / 60,
    slopePct: 0,
    climbM: 0,
    actIndex: 0,
    actName: "La Pradera",
    sunElev: 0,
    sunAzim: 0,
    sunsetHourDec,
    hourFrozen: frozenHour !== null,
    // B2: the browser degrades — divergence is a HUD line, never a throw.
    divergenceWarn: res.divergencePct > 2 ? `track diverges ${res.divergencePct.toFixed(2)}% from brief` : null,
  };

  function update(): void {
    const s = Math.min(1, Math.max(0, scroll.s));
    const d = pchipSD(s);
    const p = trackAt(route, d);
    // BLOQUEANTE NUEVO: slope over the RAW drape Z (route.z), window the
    // ONLY smoothing. The audit measured +0.9 % at km 2.1 where the act
    // averages +31.5 %: the window was running over the S7-smoothed Z that
    // already exists for climbM, double-smoothing the gradient flat.
    // climbM keeps reading p.climb (S7 series) — one field, one series.
    // Denominator: the 200 m of ALONG-TRACK run (d+100 minus d-100), never
    // plan distance or sample count.
    const half = SLOPE_WINDOW_M / 2;
    const dLo = Math.max(0, d - half);
    const dHi = Math.min(route.lengthM, d + half);
    const rise = zRawAt(route, dHi) - zRawAt(route, dLo);
    // along-track run (endpoint distance foreshortens switchbacks).
    const run = Math.max(1e-6, alongTrackRun(route, dLo, dHi));
    let hourDec: number;
    if (frozenHour !== null) {
      hourDec = frozenHour;
    } else if (s >= EPILOGUE_S) {
      // R3: the epilogue is decided by s, not d. d is constant over
      // s in [0.98, 1.00], so a pchipTD(d) lookup would freeze at 16:40.
      const f = (s - EPILOGUE_S) / (1 - EPILOGUE_S);
      hourDec = epilogueBase + (sunsetHourDec - epilogueBase) * f;
    } else {
      hourDec = pchipTD(d);
    }
    const sp = sunPosition(hourDec);
    const { act, name } = actForDistance(d);
    st.s = s;
    st.d = d;
    st.z = p.z - 4; // ROUTE_OFFSET_M: ground z = drape - offset (telemetry ground)
    st.hourDec = hourDec;
    st.slopePct = (rise / run) * 100;
    st.climbM = p.climb;
    st.actIndex = act;
    st.actName = name;
    st.sunElev = sp.elevationDeg;
    st.sunAzim = sp.azimuthDeg;
  }

  update();
  // §3b: s_hito desde d sobre la PCHIP viva (bisección exacta, 100
  // iteraciones como actBounds — la PCHIP es la única fuente).
  function sFromD(dTarget: number): number {
    const dc = Math.min(dTarget, route.lengthM);
    let lo = 0;
    let hi = EPILOGUE_S;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (pchipSD(mid) < dc) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  return {
    getState: () => st,
    update,
    resolved: () => res,
    actBounds,
    sFromD,
  };
}

/** N3b: act keys in scroll order ("0".."V" + epilogue), single spelling. */
export const ACT_KEYS: ActKey[] = [...ACT_ORDER];
