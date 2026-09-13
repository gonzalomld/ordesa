// Pure-TS UTM zone 30N forward/inverse (WGS84 ellipsoid; GRS80/ETRS89
// differences are sub-millimetre — negligible for visualisation).
// Needed because the GPX track is WGS84 lat/lon while the work CRS is EPSG:25830.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const A = 6378137; // semi-major axis
const F = 1 / 298.257223563;
const K0 = 0.9996;
const LON0 = -3; // central meridian of UTM zone 30
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);

function meridionalArc(latRad: number): number {
  const e2 = E2;
  return (
    A *
    ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * latRad -
      ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) *
        Math.sin(2 * latRad) +
      ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * latRad) -
      ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * latRad))
  );
}

export function wgs84ToUtm30N(lat: number, lon: number): { x: number; y: number } {
  const latRad = lat * D2R;
  const dLon = (lon - LON0) * D2R;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = EP2 * cosLat * cosLat;
  const a = cosLat * dLon;
  const M = meridionalArc(latRad);
  const x =
    K0 *
      N *
      (a +
        ((1 - T + C) * a * a * a) / 6 +
        ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * a * a * a * a * a) / 120) +
    500000;
  const y =
    K0 *
    (M +
      N *
        tanLat *
        ((a * a) / 2 +
          ((5 - T + 9 * C + 4 * C * C) * a * a * a * a) / 24 +
          ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * a * a * a * a * a * a) /
            720));
  return { x, y };
}

export function utm30NToWgs84(x: number, y: number): { lat: number; lon: number } {
  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu) +
    ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu) +
    ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu);
  const sinPhi1 = Math.sin(phi1);
  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const T1 = Math.tan(phi1) * Math.tan(phi1);
  const C1 = EP2 * Math.cos(phi1) * Math.cos(phi1);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const D = (x - 500000) / (N1 * K0);
  const lat =
    phi1 -
    ((N1 * Math.tan(phi1)) / R1) *
      ((D * D) / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D * D * D * D) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) *
          D *
          D *
          D *
          D *
          D *
          D) /
          720);
  const lon =
    (D -
      ((1 + 2 * T1 + C1) * D * D * D) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) *
        D *
        D *
        D *
        D *
        D) /
        120) /
    Math.cos(phi1);
  return { lat: lat * R2D, lon: LON0 + lon * R2D };
}

export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}
