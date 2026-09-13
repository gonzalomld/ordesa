// DEM reader: GeoTIFF Int16 from the IGN WCS. Resolution and origin are read
// from the file's own tags — never hardcode the "5 m" anywhere.
import { fromFile } from "geotiff";

export interface Dem {
  width: number;
  height: number;
  resX: number;
  resY: number;
  minx: number; // west edge (tiepoint)
  maxy: number; // north edge (tiepoint)
  minZ: number;
  maxZ: number;
  data: Int16Array;
  sampleBilinear(x: number, y: number): number;
  maxPixel(): { col: number; row: number; z: number; x: number; y: number };
}

function findTag(fd: Record<string, unknown>, ...names: string[]): unknown {
  const keys = Object.keys(fd);
  for (const name of names) {
    const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const k of keys) {
      if (k.toLowerCase().replace(/[^a-z0-9]/g, "") === norm) return fd[k];
    }
  }
  return undefined;
}

export async function readDem(path: string): Promise<Dem> {
  const tiff = await fromFile(path);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const fd = image.getFileDirectory() as unknown as Record<string, unknown>;

  const scale = (findTag(fd, "ModelPixelScaleTag", "ModelPixelScale", "33550") ??
    []) as number[];
  const tie = (findTag(fd, "ModelTiepointTag", "ModelTiepoint", "33922") ??
    []) as number[];
  if (scale.length < 2 || tie.length < 6) {
    throw new Error(`${path}: missing ModelPixelScale/ModelTiepoint tags`);
  }
  const resX = scale[0] as number;
  const resY = scale[1] as number;
  const minx = tie[3] as number;
  const maxy = tie[4] as number;

  const rasters = (await image.readRasters({ interleave: true })) as unknown;
  const raw = (rasters as { data?: ArrayLike<number> }).data ??
    (Array.isArray(rasters) ? (rasters as ArrayLike<number>[]) [0] : (rasters as ArrayLike<number>));
  const data = Int16Array.from(raw as ArrayLike<number>);

  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    if (v < minZ) minZ = v;
    if (v > maxZ) maxZ = v;
  }

  function at(col: number, row: number): number {
    const c = Math.min(width - 1, Math.max(0, col));
    const r = Math.min(height - 1, Math.max(0, row));
    return data[r * width + c] as number;
  }

  function sampleBilinear(x: number, y: number): number {
    const col = (x - minx) / resX;
    const row = (maxy - y) / resY;
    const c0 = Math.floor(col);
    const r0 = Math.floor(row);
    const fx = col - c0;
    const fy = row - r0;
    const a = at(c0, r0);
    const b = at(c0 + 1, r0);
    const c = at(c0, r0 + 1);
    const d = at(c0 + 1, r0 + 1);
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  }

  function maxPixel(): { col: number; row: number; z: number; x: number; y: number } {
    let col = 0;
    let row = 0;
    for (let i = 0; i < data.length; i++) {
      if ((data[i] as number) === maxZ) {
        col = i % width;
        row = Math.floor(i / width);
        break;
      }
    }
    return {
      col,
      row,
      z: maxZ,
      x: minx + (col + 0.5) * resX,
      y: maxy - (row + 0.5) * resY,
    };
  }

  return { width, height, resX, resY, minx, maxy, minZ, maxZ, data, sampleBilinear, maxPixel };
}
