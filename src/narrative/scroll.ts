// scroll.ts — Lenis + s normalisation. No camera, no time.
// Single rAF rule: the render loop calls scroll.update(dtMs, timeMs),
// which pumps lenis.raf(timeMs). No rAF of its own.
import Lenis from "lenis";
import {
  ACT_MID_S,
  BRIEF_LENGTH_M,
  K_SCROLL,
  K_SCROLL_REDUCED,
  LENIS_LERP,
  LENIS_SMOOTH_WHEEL,
  LENIS_SYNC_TOUCH,
  LENIS_TOUCH_MULT,
  LENIS_WHEEL_MULT,
  TRACK_VH,
} from "./choreography.ts";

export interface ScrollProbeState {
  /** total scroll length in screens (scrollHeight / innerHeight) */
  screens: number;
  /** screens per km of brief route (G58 gate reads this) */
  pxPerKm: number;
  sRaw: number;
  s: number;
  /** ms from the last wheel event until |s - sRaw| < 0.001 (loop-measured) */
  settleMs: number;
}

export interface CamXYZ {
  x: number;
  y: number;
  z: number;
}

export type ProbeTick = (nowMs: number, sRaw: number, s: number, cam: CamXYZ | null) => void;

export interface WheelSample {
  t: number;
  sRaw: number;
  s: number;
  camX: number;
  camY: number;
  camZ: number;
}

export interface ScrollHandle {
  sRaw: number;
  s: number;
  update(dtMs: number, timeMs: number): void;
  freezeAt(v: number | null): void;
  stop(): void;
  start(): void;
  dispose(): void;
  /** N3 plumbing for the deferred ?wheeltest=1 probe: the viewer hands a
   * live camera-position getter; the probe reads it per frame. No behaviour. */
  setCamProbe(getter: (() => CamXYZ) | null): void;
  /** N3: slot for the deferred wheeltest recorder (scroll-probe.ts only). */
  setProbeTick(fn: ProbeTick | null): void;
}

export function parseSParam(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw.trim().replace(",", "."));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

export function createScroll(): ScrollHandle {
  // B7: the browser restores scroll pos on reload — the gate would say km 0
  // with the piece at km 12 behind it. Manual restoration, decided upfront.
  try {
    history.scrollRestoration = "manual";
  } catch {
    /* non-fatal */
  }
  const q = new URLSearchParams(location.search);
  let frozen: number | null = parseSParam(q.get("s"));
  if (frozen === null) {
    const act = (q.get("act") ?? "").trim().toUpperCase();
    if (act !== "" && ACT_MID_S[act] !== undefined) frozen = ACT_MID_S[act] as number;
  }
  // N3 instruments (?debug=1 scroll probe, ?wheeltest=1 synthetic notches).
  // The wheel listener only exists when a flag is present: zero trace in
  // production scrolling. The heavy wheeltest runner is a deferred chunk
  // (scroll-probe.ts) loaded on gate enter, never in the entry bundle.
  const dbgMode = q.get("debug");
  const debugProbe = dbgMode === "1" || dbgMode === "steep";
  const wheeltest = q.get("wheeltest") === "1";
  const probeOn = debugProbe || wheeltest;

  // C7: single source — TS writes --track-vh at boot, CSS only consumes it.
  document.documentElement.style.setProperty("--track-vh", `${TRACK_VH}vh`);
  let track = document.getElementById("scroll-track");
  if (!track) {
    track = document.createElement("div");
    track.id = "scroll-track";
    const canvas = document.getElementById("scene");
    if (canvas?.parentNode) canvas.parentNode.insertBefore(track, canvas.nextSibling);
    else document.body.prepend(track);
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const k = reduced ? K_SCROLL_REDUCED : K_SCROLL;
  let lenis: Lenis | null = null;
  if (!reduced && frozen === null) {
    // N3: frame-based lerp damping (Everest parity). duration/easing is the
    // other Lenis mode — mutually exclusive, never pass both.
    lenis = new Lenis({
      lerp: LENIS_LERP,
      wheelMultiplier: LENIS_WHEEL_MULT,
      touchMultiplier: LENIS_TOUCH_MULT,
      smoothWheel: LENIS_SMOOTH_WHEEL,
      syncTouch: LENIS_SYNC_TOUCH,
    });
  }

  // settleMs: measured in the loop, never estimated. Each wheel event
  // re-opens the window; it closes when |s - sRaw| < 0.001.
  let lastWheelT = -1;
  let settled = true;
  let settleDoneMs = 0;
  const onWheel = (): void => {
    lastWheelT = performance.now();
    settled = false;
  };
  if (probeOn) window.addEventListener("wheel", onWheel, { passive: true });

  let camProbe: (() => CamXYZ) | null = null;
  let probeTick: ProbeTick | null = null;
  let wheelArmed = false;
  let wheelCancel: (() => void) | null = null;

  const armWheeltest = (): void => {
    if (!wheeltest || wheelArmed) return;
    wheelArmed = true;
    if (frozen !== null || reduced || !lenis) {
      (window as unknown as { __wheelTest?: unknown }).__wheelTest = {
        done: false,
        skipped: frozen !== null ? "frozen ?s=/?act=" : "reduced-motion",
      };
      return;
    }
    // Deferred: production never downloads this chunk without the flag.
    void import("./scroll-probe.ts").then(
      (m) => {
        wheelCancel = m.runWheelTest(h);
      },
      () => {
        /* probe failed to load — production unaffected */
      },
    );
  };

  // frozen (?s= / ?act=): no scroll reading at all, sRaw is the fixed value
  const h: ScrollHandle = {
    sRaw: frozen ?? 0,
    s: frozen ?? 0,
    update(dtMs: number, timeMs: number): void {
      if (lenis) lenis.raf(timeMs);
      if (frozen !== null) {
        h.sRaw = frozen;
        h.s = frozen;
        if (debugProbe) publishScroll(timeMs);
        probeTick?.(timeMs, h.sRaw, h.s, camProbe?.() ?? null);
        return;
      }
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      h.sRaw = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      if (dtMs > 0 && Number.isFinite(dtMs)) {
        const dt = dtMs / 1000;
        h.s += (h.sRaw - h.s) * (1 - Math.exp(-k * dt));
      }
      if (probeOn && !settled && lastWheelT >= 0 && Math.abs(h.s - h.sRaw) < 0.001) {
        settled = true;
        settleDoneMs = timeMs - lastWheelT;
      }
      if (debugProbe) publishScroll(timeMs);
      probeTick?.(timeMs, h.sRaw, h.s, camProbe?.() ?? null);
    },
    freezeAt(v: number | null): void {
      frozen = v;
      if (v !== null) {
        h.sRaw = v;
        h.s = v;
      }
    },
    stop(): void {
      lenis?.stop();
      document.body.style.overflow = "hidden";
    },
    start(): void {
      document.body.style.overflow = "";
      lenis?.start();
      // start() IS the gate-open signal (viewer calls it on enter).
      armWheeltest();
    },
    dispose(): void {
      if (probeOn) window.removeEventListener("wheel", onWheel);
      wheelCancel?.();
      wheelCancel = null;
      probeTick = null;
      camProbe = null;
      lenis?.destroy();
      lenis = null;
    },
    setCamProbe(getter: (() => CamXYZ) | null): void {
      camProbe = getter;
    },
    setProbeTick(fn: ProbeTick | null): void {
      probeTick = fn;
    },
  };

  function publishScroll(nowMs: number): void {
    const doc = document.documentElement;
    const screens = doc.scrollHeight / Math.max(1, window.innerHeight);
    const live = !settled && lastWheelT >= 0 ? nowMs - lastWheelT : settleDoneMs;
    (window as unknown as { __scroll?: ScrollProbeState }).__scroll = {
      screens,
      pxPerKm: screens / (BRIEF_LENGTH_M / 1000),
      sRaw: h.sRaw,
      s: h.s,
      settleMs: live,
    };
  }

  return h;
}
