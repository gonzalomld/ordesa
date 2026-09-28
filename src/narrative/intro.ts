// intro.ts — P1: cinematic entry flight. Clock-driven and OUTSIDE the C1
// rail: the intro never writes progress, scroll or the rig; it samples
// poseAt(0) ONCE as the landing target and hands the camera back to the rail
// exactly on it. The rail stays a pure function of s (P4).
//
// Pure module: no three, no DOM, no rAF, no time source. The render loop owns
// the single rAF and passes the elapsed clock; this module only answers
// "where is the camera at fraction t" and "how much trail is drawn at t".
//
// PENDING DESIGN NOTE (uProgressDist): d(s=0)=0, so "the rail's value at s=0"
// is 0. Landing there is what keeps the handoff seam-free, so the trail is
// revealed full length -> 0 during the dive (the camino writes itself from
// the Cola back to the Pradera). If the brief wanted the opposite (0 -> full
// with a pop at handoff), change introProgressDist only.

export const INTRO_DURATION_S = 7.0;
export const INTRO_START_ALT_M = 4200;
/** Downward pitch at the top of the dive (deg). */
export const INTRO_START_PITCH_DEG = -30;
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

/** Trail reveal factor: 1.0 at t=0 (full length walked) -> 0.0 at t=1 (the
 * rail's s=0 value), slower at the start ("más lenta al principio"). */
export function introProgressDist(t: number, lengthM: number): number {
  return lengthM * (1 - introEase(t));
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
