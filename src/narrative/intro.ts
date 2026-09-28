// intro.ts — P1: cinematic entry flight. Clock-driven and OUTSIDE the C1
// rail: the intro never writes progress, scroll or the rig; it samples
// poseAt(0) ONCE as the landing target and hands the camera back to the rail
// exactly on it. The rail stays a pure function of s (P4).
//
// Pure module: no three, no DOM, no rAF, no time source. The render loop owns
// the single rAF and passes the elapsed clock; this module only answers
// "where is the camera at fraction t".
//
// P1b note (uProgressDist): the brief wants the whole trail visible in green
// from the first frame — the rail's s=0 value (d=0). During the intro the
// line stays exactly there (no retraction, no advance): the loop's normal
// branch already writes min(st.d, e) = 0 while s=0, so the intro has no
// progress curve of its own.

export const INTRO_DURATION_S = 7.0;
export const INTRO_START_ALT_M = 4200;
/** Downward pitch at the top of the dive (deg). In this engine POSITIVE
 * pitch looks DOWN (EPI_PITCH convention: pitch = atan2(camAlt - aimAlt, …)):
 * +55° puts the aim point at ~2.9 km (fog ≈ 0.03) instead of ~7 km
 * (fog ≈ 0.7), so the frame opens with the canyon, not with sky. */
export const INTRO_START_PITCH_DEG = 55;
/** P2: minimum terrain clearance anywhere along the flight (m). */
export const INTRO_MIN_CLEARANCE_M = 60;

export interface IntroTarget {
  /** World position of the rail at s=0 (the landing pose). */
  pos: readonly [number, number, number];
  /** Rail yaw at s=0 (deg from north, clockwise) — the canyon axis. */
  yaw: number;
  /** Rail pitch at s=0 (deg). */
  pitch: number;
}

export interface IntroSample {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
}

/** Three-part curve: soft start (~0.5 s almost still), accelerate through the
 * dive, brake on settling. smoothstep is symmetric (slow at both ends); the
 * fall itself supplies the acceleration the brief asks for. */
export function introEase(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Short-arc yaw interpolation (never linear wrap) — same rule as the piece. */
export function introYawLerp(a: number, b: number, f: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * f;
}

/** Start of the flight: directly above the Pradera, high, looking down the
 * canyon axis with a pronounced picado. XZ identical to the landing pose so
 * the fall is continuous and the cloud layer is crossed head-on. */
export function introStart(target: IntroTarget): IntroSample {
  return {
    pos: [target.pos[0], INTRO_START_ALT_M, target.pos[2]],
    yaw: target.yaw,
    pitch: INTRO_START_PITCH_DEG,
  };
}

/** Camera at fraction t ∈ [0,1]. t=1 is EXACTLY the rail pose at s=0
 * (pos + yaw + pitch), which is what makes P1-seam hold by construction. */
export function introSample(t: number, target: IntroTarget): IntroSample {
  const f = introEase(t);
  const start = introStart(target);
  return {
    pos: [
      lerp(start.pos[0], target.pos[0], f),
      lerp(start.pos[1], target.pos[1], f),
      lerp(start.pos[2], target.pos[2], f),
    ],
    yaw: introYawLerp(start.yaw, target.yaw, f),
    pitch: lerp(start.pitch, target.pitch, f),
  };
}
