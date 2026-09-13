# Senda de los Cazadores — Ordesa 3D

Scroll narrativo en 3D sobre la Senda de los Cazadores, Parque Nacional de
Ordesa y Monte Perdido (Huesca). Fase 1: visor mínimo con terreno real y
trazado, sin narrativa.

## Licencias (obligatorias)

- Elevación: MDT PNOA-LiDAR © Instituto Geográfico Nacional / CNIG
  (licencia compatible CC BY 4.0).
- Imagen: Ortofoto PNOA Máxima Actualidad © Instituto Geográfico Nacional / CNIG.
- Trazado: GPX propio (`data/source/senda-cazadores.gpx`).

## Datos

- `npm run data` — descarga y genera todos los assets. **Solo en local, nunca en CI.**
- Versionados en git: `data/build/meta.json`, `public/assets/heightmap.png`,
  `public/assets/terrain-2k.webp`, `public/assets/terrain-8k.webp`,
  `public/assets/route.json`, `data/source/*.gpx`.
- `npm run verify` — 8 controles de calidad sobre los artefactos versionados,
  sin red. Corre dentro de `npm run build` y lo falla si no pasa.
- `npm run doctor` — pesos de assets y vértices por nivel de detalle.

<!--
  TODO: cuando existan los assets grandes finales, añadir en vercel.json
  cabeceras de caché larga e inmutable para heightmap.png y terrain-*.webp.
-->
