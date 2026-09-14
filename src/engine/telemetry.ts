// telemetry.ts — D6: DOM writes only on change. Phase 3A: reads journey
// state from narrative/progress.ts (single source). No distance computation
// of its own. loadRouteData stays (viewer builds RouteData from route.json).
import { actForDistance } from "./sun.ts";
import type { World } from "./terrain.ts";
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

/** Pure mapping s∈[0,1] → telemetry (ground z = drape − offset). */
export function telemetryAt(route: RouteData, s: number, offsetM = 4): Telemetry {
  const f = Math.min(route.n - 1, Math.max(0, s * (route.n - 1)));
  const i = Math.floor(f);
  const j = Math.min(route.n - 1, i + 1);
  const fr = f - i;
  const d = (route.d[i] as number) * (1 - fr) + (route.d[j] as number) * fr;
  const z = ((route.z[i] as number) * (1 - fr) + (route.z[j] as number) * fr) - offsetM;
  const climb = (route.cumClimb[i] as number) * (1 - fr) + (route.cumClimb[j] as number) * fr;
  const dz = (route.z[j] as number) - (route.z[i] as number);
  const dd = Math.max(1e-6, (route.d[j] as number) - (route.d[i] as number));
  const { act, name } = actForDistance(d);
  return { alt: z, climb, km: d / 1000, slope: (dz / dd) * 100, act, actName: name };
}

/** Phase-2 source of s: nearest track point to the camera in 3D world. */
export function projectCameraToS(
  route: RouteData,
  world: World,
  camX: number,
  camY: number,
  camZ: number,
  prevS: number,
): number {
  // coarse scan every 8th point, then refine ±8 — 3D world distance
  const step = 8;
  let bi = Math.round(prevS * (route.n - 1));
  let bd = Infinity;
  for (let i = 0; i < route.n; i += step) {
    const dx = (route.x[i] as number) - world.centerX - camX;
    const dz = -((route.y[i] as number) - world.centerY) - camZ;
    const dy = (route.z[i] as number) - camY;
    const q = dx * dx + dz * dz + dy * dy;
    if (q < bd) {
      bd = q;
      bi = i;
    }
  }
  for (let i = Math.max(0, bi - step); i <= Math.min(route.n - 1, bi + step); i++) {
    const dx = (route.x[i] as number) - world.centerX - camX;
    const dz = -((route.y[i] as number) - world.centerY) - camZ;
    const dy = (route.z[i] as number) - camY;
    const q = dx * dx + dz * dz + dy * dy;
    if (q < bd) {
      bd = q;
      bi = i;
    }
  }
  // continuity bias: ambiguity where outbound/return overlap (Pradera)
  const prev = Math.round(prevS * (route.n - 1));
  if (Math.abs(bi - prev) > route.n / 4) {
    // far jump: prefer the candidate end closest to prev — re-scan ends
    let be = prev;
    let beq = Infinity;
    for (const i of [bi, prev]) {
      const dx = (route.x[i] as number) - world.centerX - camX;
      const dz = -((route.y[i] as number) - world.centerY) - camZ;
      const dy = (route.z[i] as number) - camY;
      const q = dx * dx + dz * dz + dy * dy + Math.abs(i - prev) * 50;
      if (q < beq) {
        beq = q;
        be = i;
      }
    }
    bi = be;
  }
  return bi / (route.n - 1);
}

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
