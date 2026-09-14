// scroll.ts — Lenis + s normalisation. No camera, no time.
// Single rAF rule: the render loop calls scroll.update(dtMs, timeMs),
// which pumps lenis.raf(timeMs). No rAF of its own.
import Lenis from "lenis";
import {
  ACT_MID_S,
  K_SCROLL,
  K_SCROLL_REDUCED,
  LENIS_DURATION,
  LENIS_SMOOTH_WHEEL,
  LENIS_SYNC_TOUCH,
  LENIS_TOUCH_MULT,
  TRACK_VH,
} from "./choreography.ts";

export interface ScrollHandle {
  sRaw: number;
  s: number;
  update(dtMs: number, timeMs: number): void;
  freezeAt(v: number | null): void;
  stop(): void;
  start(): void;
  dispose(): void;
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
    lenis = new Lenis({
      duration: LENIS_DURATION,
      easing: (t: number) => 1 - Math.pow(1 - t, 4),
      smoothWheel: LENIS_SMOOTH_WHEEL,
      syncTouch: LENIS_SYNC_TOUCH,
      touchMultiplier: LENIS_TOUCH_MULT,
    });
  }
  // frozen (?s= / ?act=): no scroll reading at all, sRaw is the fixed value
  const h: ScrollHandle = {
    sRaw: frozen ?? 0,
    s: frozen ?? 0,
    update(dtMs: number, timeMs: number): void {
      if (lenis) lenis.raf(timeMs);
      if (frozen !== null) {
        h.sRaw = frozen;
        h.s = frozen;
        return;
      }
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      h.sRaw = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      if (!(dtMs > 0) || !Number.isFinite(dtMs)) return;
      const dt = dtMs / 1000;
      h.s += (h.sRaw - h.s) * (1 - Math.exp(-k * dt));
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
    },
    dispose(): void {
      lenis?.destroy();
      lenis = null;
    },
  };
  return h;
}
