// progress.ts — SINGLE source of journey state: s, d, z, hour, slope, climb.
// No module recomputes travelled distance. Everything reads getState().
// Anchor tables come from anchors.ts (pure); PCHIP from curve.ts.
import { applyYawBranches, bisectSunset, resolveAnchors, trackAt, type ResolvedAnchors, type RouteLike } from "./anchors.ts";
import { EPILOGUE_S } from "./choreography.ts";
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
  /** E5.2 branch choice needs the heightfield — passed once at load from
   * viewer.ts (elev + meta + world centre, all already in memory there). */
  grid?: { elev: Float32Array; meta: Meta; cx: number; cy: number },
): ProgressHandle {
  const res = resolveAnchors(route);
  if (grid) {
    // E5.2: the side decision runs ONCE here, before any PCHIP is built —
    // the rig below consumes the identical branch-chosen series.
    applyYawBranches(res, { route, elev: grid.elev, meta: grid.meta, cx: grid.cx, cy: grid.cy });
  }
  const pchipSD: PchipFn = buildPchip(res.sAnchors, res.dAnchorsM, "s->d");
  const pchipTD: PchipFn = buildPchip(res.timeD, res.timeH, "time");
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
    const pAhead = trackAt(route, Math.min(route.lengthM, d + 5));
    const pBack = trackAt(route, Math.max(0, d - 5));
    const dz = pAhead.z - pBack.z;
    const dd = Math.max(1e-6, Math.hypot(pAhead.x - pBack.x, pAhead.y - pBack.y));
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
    st.slopePct = (dz / dd) * 100;
    st.climbM = p.climb;
    st.actIndex = act;
    st.actName = name;
    st.sunElev = sp.elevationDeg;
    st.sunAzim = sp.azimuthDeg;
  }

  update();
  return {
    getState: () => st,
    update,
    resolved: () => res,
  };
}
