// scroll-probe.ts — N3 ?wheeltest=1 runner. Deferred chunk only: scroll.ts
// dynamic-imports it after the gate opens when the flag is present, so it
// never lands in the production entry bundle. No camera, no time, no render.
import {
  WHEELTEST_COUNT,
  WHEELTEST_DELTA_Y,
  WHEELTEST_INTERVAL_MS,
  WHEELTEST_LOG_MS,
  WHEELTEST_START_DELAY_MS,
} from "./choreography.ts";
import type { ScrollHandle, WheelSample } from "./scroll.ts";

export interface WheelTestReport {
  done: boolean;
  frames: number;
  notches: number;
  skipped?: string;
}

/** Fire 10 synthetic deltaY=100 notches every 60 ms and record
 * (t, sRaw, s, camX, camY, camZ) per frame for 3 s into window.__wheelLog.
 * The camera samples come from the probe tick the viewer wires (own rAF
 * renders it — this module owns no timer faster than setTimeout for the
 * notches and never calls requestAnimationFrame). */
export function runWheelTest(scroll: ScrollHandle): () => void {
  const startedAt = performance.now();
  const log: WheelSample[] = [];
  const w = window as unknown as {
    __wheelLog?: WheelSample[];
    __wheelTest?: WheelTestReport;
  };
  w.__wheelLog = log;
  w.__wheelTest = { done: false, frames: 0, notches: 0 };

  let cancelled = false;
  const timers: number[] = [];

  const fireNotch = (): void => {
    const ev = new WheelEvent("wheel", {
      deltaY: WHEELTEST_DELTA_Y,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    const r = w.__wheelTest;
    if (r) r.notches++;
  };

  for (let i = 0; i < WHEELTEST_COUNT; i++) {
    timers.push(
      window.setTimeout(
        () => {
          if (!cancelled) fireNotch();
        },
        WHEELTEST_START_DELAY_MS + i * WHEELTEST_INTERVAL_MS,
      ),
    );
  }

  const t0 = startedAt + WHEELTEST_START_DELAY_MS;
  scroll.setProbeTick((nowMs, sRaw, s, cam) => {
    if (cancelled) return;
    if (nowMs - t0 > WHEELTEST_LOG_MS) {
      finish();
      return;
    }
    log.push({
      t: nowMs - t0,
      sRaw,
      s,
      camX: cam?.x ?? NaN,
      camY: cam?.y ?? NaN,
      camZ: cam?.z ?? NaN,
    });
    const r = w.__wheelTest;
    if (r) r.frames = log.length;
  });

  // Hard stop even if the render loop stalls (tab hidden, gate closed).
  timers.push(
    window.setTimeout(() => {
      if (!cancelled) finish();
    }, WHEELTEST_START_DELAY_MS + WHEELTEST_LOG_MS + 1500),
  );

  function finish(): void {
    if (cancelled) return;
    cancelled = true;
    for (const t of timers) window.clearTimeout(t);
    scroll.setProbeTick(null);
    w.__wheelTest = { done: true, frames: log.length, notches: w.__wheelTest?.notches ?? 0 };
  }

  return () => {
    cancelled = true;
    for (const t of timers) window.clearTimeout(t);
    scroll.setProbeTick(null);
  };
}
