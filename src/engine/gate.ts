// gate.ts — D9: entry gate + real progress (70% bytes via meta sizes,
// 30% build work with rAF yields) + AudioContext unlock. Never blocks the
// network on the click; degrades with a concrete message on failure.
export interface GateHooks {
  onEnter(silent: boolean): void;
}

const STAGES = [
  "LEVANTANDO LA CALIZA",
  "TENDIENDO EL ARAZAS",
  "ORIENTANDO EL SOL",
  "ABRIENDO LA FAJA",
  "TRAZANDO LA SENDA",
  "LEVANTANDO LA NIEBLA",
] as const;

export function buildGate(onEnter: (silent: boolean) => void): {
  el: HTMLElement;
  setProgress(frac: number, stage: number): void;
  ready(): void;
  fail(msg: string): void;
} {
  const el = document.createElement("div");
  el.className = "gate";
  el.innerHTML = "";
  const kicker = document.createElement("div");
  kicker.className = "gate-kicker";
  kicker.textContent = "PARQUE NACIONAL DE ORDESA Y MONTE PERDIDO";
  const title = document.createElement("h1");
  title.className = "gate-title";
  title.textContent = "La senda de los cazadores";
  const sub = document.createElement("div");
  sub.className = "gate-sub";
  sub.textContent = "Un recorrido 3D por el cañón del Arazas";
  const btn = document.createElement("button");
  btn.className = "gate-btn";
  btn.type = "button";
  btn.textContent = "COMENZAR EL ASCENSO";
  btn.disabled = true;
  const sound = document.createElement("div");
  sound.className = "gate-sound";
  sound.textContent = "SE DISFRUTA MEJOR CON SONIDO";
  const prog = document.createElement("div");
  prog.className = "gate-prog";
  const bar = document.createElement("div");
  bar.className = "gate-bar";
  const fill = document.createElement("div");
  fill.className = "gate-fill";
  const msg = document.createElement("div");
  msg.className = "gate-msg";
  msg.textContent = STAGES[0];
  const pct = document.createElement("div");
  pct.className = "gate-pct";
  pct.textContent = "0 %";
  bar.appendChild(fill);
  prog.append(bar, pct);
  const silent = document.createElement("button");
  silent.className = "gate-silent";
  silent.type = "button";
  silent.textContent = "entrar en silencio";
  el.append(kicker, title, sub, btn, sound, prog, msg, silent);
  document.body.appendChild(el);

  let audio: AudioContext | null = null;
  function unlock(): AudioContext | null {
    try {
      const AC = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
      void audio.resume();
      return audio;
    } catch {
      return null;
    }
  }
  void audio;

  let entered = false;
  function enter(sil: boolean): void {
    if (entered) return;
    entered = true;
    unlock();
    el.classList.add("gate-open");
    window.setTimeout(() => el.remove(), 900);
    onEnter(sil);
  }
  btn.addEventListener("click", () => enter(false));
  silent.addEventListener("click", () => enter(true));

  let lastPct = "";
  return {
    el,
    setProgress(frac, stage) {
      const p = `${Math.round(Math.min(1, Math.max(0, frac)) * 100)} %`;
      if (p !== lastPct) {
        lastPct = p;
        pct.textContent = p;
        fill.style.transform = `scaleX(${Math.min(1, Math.max(0, frac))})`;
      }
      const s = STAGES[Math.min(STAGES.length - 1, stage)] as string;
      if (msg.textContent !== s) msg.textContent = s;
    },
    ready() {
      btn.disabled = false;
      btn.focus({ preventScroll: true });
    },
    fail(m) {
      msg.textContent = m;
      btn.disabled = false;
    },
  };
}

export function nextFrame(): Promise<void> {
  // Higiene: ceder con setTimeout(0), nunca con rAF. Los pasos de carga se
  // encadenan con promesas; con la pestaña oculta Chrome no entrega frames
  // y la carga se quedaba al 11 % tras heightmap.png. El rAF arranca solo
  // cuando la escena está lista (setAnimationLoop en viewer.ts).
  return new Promise((r) => window.setTimeout(() => r(), 0));
}

export const STAGE_COUNT = STAGES.length;
