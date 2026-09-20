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
    return `<div class="g"><div class="hbars">${rows}</div></div>`;
  }
  // Perfil: el SVG inline del parser (byte-idéntico, G68) + caption.
  return `<div class="g">${g.svg}<div class="cap">${h(g.spec_raw)}</div></div>`;
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
          `<div class="fd-epi"><div class="eyebrow">${h(b.titulo.toUpperCase())}</div><dl>${b.filas.map((r) => `<div><dt>${h(r.valor)}</dt><dd>${h(r.etiqueta)}</dd></div>`).join("")}</dl></div>`,
      )
      .join("");
    const cierre = a.epiCierre ? `<p>${a.epiCierre.html}</p>` : "";
    const pie = a.pieFuentes ? `<ul class="chips"><li>${h(a.pieFuentes)}</li></ul>` : "";
    return `<div class="pstage act"><div class="eyebrow">EPÍLOGO · <b>EL INVENTARIO</b></div><h2>${a.titulo.html}</h2><div class="tiles"><div class="tile"><div class="k">RECORRIDO</div><div class="v">18,1<small>km</small></div><div class="d">CIRCULAR</div></div><div class="tile"><div class="k">DESNIVEL</div><div class="v">+815<small>m</small></div><div class="d">ACUMULADO</div></div></div>${blocks}${cierre}${pie}</div>`;
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

export interface PanelHandle {
  setAct(act: ActKey, f: number): void;
  setCollapsed(c: boolean): void;
  isCollapsed(): boolean;
  current(): ActKey;
}

export function mountPanel(opts: { actsUrl: string; flotanteId?: string }): PanelHandle | null {
  const aside = document.getElementById("panel");
  if (!aside) return null;
  // a11y contract (G69-G73-wiring reads these literals): aside is the live
  // region, the × button reports expanded state.
  aside.setAttribute("aria-live", "polite"); // salvo: index.html ya lo trae
  const flot = document.getElementById(opts.flotanteId ?? "flotante");
  aside.setAttribute("data-lenis-prevent", "");
  aside.classList.add("pcard");

  let acts: ActJson[] | null = null;
  let cur: ActKey = "0";
  let collapsed = window.innerWidth < 900;

  const W = window as unknown as { __panelAct?: string };

  function renderFlotante(a: ActJson, f: number): void {
    if (!flot) return;
    // Epilogue keeps it; otherwise visible f<0.12, gone by f=0.25.
    if (a.key === "EPI") {
      flot.innerHTML = `<div class="flotante-ghost">EPI</div><div class="flotante-t">${a.titulo.html}</div>`;
      flot.style.opacity = "1";
      return;
    }
    const op = f <= FLOTANTE_F_IN ? 1 : f >= FLOTANTE_F_OUT ? 0 : 1 - (f - FLOTANTE_F_IN) / (FLOTANTE_F_OUT - FLOTANTE_F_IN);
    if (op <= 0) {
      flot.style.opacity = "0";
      return;
    }
    flot.style.opacity = op.toFixed(3);
    flot.innerHTML =
      `<div class="flotante-ghost">${h(a.flotante.numeral || a.key)}</div>` +
      `<div class="flotante-t">${h(a.flotante.titulo)}</div>`;
  }

  function paintAct(a: ActJson): void {
    // G72: un solo innerHTML por cambio de acto; sin layout del canvas
    // (el panel es fixed, el canvas nunca se re-mide).
    const t0 = performance.now();
    const scroller = aside.querySelector(".pscroll");
    if (scroller) scroller.innerHTML = actBody(a);
    popen.textContent = `+ ${a.key}`;
    fitEyebrow();
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

  function applyCollapsed(): void {
    aside.classList.toggle("panel-collapsed", collapsed);
    popen.hidden = !collapsed;
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
    `<div class="pscroll pswap"></div>`;
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

  function setCollapsed(c: boolean): void {
    // <900px the panel stays hidden for the 3D (CSS display:none rules).
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
  }

  const handle: PanelHandle = {
    setAct(act: ActKey, f: number): void {
      if (!acts) return;
      if (!(ACT_ORDER as readonly string[]).includes(act)) return;
      const a = acts.find((x) => x.key === (act === cur ? cur : act));
      if (act === cur) {
        if (a) renderFlotante(a, f);
        return;
      }
      commitAct(act, f);
    },
    setCollapsed,
    isCollapsed: () => collapsed,
    current: () => cur,
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
      if (collapsed) applyCollapsed();
      else window.dispatchEvent(new CustomEvent("panel:collapsed", { detail: { collapsed: false } }));
    })
    .catch((e) => {
      console.error(`[ordesa] ${e instanceof Error ? e.message : e}`);
    });

  if (collapsed) applyCollapsed();
  return handle;
}
