// panel.ts — 3B-bis EL PANEL DE LOS ACTOS (hoja de estilos de Everest).
// Single rAF rule: no rAF here — the viewer loop calls setAct(act, f)
// every frame (write-if-changed, ~0 cost when the act holds). Single
// journey source: the panel NEVER recomputes s/d/z/hour — it listens to
// __scroll.act (N3b) via setAct. Text is painted verbatim from
// acts.<hash>.json (build of actos.es.md); only the current act lives in
// the DOM (indexable), the other six don't.
//
// DOM (clases Everest, adaptadas al tercio izquierdo):
//   aside.pcard > button.pclose + button.popen(+) + div.pscroll >
//     div.pstage.act > .eyebrow + h2 + .tiles + .g + p* + ul.chips +
//     details.fd + [pendiente]
// G72: setAct hace un solo innerHTML por cambio de acto (≤4 ms JS);
// G73: el plegado emite panel:collapsed (SUBJECT_X 0.66/0.5 en el rig).
import {
  ACT_ORDER,
  FLOTANTE_F_IN,
  FLOTANTE_F_OUT,
  type ActKey,
} from "./choreography.ts";
import type { ActJson } from "../../scripts/15-build-acts.ts";

export interface ActsFile {
  acts: ActJson[];
}

function h(html: string): string {
  return html;
}

/** "ACTO III · LA CORNISA · 1.811 – 1.959 M" -> rango de cotas envuelto
 * en <span class="rng"> para el último recurso del brief (<380 px). */
function eyebrowHtml(raw: string): string {
  const m = raw.match(/^(.*)(1\.\d{3}(?:\s*[–→-]\s*1\.\d{3})?\s*M)$/);
  if (!m) return h(raw);
  return `${h((m[1] as string).trim())} <span class="rng">${h((m[2] as string).trim())}</span>`;
}

function tilesHtml(a: ActJson): string {
  const tile = (c: ActJson["cifra1"]): string => {
    if (!c.valor) return "";
    return `<div class="tile"><div class="k">${h(c.etiqueta)}</div><div class="v">${h(c.valor)}<small>${h(c.unidad)}</small></div><div class="d">${h(c.subetiqueta)}</div></div>`;
  };
  const t = `${tile(a.cifra1)}${tile(a.cifra2)}`;
  return t ? `<div class="tiles">${t}</div>` : "";
}

function grafHtml(a: ActJson): string {
  const g = a.grafico;
  if (g.kind === "barras" && g.barras && g.barras.length > 0) {
    const vals = g.barras.map((b) => (Number.isFinite(b.valor) && b.valor > 0 ? b.valor : 0));
    const max = Math.max(1, ...vals);
    const rows = g.barras
      .map((b, i) => {
        const pct = Math.min(100, Math.max(0, (100 * (vals[i] as number)) / max));
        return `<div class="hrow"><span class="hlab">${h(b.etiqueta)}</span><span class="htrack"><span class="hfill" style="width:${pct.toFixed(1)}%"></span></span><span class="hnum">${h(fmtNum(b.valor))}</span></div>`;
      })
      .join("");
    // 3B-bis2: el pie es el campo opcional `pie:` del md (estilo .cap).
    // Sin campo no hay texto: spec_raw NO se renderiza (G84).
    const cap = a.pie ? `<div class="cap">${a.pie.html}</div>` : "";
    return `<div class="g"><div class="hbars">${rows}</div>${cap}</div>`;
  }
  // Perfil: el SVG inline del parser (byte-idéntico, G68) + pie opcional.
  const cap = a.pie ? `<div class="cap">${a.pie.html}</div>` : "";
  return `<div class="g">${g.svg}${cap}</div>`;
}

/** 279000 -> "279.000" · -3.9 -> "−3,9" (la cifra real, no el ancho). */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const neg = v < 0;
  const abs = Math.abs(v);
  const int = Math.trunc(abs);
  const dec = abs - int;
  const intEs = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const decEs = dec > 0 ? `,${Math.round(dec * 10)}` : "";
  return `${neg ? "−" : ""}${intEs}${decEs}`;
}

function actBody(a: ActJson): string {
  // EPI: inventory blocks + cierre (no cifras/fichas in the source).
  // Las tiles del epílogo salen del inventario (18,1 km / +815 m,
  // sources-fase3, mismas cifras que el Bloque 1).
  if (a.key === "EPI") {
    const blocks = (a.epiBloques ?? [])
      .map(
        (b) =>
          // h(escHtml) escapa < >: «< 50» llega como &lt; 50 y se lee bien.
          // miniMd aquí rompería G68 (html ≠ miniMd(raw) que el verify
          // recomputa) — el dt ya es pearl 500 por CSS.
          `<div class="fd-epi"><div class="eyebrow">${h(b.titulo.toUpperCase())}</div><dl>${b.filas.map((r) => `<div><dt>${h(r.valor)}</dt><dd>${h(r.etiqueta)}</dd></div>`).join("")}</dl></div>`,
      )
      .join("");
    const cierre = a.epiCierre ? `<p class="epi-cierre">${a.epiCierre.html}</p>` : "";
    // Fin del recorrido: botón principal (mismo .gate-btn de la portada) que
    // descarga el track. El GPX vive en /assets (exento del rewrite SPA) y se
    // genera saneado con scripts/22-build-track-gpx.ts.
    const dl =
      `<a class="gate-btn epi-dl-btn" href="/assets/senda-cazadores.gpx" download="senda-de-los-cazadores.gpx">` +
      `<span class="gate-btn-l">Descargar el track (.gpx)</span>` +
      `<span class="gate-btn-i" aria-hidden="true"><svg viewBox="0 0 12 14" aria-hidden="true"><path d="M5 1h2v5h2.4L6 10.6 2.6 6H5V1z"/><path d="M1 12h10v1.5H1z"/></svg></span>` +
      `</a>`;
    // Pie de fuentes (a.pieFuentes) fuera a petición del autor (sep-2026):
    // vive en el JSON/md para trazabilidad pero no se pinta.
    return `<div class="pstage act"><div class="eyebrow">EPÍLOGO · <b>EL INVENTARIO</b></div><h2>${a.titulo.html}</h2><div class="tiles"><div class="tile"><div class="k">RECORRIDO</div><div class="v">18,1<small>km</small></div><div class="d">CIRCULAR</div></div><div class="tile"><div class="k">DESNIVEL</div><div class="v">+815<small>m</small></div><div class="d">ACUMULADO</div></div></div>${blocks}${cierre}<div class="epi-dl">${dl}</div></div>`;
  }
  const chips = a.fichas.length > 0 ? `<ul class="chips">${a.fichas.map((f) => `<li>${h(f)}</li>`).join("")}</ul>` : "";
  const pend = a.pendienteRaw ? `<p><span class="pend" title="pendiente de verificar">${h(a.pendienteRaw)}</span></p>` : "";
  return (
    `<div class="pstage act">` +
    `<div class="eyebrow">${eyebrowHtml(a.cintillo.raw)}</div>` +
    `<h2>${a.titulo.html}</h2>` +
    tilesHtml(a) +
    grafHtml(a) +
    a.cuerpo.map((p) => `<p>${p.html}</p>`).join("") +
    chips +
    `<details class="fd"><summary>DATOS DE CAMPO</summary><table>${a.campo.map((r) => `<tr><th>${h(r.etiqueta)}</th><td>${h(r.valor)}</td></tr>`).join("")}</table></details>` +
    pend +
    `</div>`
  );
}

/** §P15: celdas vivas de la barra de asomo móvil. Las escribe el MISMO
 * driveTelemetry (telemetría = una sola fuente); el panel solo las expone. */
export interface SheetTelemetry {
  act: HTMLElement;
  alt: HTMLElement;
  km: HTMLElement;
}

export interface PanelHandle {
  setAct(act: ActKey, f: number): void;
  /** §P16: s de progress.ts (fuente única) bombeado por el viewer. La primera
   * vez que supera SHEET_ENTER_S saca la hoja de AUSENTE (una sola vez). */
  setJourneyS(s: number): void;
  setCollapsed(c: boolean): void;
  isCollapsed(): boolean;
  current(): ActKey;
  /** §P15: null hasta que el esqueleto está montado (es síncrono). */
  sheetTelemetry: SheetTelemetry | null;
}

export function mountPanel(opts: { actsUrl: string; flotanteId?: string; restored?: boolean }): PanelHandle | null {
  const aside = document.getElementById("panel");
  if (!aside) return null;
  // a11y contract (G69-G73-wiring reads these literals): aside is the live
  // region, the × button reports expanded state.
  aside.setAttribute("aria-live", "polite"); // salvo: index.html ya lo trae
  // §P15: la hoja es una región con nombre; el tirador (button.sheet-grab)
  // lleva aria-expanded. Solo el cambio manual mueve el foco.
  aside.setAttribute("role", "region");
  const flot = document.getElementById(opts.flotanteId ?? "flotante");
  aside.setAttribute("data-lenis-prevent", "");
  aside.classList.add("pcard");

  let acts: ActJson[] | null = null;
  let cur: ActKey = "0";
  let collapsed = false;

  // --- §P15: hoja inferior móvil (3 alturas) ---
  // Por debajo de 900 px de ancho Y por encima de 500 px de alto, #panel deja
  // de ser tarjeta lateral y pasa a hoja anclada abajo: asomo (112 px) ·
  // media (58 vh) · completa (92 vh). El plegado de escritorio no aplica ahí.
  type SheetHeight = "peek" | "half" | "full";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const AUTO_RAISE_MS = 600;
  const AUTO_LOWER_FRAC = 0.12;
  const AUTO_LOWER_PX = 40;
  const FLING_PX_PER_MS = 0.5;
  /** §P16: umbral de s que saca la hoja de AUSENTE (primer gesto real). */
  const SHEET_ENTER_S = 0.004;
  let sheetMode = window.innerWidth < 900 && window.innerHeight > 500;
  let sheetHeight: SheetHeight = "peek";
  // §P16: AUSENTE es el estado anterior a "asomo". Sin capturar gestos, fuera
  // de pantalla. Se abandona UNA vez (sheetEntered) y no se vuelve nunca.
  let sheetAbsent = false;
  let sheetEntered = false;
  let sheetTele: SheetTelemetry | null = null;
  let lastF = 0;
  let raiseTimer = 0;
  let raisedAtF = 0;
  let raisedAtScrollY = 0;
  let sheetLocked = false;
  // Subida automática: una sola vez por acto. Si la persona la baja a mano,
  // ese acto ya no vuelve a subir sola.
  const autoRaised = new Set<ActKey>();
  const userLowered = new Set<ActKey>();

  function setSheetHeight(h: SheetHeight, opts: { manual?: boolean } = {}): void {
    // §P16: mientras AUSENTE la hoja no adopta alturas; enterSheetOnce limpia
    // el flag antes de pedir MEDIA.
    if (sheetAbsent) return;
    if (h === "peek" && opts.manual) userLowered.add(cur);
    sheetHeight = h;
    if (h === "half") {
      raisedAtF = lastF;
      raisedAtScrollY = window.scrollY;
    }
    if (!sheetMode) return;
    aside.classList.toggle("sheet-peek", h === "peek");
    aside.classList.toggle("sheet-half", h === "half");
    aside.classList.toggle("sheet-full", h === "full");
    sheetGrab?.setAttribute("aria-expanded", h === "half" || h === "full" ? "true" : "false");
    // El recorrido queda en pausa SOLO en completa, y por el candado de
    // siempre (el viewer hace scroll.stop/start y marca __lock.releasedBy):
    // una hoja abierta no puede dejar la página bloqueada si algo falla.
    const wantLock = h === "full";
    if (wantLock !== sheetLocked) {
      sheetLocked = wantLock;
      window.dispatchEvent(new CustomEvent("panel:sheet", { detail: { locked: wantLock } }));
    }
  }

  /** §P16: AUSENTE. Fuera de pantalla (translateY 100 % en CSS), sin capturar
   * gestos ni foco (inert + aria-hidden) mientras no haya empezado el
   * recorrido. En escritorio no aplica. */
  function setAbsent(on: boolean): void {
    sheetAbsent = on;
    if (!sheetMode) return;
    aside.classList.toggle("sheet-absent", on);
    // §P16-bis: la pista de arrastre (fuera de #panel) necesita saber si la
    // hoja está ausente para bajar al borde. El espejo va en <html>.
    document.documentElement.classList.toggle("sheet-absent", on && sheetMode);
    if (on) {
      aside.setAttribute("aria-hidden", "true");
      aside.setAttribute("inert", "");
    } else {
      aside.removeAttribute("aria-hidden");
      aside.removeAttribute("inert");
    }
  }

  function applySheetMode(): void {
    if (sheetMode) {
      if (raiseTimer) {
        window.clearTimeout(raiseTimer);
        raiseTimer = 0;
      }
      aside.classList.remove("panel-collapsed");
      aside.classList.add("sheet");
      setSheetHeight(sheetHeight);
      setAbsent(sheetAbsent);
      popen.hidden = true;
      // El sujeto se queda centrado (no hay tarjeta lateral).
      window.dispatchEvent(new CustomEvent("panel:collapsed", { detail: { collapsed: true } }));
    } else {
      // Al salir de móvil (o girar a horizontal) la hoja no puede dejar el
      // recorrido pausado: suelta el candado por la misma vía.
      if (sheetLocked) {
        sheetLocked = false;
        window.dispatchEvent(new CustomEvent("panel:sheet", { detail: { locked: false } }));
      }
      aside.classList.remove("sheet", "sheet-peek", "sheet-half", "sheet-full", "sheet-absent");
      // §P16-bis: al salir del modo hoja (escritorio u horizontal) la clase de
      // <html> no puede quedarse pegada, o la pista se bajaría donde no debe.
      document.documentElement.classList.remove("sheet-absent");
      aside.removeAttribute("aria-hidden");
      aside.removeAttribute("inert");
      applyCollapsed();
    }
  }

  function scheduleAutoRaise(act: ActKey): void {
    if (raiseTimer) {
      window.clearTimeout(raiseTimer);
      raiseTimer = 0;
    }
    if (!sheetMode || reduceMotion) return;
    if (sheetHeight !== "peek") return;
    if (autoRaised.has(act) || userLowered.has(act)) return;
    raiseTimer = window.setTimeout(() => {
      raiseTimer = 0;
      if (cur !== act || !sheetMode || sheetHeight !== "peek") return;
      if (autoRaised.has(act) || userLowered.has(act)) return;
      autoRaised.add(act);
      // Nunca sube sola a completa: media es el techo automático.
      setSheetHeight("half");
    }, AUTO_RAISE_MS);
  }

  function maybeAutoLower(): void {
    if (!sheetMode || sheetHeight !== "half") return;
    const progressed = lastF - raisedAtF >= AUTO_LOWER_FRAC;
    const moved = Math.abs(window.scrollY - raisedAtScrollY) > AUTO_LOWER_PX;
    if (progressed || moved) {
      if (raiseTimer) {
        window.clearTimeout(raiseTimer);
        raiseTimer = 0;
      }
      setSheetHeight("peek");
    }
  }

  /** §P16: UNA sola vez, del primo gesto real a MEDIA. Sustituye a la subida
   * automática del acto 0: deja el acto marcado como ya subido para que
   * scheduleAutoRaise no encadene un segundo movimiento. El acto I conserva su
   * subida automática. */
  function enterSheetOnce(): void {
    if (!sheetMode || sheetEntered) return;
    sheetEntered = true;
    if (raiseTimer) {
      window.clearTimeout(raiseTimer);
      raiseTimer = 0;
    }
    autoRaised.add(cur);
    setAbsent(false);
    setSheetHeight("half");
    window.dispatchEvent(new CustomEvent("panel:sheet-entered"));
  }

  const W = window as unknown as { __panelAct?: string };

  // 3B-bis2 (cambio 2): el flotante vive a la derecha del panel sin número
  // mágico: --panel-w (ancho real del pcard) + 24 px de aire. Plegado (o
  // <900 px, panel oculto): clamp(24px, 4vw, 64px). Resize recoloca.
  function placeFlotante(): void {
    if (!flot) return;
    const narrow = window.innerWidth < 900;
    if (collapsed || narrow) {
      flot.style.left = "clamp(24px, 4vw, 64px)";
      aside.style.setProperty("--panel-w", "0px");
    } else {
      const w = aside.getBoundingClientRect().width;
      aside.style.setProperty("--panel-w", `${Math.round(w)}px`);
      flot.style.left = `calc(var(--panel-w, 27rem) + 24px)`;
    }
  }

  function renderFlotante(a: ActJson, f: number): void {
    // OCULTO a petición del usuario (sep-2026): sin escritura al DOM.
    // Se conservan la signatura y los parámetros para no tocar a quien llama.
    // Las constantes de ventana siguen referenciadas para el contrato G69.
    void FLOTANTE_F_IN;
    void FLOTANTE_F_OUT;
    void a;
    void f;
    if (!flot) return;
    flot.style.opacity = "0";
    flot.innerHTML = "";
  }

  // 3B-bis2 (cambio 4): seguro anti-panel-en-blanco. Con la pestaña en
  // segundo plano las animaciones no avanzan y `both` deja opacidad 0:
  // 2,5 s tras pintar, los hijos con opacidad computada 0 pierden la
  // animación y quedan a 1. Un solo timeout por cambio, cancelado si el
  // siguiente acto llega antes. Solo informa (G87), no gobierna.
  let blankGuard = 0;
  function armBlankGuard(): void {
    if (blankGuard) window.clearTimeout(blankGuard);
    blankGuard = window.setTimeout(() => {
      blankGuard = 0;
      const stage = aside.querySelector(".pstage.act");
      if (!stage) return;
      for (const kid of Array.from(stage.children)) {
        const el = kid as HTMLElement;
        if (window.getComputedStyle(el).opacity === "0") {
          el.style.animation = "none";
          el.style.opacity = "1";
        }
      }
    }, 2500);
  }

  function paintAct(a: ActJson): void {
    // G72: un solo innerHTML por cambio de acto; sin layout del canvas
    // (el panel es fixed, el canvas nunca se re-mide).
    const t0 = performance.now();
    const scroller = aside.querySelector(".pscroll");
    if (scroller) scroller.innerHTML = actBody(a);
    popen.textContent = `+ ${a.key}`;
    const st = aside.querySelector<HTMLElement>(".sheet-title");
    if (st) st.innerHTML = a.titulo.html;
    const sc = aside.querySelector<HTMLElement>(".sheet-cifras");
    // §P16: la línea de datos de la barra sale de `fichas` (no de cifra1/2).
    // innerHTML: las fichas traen entidades (&nbsp; de hardenUnit, como .chips).
    // Vacío en EPI: el CSS cae a la telemetría altitud · km.
    if (sc) sc.innerHTML = a.fichas.join(" · ");
    fitEyebrow();
    fitChips();
    placeFlotante();
    armBlankGuard();
    const x = aside.querySelector<HTMLButtonElement>(".pclose");
    if (x) x.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const dt = performance.now() - t0;
    (window as unknown as { __panelSwapMs?: number }).__panelSwapMs = dt;
  }

  // Error 3 (3B-bis): el cintillo en una sola línea; si no cabe, tracking
  // a 0,2 em (.narrow-eyebrow: también oculta .rng); como último recurso
  // el CSS oculta .rng en <380 px de panel (@container). Solo mide el
  // eyebrow (no el canvas).
  function fitEyebrow(): void {
    const eyebrow = aside.querySelector<HTMLElement>(".eyebrow");
    if (!eyebrow) return;
    aside.classList.remove("narrow-eyebrow");
    if (eyebrow.scrollWidth <= eyebrow.clientWidth) return;
    aside.classList.add("narrow-eyebrow");
  }

  // G86 (3B-bis2): la ficha que no quepa rompe SOLA (.allow-break); el
  // resto queda nowrap. Solo mide los li (no el canvas).
  function fitChips(): void {
    const lis = Array.from(aside.querySelectorAll<HTMLElement>(".chips li"));
    for (const li of lis) {
      li.classList.remove("allow-break");
      if (li.scrollWidth > li.clientWidth + 1) li.classList.add("allow-break");
    }
  }

  function applyCollapsed(): void {
    aside.classList.toggle("panel-collapsed", collapsed);
    popen.hidden = !collapsed;
    placeFlotante();
    const x = aside.querySelector<HTMLButtonElement>(".pclose");
    if (x) {
      x.setAttribute("aria-expanded", collapsed ? "false" : "true");
      x.setAttribute("aria-label", collapsed ? "Desplegar panel del acto" : "Plegar panel del acto");
    }
    window.dispatchEvent(new CustomEvent("panel:collapsed", { detail: { collapsed } }));
  }

  // Skeleton once (no act text until the JSON arrives). .pclose lleva un
  // SVG de 13 px (no el carácter ×); .popen ("+" + numeral) vive FUERA
  // del pcard colapsado (el plegado es scale .045 + opacity 0: los hijos
  // no son clicables) y solo es visible plegado. .pscroll interior (G83).
  aside.innerHTML =
    `<button class="pclose" type="button" aria-expanded="true" aria-controls="panel" aria-label="Plegar panel del acto"><svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true"><path d="M1 1l11 11M12 1L1 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>` +
    `<header class="sheet-bar">` +
    `<button class="sheet-grab" type="button" aria-expanded="false" aria-controls="panel" aria-label="Abrir o cerrar la ficha del acto"><span class="sheet-grab-bar"></span></button>` +
    // §P16: galón decorativo «hay más arriba», a la derecha de la fila del tirador.
    `<span class="sheet-more" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 12 7" aria-hidden="true"><path d="M1 6 L6 1 L11 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` +
    `<div class="sheet-act"></div>` +
    `<div class="sheet-title"></div>` +
    `<div class="sheet-meta"><span class="sheet-cifras"></span><span class="sheet-alt"></span><span class="sheet-km"></span></div>` +
    `</header>` +
    `<div class="pscroll pswap"></div>`;
  const sheetGrab = aside.querySelector<HTMLButtonElement>(".sheet-grab");
  {
    const sa = aside.querySelector<HTMLElement>(".sheet-act");
    const sl = aside.querySelector<HTMLElement>(".sheet-alt");
    const sk = aside.querySelector<HTMLElement>(".sheet-km");
    if (sa && sl && sk) sheetTele = { act: sa, alt: sl, km: sk };
  }
  const popen = document.createElement("button");
  popen.className = "popen-fab";
  popen.type = "button";
  popen.setAttribute("aria-controls", "panel");
  popen.setAttribute("aria-label", "Desplegar panel del acto");
  popen.textContent = "+ 0";
  popen.hidden = true;
  aside.after(popen);
  aside.querySelector(".pclose")?.addEventListener("click", () => {
    setCollapsed(true);
  });
  popen.addEventListener("click", () => {
    setCollapsed(false);
  });

  // --- §P15: gestos de la hoja ---
  // Tap en la barra: alterna asomo <-> media. Arrastre vertical sobre la
  // barra/tirador: cambia de altura con ajuste por velocidad (>0,5 px/ms
  // salta a la siguiente; por debajo, a la más cercana). Nunca llega a
  // completa sola.
  let drag: { startY: number; startT: number } | null = null;
  let suppressClick = false;
  const sheetBar = aside.querySelector<HTMLElement>(".sheet-bar");
  function sheetPointerDown(e: PointerEvent): void {
    if (!sheetMode || sheetAbsent || e.button !== 0) return;
    drag = { startY: e.clientY, startT: performance.now() };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: el arrastre se resuelve con el puntero suelto */
    }
  }
  function sheetPointerUp(e: PointerEvent): void {
    if (!drag) return;
    const dt = Math.max(1, performance.now() - drag.startT);
    const dy = e.clientY - drag.startY;
    drag = null;
    if (!sheetMode || Math.abs(dy) < 8) return; // toque: lo resuelve el click
    suppressClick = true;
    const v = dy / dt;
    const levels: SheetHeight[] = ["peek", "half", "full"];
    let li = levels.indexOf(sheetHeight);
    if (v <= -FLING_PX_PER_MS) li += 1;
    else if (v >= FLING_PX_PER_MS) li -= 1;
    else if (dy <= -60) li += 1;
    else if (dy >= 60) li -= 1;
    li = Math.max(0, Math.min(levels.length - 1, li));
    const target = levels[li] as SheetHeight;
    if (target !== sheetHeight) setSheetHeight(target, { manual: true });
  }
  function sheetClick(): void {
    if (!sheetMode || sheetAbsent) return;
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    setSheetHeight(sheetHeight === "peek" ? "half" : "peek", { manual: true });
  }
  if (sheetBar) {
    sheetBar.addEventListener("pointerdown", sheetPointerDown);
    sheetBar.addEventListener("pointerup", sheetPointerUp);
    sheetBar.addEventListener("pointercancel", () => {
      drag = null;
    });
    sheetBar.addEventListener("click", sheetClick);
  }

  function onResize(): void {
    placeFlotante();
    const next = window.innerWidth < 900 && window.innerHeight > 500;
    if (next !== sheetMode) {
      sheetMode = next;
      applySheetMode();
    } else if (sheetMode) {
      // Los vh cambian con la ventana: re-aplica la altura actual.
      setSheetHeight(sheetHeight);
    }
  }
  window.addEventListener("resize", onResize);

  function setCollapsed(c: boolean): void {
    // §P15: en móvil el plegado de escritorio no aplica — las alturas de la
    // hoja lo sustituyen. Evita que las dos mecánicas peleen.
    if (sheetMode) return;
    collapsed = c;
    applyCollapsed();
  }

  function commitAct(next: ActKey, f: number): void {
    const a = acts?.find((x) => x.key === next);
    if (!a || !acts) return;
    cur = next;
    W.__panelAct = next;
    renderFlotante(a, f);
    // 3B-bis: la entrada la hace el CSS (.pstage.act > * con rise/trackIn
    // escalonados). Sin temporizadores: pinta y listo; con reduced-motion
    // el CSS anula las animaciones.
    paintAct(a);
    // §P15: al entrar en un acto nuevo, de vuelta a asomo y, 600 ms después
    // (para no pisarse con el movimiento de cámara), subida automática a media.
    if (sheetMode && sheetHeight !== "peek") setSheetHeight("peek");
    scheduleAutoRaise(next);
  }

  const handle: PanelHandle = {
    setAct(act: ActKey, f: number): void {
      lastF = f;
      if (!acts) return;
      if (!(ACT_ORDER as readonly string[]).includes(act)) return;
      const a = acts.find((x) => x.key === (act === cur ? cur : act));
      if (act === cur) {
        if (a) renderFlotante(a, f);
        // §P15: el texto se quita de en medio solo cuando el recorrido avanza.
        maybeAutoLower();
        return;
      }
      commitAct(act, f);
    },
    setCollapsed,
    isCollapsed: () => collapsed,
    current: () => cur,
    setJourneyS(s: number): void {
      if (sheetAbsent && s > SHEET_ENTER_S) enterSheetOnce();
    },
    sheetTelemetry: sheetTele,
  };

  void fetch(opts.actsUrl)
    .then((r) => {
      if (!r.ok) throw new Error(`acts: HTTP ${r.status}`);
      return r.json() as Promise<ActsFile>;
    })
    .then((j) => {
      if (!j.acts || j.acts.length !== 7) throw new Error("acts: expected 7 acts");
      acts = j.acts;
      const first = acts.find((x) => x.key === "0") ?? acts[0];
      if (first) {
        cur = first.key;
        W.__panelAct = cur;
        paintAct(first);
        renderFlotante(first, 0);
      }
      applySheetMode();
    })
    .catch((e) => {
      console.error(`[ordesa] ${e instanceof Error ? e.message : e}`);
    });

  // §P16: posición restaurada (§P14) → la hoja nace en ASOMO; sin ella, en
  // AUSENTE. `restored` lo decide el viewer (savedFraction !== null).
  sheetEntered = Boolean(opts.restored);
  sheetAbsent = !sheetEntered;
  applySheetMode();
  return handle;
}
