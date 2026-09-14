# Auditoría de la fase 1 — Correcciones A1, A2, B1, B2, B3, B4

Origen: contraste de los artefactos de producción contra una descarga independiente del WCS del IGN, más lectura del repo. Van ANTES que cualquier trabajo de la fase 2.

---

## A. Errores del brief original que hay que corregir

### A1. AGENTS.md contiene una regla que es FALSA y hay que reescribir

Decía:

> "Heightmap PNG via sharp from raw buffer, NO metadata: `...png({compressionLevel:9, palette:false}).withMetadata({})`"

Es contradictoria y está mal: en sharp, `withMetadata()` AÑADE metadatos, no los quita. Por defecto sharp ya no escribe ninguno. El PNG desplegado lleva perfil ICC y EXIF.

Sustituir esa línea en AGENTS.md por:

> "Heightmap PNG con sharp desde buffer raw, SIN metadatos y con filtrado adaptativo: `.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })`. NUNCA `withMetadata()`: en sharp AÑADE metadatos. Un perfil ICC hace que el navegador gestione el color del PNG y corrompe en silencio la codificación de elevación. `adaptiveFiltering` es obligatorio: sin él el fichero pesa el doble."

Aplicar el mismo cambio en `scripts/03-build-heightmap.ts`, comentario incluido.

Medido con sharp reproduciendo el fichero desplegado: 2.555.952 B (byte a byte el actual) → 1.319.784 B con adaptiveFiltering. Un 48 % menos, 1,2 MB, en la ruta crítica de carga.

### A2. Los REF_POINTS del brief estaban MAL

La proyección era exacta, los puntos no caían sobre los sitios que decían. Corregir con los waypoints del GPX, que es la fuente buena:

- `pradera` 741218, 4726062 (42,64923 / -0,05737) MDT ≈1318 ← inicio del GPX
- `puente` 741372, 4725929 (42,64798 / -0,05555) MDT ≈1318
- `calcilarruego` 741507, 4725203 (42,64141 / -0,05421) MDT 1960 (publicado 1952)
- `colaCaballo` 747159, 4726471 (42,65102 / 0,01519) MDT 1816 (publicado ~1760) — ver nota D6-P5: la cota del trazado en el km 9,67 es 1762 m, que coincide con lo publicado; los 1816 m eran del waypoint, por encima del salto.
- `montePerdido` 748647, 4729168 (42,6748 / 0,0345) MDT 3347 ← este estaba bien

Dos avisos:

- `tozalMallo` tenía `expectedZ: 0`, que es un hueco. O cota real o se quita.
- Cola de Caballo: 1816 del MDT frente a ~1760 publicado son 56 m. La cifra publicada es el pie de la cascada y el waypoint está arriba. Anotado en `content/sources.md`: la cota se toma del punto del trazado, no del waypoint.

Cuando se corrija, esos tres pasan de INFO a control real con tolerancia ±15 m.

---

## B. Correcciones del código

### B1. route.json pesa 363.803 B por serializarse como array de objetos con formato bonito

Pasarlo a arrays paralelos y minificado:

```json
{ "crs": ..., "stepM": ..., "offsetM": ..., "lengthM": ..., "x": [...], "y": [...], "z_mdt": [...], "z_gpx": [...], "d": [...], "cumClimb": [...] }
```

Medido: 142.567 B, un 61 % menos, y entra directo a Float32Array en el motor.

### B2. verify.ts — noveno control: el heightmap NO debe llevar ICC ni EXIF

Comprobar los chunks del PNG (iCCP, eXIf, sRGB, gAMA) y fallar si aparece alguno. El round-trip en Node no lo caza porque las librerías de Node ignoran el perfil; el navegador no.

### B3. vercel.json, tres cosas

- Quitar `--legacy-peer-deps` del installCommand. Herencia del andamio de shadcn; con three/lenis/sharp/geotiff no hay conflictos de peers y ese flag tapa problemas reales.
- El rewrite `/(.*) → /index.html` se traga los 404. Vercel sirve el fichero estático primero, así que los assets existentes van bien, pero un asset MAL ESCRITO devolverá 200 con HTML, y el motor intentará parsear HTML como JSON con un error incomprensible. Excluir `/assets/` del rewrite. Como esto es una sola página, plantearse si el rewrite hace falta siquiera.
- Añadir cabeceras inmutables para `/assets/*` (max-age=31536000, immutable) y meter un hash corto en el nombre de los generados (heightmap.\<hash\>.png…), con el nombre real escrito en meta.json para que el motor lo lea de ahí. Hoy todo sale con max-age=0,must-revalidate, incluida la textura de 11,6 MB. Sin hash en el nombre, "immutable" es una trampa.

### B4. @types/node está en ^24 con un runtime de 22.16

Bajarlo a ^22 para que los tipos no ofrezcan APIs que en ejecución no existen.

---

## Contexto — lo que la auditoría confirmó que está BIEN y no hay que tocar

heightmap.png reconstruye el MDT del IGN con CERO diferencias en 3.533.760 píxeles; meta.json coherente (maxPixel fila 325 col 2079 → 42,6756 N 0,0344 E = Monte Perdido); route.json con 3.626 puntos, 18.125,9 m, bilineal real, dif GPX vs MDT media 6,3 m máx 44,9 m. El pipeline de datos es correcto. Lo que falla es peso, cabeceras y unas constantes mal puestas.
