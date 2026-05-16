// Door / window / opening builders — extracted from create-mode.ts (#723).

import * as THREE from "three";
import { getPendingHostId } from "../viewer/snap-state";

const DEFAULT_DOOR_W = 0.9;
const DEFAULT_DOOR_H = 2.1;
const DEFAULT_WINDOW_W = 1.2;
const DEFAULT_WINDOW_H = 1.4;
const DEFAULT_WINDOW_SILL = 1.0;
const DEFAULT_WALL_THICKNESS = 0.2;

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export function buildDoor(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_DOOR_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_DOOR_H;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "door";
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  const chain = `// door: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]))`;
  return { mesh, chain };
}

export function buildWindow(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_WINDOW_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WINDOW_H;
  const sill = DEFAULT_WINDOW_SILL;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "window";
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  const chain = `// window: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, ${round(sill)}]))`;
  return { mesh, chain };
}

export function buildOpening(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = 1, h = 2, t = 0.25;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, wireframe: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "opening";
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  const chain = `// opening: ${round(w)}×${round(h)} void at [${round(p.x)}, ${round(p.y)}, 0]`;
  return { mesh, chain };
}
