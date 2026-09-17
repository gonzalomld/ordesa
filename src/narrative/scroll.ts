// scroll.ts — Lenis + s normalisation. No camera, no time.
// Single rAF rule: the render loop calls scroll.update(dtMs, timeMs),
// which pumps lenis.raf(timeMs). No rAF of its own.
import Lenis from "lenis";
import {
  ACT_MID_S,
  ACT_ORDER,
  ACT_SCREENS,
  ACT_SECTION_ID_PREFIX,
  BRIEF_LENGTH_M,
  K_SCROLL,
  K_SCROLL_REDUCED,
  LENIS_ACT_JUMP_DURATION,
  LENIS_LERP,
  LENIS_SMOOTH_WHEEL,
  LENIS_SYNC_TOUCH,
  LENIS_TOUCH_MULT,
  LENIS_WHEEL_MULT,
  TRACK_VH_TOTAL,
  lenisActJumpEasing,
  type ActKey,
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
  /** N3b: current act section key ("0".."V","EPI") */
  act: ActKey;
  /** N3b: fraction inside the current act section (0..1) */
  f: number;
  /** N3b: s at each act boundary (from progress.actBounds(), 8 values) */
  bounds: number[];
  /** N3b: screens per act section (from ACT_SCREENS, 7 values) */
  screensArr: number[];
  /** N3b: total screens (sum of ACT_SCREENS) */
  total: number;
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
  /** N3b: receive the live act bounds (s at act boundaries) from progress. */
  setActBounds(b: number[] | null): void;
  stop(): void;
  start(): void;
  dispose(): void;
  /** N3b: ?act= scroll target (top of the act section, px). Null = none. */
  actJumpTarget(act: string): number | null;
  /** N3b: expose Lenis for the ?act= scrollTo jump (viewer calls it after
   * the gate opens; locked before that like everything else). */
  jumpToAct(act: string): boolean;
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

function parseActParam(raw: string | null): ActKey | null {
  if (raw === null) return null;
  const a = raw.trim().toUpperCase();
  // "EPI" and legacy "EPILOGO"/"EPÍLOGO" spellings all land on the epilogue.
  const norm = a === "EPILOGO" || a === "EPÍLOGO" ? "EPI" : a;
  return (ACT_ORDER as readonly string[]).includes(norm) ? (norm as ActKey) : null;
}

export function actKeyAt(bounds: number[], s: number): { act: ActKey; f: number } {
  const sc = Math.min(1, Math.max(0, s));
  for (let i = 0; i < ACT_ORDER.length; i++) {
    const lo = bounds[i] as number;
    const hi = bounds[i + 1] as number;
    if (sc < hi || i === ACT_ORDER.length - 1) {
      const span = hi - lo;
      return { act: ACT_ORDER[i] as ActKey, f: span > 0 ? Math.min(1, Math.max(0, (sc - lo) / span)) : 0 };
    }
  }
  return { act: "EPI", f: 1 };
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
  const frozenS = parseSParam(q.get("s"));
  const actParam = parseActParam(q.get("act"));
  // N3b: ?act= jumps to the act section TOP via Lenis scrollTo (1.8 s) once
  // the gate opens — it no longer freezes s. ?s= still freezes. With
  // ?debug=1 the audit keeps the old freeze so each act reads a still frame.
  const dbgForAct = q.get("debug") === "1" || q.get("debug") === "steep";
  let frozen: number | null = frozenS;
  if (frozen === null && actParam !== null && dbgForAct) {
    frozen = (ACT_MID_S[actParam] ?? null) as number | null;
  }
  // N3 instruments (?debug=1 scroll probe, ?wheeltest=1 synthetic notches).
  // The wheel listener only exists when a flag is present: zero trace in
  // production scrolling. The heavy wheeltest runner is a deferred chunk
  // (scroll-probe.ts) loaded on gate enter, never in the entry bundle.
  const dbgMode = q.get("debug");
  const debugProbe = dbgMode === "1" || dbgMode === "steep";
  const wheeltest = q.get("wheeltest") === "1";
  const probeOn = debugProbe || wheeltest;

  // N3b: one <section> per act (Everest reference). Heights come from
  // ACT_SCREENS written as --act-*-vh vars (CSS only consumes); the SUM
  // mandates the total. Ids `acto-0`…`acto-EPI` exist for future anchors.
  // Rebuilt idempotently: index.html may already carry the sections.
  let track = document.getElementById("scroll-track");
  if (!track) {
    track = document.createElement("div");
    track.id = "scroll-track";
    const canvas = document.getElementById("scene");
    if (canvas?.parentNode) canvas.parentNode.insertBefore(track, canvas.nextSibling);
    else document.body.prepend(track);
  }
  track.setAttribute("aria-hidden", "true");
  for (const key of ACT_ORDER) {
    const id = `${ACT_SECTION_ID_PREFIX}-${key}`;
    let sec = track.querySelector<HTMLElement>(`[data-act="${key}"]`);
    if (!sec) {
      sec = document.createElement("section");
      sec.dataset.act = key;
      track.appendChild(sec);
    }
    sec.id = id;
  }
  // Drop stray sections from older builds (unknown data-act only — never the 7).
  for (const child of [...track.children]) {
    const el = child as HTMLElement;
    if (el.tagName !== "SECTION" || !(ACT_ORDER as readonly string[]).includes(el.dataset.act ?? "")) {
      if (el.tagName === "SECTION") el.remove();
    }
  }
  const root = document.documentElement;
  for (const key of ACT_ORDER) {
    // SCREENS are screens: 1 screen = 100vh in the CSS var.
    root.style.setProperty(`--act-${key.toLowerCase()}-vh`, `${ACT_SCREENS[key] * 100}vh`);
  }

  // N3b: tops/heights cache — refreshed on resize/orientationchange only,
  // never per frame. px arrays parallel ACT_ORDER.
  const trackEl = track;
  let tops: number[] = [];
  let heights: number[] = [];
  let lastInnerH = 0;
  function refreshTops(): void {
    const secs = [...trackEl.querySelectorAll<HTMLElement>("section[data-act]")];
    secs.sort(
      (a, b) =>
        (ACT_ORDER as readonly string[]).indexOf(a.dataset.act ?? "") -
        (ACT_ORDER as readonly string[]).indexOf(b.dataset.act ?? ""),
    );
    tops = secs.map((s) => s.offsetTop);
    heights = secs.map((s) => s.offsetHeight);
    lastInnerH = window.innerHeight;
  }
  refreshTops();
  const onResize = (): void => {
    if (window.innerHeight !== lastInnerH) refreshTops();
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", onResize);

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
  // N3b: live act bounds from progress (setActBounds at boot). Before they
  // arrive, fall back to the legacy linear map so first paint has an s.
  let bounds: number[] | null = null;
  // N3b: current section (for the __scroll.act/f probe readout).
  let curAct: ActKey = "0";
  let curF = 0;

  // N3b span lookup: section whose [top, top+height) holds scrollY
  // (top edge; the fixed canvas never covers scroll). Continuity is exact
  // BY CONSTRUCTION: every section maps its OWN [top, top+height) through
  // its OWN height, so at each boundary f hits 1 on the left and 0 on the
  // right with the same value bounds[i+1] — the frame that "crosses" reads
  // the neighbour's span, never an average, and Δs there is the local rate,
  // not a jump. The LAST section is anchored to the scroll END instead:
  // its divisor is (max - topEpi), because offsetHeight sums drift ±2 px
  // from scrollHeight (sub-pixel rounding + body line-height) and dividing
  // by heightEpi left G63/G61 short at s=0.996. f still reads 1 exactly at
  // max scroll, 0 at the EPI top (its own top, not a neighbour's).
  function spanS(scrollY: number): { s: number; act: ActKey; f: number } {
    if (!bounds || tops.length !== ACT_ORDER.length) {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const lin = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
      return { s: lin, act: "0", f: lin };
    }
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const y = Math.max(0, scrollY);
    let i = tops.length - 1;
    for (let j = 0; j < tops.length; j++) {
      const top = tops[j] as number;
      const hgt = heights[j] as number;
      if (y < top + hgt || j === tops.length - 1) {
        i = j;
        break;
      }
    }
    const lo = bounds[i] as number;
    const hi = bounds[i + 1] as number;
    if (i === tops.length - 1) {
      const top = tops[i] as number;
      const f = max > top ? Math.min(1, Math.max(0, (y - top) / (max - top))) : 1;
      return { s: lo + f * (hi - lo), act: ACT_ORDER[i] as ActKey, f };
    }
    const top = tops[i] as number;
    const hgt = Math.max(1, heights[i] as number);
    const f = Math.min(1, Math.max(0, (y - top) / hgt));
    return { s: lo + f * (hi - lo), act: ACT_ORDER[i] as ActKey, f };
  }

  function actJumpTargetPx(act: string): number | null {
    const key = parseActParam(act);
    if (key === null || tops.length !== ACT_ORDER.length) return null;
    const i = (ACT_ORDER as readonly string[]).indexOf(key);
    return tops[i] as number;
  }

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

  // frozen (?s=, or ?act= with ?debug=1): no scroll reading at all.
  const h: ScrollHandle = {
    sRaw: frozen ?? 0,
    s: frozen ?? 0,
    update(dtMs: number, timeMs: number): void {
      if (lenis) lenis.raf(timeMs);
      if (frozen !== null) {
        h.sRaw = frozen;
        h.s = frozen;
        if (bounds) {
          const a = actKeyAt(bounds, frozen);
          curAct = a.act;
          curF = a.f;
        }
        if (debugProbe) publishScroll(timeMs);
        probeTick?.(timeMs, h.sRaw, h.s, camProbe?.() ?? null);
        return;
      }
      const sp = spanS(window.scrollY);
      h.sRaw = Math.min(1, Math.max(0, sp.s));
      curAct = sp.act;
      curF = sp.f;
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
    setActBounds(b: number[] | null): void {
      bounds = b && b.length === ACT_ORDER.length + 1 ? b.slice() : null;
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
      // N3b: ?act= (no ?debug=1) jumps to the section top with Lenis now
      // that scrolling is unlocked — duration 1.8 s, Everest parity.
      if (actParam !== null && frozen === null && lenis) {
        const top = actJumpTargetPx(actParam);
        if (top !== null && top > 0) {
          try {
            lenis.scrollTo(top, {
              duration: LENIS_ACT_JUMP_DURATION,
              easing: lenisActJumpEasing,
            });
          } catch {
            /* jump failed — user scrolls manually, no worse than today */
          }
        }
      }
    },
    dispose(): void {
      if (probeOn) window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      wheelCancel?.();
      wheelCancel = null;
      probeTick = null;
      camProbe = null;
      lenis?.destroy();
      lenis = null;
    },
    actJumpTarget(act: string): number | null {
      return actJumpTargetPx(act);
    },
    jumpToAct(act: string): boolean {
      if (!lenis) return false;
      const top = actJumpTargetPx(act);
      if (top === null) return false;
      try {
        lenis.scrollTo(top, { duration: LENIS_ACT_JUMP_DURATION, easing: lenisActJumpEasing });
        return true;
      } catch {
        return false;
      }
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
      act: curAct,
      f: curF,
      bounds: bounds ? bounds.slice() : [],
      screensArr: (ACT_ORDER as readonly ActKey[]).map((a) => ACT_SCREENS[a]),
      total: TRACK_VH_TOTAL,
    };
  }

  return h;
}
