// scripts/predict-sky.ts — §4b FASE 3: offline Preetham + SKY_SAT + SKY_SCALE
// + ACES + sRGB predictor for the capture zenith / horizon pixels.
// Same math as sky-capture.ts CAPTURE_FRAG (verbatim three 0.170 Sky body)
// + the JS ACES chain in readZenith. Sun position from scripts/lib/sun.ts
// (same NOAA as the front). Usage:
//   npx tsx scripts/predict-sky.ts [turb] [ray] [sat] [scale]
// Defaults = current choreography values. Prints display hex + hz for
// 12:00/9:00/19:00 (Aug 16, Ordesa lat/lon) at zenith + horizon-away.
import { sunPosition } from "./lib/sun.ts";
import { SKY_G, SKY_MIE, SKY_RAYLEIGH, SKY_SAT, SKY_SCALE, SKY_TURBIDITY } from "../src/narrative/choreography.ts";

const turb = Number(process.argv[2] ?? SKY_TURBIDITY);
const ray = Number(process.argv[3] ?? SKY_RAYLEIGH);
const sat = Number(process.argv[4] ?? SKY_SAT);
const scale = Number(process.argv[5] ?? SKY_SCALE);

const D2R = Math.PI / 180;
const totalRayleigh = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const K = [0.686, 0.678, 0.666];
const MieConst = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const E = 2.718281828459045;
const cutoffAngle = 1.6110731556870734;
const steepness = 1.5;
const EE = 1000.0;
const mieZenithLength = 1250.0;
const rayleighZenithLength = 8400.0;
const sunAngularDiameterCos = 0.9999566769464484;

function sunIntensity(cosA: number): number {
  const c = Math.min(1, Math.max(-1, cosA));
  return EE * Math.max(0, 1 - Math.pow(E, -((cutoffAngle - Math.acos(c)) / steepness)));
}
function totalMie(T: number): number[] {
  const c = 0.2 * T * 10e-18;
  return MieConst.map((m) => 0.434 * c * m);
}

// ACES chain (must match sky-capture.ts readZenith JS exactly)
const ACES_IN = [[0.59719, 0.35458, 0.04823], [0.076, 0.90834, 0.01566], [0.0284, 0.13383, 0.83777]];
const ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const fit = (v: number): number => {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
};
const cl01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
function aces(c: number[]): number[] {
  const e = [c[0] / 0.6, c[1] / 0.6, c[2] / 0.6];
  const a = [0, 1, 2].map((i) => ACES_IN[i][0] * e[0] + ACES_IN[i][1] * e[1] + ACES_IN[i][2] * e[2]);
  const r = a.map(fit);
  return [0, 1, 2].map((i) => cl01(ACES_OUT[i][0] * r[0] + ACES_OUT[i][1] * r[1] + ACES_OUT[i][2] * r[2]));
}
const srgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hex = (c: number[]): string =>
  `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const luma = (c: number[]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function skyPixel(dir: number[], sunDir: number[], sunE: number, sunfade: number): number[] {
  // vBeta (vertex, uniform-only)
  const rayCoeff = ray - (1 - (1 - sunfade));
  const vBetaR = totalRayleigh.map((t) => t * rayCoeff);
  const tm = totalMie(turb);
  const vBetaM = tm.map((t) => t * SKY_MIE);
  // fragment body
  const up = [0, 1, 0];
  const dotUp = dir[1];
  const zenithAngle = Math.acos(Math.max(0, dotUp));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - ((zenithAngle * 180) / Math.PI), -1.253));
  const sR = rayleighZenithLength * inv;
  const sM = mieZenithLength * inv;
  const Fex = [0, 1, 2].map((i) => Math.exp(-(vBetaR[i] * sR + vBetaM[i] * sM)));
  const cosTheta = dir[0] * sunDir[0] + dir[1] * sunDir[1] + dir[2] * sunDir[2];
  const rPhase = 0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2));
  const g2 = SKY_G * SKY_G;
  const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(1 - 2 * SKY_G * cosTheta + g2, 1.5));
  const betaRTheta = vBetaR.map((b) => b * rPhase);
  const betaMTheta = vBetaM.map((b) => b * mPhase);
  const Lin = [0, 1, 2].map((i) => {
    const base = sunE * ((betaRTheta[i] + betaMTheta[i]) / (vBetaR[i] + vBetaM[i])) * (1 - Fex[i]);
    let v = Math.pow(Math.max(0, base), 1.5);
    const upSun = up[0] * sunDir[0] + up[1] * sunDir[1] + up[2] * sunDir[2];
    const mixK = Math.min(1, Math.max(0, Math.pow(1 - upSun, 5)));
    const hi = Math.pow(Math.max(0, sunE * ((betaRTheta[i] + betaMTheta[i]) / (vBetaR[i] + vBetaM[i])) * Fex[i]), 0.5);
    return v * (1 - mixK) + v * hi * mixK;
  });
  const L0 = Fex.map((f) => 0.1 * f);
  const sundisk = cosTheta >= sunAngularDiameterCos + 0.00002 ? 1 : cosTheta <= sunAngularDiameterCos ? 0 : (cosTheta - sunAngularDiameterCos) / 0.00002;
  const L0d = L0.map((l, i) => l + sunE * 19000 * Fex[i] * sundisk);
  const tex = [0, 1, 2].map((i) => (Lin[i] + L0d[i]) * 0.04 + [0, 0.0003, 0.00075][i]);
  const ret = tex.map((t) => Math.pow(Math.max(0, t), 1 / (1.2 + 1.2 * sunfade)));
  // SKY_SAT (elevation-weighted like dome + capture) + SKY_SCALE.
  // dirY = view-direction Y (called per-pixel with the real direction).
  const dirY = dir[1];
  const wEl = smoothstep(0.05, 0.45, dirY);
  const sEff = 1 + (sat - 1) * wEl;
  const l = 0.2126 * ret[0] + 0.7152 * ret[1] + 0.0722 * ret[2];
  return ret.map((v) => Math.max(0, l + (v - l) * sEff) * scale);
}

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function sunVec(h: number): { dir: number[]; e: number; fade: number } {
  const p = sunPosition(42.645, -0.055, 2026, 8, 16, h, 120);
  const az = p.azimuthDeg * D2R;
  const ev = p.elevationDeg * D2R;
  const dir = [Math.sin(az) * Math.cos(ev), Math.sin(ev), -Math.cos(az) * Math.cos(ev)];
  // viewer copies the UNIT dir into the sunPosition uniform, so the shader
  // sees sunPosition.y = sin(elev) (≈0.9 at noon), NOT metres.
  const vSunDir = dir.map((v) => v / Math.hypot(...dir));
  const sunE = sunIntensity(vSunDir[1]);
  const fade = 1 - Math.min(1, Math.max(0, 1 - Math.exp(vSunDir[1] / 450000)));
  return { dir: vSunDir, e: sunE, fade };
}

console.log(`params turb=${turb} ray=${ray} sat=${sat} scale=${scale}`);
for (const h of [9, 12, 19]) {
  const { dir, e, fade } = sunVec(h);
  const sunAz = Math.atan2(dir[0], -dir[2]);
  // zenith ROW (capture row 30: v=0.953, el=81.6°) — NOT true zenith.
  const elZ = ((30.5 / 32) - 0.5) * Math.PI;
  const zen = skyPixel([Math.cos(elZ) * Math.cos(sunAz), Math.sin(elZ), Math.cos(elZ) * Math.sin(sunAz)], dir, e, fade);
  // horizon away + toward the sun (capture col x=32 is a FIXED az — the
  // gate must hold on the brighter side too).
  const hzA = skyPixel([Math.cos(sunAz + Math.PI), 0.02, -Math.sin(sunAz + Math.PI)], dir, e, fade);
  const hzS = skyPixel([Math.cos(sunAz), 0.02, -Math.sin(sunAz)], dir, e, fade);
  const zenD = aces(zen.map((v) => Math.min(1, v))).map(srgb);
  const hzAD = aces(hzA.map((v) => Math.min(1, v))).map(srgb);
  const hzSD = aces(hzS.map((v) => Math.min(1, v))).map(srgb);
  const chan = (c: number[]): string => c.map((v) => Math.round(v * 255).toString().padStart(3)).join(",");
  console.log(
    `${h}:00 cenit=${hex(zenD)} (${chan(zenD)}) hzAway=${hex(hzAD)} (${chan(hzAD)}) hzSun=${hex(hzSD)} (${chan(hzSD)}) ratio=${(luma(hzAD) / Math.max(1e-6, luma(zenD))).toFixed(2)} linZ=(${zen.map((v) => v.toFixed(2)).join(",")})`,
  );
}
