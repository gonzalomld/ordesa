// sun.ts — front mirror of scripts/lib/sun.ts (same NOAA formulas).
// Pure: lightingAt(madridHHMM) → everything the renderer needs.
import { ACTS, ROUTE_DATE } from "../../scripts/geo-constants.ts";

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
  cloudDensity: number; // convection 0..1
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

function warmColor(elev: number): number {
  // high sun ≈ neutral warm white; low sun ≈ amber
  if (elev > 30) return 0xfff3e2;
  if (elev > 10) return 0xffd9a8;
  if (elev > 0) return 0xff9e5e;
  return 0x7d8fc4; // twilight: cool fill only
}

/** HH:MM ("08:42") or decimal hours → full lighting state. */
export function lightingAt(t: string | number): Lighting {
  const h = typeof t === "number" ? t : Number(t.split(":")[0]) + Number(t.split(":")[1]) / 60;
  const { azimuthDeg, elevationDeg } = sunPosition(h);
  const e = elevationDeg;
  const nightMix = e >= 0 ? 0 : Math.min(1, -e / 8);
  // valley fog: max at sunrise, gone by ~10:30
  const fogDensity = e <= 0 ? 1 : Math.max(0, 1 - (h - 7.1) / 3.4);
  const fogTopM = lerp(1750, 1400, Math.min(1, Math.max(0, (h - 7) / 3.5)));
  // convection: grows 11:00 → 16:00
  const cloudDensity = Math.min(1, Math.max(0, (h - 11) / 5)) * 0.85 + (h >= 11 ? 0.15 : 0);
  // R3c: exposure carries contrast at low sun, not a veil.
  // 16° → ~1.0; noon → 0.85; twilight stays bright enough to read (1.25).
  const exposure = e <= 0 ? 1.25 : lerp(1.05, 0.85, Math.min(1, Math.max(0, (e - 12) / 48)));
  return {
    sunAzimuth: azimuthDeg,
    sunElevation: elevationDeg,
    sunColor: warmColor(e),
    sunIntensity: e <= 0 ? 0.12 : lerp(1.2, 2.8, Math.min(1, e / 60)),
    turbidity: 2.2,
    rayleigh: e > 10 ? 0.9 : 1.8,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.85,
    fogDensity: Math.min(1, fogDensity),
    fogTopM,
    cloudDensity: e <= 0 ? 0 : cloudDensity,
    exposure,
    nightMix,
  };
}

export function actForDistance(dM: number): { act: number; name: string } {
  for (const a of ACTS) if (dM >= a.startM && dM < a.endM) return { act: a.act, name: a.name };
  return { act: 5, name: "El regreso" };
}

export { ROUTE_DATE };
