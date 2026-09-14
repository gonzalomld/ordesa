// telemetry.ts — D6: DOM writes only on change. BLOCKER G14: the ONLY
// input is ProgressState (single source). This module formats — it never
// computes position, time, act or climb. No trackAt, no telemetryAt, no
// actForDistance, no projectCameraToS: those lived here, drifted from the
// rig's d, and painted three different clocks on the same frame.
import type { ProgressState } from "../narrative/progress.ts";

export interface RouteData {
  lengthM: number;
  totalClimbM: number;
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array; // drape z (mdt+offset)
  d: Float32Array;
  cumClimb: Float32Array;
}

export async function loadRouteData(): Promise<RouteData> {
  const res = await fetch(routeUrl());
  if (!res.ok) throw new Error(`route.json: HTTP ${res.status}`);
  const j = (await res.json()) as {
    x: number[];
    y: number[];
    z_mdt: number[];
    d: number[];
    cumClimb: number[];
    lengthM: number;
    totalClimbM: number;
  };
  // R2: ONE climb series — the smoothed accumulation (S7, published +815 m).
  // The raw drape never had its own; cumClimb is it.
  return {
    lengthM: j.lengthM,
    totalClimbM: j.totalClimbM,
    n: j.x.length,
    x: Float32Array.from(j.x),
    y: Float32Array.from(j.y),
    z: Float32Array.from(j.z_mdt),
    d: Float32Array.from(j.d),
    cumClimb: Float32Array.from(j.cumClimb),
  };
}

export function routeUrl(): string {
  const m = (window as unknown as { __META?: { assets?: { route?: string } } }).__META;
  return "/" + (m?.assets?.route ?? "assets/route.json");
}

export interface Telemetry {
  alt: number;
  climb: number;
  km: number;
  slope: number; // %
  act: number;
  actName: string;
}

/** Phase-3A source: journey state straight from progress.getState().
 * Kept for reference/tests; the render loop passes ProgressState. */
export function telemetryFromState(st: ProgressState): Telemetry {
  return {
    alt: st.z,
    climb: st.climbM,
    km: st.d / 1000,
    slope: st.slopePct,
    act: st.actIndex,
    actName: st.actName,
  };
}

/** Write-if-changed driver. Call every frame with progress.getState();
 * touches DOM only on change. Receives the ALREADY-FORMATTED hour/sun
 * strings: even the hhmm() rounding lives in viewer.ts, not here. */

const fmtInt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat("es-ES", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export interface TeleCells {
  alt: HTMLElement;
  climb: HTMLElement;
  km: HTMLElement;
  slope: HTMLElement;
  hour: HTMLElement;
  sun: HTMLElement;
  act: HTMLElement;
}

/** Write-if-changed driver. Call every frame; touches DOM only on change. */
export function driveTelemetry(
  cells: TeleCells,
  last: Record<string, string>,
  st: ProgressState,
  hourLabel: string,
  sunElev: number,
): void {
  const t = telemetryFromState(st);
  const vals: Record<string, string> = {
    alt: `${fmtInt.format(Math.round(t.alt))} m`,
    climb: `+${fmtInt.format(Math.round(t.climb))} m`,
    km: `${fmt1.format(t.km)} km`,
    slope: `${t.slope >= 0 ? "+" : ""}${fmt1.format(t.slope)} %`,
    hour: hourLabel,
    sun: `${fmt1.format(sunElev)}°`,
    act: `ACTO ${["0", "I", "II", "III", "IV", "V"][t.act] ?? t.act} · ${t.actName.toUpperCase()}`,
  };
  const map: Record<string, HTMLElement> = {
    alt: cells.alt,
    climb: cells.climb,
    km: cells.km,
    slope: cells.slope,
    hour: cells.hour,
    sun: cells.sun,
    act: cells.act,
  };
  for (const k of Object.keys(vals)) {
    if (last[k] !== vals[k]) {
      last[k] = vals[k] as string;
      (map[k] as HTMLElement).textContent = vals[k] as string;
    }
  }
}
