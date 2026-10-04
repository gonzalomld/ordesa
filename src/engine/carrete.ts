// carrete.ts — §M2: la galería del marcador. DOM, no three: las tarjetas son
// <img> planas mirando a cámara (planos texturizados se comerían la VRAM de
// §P14). Abre al evento "marcador:abrir", entra desde la dirección en pantalla
// de su motivo (§4) y libera toda la memoria de imagen al cerrar (§7).
import { anguloRelativo, type MarkerDef } from "./markers.ts";

export interface Foto {
  src: string;
  w: number;
  h: number;
  titulo: string;
  sujeto: string;
  az: number;
  el?: number;
  km: number;
  exif?: string;
  autor?: string;
  licencia?: string;
  licenciaUrl?: string;
  origen?: string;
  demo?: boolean;
}

export interface CarreteOpts {
  fotos: Record<string, Foto[]>;
  demo: boolean;
  markers: MarkerDef[];
  reduced: boolean;
  getRumbo: () => number;
  onOpen: () => void;
  onClose: () => void;
}

export interface CarreteHandle {
  open(id: string): boolean;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

const CLEAR_DELAY_MS = 220;
const REDUCED_DELAY_MS = 160;

/** §4 — unitario de entrada en pantalla desde el rumbo del motivo.
 * rel = anguloRelativo(az, rumboCam); ux = sin(rel); uy = −sin(el).
 * Se normaliza; degenerado (casi nulo) → (0,−1). Pura. */
export function vectorEntrada(az: number, el: number, rumboCam: number): { ux: number; uy: number } {
  const rel = anguloRelativo(az, rumboCam);
  let ux = Math.sin((rel * Math.PI) / 180);
  let uy = -Math.sin((el * Math.PI) / 180);
  const len = Math.hypot(ux, uy);
  if (len < 1e-4) return { ux: 0, uy: -1 };
  ux /= len;
  uy /= len;
  return { ux, uy };
}

/** §M3 — demo: TRES marcos de relleno por marcador, con tres rumbos distintos
 * (para poder juzgar el abanico y la entrada escalonada). Nunca foto real. */
export function fotosDemo(m: MarkerDef): Foto[] {
  const e = m.encuadre;
  return [
    { src: "", w: 0, h: 0, titulo: m.nombre, sujeto: e.sujeto, az: e.az, el: e.el, km: e.km, demo: true },
    {
      src: "",
      w: 0,
      h: 0,
      titulo: m.nombre,
      sujeto: "Valle de Ordesa",
      az: (e.az + 95) % 360,
      el: -4,
      km: e.km,
      demo: true,
    },
    {
      src: "",
      w: 0,
      h: 0,
      titulo: m.nombre,
      sujeto: "Pared norte",
      az: (e.az + 240) % 360,
      el: 18,
      km: e.km,
      demo: true,
    },
  ];
}

/** §M2 — monta el carrete (una sola instancia, DOM persistente oculto). */
export function buildCarrete(opts: CarreteOpts): CarreteHandle {
  const byId = new Map(opts.markers.map((m) => [m.id, m]));

  const shell = document.createElement("div");
  shell.className = "carrete";
  shell.hidden = true;
  shell.tabIndex = -1;
  const veil = document.createElement("div");
  veil.className = "carrete-veil";
  const stage = document.createElement("div");
  stage.className = "carrete-stage";
  shell.append(veil, stage);
  document.body.appendChild(shell);

  let openId: string | null = null;
  let closing = false;
  let active = 0;
  let list: Foto[] = [];
  let fan: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let metaEl: HTMLElement | null = null;
  let dotsEl: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  let openMarkerEl: HTMLElement | null = null;

  function findMarkerEl(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`.marker[data-id="${cssEscape(id)}"]`);
  }

  function cssEscape(s: string): string {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
  }

  function fotosDe(id: string): Foto[] {
    if (opts.demo) {
      const m = byId.get(id);
      return m ? fotosDemo(m) : [];
    }
    const arr = opts.fotos[id];
    return Array.isArray(arr) ? arr.filter((f) => f && (f.src || f.demo)) : [];
  }

  function elDe(foto: Foto, marker: MarkerDef | undefined): number {
    return foto.el ?? marker?.encuadre.el ?? 0;
  }

  function setActive(i: number): void {
    if (list.length === 0 || !fan) return;
    active = ((i % list.length) + list.length) % list.length;
    const cards = [...fan.querySelectorAll<HTMLElement>(".carrete-card")];
    cards.forEach((c, j) => {
      c.classList.toggle("is-active", j === active);
      c.classList.toggle("is-left", j < active);
      c.classList.toggle("is-right", j > active);
    });
    updateFoot();
    const a = cards[active];
    if (a) a.focus({ preventScroll: true });
  }

  function updateFoot(): void {
    const f = list[active];
    if (!f || !titleEl || !metaEl || !dotsEl) return;
    titleEl.textContent = f.titulo;
    // §M2 atribución: autor + licencia (con enlace) siempre visibles.
    metaEl.replaceChildren();
    const add = (t: string): void => {
      if (t) metaEl.append(document.createTextNode(t));
    };
    if (f.exif) add(`${f.exif} · `);
    if (f.autor) add(f.autor);
    if (f.licencia) {
      if (f.autor) add(" · ");
      if (f.licenciaUrl) {
        const a = document.createElement("a");
        a.href = f.licenciaUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = f.licencia;
        metaEl.appendChild(a);
      } else {
        add(f.licencia);
      }
    }
    [...dotsEl.children].forEach((d, j) => d.classList.toggle("is-on", j === active));
  }

  function makeCard(foto: Foto, i: number, marker: MarkerDef | undefined, rumboCam: number): HTMLElement {
    const card = document.createElement("article");
    card.className = "carrete-card";
    card.dataset.i = String(i);

    const lab = document.createElement("span");
    lab.className = "cc-label";
    lab.textContent = `${foto.sujeto} · ${Math.round(foto.az)}°`;
    card.appendChild(lab);

    const frame = document.createElement("div");
    frame.className = "cc-frame";
    for (const p of ["tl", "tr", "bl", "br"]) {
      const c = document.createElement("span");
      c.className = `cc-corner cc-corner--${p}`;
      frame.appendChild(c);
    }

    if (foto.demo || !foto.src) {
      const d = document.createElement("div");
      d.className = "cc-demo";
      const n = document.createElement("b");
      n.textContent = foto.titulo;
      const s = document.createElement("span");
      s.textContent = "sin foto todavía";
      d.append(n, s);
      frame.appendChild(d);
    } else {
      const img = document.createElement("img");
      img.className = "cc-img";
      img.loading = "eager";
      img.decoding = "async";
      img.alt = `Foto: ${foto.titulo}`;
      if (foto.w > 0) img.width = foto.w;
      if (foto.h > 0) img.height = foto.h;
      img.addEventListener("error", () => img.classList.add("cc-img-err"));
      img.src = foto.src;
      frame.appendChild(img);
      const cred = document.createElement("div");
      cred.className = "cc-credit";
      if (foto.autor) cred.append(document.createTextNode(foto.autor));
      if (foto.licencia) {
        if (foto.autor) cred.append(document.createTextNode(" · "));
        if (foto.licenciaUrl) {
          const a = document.createElement("a");
          a.href = foto.licenciaUrl;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = foto.licencia;
          cred.appendChild(a);
        } else {
          cred.append(document.createTextNode(foto.licencia));
        }
      }
      frame.appendChild(cred);
    }
    card.appendChild(frame);

    // §4 — vector de entrada desde el rumbo del motivo.
    const v = opts.reduced ? { ux: 0, uy: 0 } : vectorEntrada(foto.az, elDe(foto, marker), rumboCam);
    card.style.setProperty("--ex", `${(v.ux * 60).toFixed(3)}vmin`);
    card.style.setProperty("--ey", `${(v.uy * 60).toFixed(3)}vmin`);
    card.classList.add("is-pre");
    return card;
  }

  function mount(id: string, defs: Foto[]): boolean {
    const marker = byId.get(id);
    const rumboCam = opts.getRumbo();
    list = defs;
    active = 0;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "carrete-close";
    closeBtn.setAttribute("aria-label", "Cerrar carrete");
    const cx = document.createElement("span");
    cx.className = "carrete-close-x";
    cx.setAttribute("aria-hidden", "true");
    cx.textContent = "×";
    const ct = document.createElement("span");
    ct.className = "carrete-close-t";
    ct.textContent = "ESC · VOLVER A LA SENDA";
    closeBtn.append(cx, ct);
    closeBtn.addEventListener("click", () => close());

    fan = document.createElement("div");
    fan.className = "carrete-fan";
    defs.forEach((f, i) => fan?.appendChild(makeCard(f, i, marker, rumboCam)));

    titleEl = document.createElement("div");
    titleEl.className = "carrete-titulo";
    metaEl = document.createElement("div");
    metaEl.className = "carrete-meta";
    dotsEl = document.createElement("div");
    dotsEl.className = "carrete-dots";
    defs.forEach((_, i) => {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "carrete-dot";
      d.setAttribute("aria-label", `Foto ${i + 1}`);
      d.addEventListener("click", () => setActive(i));
      dotsEl?.appendChild(d);
    });
    const foot = document.createElement("div");
    foot.className = "carrete-foot";
    foot.append(titleEl, metaEl, dotsEl);

    stage.replaceChildren(closeBtn, fan, foot);
    setActive(0);
    return true;
  }

  function animateIn(): void {
    const cards = [...stage.querySelectorAll<HTMLElement>(".carrete-card")];
    void shell.offsetWidth;
    requestAnimationFrame(() => {
      shell.classList.add("is-in");
      cards.forEach((c, i) => {
        c.style.transitionDelay = opts.reduced ? "0ms" : `${i * 60}ms`;
        c.classList.remove("is-pre");
      });
    });
  }

  function teardownContent(): void {
    // §7 — liberar la memoria de imagen: src fuera y nodos fuera del DOM.
    for (const img of stage.querySelectorAll("img")) img.removeAttribute("src");
    stage.replaceChildren();
    fan = null;
    titleEl = null;
    metaEl = null;
    dotsEl = null;
  }

  function open(id: string): boolean {
    const defs = fotosDe(id);
    if (defs.length === 0) return false; // §2 — sin fotos no abre (ni toca scroll)
    const markerEl = findMarkerEl(id);

    if (openId !== null) {
      // §5 — otra chapa abierta: sustituye el contenido, no abre un segundo.
      teardownContent();
      const ok = mount(id, defs);
      if (!ok) return false;
      if (openMarkerEl) openMarkerEl.classList.remove("is-on");
      openMarkerEl = markerEl;
      openMarkerEl?.classList.add("is-on");
      openId = id;
      shell.hidden = false;
      animateIn();
      return true;
    }

    const nextOpener = markerEl?.querySelector<HTMLElement>(".marker-hit") ?? null;
    opts.onOpen();
    let ok = false;
    // §5 — el montaje va en try/finally: ninguna excepción deja el scroll parado.
    try {
      ok = mount(id, defs);
    } finally {
      if (!ok) {
        teardownContent();
        opts.onClose();
        return false;
      }
    }
    opener = nextOpener;
    openMarkerEl = markerEl;
    openMarkerEl?.classList.add("is-on");
    openId = id;
    shell.hidden = false;
    animateIn();
    try {
      shell.focus({ preventScroll: true });
    } catch {
      /* focus is best-effort */
    }
    return true;
  }

  function close(): void {
    if (openId === null || closing) return;
    closing = true;
    shell.classList.remove("is-in");
    for (const c of stage.querySelectorAll<HTMLElement>(".carrete-card")) c.classList.add("is-out");
    const finish = (): void => {
      try {
        teardownContent();
        if (openMarkerEl) openMarkerEl.classList.remove("is-on");
        openId = null;
        closing = false;
      } finally {
        shell.hidden = true;
        opts.onClose();
        const op = opener;
        opener = null;
        openMarkerEl = null;
        if (op) {
          try {
            op.focus({ preventScroll: true });
          } catch {
            /* focus is best-effort */
          }
        }
      }
    };
    window.setTimeout(finish, opts.reduced ? REDUCED_DELAY_MS : CLEAR_DELAY_MS);
  }

  function onKey(e: KeyboardEvent): void {
    if (openId === null) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setActive(active + 1);
    }
  }

  let dragX: number | null = null;
  shell.addEventListener("touchstart", (e) => {
    dragX = e.touches[0]?.clientX ?? null;
  }, { passive: true });
  shell.addEventListener("touchend", (e) => {
    if (dragX === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? dragX) - dragX;
    dragX = null;
    if (Math.abs(dx) > 40) setActive(active + (dx < 0 ? 1 : -1));
  });
  veil.addEventListener("click", () => close());
  window.addEventListener("keydown", onKey);

  return {
    open,
    close,
    isOpen: () => openId !== null,
    dispose(): void {
      window.removeEventListener("keydown", onKey);
      teardownContent();
      shell.remove();
    },
  };
}
