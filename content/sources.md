# Fuentes

Cada dato de la pieza, con su fuente primaria. Sin fuente, no entra.
Huecos visibles y anotados — nada de relleno.

## Verificado (entra en el brief)

- Parque Nacional de Ordesa y Monte Perdido: declarado el 16 de agosto de
  1918, uno de los dos primeros parques nacionales de España — ficha técnica
  del MITECO.
- Reclasificado y ampliado por la Ley 52/1982, de 13 de julio.
- Superficie: 15.696,20 ha; zona periférica de protección 19.196,36 ha —
  ficha técnica del MITECO.
- Gestión transferida en exclusiva a Aragón desde el 1 de julio de 2006.
- Reserva de la Biosfera Ordesa-Viñamala (1977) · Patrimonio Mundial UNESCO
  (1997), dentro de «Pirineos–Monte Perdido» · Diploma Europeo del Consejo de
  Europa (1988-2018) · Geoparque Sobrarbe-Pirineos — ficha técnica del MITECO.
- Bucardo: en 1972 quedaban menos de 50 ejemplares; hasta 1981 por encima de
  30; después desplome sin causa del todo identificada.
- Último bucardo (hembra Celia): muerto el 6 de enero de 2000 bajo un árbol
  caído. Cuerpo en el Centro de Visitantes de Torla-Ordesa.
- Clon de Celia: nacido por cesárea el 30 de julio de 2003, muerto a los
  pocos minutos por fallo respiratorio.
- Avistamiento noviembre de 2022 en Mondarruego (2.845 m): cabra montés joven
  de reintroducciones francesas (2014, 170 animales de Guadarrama). NO es
  bucardo — matiz irrenunciable.
- Glaciar de Monte Perdido: en la lista de «víctimas climáticas» de 2025
  (Año Internacional de la Preservación de los Glaciares). Monitorizado por
  el CSIC (IPE / Cryopyr).

## Pendiente de verificar (no entra hasta citarse aquí)

- Cifras actuales de superficie y pérdida de espesor del glaciar
  (cryopyr.csic.es, monografía OAPN).
- Lucien Briet y su peso en la declaración de 1918.
- Historia concreta de la apertura de la senda (quién, cuándo, permisos).
- Régimen de acceso/lanzadera de la temporada (pnomp.es, antes de publicar).
- Fecha del vuelo de la ortofoto PNOA usada (GetCapabilities) → decisión
  nieve por encima de 2.500 m.

## Datos geoespaciales

- Elevación: MDT PNOA-LiDAR vía WCS de IDEE
  (`https://servicios.idee.es/wcs-inspire/mdt`, cobertura `Elevacion25830_5`).
- Imagen: Ortofoto PNOA Máxima Actualidad vía WMS del IGN
  (`https://www.ign.es/wms-inspire/pnoa-ma`, capa `OI.OrthoimageCoverage`).
- Trazado: `data/source/senda-cazadores.gpx` (GPX propio, descargado de la
  URL facilitada por Gonzalo; el fichero versionado es la fuente primaria).
- Vuelo de la ortofoto PNOA-MA sobre el encuadre: FECHA='2024-07',
  RESOLUCION='0.25' (25 cm nativos), vuelo único en los seis puntos
  consultados (Pradera, Calcilarruego, Cola de Caballo, Monte Perdido y dos
  esquinas) vía GetFeatureInfo a `OI.MosaicElement` — ver
  `scripts/10-fetch-flight-date.ts` y `data/source/ortho.json`. Sol del vuelo
  ajustado por mínima correlación albedo↔iluminación: az 90° / alt 68°
  (coherente con mediodía solar de julio), correlación residual −0,092,
  máscara de sombra profunda 0,15 % — `scripts/11-measure-shadow.ts`.
- Cotas de referencia (fase 2, MDT propio + GPX):
  Pradera 1.321 m (inicio del GPX 741218,4726062) · puente de los Cazadores
  1.318 m (waypoint GPX 741372,4725929) · mirador de Calcilarruego 1.960 m
  (waypoint GPX 741507,4725203; publicado 1.952 m) · cota máxima del camino
  1.999 m (trazado km 2,44 — el camino sigue por encima del mirador;
  verificar cuál etiquetar) · Cola de Caballo 1.762 m (punto del trazado km
  9,67 = pie publicado ~1.760 m; el waypoint del GPX da 1.816 m porque está
  por encima del salto) · Monte Perdido 3.347 m (máximo del MDT
  748638,4729252 = 42,67556 N / 0,03442 E; oficial 3.348 m).
- Etiquetas de cumbres (fase 2): solo Monte Perdido y Mondarruego (2.845 m,
  ladera del avistamiento de cabra montés de noviembre de 2022) tienen nombre
  confirmado. Los 13 picos restantes van con posición y cota del MDT pero SIN
  nombre hasta identificarlos en MTN25 0146-3, 0146-4, 0178-1 y 0178-2 o en la
  cartografía del parque. Tozal del Mallo (2.254 m): aguja no resuelta por el
  MDT de 5 m en radio 150 m (máximo local 1.348 m); pendiente de búsqueda
  específica.
