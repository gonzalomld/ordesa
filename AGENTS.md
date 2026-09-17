# AGENTS.md

## Platform conventions (do not delete)

- Config: `opencode.json` → `docs/mcode-rules.md`. Obey that file; it wins on workflow.
- Lint/typecheck **once, after all edits**. Max 1 cycle: lint → fix critical → lint. No doom loops.
- Targeted lint only (`npx oxlint <edited-files>` if available, else `npx eslint <edited-files>`). Never whole-project. Skip lint for CSS/text/assets-only changes.
- Never explain how to run the app locally (mCode handles preview).

## Senda de los Cazadores — project rules

- Ningún valor que cambie por frame (posición de cámara, progreso de scroll, tiempo) se guarda en estado reactivo ni dispara re-render de nada. El bucle de render es dueño de sus propios datos y escribe en el DOM solo cuando un valor visible para el usuario cambia de verdad.
- Stack: Vite + vanilla TS + three.js (ES module) + Lenis. No React, no Tailwind, no CSS frameworks. Custom properties in `src/styles/`.
- Node: dev 22.16 (Vibes env limit), Vercel prod 24.x (panel, do NOT touch). Safe direction: code running on 22 runs on 24. `engines: >=22.16` (open range: no local EBADENGINE, Vercel resolves to latest). `.nvmrc` = local reality (24 when env allows: then set `.nvmrc` 24, `engines` 24.x, drop tsx). Pipeline via tsx (`npx tsx scripts/*.ts`) + native `fetch`. No axios/node-fetch. Never switch package manager (npm + `package-lock.json`).
- Geo: work CRS EPSG:25830. BBOX `738240,4722700 → 749040,4730880` lives in ONE place: `scripts/geo-constants.ts` (source) → `data/build/meta.json` (generated). Front reads `meta.json` only; `verify` cross-checks meta vs geo-constants.
- Data flow: `npm run data` = local only, never CI. Versioned in git: `data/build/meta.json`, `public/assets/heightmap.png`, `public/assets/terrain-*.webp`, `public/assets/route.json`, `data/source/*.gpx`. Gitignored: `data/source/dem.tif`, ortho tiles/mosaic, `data/source/mdt02/`. `verify` reads versioned artefacts only (heightmap.png + meta.json + route.json), no network, no dem.tif — safe in `build`. Only extra: when `dem.tif` happens to exist locally, one strict gate compares every PNG pixel vs the DEM; in CI that gate SKIP-passes.
- Deps for pipeline: `geotiff` (read WCS Int16 + tags) + `sharp` (tiles/mosaic/resize/heightmap PNG/WebP). Nothing else.
- Heightmap PNG con sharp desde buffer raw, SIN metadatos y con filtrado adaptativo: `.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })`. NUNCA `withMetadata()`: en sharp AÑADE metadatos. Un perfil ICC hace que el navegador gestione el color del PNG y corrompe en silencio la codificación de elevación. `adaptiveFiltering` es obligatorio: sin él el fichero pesa el doble.
- Ortho mosaic: WMS returns JPEG, no GDAL — save as PNG/JPEG + sidecar `ortho.json` (bbox, CRS, m/px). Never name it `.tif` if it isn't.
- Textures: two levels — `terrain-2k.webp` (first paint) then `terrain-8k.webp` (max 8192 px wide) swapped in behind.
- Terrain mesh: builder takes step param, never assumes single geometry (MDT02 2 m will need quadtree). LOD steps 1/2/4, boot at step 2, step 1 behind a control. Default vertical exaggeration 1.0.
- Quality gate: model max must read ≈3347 m ±3 (Monte Perdido, official 3348). If it drifts, georeferencing broke.
- Content: Spanish (Spain) UI/text; code + commits in English, small commits. No placeholder data, no invented figures/dates — every fact needs a source in `content/sources.md`; leave visible gaps. IGN services failing = stop and report, never swap sources silently.
- Licences (footer + README): elevation + ortho © IGN/CNIG (CC BY 4.0 compatible); track = own GPX (or © OSM contributors, ODbL if fallback).

## Senda de los Cazadores — phase 3A rules

- Un único `requestAnimationFrame` en el proyecto. Cualquier animación se engancha al bucle de render existente.
- Todo suavizado temporal usa `1 - exp(-k*dt)`. Los factores fijos por frame están prohibidos.
- Los ángulos se interpolan por arco corto sobre el ángulo desenrollado, nunca con lerp lineal.
- El estado del recorrido (s, d, z, hora, pendiente, desnivel) tiene una sola fuente: `narrative/progress.ts`. Ningún módulo lo recalcula.
- Antes de ajustar un parámetro dos veces seguidas sin explicación, se construye la visualización que enseñe la magnitud que falla.
- Todo instrumento de depuración vive detrás de una bandera de URL, se carga de forma diferida y no deja rastro en el bundle de producción. Ningún instrumento puede escribir en un estado que también controle la pieza.
- Anulaciones explícitas de la pieza (orden: `?cam=` > rig para la pose, `?t=` > scroll para la hora, `?s=`/`?act=` > scroll para `s`, `?orbit=1` excluye el rig). Si está `?cam=`, el rig no compone; si está `?t=`, la hora queda congelada.
- El contexto GL crudo solo se lee (`getError`, `getShaderSource`, `readPixels`, timer queries); nunca se escribe. Todo estado pasa por el renderer.
- Todo uniforme añadido a un ShaderMaterial o a un onBeforeCompile se DECLARA en el GLSL (`uniform float X;`). three sube material.uniforms, no los declara. Comprobación obligatoria antes de subir: window.__programs sin ningún ok=false.
- Ningún render a target usa la escena principal. Cada pase fuera de pantalla tiene su escena propia con solo lo que necesita.
- Una fase, un despliegue. Cuando el brief da un orden con una comprobación entre fases, el orden es parte del brief. Juntar fases para ahorrar un despliegue no ahorra nada: cuesta la localización del fallo.
- Ningún parámetro de dibujo se retroalimenta de una sonda que lo mide; las sondas informan, no gobiernan.
