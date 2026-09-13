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
- Data flow: `npm run data` = local only, never CI. Versioned in git: `data/build/meta.json`, `public/assets/heightmap.png`, `public/assets/terrain-*.webp`, `public/assets/route.json`, `data/source/*.gpx`. Gitignored: `data/source/dem.tif`, ortho tiles/mosaic, `data/source/mdt02/`. `verify` checks versioned artefacts, no network — safe in `build`.
- Deps for pipeline: `geotiff` (read WCS Int16 + tags) + `sharp` (tiles/mosaic/resize/heightmap PNG/WebP). Nothing else.
- Heightmap PNG via sharp from raw buffer, NO metadata: `sharp(buf, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 9, palette: false }).withMetadata({})`. An ICC profile makes the browser color-manage the PNG and silently corrupts elevation encoding.
- Ortho mosaic: WMS returns JPEG, no GDAL — save as PNG/JPEG + sidecar `ortho.json` (bbox, CRS, m/px). Never name it `.tif` if it isn't.
- Textures: two levels — `terrain-2k.webp` (first paint) then `terrain-8k.webp` (max 8192 px wide) swapped in behind.
- Terrain mesh: builder takes step param, never assumes single geometry (MDT02 2 m will need quadtree). LOD steps 1/2/4, boot at step 2, step 1 behind a control. Default vertical exaggeration 1.0.
- Quality gate: model max must read ≈3347 m ±3 (Monte Perdido, official 3348). If it drifts, georeferencing broke.
- Content: Spanish (Spain) UI/text; code + commits in English, small commits. No placeholder data, no invented figures/dates — every fact needs a source in `content/sources.md`; leave visible gaps. IGN services failing = stop and report, never swap sources silently.
- Licences (footer + README): elevation + ortho © IGN/CNIG (CC BY 4.0 compatible); track = own GPX (or © OSM contributors, ODbL if fallback).
