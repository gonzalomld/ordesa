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
import { quatDistDeg, quatYXZ } from "./anchors.ts";
import type { ScrollHandle, WheelSample } from "./scroll.ts";

export interface WheelTestReport {
  done: boolean;
  frames: number;
  notches: number;
  skipped?: string;
  /** C1: after the 10 forward notches, 10 more backwards (reversibility). */
  backward?: boolean;
}

/** Fire 10 synthetic deltaY=100 notches every 60 ms (then 10 backwards) and
 * record (t, sRaw, s, camX, camY, camZ, yaw, pitch, qdist) per frame for 3 s
 * into window.__wheelLog. The camera/orientation samples come from the probe
 * ticks the viewer wires (its own rAF renders — this module owns no timer
 * faster than setTimeout for the notches and never calls
 * requestAnimationFrame). C1: qdist is the quaternion angular step vs the
 * previous frame (q and -q are the same orientation). */
export function runWheelTest(scroll: ScrollHandle): () => void {
  const startedAt = performance.now();
  const log: WheelSample[] = [];
  const w = window as unknown as {
    __wheelLog?: WheelSample[];
    __wheelTest?: WheelTestReport;
  };
  w.__wheelLog = log;
  w.__wheelTest = { done: false, frames: 0, notches: 0, backward: false };

  let cancelled = false;
  const timers: number[] = [];
  let prevQ: [number, number, number, number] | null = null;

  const fireNotch = (dir: 1 | -1): void => {
    const ev = new WheelEvent("wheel", {
      deltaY: dir * WHEELTEST_DELTA_Y,
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
          if (!cancelled) fireNotch(1);
        },
        WHEELTEST_START_DELAY_MS + i * WHEELTEST_INTERVAL_MS,
      ),
    );
  }
  // C1: backward run right after the forward one (same spacing, then a gap).
  const back0 = WHEELTEST_START_DELAY_MS + WHEELTEST_COUNT * WHEELTEST_INTERVAL_MS + 600;
  for (let i = 0; i < WHEELTEST_COUNT; i++) {
    timers.push(
      window.setTimeout(
        () => {
          if (cancelled) return;
          const r = w.__wheelTest;
          if (r) r.backward = true;
          fireNotch(-1);
        },
        back0 + i * WHEELTEST_INTERVAL_MS,
      ),
    );
  }

  const t0 = startedAt + WHEELTEST_START_DELAY_MS;
  const logMs = WHEELTEST_LOG_MS + 600 + 2 * WHEELTEST_COUNT * WHEELTEST_INTERVAL_MS;
  scroll.setOriTick((nowMs, sRaw, s, cam, ori) => {
    if (cancelled) return;
    if (nowMs - t0 > logMs) {
      finish();
      return;
    }
    const yaw = ori?.yaw ?? NaN;
    const pitch = ori?.pitch ?? NaN;
    let qd = NaN;
    if (Number.isFinite(yaw) && Number.isFinite(pitch)) {
      const q = quatYXZ(yaw, pitch);
      if (prevQ) qd = quatDistDeg(prevQ, q);
      prevQ = q;
    }
    log.push({
      t: nowMs - t0,
      sRaw,
      s,
      camX: cam?.x ?? NaN,
      camY: cam?.y ?? NaN,
      camZ: cam?.z ?? NaN,
      yaw,
      pitch,
      qdist: qd,
    });
    const r = w.__wheelTest;
    if (r) r.frames = log.length;
  });

  // Hard stop even if the render loop stalls (tab hidden, gate closed).
  timers.push(
    window.setTimeout(() => {
      if (!cancelled) finish();
    }, WHEELTEST_START_DELAY_MS + logMs + 1500),
  );

  function finish(): void {
    if (cancelled) return;
    cancelled = true;
    for (const t of timers) window.clearTimeout(t);
    scroll.setProbeTick(null);
    scroll.setOriTick(null);
    w.__wheelTest = { done: true, frames: log.length, notches: w.__wheelTest?.notches ?? 0, backward: w.__wheelTest?.backward ?? false };
  }

  return () => {
    cancelled = true;
    for (const t of timers) window.clearTimeout(t);
    scroll.setProbeTick(null);
    scroll.setOriTick(null);
  };
}
