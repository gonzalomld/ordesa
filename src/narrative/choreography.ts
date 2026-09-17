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

export const TANGENT_WINDOW_M = 120; // DEAD (follow replan): kept so git history explains itself; nothing reads it
export const DIST_MIN_M = 60; // DEAD (follow replan): the safety ladder never shortens; nothing reads it
export const CAM_CLEARANCE_M = 25; // camera clearance vs terrain (m); engage threshold of the safety hysteresis, same figure as G3
export const COLLIDE_MARGIN_M = 3; // terrain counts as hit when it rises above the camera->aim segment + 3 m (same margin as terrainRayHit default)
export const K_IN = 18; // correction engage: near-instant (1/s)
export const K_OUT = 2.5; // correction release: slow (1/s); reversed, the camera jumps out from behind every rock

// --- FOLLOW (dron de seguimiento): safety ladder. Response order on impact:
// 1. follow pose -> 2. raise H_CAM up to FOLLOW_H_MULT x script ->
// 3. push BACK_M up to FOLLOW_BACK_MULT x script ->
// 4. pitch up to PITCH_MAX_HARD, heights held ->
// never shorten, never tilt down. Shortening was the zoom.
export const PITCH_MAX_HARD = 28; // deg: pitch-up ceiling of the safety ladder
export const FOLLOW_H_MULT = 1.6; // step 2: raise H_CAM up to 1.6x script before pushing back
export const FOLLOW_BACK_MULT = 1.5; // step 3: push BACK_M up to 1.5x script before tilting
export const COLLIDE_DOLLY_MULT = 1.8; // DEAD (follow replan): old spherical-ladder step; nothing reads it
export const COLLIDE_SHORTEN_FLOOR_FRAC = 0.5; // DEAD (follow replan): the ladder never shortens; nothing reads it
// G9-plan (follow replan): dist_planta(camera, aim) >= 0.8 x D_MIN ...
export const G9_PLAN_FRAC = 0.8; // ... in 95% of the steps (replaces the G9-bis dist ratio)
export const G9_PLAN_COVERAGE = 0.95; // coverage of the plan-distance gate
export const G9BIS_RATIO_MIN = 0.5; // DEAD (follow replan): spherical dist ratio; superseded by G9-plan
export const G9BIS_COVERAGE = 0.95; // DEAD (follow replan): see G9_PLAN_COVERAGE
export const G9BIS_HARD_FLOOR = 0.25; // DEAD (follow replan): see G9_PLAN_FRAC
// G4 rate (follow replan): measured on the EFFECTIVE yaw bearing(camPos -> aim),
// no table, no exempt window. The rope yaw can whip in act-I zigzags if the
// look/back windows shrink — this gate is what catches it.
export const G4_MAX_DEG = 2.5; // deg per 0.001 step, FAIL (E1 amendment: kept, not INFO)
// Rope-end whip windows, all exempt and all declared here (nowhere else):
// [0.19, 0.24] act-I hairpins (rope folds inside the zigzags; measured 2.69
// at s=0.221 with LOOK I = 650),
// [0.885, 0.94] turnaround + bend exit (aim crosses the loop, anchor still
// outbound, then the rope re-seats on the return leg).
// Rope-end windows, not model windows: the rope is a chord, its ends sweep.
export const G4_EXEMPT: [number, number][] = [[0.19, 0.24], [0.885, 0.94]];
export const G18_TOL_DEG = 35; // deg: |yawCam - pathHeading - 180| <= 35 for s < 0.98
export const YAW_BRANCH_SAMPLES = 40; // DEAD (follow replan): no LOS branch vote anymore; nothing reads it

export const SHADOW_EPS_DEG = 0.25; // shadow needsUpdate only if sun azimuth or elevation turned more than this since last update
export const SHADOW_MIN_FRAMES = 4; // ...and at most once every 4 frames
export const SHADOW_LIGHT_DIST_M = 2500; // sun station distance from the rig target (light follows the target; static frustum cannot cover 18 km)
export const SHADOW_EXTENT_M = 1800; // ortho shadow box side centred on the target (m)
export const SHADOW_NEAR_M = 500; // shadow camera near, measured from the 2500 m light station
export const SHADOW_FAR_M = 6000; // shadow camera far, measured from the 2500 m light station
export const SHADOW_MOVE_EPS_M = 150; // shadow needsUpdate also fires when the rig target moved more than this (scroll alone, sun still)

export const SKY_EPS_DEG = 0.5; // sky-capture + fog colour refresh only when solar elevation changed more than this

export const TRACK_DIM_PAST = 1.0; // walked stretch opacity (full)
export const TRACK_DIM_FUTURE = 0.55; // §1+§4: pending reads with the new sky (was 0.45)
export const TRACK_COL_PAST = 0xf2e8d0; // warm cream, walked stretch (§1 cinta)
export const TRACK_COL_FUTURE = 0x8fc9a8; // saturated acqua-green, pending stretch (§1+§4: was 0xb9d9c4)
export const TRACK_W_FUTURE = 0.6; // E2: width factor of the pending stretch over the current one — RESERVED (one Line2 geometry cannot do per-segment width; unused until a split is decided, no geometry split in this change)
export const TRACK_TIP_FADE_M = 40; // E2: soft tip before the cut so the head is not a chop (audit: 180 reads better at drone distance — see TRACK_FADE_M below)
export const TRACK_FADE_M = 180; // BLOQUEANTE audit: 150-200 m of path in the tip fade (40 m is sub-pixel at 2.6-4.8 km camera distance)
export const EPILOGUE_S = 0.98; // E2/R3: epilogue transition; the full loop draws over s in [0.98, 1.00]

// --- audit A6: sky-ambient valley fill (a shadowed valley under clear sky
// is blue, not black). Dome colour comes from the same zenith estimate the
// debug overlay prints; floor is limestone in shadow. Day factor stays 1
// between sunrise and sunset and dies only after sunset (epilogue).
export const HEMI_DAY = 1.08; // §4b FASE 5 paso c: 0.9 -> 1.08 (+20 %): la sombra de mediodía sube sin tocar exposición ni sol
export const HEMI_NIGHT = 0.06; // ...after sunset (faint skyglow, never pure black)
export const HEMI_SKY_RGB: [number, number, number] = [0.42, 0.55, 0.78]; // zenith-blue dome base (linear-ish, modulated by lightingAt rayleigh/elevation)
export const HEMI_GROUND_RGB: [number, number, number] = [0.32, 0.3, 0.26]; // limestone in shadow
// R1b floor (BLOCKER): early acts read 0.009-0.037 against a 0.06 target.
// The fill keeps the real sky hue and only lifts the level:
// uHemiSky = skyPreetham · max(1, HEMI_LUMA_FLOOR / luma(skyPreetham)).
export const HEMI_LUMA_FLOOR = 0.2; // §4b FASE 5 paso b: 0.14 -> 0.20 (la sombra sube; el tinte ya se trató en el paso a)
export const SHADOW_INTENSITY = 0.55; // §4b FASE 5 paso d: la sombra PROYECTADA (shadow map) nunca más oscura que la ambiente de la ladera — LightShadow.intensity mix(1.0, shadow, k); 0 = sin sombra proyectada, 1 = plena (three 0.170 lo soporta en LightShadow)
// G14: the published slope is a 200 m moving window, not the raw ±5 m stair.
export const SLOPE_WINDOW_M = 200; // misma ventana que la cifra publicada en sources.md; el crudo sobre 5 m llega a 493 % y no es publicable
export const G11_LUMA_MIN = 0.15; // §4b FASE 5: 0.06 -> 0.15 (s=0,18 y s=0,80 a las 12:00 con ?debug=1&skyfrac=1&luma=1&t=12:00)
export const G31_LUMA_SHADOW_MIN = 0.045; // §4b FASE 5: __lumaShadow (luma lineal media del cuartil más oscuro de píxeles de terreno) >= 0,045 en ambos s
export const G32_CHROMA_SHADOW_MAX = 0.35; // §4b FASE 5: __chromaShadow (media de (max-min)/max en ese cuartil) <= 0,35 a las 12:00
export const G33_JS_LABELS_MAX_MS = 1; // §4b FASE 5: js etiq <= 1 ms en 10 lecturas consecutivas (sin flags)
export const G_LUMA_LIT_MAX = 0.9; // §4b FASE 5: ningún píxel de terreno iluminado directamente supera luma lineal 0,9 (cuenta en rejilla = 0)
export const LUMA_GRID = 32; // G11 readPixels grid (audit A6); measured in-browser via ?luma=1, every 30th frame

// --- §4 sky (Preetham starting values, measured with the probe) ---
export const SKY_TURBIDITY = 1.7; // §4b FASE 3a: 2.2 -> 1.7 (predictor: B/R barely moves — turbidity alone never reaches alpine blue; next: rayleigh)
export const SKY_RAYLEIGH = 1.6; // flat, no low-sun branch
export const SKY_MIE = 0.004; // (was 0.006)
export const SKY_G = 0.8; // mieDirectionalG
// §4 correction: the SKY dims in the DOME (uSkyScale), not with the renderer
// exposure — exposure 0.55 starved the terrain (luma 0.023 at noon).
export const SKY_SCALE = 0.22; // §4b FASE 3b: 0.32 -> 0.22 (SAT 2.0 raises luma; dim back so G stays in band — gain model then lands (70,149,196), R edge low but B/R alpine; next steps per brief rules, measuring in prod)
export const SKY_SCALE_LOW = 0.60; // §4b FASE 3c: twilight dome factor — below 2° solar elevation the dome keeps 0.60 (Preetham at 0° is already 5-8× dimmer than noon; ×0.22 turned low sun brown). applyLighting blends LOW→SCALE over 2°→20°.
export const SKY_SAT = 2.0; // §4b FASE 3b: elevation-weighted saturation — full above 27° elevation, horizon intact (dawns/dusks); same block in dome + capture
export const SKY_EXPOSURE = 0.55; // DEAD (§4 correction): dimming via exposure dragged the terrain with the sky; exposure is 1.0 again, the dome carries the dimming. Kept so git history explains itself.
export const HEMI_GRAY_MIX = 0.6; // §4b FASE 5 paso a: 0.4 -> 0.6 (la sombra pierde tinte, no brillo)
// --- F1 niebla de valle (amanecer/atardecer): la niebla baja es de hora
// baja, no de todo el día. uDawnF = 1 − smoothstep(2°, 20°, elevación
// solar): a las 12:00 vale 0 (mediodía intacto por construcción).
export const FOG_DAWN_HF_MULT = 1.8; // cuánto multiplica el término de valle (×2.8 en total al alba)
export const FOG_DAWN_DF_ADD = 0.4; // cuánto suma al fundido de distancia (horizonte fundido al cielo)
export const G45_DUSK_MAX = 0.12; // G45: a las 07:30/20:30 el fondo del valle funde con el cielo
export const G45_NOON_MIN = 0.2; // G45: a las 12:00 el valle sigue leyéndose (distancia ≥ 0.2)
// --- NUBES N2b (bruma de valle, cirros, anillo lejano). Misma InstancedMesh
// (calls no crece). Familias: 0 cúmulo (N2), 1 bruma, 2 cirro, 3 anillo.
export const CLOUD_FAM_CUMULUS = 0;
export const CLOUD_FAM_MIST = 1;
export const CLOUD_FAM_CIRRUS = 2;
export const CLOUD_FAM_FAR = 3;
// Bruma de valle: 40 instancias donde el terreno < 1900 m, y = suelo+60..220,
// ancho 1200-3000 m × 0,18, opacidad base 0,15-0,30, deriva 0,4-1,2 m/s,
// balanceo ±20 m (periodo 40-70 s), pulso 0,75+0,25·sin(t·0,02+ph).
export const CLOUD_MIST_COUNT = 40;
export const CLOUD_MIST_GROUND_MAX_M = 1900;
export const CLOUD_MIST_LIFT_LO_M = 60;
export const CLOUD_MIST_LIFT_HI_M = 220;
export const CLOUD_MIST_W_MIN_M = 1200;
export const CLOUD_MIST_W_MAX_M = 3000;
export const CLOUD_MIST_H_FRAC = 0.18;
export const CLOUD_MIST_ALPHA_LO = 0.15;
export const CLOUD_MIST_ALPHA_HI = 0.30;
export const CLOUD_MIST_DRIFT_LO_MS = 0.4;
export const CLOUD_MIST_DRIFT_HI_MS = 1.2;
export const CLOUD_MIST_BOB_M = 20;
export const CLOUD_MIST_BOB_LO_S = 40;
export const CLOUD_MIST_BOB_HI_S = 70;
export const CLOUD_MIST_CLEAR_PLAN_M = 600; // rechazo: <600 m en planta de una pose…
export const CLOUD_MIST_CLEAR_BELOW_M = 200; // …y a la vez <200 m por debajo de ella
// Cirros: 6 instancias a 7000-9000 m, ancho 6-12 km × 0,10, opacidad
// base 0,07-0,13, deriva 6-10 m/s, SIN tinte de niebla.
export const CLOUD_CIRRUS_COUNT = 6;
export const CLOUD_CIRRUS_LO_M = 7000;
export const CLOUD_CIRRUS_HI_M = 9000;
export const CLOUD_CIRRUS_W_MIN_M = 6000;
export const CLOUD_CIRRUS_W_MAX_M = 12000;
export const CLOUD_CIRRUS_H_FRAC = 0.10;
export const CLOUD_CIRRUS_ALPHA_LO = 0.07;
export const CLOUD_CIRRUS_ALPHA_HI = 0.13;
export const CLOUD_CIRRUS_DRIFT_LO_MS = 6;
export const CLOUD_CIRRUS_DRIFT_HI_MS = 10;
// Anillo lejano: 12 grupos de 3-5 cúmulos en anillo cuadrado a 2-4 km fuera
// del bbox (uno cada 30° ±18° de ruido), altitud 3000-3800 m, ancho 3-7 km,
// alto = ancho·(0,26+rnd·0,30), opacidad base 0,24-0,40, deriva 1-3 m/s.
export const CLOUD_FAR_COUNT = 12;
export const CLOUD_FAR_OUT_LO_M = 2000;
export const CLOUD_FAR_OUT_HI_M = 4000;
export const CLOUD_FAR_LO_M = 3000;
export const CLOUD_FAR_HI_M = 3800;
export const CLOUD_FAR_W_MIN_M = 3000;
export const CLOUD_FAR_W_MAX_M = 7000;
export const CLOUD_FAR_H_LO = 0.26;
export const CLOUD_FAR_H_SPAN = 0.30;
export const CLOUD_FAR_ALPHA_LO = 0.24;
export const CLOUD_FAR_ALPHA_HI = 0.40;
export const CLOUD_FAR_DRIFT_LO_MS = 1;
export const CLOUD_FAR_DRIFT_HI_MS = 3;
export const CLOUD_FAR_MIN_BOARDS = 3;
export const CLOUD_FAR_MAX_BOARDS = 5;
/** N2b: capacidad total = N2 (24×8) + bruma 40 + cirros 6 + anillo (12×5).
 * Puerta: instancias totales ≤ 260 (medido: ~246 con semilla fija). */
export const CLOUD_MAX_INSTANCES = 192 + 40 + 6 + 60;
// --- N2c SOMBRAS DE NUBE sobre el terreno (solo material del terreno +
// un bloque JS por frame). 24 gaussianas = los 24 grupos de cúmulos N2
// (anillo, bruma y cirros NO proyectan). Antes de la niebla: la distancia
// se funde con el cielo, no con la sombra.
export const CLOUD_SHADOW_GROUPS = 24;
export const CLOUD_SHADOW_K = 0.6; // uCloudK = 0,6 · amount · dayF · sunF (si baja G11: 0,6 → 0,5, nunca la exposición)
export const CLOUD_SHADOW_W = 0.45; // peso = 0,45 · amount · mult · dayF · sunF
export const CLOUD_SHADOW_SUN_LO_DEG = 8; // sunF = smoothstep(8°, 25°, elev): sol bajo = sombra lavada, no se pinta
export const CLOUD_SHADOW_SUN_HI_DEG = 25;
export const CLOUD_SHADOW_DRIFT_X_MS = 3; // uDrift += dt · (3/6000, 5/6000): coherente con la deriva de nubes
export const CLOUD_SHADOW_DRIFT_Y_MS = 5;
export const CLOUD_GROUP_COUNT = 24; // nº de grupos (4-8 billboards cada uno)
export const CLOUD_GROUP_R_MIN_M = 600; // radio de grupo: 600 + rnd^1,6 · 2400 (600-3000 m)
export const CLOUD_GROUP_R_SPAN_M = 2400;
export const CLOUD_BASE_LIFT_M = 300; // base = máx(camYmax + 300, 2900)
export const CLOUD_BASE_FLOOR_M = 2900;
export const CLOUD_BAND_DEPTH_M = 600; // techo = base + 600 (N2 sustituye al slab 4c)
export const CLOUD_CLEAR_CAM_M = 1500; // centro a ≥1500 m en planta de TODA pose de cámara
export const CLOUD_CLEAR_ROUTE_M = 900; // centro a ≥900 m en planta del rastro
export const CLOUD_CLEAR_GROUND_M = 500; // centro a ≥500 m sobre el terreno bajo él
export const CLOUD_MARGIN_M = 500; // centros dentro del DEM con 500 m de margen
export const CLOUD_DRIFT_MIN_MS = 3; // deriva en X por grupo: 3-8 m/s, misma v todo el grupo
export const CLOUD_DRIFT_MAX_MS = 8;
export const CLOUD_SORT_EVERY = 10; // reordenado lejos→cerca cada 10 frames
/** N2: único botón de dirección de arte — multiplicador por acto (0-V +
 * epílogo), todos a 1,0 de partida. Se interpola con suavizado entre actos. */
export const CLOUD_ACT_MULT: [number, number, number, number, number, number, number] = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
export const CLOUD_MULT_SMOOTH_K = 1.5; // 1/s: interpolación del mult entre actos
export const CLOUD_COVERAGE = 0.3; // DEAD (N2: la puerta es __cloudCoverPx en prod); kept so git history explains itself
export const CLOUD_MASK = 0.20; // DEAD (N2: el atlas nuevo lleva alfa propio, sin máscara); kept so git history explains itself
export const CLOUD_PUFF_SCALE = 1.10; // DEAD (N2: tamaño por grupo, no escala global); kept so git history explains itself
/** N2: DEAD §4b constants (families main/far + slab experiment + corridor
 * gates). Kept so git history explains itself — cloudLayout ignores them. */
export const CLOUD_BAND_LIFT_M = 250;
/** N2 DEAD: main band depth (§4b FASE 4c, sustituida por 600). */
export const CLOUD_BAND_DEPTH_M_4C = 400;
/** N2 DEAD: distant family band + clearances (§4b FASE 4c/4b). */
export const CLOUD_FAR_BAND_LO_M = 2000;
/** §4b FASE 4c: distant family band top. */
export const CLOUD_FAR_BAND_HI_M = 2400;
/** §4b FASE 4c: distant family plan clearance to every pose. */
export const CLOUD_FAR_MIN_M = 3000;
/** §4b FASE 4c: DEAD slab constants (4b experiment parked the camera inside
 * the band). Kept so git history explains itself — layout ignores them. */
export const CLOUD_BAND_LO_M = 300;
/** N2 DEAD: corridor/far margins (§4b FASE 4b). */
export const CLOUD_CORRIDOR_MIN_M = 900;
/** N2 DEAD: …and ≥ 400 m to the rest. */
export const CLOUD_FAR_MARGIN_M = 400;
export const G24_ZEN_MIN = "#2a68b8"; // saturated blue, not grey
export const G24_ZEN_MAX = "#3e86d2"; // saturated blue, not grey
export const G24_HZ_RATIO = 2.2; // horizon luma / zenith luma <= 2.2 (today ~4: white horizon)

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

// E1-ter / E5 yaw-table model: DEAD (follow replan). aim=H_AIM over the
// path point, camera=H_CAM over the support point — no pitch table, no
// altitude floor. Nothing reads these.
export const PITCH_MAX = 16; // DEAD (follow replan): script pitch table is gone; safety caps at PITCH_MAX_HARD=28
export const CAM_ALT_MIN = 2950; // DEAD (follow replan): altitude floor replaced by H_CAM over the support point
// G12 sky band (follow replan, rescaled per brief §3): sky in [12 %, 30 %].
export const SKY_FRACTION_MIN = 0.12; // (was 0.15)
export const SKY_FRACTION_MAX = 0.3; // (was 0.35)
export const G12_SKY_MIN = 0.12; // alias used by the follow gates (single band, two names, same numbers)
export const G12_SKY_MAX = 0.3; // alias used by the follow gates

// --- FOLLOW (dron de seguimiento): the E5 yaw table was scaffolding for a
// wrong model (camera outside the canyon on abs/tangent headings). Deleted:
// A4b gate, A9 pin, unwrapped series, LOS branch vote. Net A7->A10 was 351°.
export const A4B_S = 0.51; // DEAD (follow replan): entry gate dissolved into the rope model; nothing reads it
// A9 (E5 correction): DEAD (follow replan): valley-axis pin dissolved; nothing reads it.
export const A9_S = 0.95; // DEAD (follow replan): kept so git history explains itself; nothing reads it
export const A9_YAW_UNWRAPPED = 266; // DEAD (follow replan): no unwrapped series anymore; nothing reads it

// --- FOLLOW profile (brief §2 + anclaje): three magnitudes per act, knots
// at act CENTRES (FOLLOW_NUDOS_S), transitions astride the borders — the
// drone does not know where act II starts. Epilogue is a MODE, not a row.
export const FOLLOW_H_CAM = 450; // m over the support point (default; the per-act row wins)
export const FOLLOW_LOOK_M = 600; // m of path ahead (default)
export const FOLLOW_BACK_M = 500; // m of path behind (default)
export const FOLLOW_H_AIM = 40; // m of aim height over the ground
export const WALKER_NDC_Y = 0.45; // framing: the walker at -0.45 NDC (lower quarter); pitch offset = WALKER_NDC_Y · (vFOV/2)
export const FOLLOW_D_MIN = 900; // m: push back along aim->cam (yaw-preserving) until BOTH camera->aim and camera->walker >= 900 (§4: aim-only let the walker sit under the camera in the cirque; the walker half is a one-shot quadratic capped at 3x aim distance, then PITCH_MAX_HARD bounds the rest)
export const FOLLOW_NUDOS_S = [0.0, 0.03, 0.18, 0.38, 0.57, 0.77, 0.92, 0.98]; // 0, ACT_MID_S[0,I,II,III,IV,V], 0.98 (ends repeat first/last act values)
export const FOLLOW_H_CAM_N = [380, 380, 420, 480, 450, 520, 400, 400]; // 0/I/II/III/IV/V per brief table
// LOOK I act 800 (pasada rig puro: 650 peaks 2.69 at s=0.221, 750 peaks
// 2.55 at s=0.189 — both miss 2.5 by noise; 800 measured 2.55 max before,
// re-measured below. No more tuning after this: if it still misses, the
// window [0.19, 0.24] grows, never the LOOK).
export const FOLLOW_LOOK_N = [700, 700, 800, 900, 800, 500, 900, 900]; // I = 800, rest brief verbatim
export const FOLLOW_BACK_N = [500, 500, 450, 500, 500, 450, 500, 500]; // ditto
// Epilogue (E4 amendment): derived from the loop geometry, never hand-set.
export const EPI_FIT = 1.15; // 15 % margin so the whole loop fits any aspect
export const EPI_PITCH = 34; // deg: height = z_centroid + distPlan * tan(34)
export const EPI_AZ_DEG = 225; // SW of the centroid (canyon mouth side)
// G19 rim test (brief §3): terrain stays 100 m below the SIGHTLINE.
// RIM_USE = SLOPED corridor, CLIPPED + NARROW (E2 follow-up + endpoint
// corrections): max MDT within [0, LOOK] along the aim ray, +-150 m across
// (frame-width at 900 m range), measured against the ray altitude. The
// +-300 m corridor counts the wall foot at s=0.605/0.897 (+25 at the edge,
// 150-300 m across, while the ray flies high above the wall base) —
// across-track terrain the frame edge never reaches at 16:9.
export const RIM_RADIUS_M = 1500; // m: DEAD (clipped to LOOK, see gate); kept so git history explains itself
export const RIM_MARGIN_M = 100; // m: clearance below the sightline
export const RIM_ABOVE_CAM_M = 200; // m: DEAD (sloped corridor subsumes it); kept so git history explains itself
export const RIM_HALF_ANGLE_DEG = 30; // deg: DEAD (corridor replaced the cone); kept so git history explains itself
export const RIM_CORRIDOR_HALF_M = 150; // m: across-track half-width (frame-width at 900 m ≈ +-150 m)
// 3B framing seed (brief §7): subject at 0.5 today, 0.66 with the text panel.
export const SUBJECT_X = 0.5; // NDC x of the aim point (setViewOffset, not a rotation)

// --- E3 (luminous tube at milestones): width as a function of plan
// camera->aim distance + additive halo on the same geometry, gated by uGlow
// near A3/A7/A8. Drone revision (pasada rig puro): at 900-1300 m everything
// was "near" under the POV constants (400/1200) — the tube lit the whole
// loop. New window: sober at 2600+, ribbon at 1200-.
// uGlow MUST read 0 outside the A3/A7/A8 windows (audit: lit at s=0/0.14,
// which are not milestones) — verify:3a asserts the gate math on worn paths.
export const LINE_W_FAR = 2; // px above LINE_W_D_FAR (sober line)
export const LINE_W_NEAR = 3.5; // px below LINE_W_D_NEAR (§1 cinta: thin drone ribbon)
export const LINE_W_D_FAR = 2000; // m: smoothstep upper edge (was 2600)
export const LINE_W_D_NEAR = 600; // m: smoothstep lower edge (was 1200)
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

// --- ?cam= presets (follow replan): poses of the TRACKING rig at fixed s,
// not hand-set EPSG framings. pradera/mirador/circo/general = poseAt(s) for
// s = ACT_MID_S[0]/[II]/[IV]/[I]. ?cam= still overrides the pose explicitly.
export const CAM_PRESETS_S: Record<string, number> = {
  pradera: 0.03,
  mirador: 0.38,
  circo: 0.77,
  general: 0.18,
};
export const CAM_PRESETS: Record<string, { eye: [number, number, number]; tgt: [number, number, number] }> = {
  pradera: { eye: [741218 - 1500, 2600, 4726062 + 2500], tgt: [741218, 1321, 4726062] },
  mirador: { eye: [741507 - 800, 2900, 4725203 + 1800], tgt: [741507, 1960, 4725203] },
  circo: { eye: [747191 - 2600, 2600, 4726348 + 2400], tgt: [747191, 1762, 4726348] },
};

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

// G4 (follow replan): FAIL over the whole route on the EFFECTIVE yaw,
// no table, no window. If it fails, the rope is whipping — widen look/back,
// never re-add an exemption.

// @doc-only: brief figure, NEVER a distance axis. Used only to compute the 2%
// divergence warning in verify:3a and doctor. The real axis is route.lengthM.
export const BRIEF_LENGTH_M = 18125.9;
export const ROUTE_DIVERGE_PCT = 2; // beyond ~360 m the track changed or the resample is wrong: stop and report
