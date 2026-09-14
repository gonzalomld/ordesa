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
export const DIST_MIN_M = 60; // absolute floor after any shorten ( audit E5: the policy floor is 0.5 x script dist; this stays as the hard minimum)
export const CAM_CLEARANCE_M = 25; // camera.y >= terrain + 25; same figure as G3
export const COLLIDE_MARGIN_M = 3; // terrain counts as hit when it rises above the target->camera segment + 3 m (same margin as terrainRayHit default)
export const K_IN = 18; // shorten: near-instant (1/s)
export const K_OUT = 2.5; // recover: slow (1/s); reversed, the camera jumps out from behind every rock

// --- E5: collision repositions, never dollies. Response order on impact
// (BLOQUEANTE audit: distance before pitch — tilting destroys the framing,
// dollying preserves it; the cirque has room, measured clearance 1242 m):
// 1. script pose -> 2. yaw + 180 (opposite slope), same dist, same pitch ->
// 3. grow dist up to COLLIDE_DOLLY_MULT x script, pitch held ->
// 4. pitch up to PITCH_MAX_HARD, dist untouched ->
// 5. shorten LAST, floored at COLLIDE_SHORTEN_FLOOR_FRAC x script dist.
export const PITCH_MAX_HARD = 26; // deg (was 35): pitch-up ceiling — 35° sent the horizon out of frame at the cirque
export const COLLIDE_DOLLY_MULT = 1.8; // step 3: dolly out to 1.8x script dist before touching pitch
export const COLLIDE_SHORTEN_FLOOR_FRAC = 0.5; // shorten never goes below half the scripted dist
// G9-bis (E5): the old G9 watched the 25 m floor, not the zoom. Watch the ratio.
export const G9BIS_RATIO_MIN = 0.5; // actual/script dist >= 0.5 ...
export const G9BIS_COVERAGE = 0.95; // ... in 95% of the steps ...
export const G9BIS_HARD_FLOOR = 0.25; // ... and never below 0.25 anywhere
// G4 rate (E5: the turnaround spreads 181 deg over s 0.86-0.94 = 80 steps).
export const G4_MAX_DEG = 2.5; // deg per 0.001 step outside the exempt window
// E5 construction-side branch choice: per consecutive anchor pair, 40
// samples, direct vs +180 branch; most clear LOS wins, ties -> less rotation.
export const YAW_BRANCH_SAMPLES = 40;

export const SHADOW_EPS_DEG = 0.25; // shadow needsUpdate only if sun azimuth or elevation turned more than this since last update
export const SHADOW_MIN_FRAMES = 4; // ...and at most once every 4 frames
export const SHADOW_LIGHT_DIST_M = 2500; // sun station distance from the rig target (light follows the target; static frustum cannot cover 18 km)
export const SHADOW_EXTENT_M = 1800; // ortho shadow box side centred on the target (m)
export const SHADOW_NEAR_M = 500; // shadow camera near, measured from the 2500 m light station
export const SHADOW_FAR_M = 6000; // shadow camera far, measured from the 2500 m light station
export const SHADOW_MOVE_EPS_M = 150; // shadow needsUpdate also fires when the rig target moved more than this (scroll alone, sun still)

export const SKY_EPS_DEG = 0.5; // sky-capture + fog colour refresh only when solar elevation changed more than this

export const TRACK_DIM_PAST = 1.0; // walked stretch opacity (full)
export const TRACK_DIM_FUTURE = 0.0; // E2: the road ahead does not exist; the line ends at the walker (was 0.35)
export const TRACK_TIP_FADE_M = 40; // E2: soft tip before the cut so the head is not a chop (audit: 180 reads better at drone distance — see TRACK_FADE_M below)
export const TRACK_FADE_M = 180; // BLOQUEANTE audit: 150-200 m of path in the tip fade (40 m is sub-pixel at 2.6-4.8 km camera distance)
export const EPILOGUE_S = 0.98; // E2/R3: epilogue transition; the full loop draws over s in [0.98, 1.00]

// --- audit A6: sky-ambient valley fill (a shadowed valley under clear sky
// is blue, not black). Dome colour comes from the same zenith estimate the
// debug overlay prints; floor is limestone in shadow. Day factor stays 1
// between sunrise and sunset and dies only after sunset (epilogue).
export const HEMI_DAY = 0.9; // hemisphere intensity while the sun is up (fraction of sky visible ~ sky dome)
export const HEMI_NIGHT = 0.06; // ...after sunset (faint skyglow, never pure black)
export const HEMI_SKY_RGB: [number, number, number] = [0.42, 0.55, 0.78]; // zenith-blue dome base (linear-ish, modulated by lightingAt rayleigh/elevation)
export const HEMI_GROUND_RGB: [number, number, number] = [0.32, 0.3, 0.26]; // limestone in shadow
// R1b floor (BLOCKER): early acts read 0.009-0.037 against a 0.06 target.
// The fill keeps the real sky hue and only lifts the level:
// uHemiSky = skyPreetham · max(1, HEMI_LUMA_FLOOR / luma(skyPreetham)).
export const HEMI_LUMA_FLOOR = 0.14; // linear-luma floor (was 0.10): Pradera 0.049 and mirador 0.042 still below 0.06
// G14: the published slope is a 200 m moving window, not the raw ±5 m stair.
export const SLOPE_WINDOW_M = 200; // misma ventana que la cifra publicada en sources.md; el crudo sobre 5 m llega a 493 % y no es publicable
export const G11_LUMA_MIN = 0.06; // mean linear framebuffer luminance at s=0.10 (audit A6, 32x32 readPixels grid)
export const LUMA_GRID = 32; // G11 readPixels grid (audit A6); measured in-browser via ?luma=1, every 30th frame

// --- audit A9: cloud layer seen from above (epilogue) must fade toward the
// zenith while keeping its grazing-incidence density.
export const CLOUD_ZENITH_FADE = 0.85; // max opacity cut looking straight down (0 = opaque disc, 1 = invisible)
export const CLOUD_FADE_START_DEG = 25; // view-ray elevation above which the fade ramps in (deg from horizontal)

// --- TEMBLOR (T3/T5): depth + correction dynamics, all in one place ---
// T3: the camera never gets within 500 m of anything; near=5 wastes depth
// precision over a 120 km frustum. near 50 + far 40000 (loaded terrain
// ends < 20 km) buys orders of magnitude for free. Logarithmic depth stays
// OFF (cost + shader recompile) unless this proves insufficient.
export const CAM_NEAR = 50; // m (was 5): nearest approach is 500 m+
export const CAM_FAR = 40000; // m (was 120000): 120 km of far plane for <20 km of terrain
// T5: asymmetric K_IN=18/K_OUT=2.5 rings when the LOS grazes terrain
// (snap in / creep out / snap in). Two cures, both:
// 1. explicit hysteresis — engage below CAM_CLEARANCE_M (25), release only
//    above CORR_RELEASE_M (60). No dead band, any asymmetric loop rings.
// 2. correction slew limit — |d(corr)| <= CORR_SLEW_MPS after smoothing.
//    A legit reframe never needs more than 40 m/s.
export const CORR_RELEASE_M = 60; // m: clearance at which the correction lets go
export const CORR_SLEW_MPS = 40; // m/s: max correction speed, applied post-smoothing

// --- E1-ter (confirmed necessary): altitude rule with pitch cap. Script
// pitches (27-36 deg) put the frame top 2-11 deg BELOW horizontal with a
// 50 deg vertical FOV — the sky cannot enter. Rule, in order:
// camAlt = max(targetY + dist·sin(pitchBase), CAM_ALT_MIN); then
// pitch = asin((camAlt − targetY) / dist); if pitch > PITCH_MAX, grow dist,
// never lower camAlt.
export const PITCH_MAX = 16; // deg (was 20): the five sky acts sit at 8.8-14.7 %, this puts them in range
export const CAM_ALT_MIN = 2950; // m: absolute camera altitude floor (valley floor ~1400 m + relief)
export const SKY_FRACTION_MIN = 0.15; // G12: sky occupies 15-35% of frame height in all seven acts
export const SKY_FRACTION_MAX = 0.35; // measured with the G11 framebuffer sampler, pixels above the geometric horizon

// --- E5 (correction): the turnaround is a rear three-quarter, not an
// opposition. A8 abs 125 (unwrapped from 275 via the short arc: -150) + A9
// abs 266 at s=0.95 (unwrapped 266, +141 from 125). Net A7->A10: -9 deg
// with a +-150 excursion — no full turn, no exempt window, no run-out gates.
// A7->A8: 150 deg / 115 steps = 1.30 deg/step; A8->A9: 141 deg / 90 steps =
// 1.57 deg/step; PCHIP overshoot (~1.5x) stays under the 2.5 threshold.
export const A4B_S = 0.51; // E5.4: entry gate to the cornice — canyon axis to void side happens here, in the wide valley mouth
// A9 (E5 correction): yaw pin on the valley axis (displayed 266, unwrapped
// 266) at s=0.95 — the turn ends before the corridor, 0.95→1.00 holds 266.
export const A9_S = 0.95; // was 0.94: ends the turn before the corridor
export const A9_YAW_UNWRAPPED = 266; // abs 266 on the short-arc branch from A8's 125 (+141)

// --- E3 (luminous tube at milestones): width as a function of camera-target
// distance + additive halo on the same geometry, gated by uGlow near A3/A7/A8.
export const LINE_W_FAR = 2; // px above LINE_W_D_FAR (sober line)
export const LINE_W_NEAR = 7; // px below LINE_W_D_NEAR (ribbon near the path)
export const LINE_W_D_FAR = 1200; // m: smoothstep upper edge
export const LINE_W_D_NEAR = 400; // m: smoothstep lower edge
export const GLOW_MULT = 3; // halo pass width x3, drawn first
export const GLOW_ALPHA = 0.18; // halo opacity (cream, additive)
export const GLOW_S_WINDOW = 0.02; // uGlow 0..1 within +-0.02 s of A3/A7/A8

// --- E4 (line floats over decimated mesh): full-res corridor around track ---
export const CORRIDOR_HALF_M = 150; // force LOD 0 within +-150 m of the track
export const G13_TOL_M = 12.0; // residual slope-stencil difference after the corridor fix (E4: corridor kills the LOD term; the stencil term on 8:1 walls is ~11.5 m and is NOT float — it is the drape following the wall, honest relief)

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
export type YawSpec = { mode: "abs"; deg: number; unwrapped?: number } | { mode: "tang"; off: number } | { mode: "hold" };
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
  // E1: drone framing replaces the whole table. Criterion (G12): sky fills
  // 15-35% of frame height in all seven acts; dist 900-1800 m at ~30 deg
  // pitch keeps the camera in free air (G9 solves itself) and puts texture
  // defects below screen pixel at 2.4 m/px.
  { id: "A0", s: 0.0, kmBrief: 0.0, distM: 1600, pitchDeg: 30, yaw: { mode: "abs", deg: 266 }, hTargetM: 60 },
  { id: "A1", s: 0.06, kmBrief: 0.3, distM: 1400, pitchDeg: 30, yaw: { mode: "tang", off: 150 }, hTargetM: 50 },
  { id: "A2", s: 0.18, kmBrief: 1.2, distM: 1200, pitchDeg: 32, yaw: { mode: "tang", off: 120 }, hTargetM: 45 },
  { id: "A3", s: 0.3, kmBrief: 2.44, distM: 1500, pitchDeg: 30, yaw: { mode: "abs", deg: 266 }, hTargetM: 60 },
  { id: "A4", s: 0.46, kmBrief: 3.0, distM: 1700, pitchDeg: 28, yaw: { mode: "abs", deg: 266 }, hTargetM: 70 },
  // A4b (E5.4): entry gate — canyon axis to void side BEFORE the ledge, in
  // the wide valley mouth. dist/pitch interpolate (never hand-set); only yaw
  // is prescribed. The whole A4b->A5->A6 span then flies over air.
  { id: "A4b", s: 0.51, kmBrief: -1, distM: -1, pitchDeg: -1, yaw: { mode: "tang", off: 90 }, hTargetM: -1 },
  { id: "A5", s: 0.57, kmBrief: 6.0, distM: 1500, pitchDeg: 30, yaw: { mode: "tang", off: 90 }, hTargetM: 60 },
  { id: "A6", s: 0.68, kmBrief: 9.0, distM: 1700, pitchDeg: 28, yaw: { mode: "abs", deg: 250 }, hTargetM: 80 },
  { id: "A7", s: 0.745, kmBrief: 9.67, distM: 900, pitchDeg: 26, yaw: { mode: "abs", deg: 275 }, hTargetM: 50 },
  // A8 (E5 correction): rear three-quarter (abs 125), not the opposition
  // (85). Frames the turnaround just as well and kills the full turn.
  { id: "A8", s: 0.86, kmBrief: 10.5, distM: 1400, pitchDeg: 34, yaw: { mode: "abs", deg: 125 }, hTargetM: 90 },
  // A9 (E5 correction): valley-axis pin at s=0.95, unwrapped 266 (+141 from
  // A8's 125 via the short arc). 0.95→1.00 holds 266 down the descent.
  { id: "A9", s: A9_S, kmBrief: 14.0, distM: 1500, pitchDeg: 30, yaw: { mode: "abs", deg: 266, unwrapped: 266 }, hTargetM: 60 },
  { id: "A10", s: 0.98, kmBrief: 18.13, distM: 1800, pitchDeg: 32, yaw: { mode: "abs", deg: 266 }, hTargetM: 80 },
  // A11 epilogue: camera detached and high, no longer the walker's POV
  { id: "A11", s: 1.0, kmBrief: 18.13, distM: 3200, pitchDeg: 38, yaw: { mode: "abs", deg: 266 }, hTargetM: 400 },
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

// G4 has NO exempt window (E5 correction): 2.5 deg/step over the whole
// route, no exceptions. If it fails, move A9 to 0.96 — never re-add
// an exemption.

// @doc-only: brief figure, NEVER a distance axis. Used only to compute the 2%
// divergence warning in verify:3a and doctor. The real axis is route.lengthM.
export const BRIEF_LENGTH_M = 18125.9;
export const ROUTE_DIVERGE_PCT = 2; // beyond ~360 m the track changed or the resample is wrong: stop and report
