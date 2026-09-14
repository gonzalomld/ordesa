// scripts/lib/sun.ts — single NOAA solar-position module shared by the
// pipeline (D2 de-shadowing) and the front (D3 lightingAt). One algorithm,
// two copies (this Node one + src/engine/sun.ts); keep formulas in sync.
//
// NOAA approximation (Reda & Andreas simplified): day angle from a plain
// civil date, equation of time + declination, hour angle from solar noon.
export interface SunPos {
  azimuthDeg: number; // 0=N, 90=E, compass
  elevationDeg: number; // negative = below horizon
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function dayOfYear(y: number, m: number, d: number): number {
  return Math.floor(
    (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000,
  );
}

/** Local civil time (Europe/Madrid) → SunPos for lat/lon. tzOffsetMin: minutes EAST of UTC (e.g. +120 in August CEST). */
export function sunPosition(
  lat: number,
  lon: number,
  year: number,
  month: number,
  day: number,
  hourLocal: number,
  tzOffsetMin: number,
): SunPos {
  const n = dayOfYear(year, month, day);
  const g = ((2 * Math.PI) / 365) * (n - 1 + (hourLocal - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g));
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g);
  const utcMin = hourLocal * 60 - tzOffsetMin;
  const tstMin = utcMin + eqtime + 4 * lon;
  const haDeg = tstMin / 4 - 180;
  const ha = haDeg * D2R;
  const latR = lat * D2R;
  const cosZen =
    Math.sin(latR) * Math.sin(decl) +
    Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const elevationDeg = 90 - zen * R2D;
  const sinAz = (-Math.sin(ha) * Math.cos(decl)) / Math.sin(zen);
  const cosAz =
    (Math.sin(decl) - Math.sin(latR) * Math.cos(zen)) /
    (Math.cos(latR) * Math.sin(zen));
  let az = Math.atan2(sinAz, cosAz) * R2D;
  if (!Number.isFinite(az)) az = haDeg > 0 ? 270 : 90;
  if (az < 0) az += 360;
  return { azimuthDeg: az, elevationDeg };
}

/** Parse "YYYY-MM" flight stamps into a representative mid-month date. */
export function midMonth(yearMonth: string): { y: number; m: number; d: number } {
  const [y, m] = yearMonth.split("-").map(Number);
  return { y: y as number, m: m as number, d: 15 };
}
