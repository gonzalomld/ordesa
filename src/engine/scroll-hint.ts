// scroll-hint.ts — §P14: pista táctil de arrastre. En móvil, al aterrizar en
// el inicio de la senda, un chevron sutil y animado invita a arrastrar hacia
// arriba, que es lo que hace avanzar el recorrido. Se retira al primer gesto
// real de scroll. Solo punteros gruesos (móvil/tablet): en ratón no aplica.
// Cero rAF propio — la animación entera vive en el CSS.
export interface ScrollHintHandle {
  show(): void;
  hide(): void;
}

function windowFraction(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

export function mountScrollHint(): ScrollHintHandle | null {
  // Solo punteros de contacto: en un ratón no hay "arrastrar hacia arriba".
  if (!window.matchMedia("(pointer: coarse)").matches) return null;

  const el = document.createElement("div");
  el.className = "scroll-hint";
  el.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "scroll-hint-text";
  text.textContent = "Desliza para ascender";

  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("class", "scroll-hint-arrow");
  arrow.setAttribute("viewBox", "0 0 12 7");
  arrow.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M1 6 L6 1 L11 6");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  arrow.appendChild(path);

  el.append(text, arrow);
  document.body.appendChild(el);

  let shown = false;
  let armed = false;
  let fractionAtShow = 0;

  const hide = (): void => {
    if (!shown) return;
    shown = false;
    el.classList.remove("scroll-hint-on");
  };

  // El `scroll` de Lenis puede dispararse sin movimiento (scrollTo(0,0) del
  // relevo): por eso no se oculta con el primer evento, solo cuando la
  // fracción se ha movido de verdad. touchmove/wheel sí son gestos reales.
  const onScroll = (): void => {
    if (Math.abs(windowFraction() - fractionAtShow) > 0.01) hide();
  };

  const arm = (): void => {
    if (armed) return;
    armed = true;
    window.addEventListener("touchmove", hide, { passive: true });
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
  };

  return {
    show(): void {
      if (shown) return;
      shown = true;
      fractionAtShow = windowFraction();
      el.classList.add("scroll-hint-on");
      arm();
    },
    hide,
  };
}
