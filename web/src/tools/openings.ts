// Door / window / opening builders — extracted from create-mode.ts (#723).
// Door and window dimensions sourced from FZK-Haus IFC (#754) via extract-fzk-templates.ts.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getPendingHostId } from "../viewer/snap-state";

// FZK-Haus sourced dimensions (via scripts/extract-fzk-templates.ts)
export const FZK_DOOR_W    = 0.885;
export const FZK_DOOR_H    = 2.01;
export const FZK_WINDOW_W  = 2.0;
export const FZK_WINDOW_H  = 1.2;
export const FZK_WINDOW_SILL = 0.9;  // typical residential sill height

const DEFAULT_WALL_THICKNESS = 0.2;

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export function buildDoor(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w  = FZK_DOOR_W;
  const t  = DEFAULT_WALL_THICKNESS;
  const h  = FZK_DOOR_H;
  const fw = 0.05;  // frame rail width

  // Door frame: outer box minus panel area = three frame rails + inner panel
  const frameColor = 0x5c3d1e;
  const panelColor = 0x7a4f2a;

  // Left rail
  const g0 = new THREE.BoxGeometry(fw, t, h);
  g0.translate(-w / 2 + fw / 2, 0, h / 2);
  // Right rail
  const g1 = new THREE.BoxGeometry(fw, t, h);
  g1.translate(w / 2 - fw / 2, 0, h / 2);
  // Top rail
  const g2 = new THREE.BoxGeometry(w, t, fw);
  g2.translate(0, 0, h - fw / 2);
  // Panel (slightly recessed in y)
  const panelW = w - 2 * fw;
  const panelH = h - fw;
  const g3 = new THREE.BoxGeometry(panelW, t * 0.5, panelH);
  g3.translate(0, 0, panelH / 2);

  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.6, metalness: 0 });
  const panelMat = new THREE.MeshStandardMaterial({ color: panelColor, roughness: 0.5, metalness: 0 });

  const frameParts = mergeGeometries([g0, g1, g2]);
  const frameM = new THREE.Mesh(frameParts, frameMat);
  const panelM = new THREE.Mesh(g3, panelMat);
  panelM.position.z = 0;

  // Merge frame + panel into a single mesh for scene compatibility
  const merged = mergeGeometries([frameParts, g3]);
  const mat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.6, metalness: 0 });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "door";
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  // Nominal void dimensions for CSC cut chain (900mm × 2100mm standard)
  const vW = 0.9, vT = t, vH = 2.1;
  const chain = `door: makeBox(${vW}, ${vT}, ${vH}) translate([${round(p.x)}, ${round(p.y)}, ${vH / 2}])`;

  // Suppress unused vars from intermediate mesh objects
  void frameM; void panelM;
  return { mesh, chain };
}

export function buildWindow(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w    = FZK_WINDOW_W;
  const t    = DEFAULT_WALL_THICKNESS;
  const h    = FZK_WINDOW_H;
  const sill = FZK_WINDOW_SILL;
  const fw   = 0.06;  // frame width

  // Window: outer frame + glass pane (translucent)
  const frameColor = 0x444444;

  // Top rail
  const g0 = new THREE.BoxGeometry(w, t, fw);
  g0.translate(0, 0, h - fw / 2);
  // Bottom rail
  const g1 = new THREE.BoxGeometry(w, t, fw);
  g1.translate(0, 0, fw / 2);
  // Left stile
  const g2 = new THREE.BoxGeometry(fw, t, h);
  g2.translate(-w / 2 + fw / 2, 0, h / 2);
  // Right stile
  const g3 = new THREE.BoxGeometry(fw, t, h);
  g3.translate(w / 2 - fw / 2, 0, h / 2);
  // Glass (translucent pane)
  const glassW = w - 2 * fw;
  const glassH = h - 2 * fw;
  const g4 = new THREE.BoxGeometry(glassW, t * 0.3, glassH);
  g4.translate(0, 0, h / 2);

  const frameMat = new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.4, metalness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x88c4e8, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0 });

  const frameParts = mergeGeometries([g0, g1, g2, g3]);
  const merged = mergeGeometries([frameParts, g4]);
  // Store per-group material info in userData so renderer can split if needed
  const mesh = new THREE.Mesh(merged, [frameMat, glassMat]);
  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "window";
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  const chain = `window: makeBox(${w}, ${t}, ${h}) translate([${round(p.x)}, ${round(p.y)}, ${Math.round(sill)}])`;
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
