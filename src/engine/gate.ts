// gate.ts — P11 "Umbral": entry gate over the live first frame of the
// flight + real progress (70% bytes via meta sizes, 30% build work with
// rAF yields) + AudioContext unlock. Never blocks the network on the click;
// degrades with a concrete message on failure.
//
// The gate is transparent: the render loop parks the camera on
// introSample(0) behind it (introArmed in viewer.ts), so the canyon visible
// under the title IS frame 0 of the flight. .gate-veil covers the
// not-yet-mounted scene and fades in ready(), not on click.
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

function routeJsonUrl(): string {
  const m = (window as unknown as { __META?: { assets?: { route?: string } } }).__META;
  return "/" + (m?.assets?.route ?? "assets/route.json");
}

/** Data line figures, read from route.json — never handwritten (P11). */
async function loadGateData(line: HTMLElement): Promise<void> {
  try {
    const res = await fetch(routeJsonUrl());
    if (!res.ok) return;
    const j = (await res.json()) as {
      lengthM: number;
      totalClimbM: number;
      z_mdt: number[];
      offsetM?: number;
    };
    if (!Number.isFinite(j.lengthM) || !Number.isFinite(j.totalClimbM) || !Array.isArray(j.z_mdt)) return;
    const km = (j.lengthM / 1000).toLocaleString("es-ES", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const climb = `+${Math.round(j.totalClimbM).toLocaleString("es-ES")} M`;
    // Ground cota, same convention as progress.ts (st.z = drape − offset)
    // and labels.json hitos (z_mdt − ROUTE_OFFSET_M): the drape floats 4 m
    // over the terrain, the published cota is the ground under it.
    const off = Number.isFinite(j.offsetM) ? (j.offsetM as number) : 4;
    const maxZ = `${Math.round(Math.max(...j.z_mdt) - off).toLocaleString("es-ES")} M`;
    line.textContent = `${km} KM · ${climb} · ${maxZ} · CINCO ACTOS`;
  } catch {
    /* without the figures the line stays empty — never a frozen literal */
  }
}

export function buildGate(onEnter: (silent: boolean) => void): {
  el: HTMLElement;
  setProgress(frac: number, stage: number): void;
  ready(): void;
  enable(): void;
  fail(msg: string): void;
} {
  const el = document.createElement("div");
  el.className = "gate";

  // Opaque cover while the scene is not mounted yet; fades in ready().
  const veil = document.createElement("div");
  veil.className = "gate-veil";
  veil.setAttribute("aria-hidden", "true");

  const col = document.createElement("div");
  col.className = "gate-col";

  const kicker = document.createElement("div");
  kicker.className = "gate-kicker";
  kicker.textContent = "PARQUE NACIONAL DE ORDESA Y MONTE PERDIDO";
  // Two nodes, not a string: the <em> carries the first line.
  const title = document.createElement("h1");
  title.className = "gate-title";
  const titleA = document.createElement("em");
  titleA.className = "gate-title-a";
  titleA.textContent = "La senda de";
  const titleB = document.createElement("span");
  titleB.className = "gate-title-b";
  titleB.textContent = "los cazadores";
  title.append(titleA, titleB);
  const data = document.createElement("div");
  data.className = "gate-data";
  data.setAttribute("aria-hidden", "true");

  const action = document.createElement("div");
  action.className = "gate-action";
  // Visible load line: the entry is blocked until the scene is whole, so the
  // visitor must SEE the progress. %.stage it mirrors in .gate-sr for AT.
  const load = document.createElement("div");
  load.className = "gate-load";
  load.setAttribute("aria-hidden", "true");
  const loadPct = document.createElement("span");
  loadPct.className = "gate-load-pct";
  loadPct.textContent = "0 %";
  const loadStage = document.createElement("span");
  loadStage.className = "gate-load-stage";
  loadStage.textContent = STAGES[0];
  load.append(loadPct, loadStage);
  const btn = document.createElement("button");
  btn.className = "gate-btn";
  btn.type = "button";
  btn.disabled = true;
  const btnL = document.createElement("span");
  btnL.className = "gate-btn-l";
  btnL.textContent = "Comenzar el ascenso";
  const btnI = document.createElement("span");
  btnI.className = "gate-btn-i";
  btnI.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 14");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1 1 L11 7 L1 13 Z");
  svg.appendChild(path);
  btnI.appendChild(svg);
  btn.append(btnL, btnI);
  // Visible network errors live next to the button (screen-reader alert).
  const err = document.createElement("div");
  err.className = "gate-err";
  err.setAttribute("role", "alert");
  err.hidden = true;
  const soundline = document.createElement("div");
  soundline.className = "gate-soundline";
  const soundNote = document.createElement("span");
  soundNote.className = "gate-soundnote";
  soundNote.textContent = "SE DISFRUTA MEJOR CON SONIDO · ";
  const silent = document.createElement("button");
  silent.className = "gate-silent";
  silent.type = "button";
  silent.textContent = "entrar en silencio";
  silent.disabled = true;
  soundline.append(soundNote, silent);
  action.append(btn, soundline);

  col.append(kicker, title, data, load, action, err);

  // 1 px load edge at the viewport bottom; same setProgress as before.
  const prog = document.createElement("div");
  prog.className = "gate-prog";
  prog.setAttribute("aria-hidden", "true");
  const bar = document.createElement("div");
  bar.className = "gate-bar";
  const fill = document.createElement("div");
  fill.className = "gate-fill";
  bar.appendChild(fill);
  prog.appendChild(bar);

  // % + stage stay in the DOM for screen readers, out of sight.
  const sr = document.createElement("div");
  sr.className = "gate-sr";
  sr.setAttribute("aria-live", "polite");
  sr.textContent = `0 % · ${STAGES[0]}`;

  el.append(veil, col, prog, sr);
  document.body.appendChild(el);

  void loadGateData(data);

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
  let enabled = false;
  function enter(sil: boolean): void {
    if (entered || !enabled) return;
    entered = true;
    unlock();
    // Normally already 0 since ready(); an instant click may still find the
    // veil up — it leaves with the same transition, never a black cut.
    veil.style.opacity = "0";
    el.classList.add("gate-open");
    window.setTimeout(() => el.remove(), 900);
    onEnter(sil);
  }
  btn.addEventListener("click", () => enter(false));
  silent.addEventListener("click", () => enter(true));

  let lastSr = "";
  return {
    el,
    setProgress(frac, stage) {
      const c = Math.min(1, Math.max(0, frac));
      fill.style.transform = `scaleX(${c})`;
      const s = STAGES[Math.min(STAGES.length - 1, stage)] as string;
      const pct = `${Math.round(c * 100)} %`;
      const t = `${pct} · ${s}`;
      if (t !== lastSr) {
        lastSr = t;
        sr.textContent = t;
        loadPct.textContent = pct;
        loadStage.textContent = s;
      }
    },
    ready() {
      // El velo se retira: el título se lee sobre el cañón mientras termina
      // la carga. NO habilita el botón — eso es enable(), cuando la escena
      // está entera (primer frame pintado). Ver viewer.ts.
      veil.style.opacity = "0";
    },
    enable() {
      if (enabled) return;
      enabled = true;
      // La barra de carga se retira: solo queda la acción.
      load.hidden = true;
      btn.disabled = false;
      silent.disabled = false;
      btn.focus({ preventScroll: true });
    },
    fail(m) {
      load.hidden = true;
      err.textContent = m;
      err.hidden = false;
      // Un error de red no puede dejar la portada muda: el botón vuelve a
      // responder para que el visitante pueda intentarlo igualmente.
      enabled = true;
      btn.disabled = false;
      silent.disabled = false;
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
