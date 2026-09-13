// Puerta fase 1: canvas pintando un color plano. Sin motor 3D hasta que el
// build y la previsualización estén en verde sin React.
const canvas = document.getElementById("scene") as HTMLCanvasElement;

function resize(): void {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

resize();
window.addEventListener("resize", resize);

const gl = canvas.getContext("webgl");

if (gl) {
  // Gris caliza de Ordesa como color plano provisional.
  gl.clearColor(0.45, 0.43, 0.4, 1.0);
  gl.clear(gl.COLOR_BUFFER_BIT);
} else {
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#737065";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}
