// sun.ts — front mirror of scripts/lib/sun.ts (same NOAA formulas).
// Pure: lightingAt(madridHHMM) → everything the renderer needs.
// §4 sky: Preetham values measured with the existing probe. The daytime
// numbers are FLAT (no elevation branch): the sky model must read the same
// at 12:00 whatever the hour math does. Twilight keeps its own exposure.
import { ACTS, ROUTE_DATE } from "../../scripts/geo-constants.ts";
import { SKY_G, SKY_MIE, SKY_RAYLEIGH, SKY_TURBIDITY } from "../narrative/choreography.ts";

export interface Lighting {
  sunAzimuth: number;
  sunElevation: number;
  sunColor: number; // hex
  sunIntensity: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  fogDensity: number; // valley-height fog 0..1
  fogTopM: number; // ceiling of the valley fog
  cloudDensity: number; // convection 0..1 (presence — never gated on daylight)
  /** §4b FASE 4b: 0 = night/twilight cloud light … 1 = full day. */
  cloudDayF: number; // smoothstep(−4°, +4°) on solar elevation
  exposure: number;
  nightMix: number; // 0 = day sky, 1 = full night
}

const D2R = Math.PI / 180;
const LAT = 42.645;
const LON = -0.055;

function dayOfYear(y: number, m: number, d: number): number {
  return Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

export function sunPosition(hourLocal: number): { azimuthDeg: number; elevationDeg: number } {
  const [y, m, d] = ROUTE_DATE.split("-").map(Number) as [number, number, number];
  const tz = 120; // CEST in August
  const n = dayOfYear(y, m, d);
  const g = ((2 * Math.PI) / 365) * (n - 1 + (hourLocal - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tstMin = hourLocal * 60 - tz + eqtime + 4 * LON;
  const ha = ((tstMin / 4 - 180) * D2R);
  const latR = LAT * D2R;
  const cosZen = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevationDeg = 90 - zen * (180 / Math.PI);
  const sinAz = (-Math.sin(ha) * Math.cos(decl)) / Math.sin(zen);
  const cosAz = (Math.sin(decl) - Math.sin(latR) * Math.cos(zen)) / (Math.cos(latR) * Math.sin(zen));
  let az = (Math.atan2(sinAz, cosAz) * 180) / Math.PI;
  if (!Number.isFinite(az)) az = ha > 0 ? 270 : 90;
  if (az < 0) az += 360;
  return { azimuthDeg: az, elevationDeg };
}

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;

/** N2: convección realista de agosto (sin gate de sol): 0,35 de base,
 * rampa a mediodía (smoothstep 7,2→13,0), caída parcial al atardecer
 * (−0,2 · smoothstep 18,0→21,0). Continua en hora: G35 por construcción. */
export function cloudAmount(hourDec: number): number {
  const up = smoothstep(7.2, 13.0, hourDec);
  const down = smoothstep(18.0, 21.0, hourDec);
  return Math.min(1, Math.max(0, 0.35 + 0.65 * up - 0.2 * down));
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** N2b: bruma de valle — plena hasta las 08:00, cero a las 10:30, vuelve al
 * 60 % al anochecer. Continua en hora (G35). dayF = cloudDayF (misma
 * fuente que la niebla y P). */
export function mistAmount(hourDec: number, dayF: number): number {
  const morn = Math.min(1, Math.max(0, 1 - (hourDec - 8.0) / 2.5));
  const eve = 0.6 * smoothstep(18.5, 20.5, hourDec);
  return Math.min(1, Math.max(0, (0.35 + 0.65 * dayF) * (morn + eve)));
}

const SUN_HI = 0xfff3e2; // high sun ≈ neutral warm white
const SUN_MID = 0xffd9a8;
const SUN_LO = 0xff9e5e; // low sun ≈ amber
const SUN_TWILIGHT = 0x7d8fc4; // twilight: cool fill only

function hexLerp(a: number, b: number, f: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * f);
  const g = Math.round(ag + (bg - ag) * f);
  const bl = Math.round(ab + (bb - ab) * f);
  return (r << 16) | (g << 8) | bl;
}

function warmColor(elev: number): number {
  // Continuous in elevation (G35): the old stepwise branches switched the
  // whole scene at 30°/10°/0° — at dawn (07:12, elev ≈ 0°) the mountains
  // went reddish in a single scroll step. Same anchor colours, smoothstep
  // easing between — noon pixels identical by construction.
  // Below-horizon branch (−8°→0°, smoothstep): the twilight fill drifts
  // blue→amber over ~35 min of scroll instead of switching at sunrise.
  if (elev >= 30) return SUN_HI;
  if (elev >= 10) return hexLerp(SUN_MID, SUN_HI, smoothstep(10, 30, elev));
  if (elev >= 0) return hexLerp(SUN_LO, SUN_MID, smoothstep(0, 10, elev));
  return hexLerp(SUN_TWILIGHT, SUN_LO, smoothstep(-8, 0, elev));
}

/** HH:MM ("08:42") or decimal hours → full lighting state.
 * elevOverride: smoothed solar elevation (viewer dawn-smoothing) — when
 * given, every elevation-driven term (colour, intensity, exposure, day
 * factors, nightMix) reads it instead of the raw sunPosition. Hour-driven
 * terms (fog amount/ceiling, cloud presence) still read the clock. */
export function lightingAt(t: string | number, elevOverride?: number): Lighting {
  const h = typeof t === "number" ? t : Number(t.split(":")[0]) + Number(t.split(":")[1]) / 60;
  const { azimuthDeg, elevationDeg } = sunPosition(h);
  const e = elevOverride ?? elevationDeg;
  const nightMix = e >= 0 ? 0 : Math.min(1, -e / 8);
  // valley fog: max at sunrise, floor 0.55 at midday (U1: fog10km ≥ 0.80 —
  // the x⁴ distance curve keeps the valley readable, only the far edge melts)
  const fogDensity = e <= 0 ? 1 : Math.max(0.55, 1 - (h - 7.1) / 3.4);
  // F2: techo al alba 1750 -> 1620 m (la Pradera está a 1321: 300 m de
  // capa, no 430); la caída a 1400 se mantiene.
  const fogTopM = lerp(1620, 1400, Math.min(1, Math.max(0, (h - 7) / 3.5)));
  // N2: amount(h) sustituye a cloudDensity — sigue expuesto como cloudDensity
  // para no remover llamadas (misma semántica: presencia, nunca gate de sol).
  const cloudDensity = cloudAmount(h);
  // §4 correction: day exposure is 1.0 (renderer default) — the SKY dims
  // in the DOME (SKY_SCALE), never via exposure: 0.55 starved the terrain
  // (luma 0.023 at noon against a 0.18 gate). Twilight keeps 1.25.
  // Dawn continuity (G35): the old `e <= 0 ? … : …` branches switched sun
  // intensity 0.12→1.2 and exposure 1.25→1.0 in a SINGLE scroll step at
  // sunrise (07:12–07:15, elev ≈ 0°) — the "light switched on" the user
  // sees. Same endpoints, eased over −2°→0° (~15 min of scroll).
  const exposure = e <= -2 ? 1.25 : e >= 0 ? 1.0 : lerp(1.25, 1.0, smoothstep(-2, 0, e));
  // §4b FASE 4b: day factor for CLOUD LIGHT — smoothstep(−4°, +4°) on
  // solar elevation. Shared with the cloud shader (uDayF): night and
  // twilight puffs stay as blue-grey masses, day puffs go white with sun
  // shading. Presence (cloudDensity) never depends on e — no pop at dawn.
  const cloudDayF = Math.min(1, Math.max(0, (e + 4) / 8));
  const cc = cloudDayF * cloudDayF * (3 - 2 * cloudDayF);
  return {
    sunAzimuth: azimuthDeg,
    sunElevation: elevationDeg,
    sunColor: warmColor(e),
    // Continuous in elevation (G35): constant lerp slope toward full sun
    // over 0°→60° — the old branch read 1.2 at 0.59° (07:15) and 2.8 by
    // 60° with a kink where dawn met day. Noon pixels identical.
    // Dawn continuity: the old `e <= 0 ? 0.12 : …` jumped 0.12→1.2 in one
    // scroll step at sunrise — eased over −2°→0° like the exposure.
    sunIntensity:
      e <= -2 ? 0.12 : e >= 0 ? lerp(1.2, 2.8, smoothstep(0, 60, e)) : lerp(0.12, 1.2, smoothstep(-2, 0, e)),
    turbidity: SKY_TURBIDITY,
    rayleigh: SKY_RAYLEIGH,
    mieCoefficient: SKY_MIE,
    mieDirectionalG: SKY_G,
    fogDensity: Math.min(1, fogDensity),
    fogTopM,
    cloudDensity,
    cloudDayF: cc,
    exposure,
    nightMix,
  };
}

export function actForDistance(dM: number): { act: number; name: string } {
  for (const a of ACTS) if (dM >= a.startM && dM < a.endM) return { act: a.act, name: a.name };
  return { act: 5, name: "El regreso" };
}

export { ROUTE_DATE };
