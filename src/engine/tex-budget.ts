// tex-budget.ts — §P14: única fuente de verdad de QUÉ texturas carga cada
// nivel. La importan el viewer (para decidir) y las puertas de verify-3a (para
// medir el presupuesto real). Es deliberadamente declarativo: no consulta
// meta.assets, así una textura ausente se detecta como fallo en vez de
// degradar en silencio.
//
// Cuatro niveles, no tres: "lite" NO es "móvil". Es la rama de un aparato que
// no puede subir una textura de 4096 px (maxTextureSize < 4096): un límite
// duro de capacidad, no una preferencia de presupuesto. "phone" es el eje
// opuesto — un iPhone declara 8192/16384, puede con 4096 de sobra, lo que no
// tiene es memoria.
export type TexLevel = "full" | "mid" | "phone" | "lite";

export const TEX_HEIGHTMAP = "heightmap";

export interface MetaLike {
  assets?: Record<string, string>;
}

/** Claves de meta.assets que se llegan a cargar en cada nivel. "heightmap"
 * no vive en meta.assets (assetWebPath lo resuelve a assets/heightmap.png). */
export function pickTextures(texLevel: TexLevel): string[] {
  if (texLevel === "lite") {
    // Exactamente lo de hoy: rescate para hardware sin 4096.
    return [TEX_HEIGHTMAP, "terrain-base-2048", "clouds-atlas"];
  }
  if (texLevel === "phone") {
    // Puede con 4096, no tiene memoria: corredor y normales a media res.
    return [TEX_HEIGHTMAP, "terrain-base-2048", "terrain-corridor-4k", "clouds-atlas", "terrain-normal-2048"];
  }
  if (texLevel === "mid") {
    return [TEX_HEIGHTMAP, "terrain-base", "terrain-corridor-4k", "clouds-atlas", "terrain-normal", "rock-albedo", "rock-normal"];
  }
  return [TEX_HEIGHTMAP, "terrain-base", "terrain-corridor", "clouds-atlas", "terrain-normal", "rock-albedo", "rock-normal"];
}

/** Ruta tal como la pide el navegador ("assets/xxx"); la puerta antepone
 * "public/" para leer el fichero del disco. */
export function assetWebPath(key: string, meta: MetaLike): string {
  if (key === TEX_HEIGHTMAP) return "assets/heightmap.png";
  return meta.assets?.[key] ?? "";
}
