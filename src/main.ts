// Phase-1 viewer entry. No narrative, no scroll — orbit over real terrain.
import { inject, type BeforeSendEvent } from "@vercel/analytics";
import { startViewer } from "./engine/viewer.ts";

// §P17: analítica de Vercel por la vía "Other" (inject, no componente de React:
// aquí no hay React). Sin cookies y sin datos personales.
inject({
  // Vite no expone NODE_ENV al código de cliente de forma garantizada, así que la
  // detección automática del paquete no es fiable aquí: se fija a mano.
  mode: import.meta.env.PROD ? "production" : "development",
  beforeSend: (event: BeforeSendEvent) => {
    // No contamos nuestras propias auditorías: toda visita que lleve una bandera
    // de depuración o de pose se descarta. Devolver null descarta el evento.
    const q = new URLSearchParams(new URL(event.url, location.origin).search);
    const FLAGS = [
      "debug", "s", "cam", "orbit", "wheeltest", "wheelstart", "act",
      "tier", "ghost", "clouds", "skyfrac", "t", "slot",
    ];
    if (FLAGS.some((k) => q.has(k))) return null;
    return event;
  },
});

const canvas = document.getElementById("scene") as HTMLCanvasElement;
startViewer(canvas).catch((err) => {
  console.error(err);
  const d = document.createElement("div");
  d.className = "fatal";
  d.textContent = `No se pudo cargar el visor: ${err instanceof Error ? err.message : err}`;
  document.body.appendChild(d);
});
