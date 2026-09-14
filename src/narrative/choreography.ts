// choreography.ts — Phase 3A: EVERY numeric choreography constant lives HERE.
// Source: brief Fase 3A + 3 clarifications. The brief wins over this file.
// No other file contains choreography literals: if a number is missing here,
// add it here with a comment saying where it comes from.

export const K_SCROLL = 6; // framerate-independent smoothing rate (1/s)
export const K_SCROLL_REDUCED = 20; // prefers-reduced-motion: native scroll, faster catch-up
export const TRACK_VH = 900; // initial --track-vh height (vh); scroll.ts writes it to CSS at boot so it stays tweakable without recompile
export const LENIS_DURATION = 1.2; // Lenis scroll inertia (s)
export const LENIS_TOUCH_MULT = 1.6; // touch scroll multiplier
export const LENIS_SMOOTH_WHEEL = true; // Lenis smoothWheel flag
export const LENIS_SYNC_TOUCH = false; // Lenis syncTouch flag

export const SUNSET_ELEV_DEG = -0.833; // standard sunset: -0.25 solar semidiameter + -0.583 mean refraction. NOT 0 deg, NO altitude horizon-dip (blocked western wall)
export const SUNSET_SEARCH_START_H = 18; // bisection window start, local Europe/Madrid time
export const SUNSET_SEARCH_END_H = 23; // bisection window end, local Europe/Madrid time
export const SUNSET_TOL_S = 1; // converge below 1 second

export const TANGENT_WINDOW_M = 120; // smoothed tangent window: P(d+120) - P(d-120). If act I looks nervous, raise the window, touch nothing else
export const DIST_MIN_M = 60; // floor after raycast shorten (distHit * 0.9)
export const CAM_CLEARANCE_M = 25; // camera.y >= terrain + 25; same figure as G3
export const COLLIDE_MARGIN_M = 3; // terrain counts as hit when it rises above the target->camera segment + 3 m (same margin as terrainRayHit default)
export const K_IN = 18; // shorten: near-instant (1/s)
export const K_OUT = 2.5; // recover: slow (1/s); reversed, the camera jumps out from behind every rock

export const SHADOW_EPS_DEG = 0.25; // shadow needsUpdate only if sun azimuth or elevation turned more than this since last update
export const SHADOW_MIN_FRAMES = 4; // ...and at most once every 4 frames
export const SHADOW_LIGHT_DIST_M = 2500; // sun station distance from the rig target (light follows the target; static frustum cannot cover 18 km)
export const SHADOW_EXTENT_M = 1800; // ortho shadow box side centred on the target (m)
export const SHADOW_NEAR_M = 500; // shadow camera near, measured from the 2500 m light station
export const SHADOW_FAR_M = 6000; // shadow camera far, measured from the 2500 m light station
export const SHADOW_MOVE_EPS_M = 150; // shadow needsUpdate also fires when the rig target moved more than this (scroll alone, sun still)

export const SKY_EPS_DEG = 0.5; // sky-capture + fog colour refresh only when solar elevation changed more than this

export const TRACK_DIM_PAST = 1.0; // walked stretch opacity (full)
export const TRACK_DIM_FUTURE = 0.35; // pending stretch opacity

// --- audit A6: sky-ambient valley fill (a shadowed valley under clear sky
// is blue, not black). Dome colour comes from the same zenith estimate the
// debug overlay prints; floor is limestone in shadow. Day factor stays 1
// between sunrise and sunset and dies only after sunset (epilogue).
export const HEMI_DAY = 0.9; // hemisphere intensity while the sun is up (fraction of sky visible ~ sky dome)
export const HEMI_NIGHT = 0.06; // ...after sunset (faint skyglow, never pure black)
export const HEMI_SKY_RGB: [number, number, number] = [0.42, 0.55, 0.78]; // zenith-blue dome base (linear-ish, modulated by lightingAt rayleigh/elevation)
export const HEMI_GROUND_RGB: [number, number, number] = [0.32, 0.3, 0.26]; // limestone in shadow
export const G11_LUMA_MIN = 0.06; // mean linear framebuffer luminance at s=0.10 (audit A6, 32x32 readPixels grid)
export const LUMA_GRID = 32; // G11 readPixels grid (audit A6); measured in-browser via ?luma=1, every 30th frame

// --- audit A9: cloud layer seen from above (epilogue) must fade toward the
// zenith while keeping its grazing-incidence density.
export const CLOUD_ZENITH_FADE = 0.85; // max opacity cut looking straight down (0 = opaque disc, 1 = invisible)
export const CLOUD_FADE_START_DEG = 25; // view-ray elevation above which the fade ramps in (deg from horizontal)

// --- s -> distance anchors (brief section 2) ---
// kmBrief is DESCRIPTIVE (rounded off route.json), never the distance axis.
// Resolution moves d, never s: the s values below are fixed (anchors.ts).
export interface SDAnchor {
  s: number;
  kmBrief: number;
  act: string;
}
export const S_TO_D_ANCHORS: SDAnchor[] = [
  { s: 0.0, kmBrief: 0.0, act: "0 - La Pradera" },
  { s: 0.06, kmBrief: 0.3, act: "I - La subida" },
  { s: 0.3, kmBrief: 2.44, act: "II - El mirador" },
  { s: 0.46, kmBrief: 3.0, act: "III - La cornisa" },
  { s: 0.68, kmBrief: 9.0, act: "IV - El circo" },
  { s: 0.86, kmBrief: 10.5, act: "V - El regreso" },
  { s: 0.98, kmBrief: 18.13, act: "V - El regreso (fin)" },
  { s: 1.0, kmBrief: 18.13, act: "Epilogo" },
];

// --- time anchors (brief section 3): real-hike durations, not a function of exact distance ---
// Each row hooks to the d RESOLVED for the anchor id in `via` (clarification C2).
// Order matters: distances resolve first, hours hook onto them.
export interface TimeAnchor {
  kmBrief: number;
  hh: number;
  mm: number;
  via: string;
  porQue: string;
}
export const TIME_ANCHORS: TimeAnchor[] = [
  { kmBrief: 0.0, hh: 7, mm: 10, via: "A0", porQue: "salida de la Pradera" },
  { kmBrief: 0.3, hh: 7, mm: 15, via: "A1", porQue: "pie de la subida" },
  { kmBrief: 2.44, hh: 9, mm: 5, via: "A3", porQue: "+664 m en 1 h 50 min" },
  { kmBrief: 3.0, hh: 9, mm: 35, via: "A4", porQue: "parada en el mirador" },
  { kmBrief: 9.0, hh: 12, mm: 10, via: "A6", porQue: "faja de Pelay, seis kilometros casi llanos" },
  { kmBrief: 9.67, hh: 12, mm: 35, via: "A7", porQue: "Cola de Caballo" },
  { kmBrief: 10.5, hh: 13, mm: 20, via: "A8", porQue: "comida en el circo" },
  { kmBrief: 18.13, hh: 16, mm: 40, via: "A10", porQue: "vuelta a la Pradera" },
];

// --- camera anchors (brief section 4 + audit) ---
// yaw = bearing FROM the target TO the camera, degrees from north, clockwise.
// yaw 266 puts the camera WSW looking up-canyon toward Monte Perdido (D8).
// Phase-2 pose presets restored by ?cam= (A7): pradera/mirador/circo/general,
// verbatim from the pre-3A viewer. Source: viewer.ts @ parent commit.
export const CAM_PRESETS: Record<string, { eye: [number, number, number]; tgt: [number, number, number] }> = {
  pradera: { eye: [741218 - 1500, 2600, 4726062 + 2500], tgt: [741218, 1321, 4726062] },
  mirador: { eye: [741507 - 800, 2900, 4725203 + 1800], tgt: [741507, 1960, 4725203] },
  circo: { eye: [747191 - 2600, 2600, 4726348 + 2400], tgt: [747191, 1762, 4726348] },
};
export type YawSpec = { mode: "abs"; deg: number } | { mode: "tang"; off: number };
export interface CameraAnchor {
  id: string;
  s: number;
  kmBrief: number;
  distM: number;
  pitchDeg: number;
  yaw: YawSpec;
  hTargetM: number;
}
export const CAMERA_ANCHORS: CameraAnchor[] = [
  { id: "A0", s: 0.0, kmBrief: 0.0, distM: 420, pitchDeg: 12, yaw: { mode: "abs", deg: 266 }, hTargetM: 40 },
  { id: "A1", s: 0.06, kmBrief: 0.3, distM: 300, pitchDeg: 18, yaw: { mode: "tang", off: 150 }, hTargetM: 25 },
  { id: "A2", s: 0.18, kmBrief: 1.2, distM: 220, pitchDeg: 26, yaw: { mode: "tang", off: 120 }, hTargetM: 20 },
  // A3/A4 (audit A4): pitch 8/6 deg buried the camera in Sierra Custodia
  // (clamp active 18% of the piece). Same D8 gaze ENE toward Monte Perdido,
  // from above the ridge instead of inside it. Values exactly as audited.
  { id: "A3", s: 0.3, kmBrief: 2.44, distM: 520, pitchDeg: 26, yaw: { mode: "abs", deg: 266 }, hTargetM: 30 },
  { id: "A4", s: 0.46, kmBrief: 3.0, distM: 620, pitchDeg: 22, yaw: { mode: "abs", deg: 266 }, hTargetM: 35 },
  // A5 (audit A2): tang +90 puts the camera south looking north into the
  // void. Bearing resolves ~92.7 deg, yaw ~182.7. A1/A2 keep their brief
  // signs: checked against the grid, both already sit over air
  // (A1 +150 clear ~127 m, A2 +120 clear ~342 m).
  { id: "A5", s: 0.57, kmBrief: 6.0, distM: 200, pitchDeg: 14, yaw: { mode: "tang", off: 90 }, hTargetM: 20 },
  { id: "A6", s: 0.68, kmBrief: 9.0, distM: 380, pitchDeg: 10, yaw: { mode: "abs", deg: 250 }, hTargetM: 60 },
  { id: "A7", s: 0.745, kmBrief: 9.67, distM: 150, pitchDeg: 4, yaw: { mode: "abs", deg: 275 }, hTargetM: 40 },
  // A7b (audit A1): hold-shot, same 275 heading until s=0.845, so the whole
  // 170 deg turn happens inside the exempt window instead of spilling out.
  // kmBrief -1 = sentinel: d resolved as d(s=0.845) in anchors.ts.
  { id: "A7b", s: 0.845, kmBrief: -1, distM: 900, pitchDeg: 38, yaw: { mode: "abs", deg: 275 }, hTargetM: 120 },
  // A8 (audit A1): pitch 38 + dist 900 reads the yaw change as an orbit over
  // the cirque, not a whip. The only deliberate hard turn (G4-exempt window).
  // Audit round 2: A9 tang -60 backtracks against the loop (582 deg) and
  // forces a second 110 deg swing AFTER the window. Pinned abs 266: after
  // the turnaround the camera holds WSW and looks down-valley with the
  // walker — one turn in the whole piece, not two.
  { id: "A8", s: 0.86, kmBrief: 10.5, distM: 900, pitchDeg: 38, yaw: { mode: "abs", deg: 85 }, hTargetM: 120 },
  // A9 (audit round 2): the return leg walks WSW, so the brief's tang -60
  // backtracks against the loop and forces a second swing AFTER the window.
  // Reverted to the brief value: the audit pass decides A8/A9 framing from
  // ?debug=path captures, not from the gate number alone.
  { id: "A9", s: 0.93, kmBrief: 14.0, distM: 300, pitchDeg: 12, yaw: { mode: "tang", off: -60 }, hTargetM: 25 },
  { id: "A10", s: 0.98, kmBrief: 18.13, distM: 500, pitchDeg: 16, yaw: { mode: "abs", deg: 266 }, hTargetM: 60 },
  // A11 epilogue: camera detached and high, no longer the walker's POV
  { id: "A11", s: 1.0, kmBrief: 18.13, distM: 2600, pitchDeg: 34, yaw: { mode: "abs", deg: 266 }, hTargetM: 400 },
];

// ?act= jumps: arithmetic midpoint of each act's s interval (brief s->d table)
export const ACT_MID_S: Record<string, number> = {
  "0": 0.03,
  I: 0.18,
  II: 0.38,
  III: 0.57,
  IV: 0.77,
  V: 0.92,
  EPI: 0.99,
};

// Phase-2 stills kept for the debugging instruments (?debug=1 time readout
// shows the frozen value; no slider anymore). Source: phase-2 HUD.
export const DEBUG_STILLS: number[] = [6.75, 8.7, 14 + 4 / 60, 17.5];

// G4-exempt yaw window around A8 (the deliberate turnaround, audit A1:
// the whole 170 deg turn happens between A7b s=0.845 and A8 s=0.86)
export const A8_EXEMPT_S0 = 0.84; // G4 test declares its own exemption here
export const A8_EXEMPT_S1 = 0.872; // (same window, single source)

// @doc-only: brief figure, NEVER a distance axis. Used only to compute the 2%
// divergence warning in verify:3a and doctor. The real axis is route.lengthM.
export const BRIEF_LENGTH_M = 18125.9;
export const ROUTE_DIVERGE_PCT = 2; // beyond ~360 m the track changed or the resample is wrong: stop and report
