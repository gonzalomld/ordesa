// route-line.ts — the draped track as a tube above the terrain.
import * as THREE from "three";
import { epsgToWorld, type World } from "./terrain.ts";

export interface RoutePoint {
  x: number;
  y: number;
  z_mdt: number;
  z_gpx: number;
  d: number;
}

export async function loadRoute(): Promise<RoutePoint[]> {
  const res = await fetch("/assets/route.json");
  if (!res.ok) throw new Error(`route.json: HTTP ${res.status}`);
  const json = (await res.json()) as { points: RoutePoint[] };
  return json.points;
}

export function buildRouteLine(points: RoutePoint[], world: World): THREE.Mesh {
  // Subsample for the curve: every 3rd point keeps the shape, tube stays light.
  const curvePts: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 3) {
    const p = points[i] as RoutePoint;
    const [wx, wy, wz] = epsgToWorld(p.x, p.y, p.z_mdt, world);
    curvePts.push(new THREE.Vector3(wx, wy, wz));
  }
  const last = points[points.length - 1] as RoutePoint;
  const [lx, ly, lz] = epsgToWorld(last.x, last.y, last.z_mdt, world);
  curvePts.push(new THREE.Vector3(lx, ly, lz));
  const curve = new THREE.CatmullRomCurve3(curvePts);
  const geo = new THREE.TubeGeometry(curve, 2000, 6, 6, false);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5c1f });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
