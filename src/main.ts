// Phase-1 viewer entry. No narrative, no scroll — orbit over real terrain.
import { startViewer } from "./engine/viewer.ts";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
startViewer(canvas).catch((err) => {
  console.error(err);
  const d = document.createElement("div");
  d.className = "fatal";
  d.textContent = `No se pudo cargar el visor: ${err instanceof Error ? err.message : err}`;
  document.body.appendChild(d);
});
