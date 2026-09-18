// panel.ts — 3B EL PANEL DE LOS ACTOS. Single rAF rule: no rAF here —
// the viewer loop calls setAct(act, f) every frame (write-if-changed, ~0
// cost when the act holds). Single journey source: the panel NEVER
// recomputes s/d/z/hour — it listens to __scroll.act (N3b) via setAct.
// Text is painted verbatim from acts.<hash>.json (build of actos.es.md);
// only the current act lives in the DOM (indexable), the other six don't.
import {
  ACT_ORDER,
  FLOTANTE_F_IN,
  FLOTANTE_F_OUT,
  PANEL_HEIGHT_MS,
  PANEL_SWAP_MS,
  type ActKey,
} from "./choreography.ts";
import type { ActJson } from "../../scripts/15-build-acts.ts";

export interface ActsFile {
  acts: ActJson[];
}

function h(html: string): string {
  return html;
}

function cifraHtml(c: ActJson["cifra1"]): string {
  if (!c.valor) return "";
  return `<div class="panel-cifra"><b>${h(c.valor)}</b><small>${h(c.unidad)}</small><span>${h(c.etiqueta)} · ${h(c.subetiqueta)}</span></div>`;
}

function actBody(a: ActJson): string {
  // EPI: inventory blocks + cierre (no cifras/fichas in the source).
  if (a.key === "EPI") {
    const blocks = (a.epiBloques ?? [])
      .map(
        (b) =>
          `<div class="panel-epi"><div class="panel-cintillo">${h(b.titulo.toUpperCase())}</div><dl>${b.filas.map((r) => `<div><dt>${h(r.valor)}</dt><dd>${h(r.etiqueta)}</dd></div>`).join("")}</dl></div>`,
      )
      .join("");
    const cierre = a.epiCierre ? `<div class="panel-cuerpo"><p>${a.epiCierre.html}</p></div>` : "";
    const pie = a.pieFuentes ? `<div class="panel-pend">${h(a.pieFuentes)}</div>` : "";
    return `<div class="panel-cintillo">EPÍLOGO · EL INVENTARIO</div><h2 class="panel-titulo">${a.titulo.html}</h2>${blocks}${cierre}${pie}`;
  }
  const grafLeyenda =
    a.grafico.kind === "barras" && a.grafico.barras
      ? `<div class="panel-graf-leyenda">${a.grafico.barras.map((b) => `<span>${h(b.etiqueta)}</span>`).join("")}</div>`
      : "";
  const pend = a.pendienteRaw ? `<div class="panel-pend"><span class="pend" title="pendiente de verificar">${h(a.pendienteRaw)}</span></div>` : "";
  return (
    `<div class="panel-cintillo">${h(a.cintillo.raw)}</div>` +
    `<h2 class="panel-titulo">${a.titulo.html}</h2>` +
    `<div class="panel-cifras">${cifraHtml(a.cifra1)}${cifraHtml(a.cifra2)}</div>` +
    `<figure class="panel-grafico">${a.grafico.svg}${grafLeyenda}</figure>` +
    `<div class="panel-cuerpo">${a.cuerpo.map((p) => `<p>${p.html}</p>`).join("")}</div>` +
    `<div class="panel-fichas">${a.fichas.map((f) => `<span class="panel-ficha">${h(f)}</span>`).join("")}</div>` +
    `<details class="panel-datos"><summary>DATOS DE CAMPO</summary><dl>${a.campo.map((r) => `<div><dt>${h(r.etiqueta)}</dt><dd>${h(r.valor)}</dd></div>`).join("")}</dl></details>` +
    pend
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
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const swapMs = reduced ? 0 : PANEL_SWAP_MS;
  const heightMs = reduced ? 0 : PANEL_HEIGHT_MS;

  let acts: ActJson[] | null = null;
  let cur: ActKey = "0";
  let collapsed = window.innerWidth < 900;
  let pending: ActKey | null = null;
  let swapping = false;

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
    const body = aside.querySelector(".panel-body");
    if (body) body.innerHTML = actBody(a);
    const tab = aside.querySelector(".panel-tabnum");
    if (tab) tab.textContent = a.key;
    const x = aside.querySelector<HTMLButtonElement>(".panel-x");
    if (x) x.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function applyCollapsed(): void {
    aside.classList.toggle("panel-collapsed", collapsed);
    const x = aside.querySelector<HTMLButtonElement>(".panel-x");
    if (x) {
      x.setAttribute("aria-expanded", collapsed ? "false" : "true");
      x.textContent = collapsed ? "+" : "×";
      x.setAttribute("aria-label", collapsed ? "Desplegar panel del acto" : "Plegar panel del acto");
    }
    window.dispatchEvent(new CustomEvent("panel:collapsed", { detail: { collapsed } }));
  }

  // Skeleton once (no act text until the JSON arrives).
  aside.innerHTML =
    `<button class="panel-x" type="button" aria-expanded="true" aria-controls="panel" aria-label="Plegar panel del acto">×</button>` +
    `<div class="panel-tabnum" aria-hidden="true">0</div>` +
    `<div class="panel-body pswap"></div>`;
  aside.querySelector(".panel-x")?.addEventListener("click", () => {
    setCollapsed(!collapsed);
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
    const body = aside.querySelector<HTMLElement>(".panel-body");
    renderFlotante(a, f);
    if (!body) return;
    if (swapMs === 0) {
      paintAct(a);
      return;
    }
    if (swapping) {
      pending = next;
      return;
    }
    swapping = true;
    // Pin the height so the swap never jumps the panel (240 ms settle).
    const h0 = aside.offsetHeight;
    aside.style.height = `${h0}px`;
    body.classList.add("out");
    window.setTimeout(() => {
      // If another act queued mid-swap, paint the latest only.
      const latest = pending ?? next;
      pending = null;
      const la = acts?.find((x) => x.key === latest);
      if (la) {
        cur = latest;
        W.__panelAct = latest;
        paintAct(la);
        renderFlotante(la, f);
      }
      body.classList.remove("out");
      // Settle to the new natural height, then release.
      const h1 = aside.scrollHeight;
      aside.style.height = `${h1}px`;
      window.setTimeout(() => {
        aside.style.height = "";
        swapping = false;
        if (pending) {
          const p = pending;
          pending = null;
          commitAct(p, f);
        }
      }, heightMs);
    }, swapMs);
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
