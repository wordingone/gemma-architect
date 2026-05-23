// Door / window / opening builders — extracted from create-mode.ts (#723).
// Door and window geometry sourced from FZK-Haus IFC (#874) via extract-fzk-geometry.ts.
// GLB assets at web/public/assets/architectural/{doors,windows}/ (#1127).
// Dimensions sourced from FZK-Haus IFC (#754) via extract-fzk-templates.ts.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getPendingHostId } from "../viewer/snap-state";

// FZK-Haus sourced dimensions (via scripts/extract-fzk-templates.ts) — for FZK fixture load path only
// EG interior doors: Innentuer-1/2/3 (IFC #17468/#19199/#19504)
export const FZK_DOOR_W    = 0.885;
export const FZK_DOOR_H    = 2.01;
// EG front door: Haustuer (IFC #27013)
export const FZK_FRONT_DOOR_W = 1.01;
export const FZK_FRONT_DOOR_H = 2.01;
// Terrace door: Terrassentuer (IFC #31079)
export const FZK_TERRACE_DOOR_W      = 2.01;
export const FZK_TERRACE_DOOR_H      = 2.375;
export const FZK_TERRACE_FANLIGHT_H  = 0.5;
// EG ground-floor windows: EG-Fenster-1 to -9 (IFC #23024 et al.)
export const FZK_WINDOW_W  = 2.0;
export const FZK_WINDOW_H  = 1.2;
export const FZK_WINDOW_SILL = 0.8;  // IFC Brüstungshöhe #23241/#67296
// OG upper-floor windows: OG-Fenster-1/2 (IFC #66459/#74280)
export const FZK_OG_WINDOW_W    = 1.0;
export const FZK_OG_WINDOW_H    = 1.0;

// IBC / California residential defaults for new user-placed elements
export const DEFAULT_DOOR_W   = 0.914;   // IBC R311.2: 36" exterior residential
export const DEFAULT_DOOR_H   = 2.032;   // IBC R311.2: 80" / 6'-8"

const DEFAULT_WALL_THICKNESS = 0.2;

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// ── FZK template geometry cache (#874) ────────────────────────────────────────

interface FzkGeomData {
  positions: number[];
  normals: number[];
  indices: number[];
  colors: number[];
  groups?: { start: number; count: number; material: "frame" | "glass" }[];
}

let _doorData: FzkGeomData | null = null;
let _windowData: FzkGeomData | null = null;

function _fetchTemplate(path: string): Promise<FzkGeomData | null> {
  return fetch(path).then(r => r.json()).catch(() => null);
}

// Kick off fetches immediately on module load so they're ready by first placement.
// Use BASE_URL prefix so paths resolve correctly on GitHub Pages subpath deployments.
const _OPENING_BASE = import.meta.env.BASE_URL;
_fetchTemplate(`${_OPENING_BASE}samples/fzk-door-geom.json`).then(d => { _doorData = d; });
_fetchTemplate(`${_OPENING_BASE}samples/fzk-window-geom.json`).then(d => { _windowData = d; });

// ── GLB asset cache (#1127) ───────────────────────────────────────────────────
// door variant index (0 or 1); window variant index (0 or 1)
export let _doorVariant   = 0;
export let _windowVariant = 0;

export function setDoorVariant(v: 0 | 1): void   { _doorVariant = v; }
export function setWindowVariant(v: 0 | 1): void { _windowVariant = v; }

// Per-variant GLB cache: null = not yet loaded, THREE.Group = loaded ok, false = load failed
const _doorGlbCache:   (THREE.Group | false | null)[] = [null, null];
const _windowGlbCache: (THREE.Group | false | null)[] = [null, null];

const DOOR_GLBS   = ["assets/architectural/doors/fzk-haus-door-1.glb",
                     "assets/architectural/doors/fzk-haus-door-2.glb"];
const WINDOW_GLBS = ["assets/architectural/windows/fzk-haus-window-1.glb",
                     "assets/architectural/windows/fzk-haus-window-2.glb"];

// Warm up GLB variants — only in browser context (not in test/SSR environments).
if (typeof window !== "undefined" && typeof _OPENING_BASE === "string") {
  const _gltfLoader = new GLTFLoader();
  const _warmGlb = (paths: string[], cache: (THREE.Group | false | null)[], i: number): void => {
    _gltfLoader.load(
      `${_OPENING_BASE}${paths[i]}`,
      (gltf) => { cache[i] = gltf.scene; },
      undefined,
      () => { cache[i] = false; },
    );
  };
  for (let i = 0; i < 2; i++) { _warmGlb(DOOR_GLBS, _doorGlbCache, i); }
  for (let i = 0; i < 2; i++) { _warmGlb(WINDOW_GLBS, _windowGlbCache, i); }
}

// Build a positioned/scaled mesh from a loaded GLB group.
// GLB meshes are produced in normalized [−0.5..0.5, depth, 0..1] space by gen-fzk-glbs.ts
// The axis-swap (IFC→app) was already baked in during extraction, so we just scale + place.
function _buildFromGlb(
  glbGroup: THREE.Group,
  targetW: number,
  targetThick: number,
  targetH: number,
  source: string,
): THREE.Mesh | null {
  try {
    const clone = glbGroup.clone(true);
    // Gather all meshes to compute aggregate bbox
    const meshes: THREE.Mesh[] = [];
    clone.traverse((obj) => { if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh); });
    if (meshes.length === 0) return null;

    // Aggregate bbox in local-group space
    const bb = new THREE.Box3().setFromObject(clone);
    const sz = bb.getSize(new THREE.Vector3());
    if (sz.x < 1e-4 || sz.y < 1e-4 || sz.z < 1e-4) return null;

    // Center X/Y, zero-floor Z
    const center = bb.getCenter(new THREE.Vector3());
    clone.position.set(-center.x, -center.y, -bb.min.z);

    // Scale to target dims
    const sx = targetW     / sz.x;
    const sy = targetThick / sz.y;
    const sz_ = targetH    / sz.z;
    clone.scale.set(sx, sy, sz_);

    // Wrap in a single Mesh-shaped container via a Group-as-Mesh trick:
    // Return the group cast as a Mesh so callers don't need to change their type.
    const container = new THREE.Group();
    container.add(clone);

    // Tag userData on each child mesh for S130 assertion
    container.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) obj.userData.source = source;
    });

    // Return container as a Mesh (callers use mesh.add/position/userData)
    (container as unknown as THREE.Mesh).userData = { source };
    return container as unknown as THREE.Mesh;
  } catch {
    return null;
  }
}

// Build a THREE.BufferGeometry from FZK JSON data. Applies axis swap from
// IFC convention (X=depth, Y=height centered, Z=width floored at 0) to app
// convention (X=width centered, Y=depth centered, Z=height with bottom at 0),
// then scales to the target placement dimensions.
function _buildFromFzkData(
  data: FzkGeomData,
  targetW: number,
  targetThick: number,
  targetH: number,
): { geom: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null {
  try {
    const positions = new Float32Array(data.positions);
    const normals   = new Float32Array(data.normals);
    const colors    = new Float32Array(data.colors);
    const indices   = new Uint32Array(data.indices);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal",   new THREE.BufferAttribute(normals, 3));
    geom.setAttribute("color",    new THREE.BufferAttribute(colors, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    // Axis swap: IFC [X=depth, Y=height, Z=width] → App [X=width, Y=depth, Z=height]
    // new_x = old_z, new_y = old_x, new_z = old_y
    geom.applyMatrix4(new THREE.Matrix4().set(
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    ));

    // Recompute bbox after swap; center X/Y and put Z bottom at 0.
    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return null;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const swRange = bb.max.x - bb.min.x;
    const stRange = bb.max.y - bb.min.y;
    const shRange = bb.max.z - bb.min.z;
    if (swRange < 0.001 || stRange < 0.001 || shRange < 0.001) return null;

    geom.applyMatrix4(new THREE.Matrix4().makeTranslation(-cx, -cy, -bb.min.z));

    // Non-uniform scale to fit target placement dims.
    geom.scale(targetW / swRange, targetThick / stRange, targetH / shRange);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.05,
    });
    return { geom, mat };
  } catch {
    return null;
  }
}

// Window-specific FZK builder: applies frame/glass groups from extracted JSON (#885).
// Frame → MeshStandardMaterial (tan, opaque).
// Glass → MeshPhysicalMaterial (transparent, transmission-based).
function _buildWindowFromFzkData(
  data: FzkGeomData,
  targetW: number,
  targetThick: number,
  targetH: number,
): { geom: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] } | null {
  try {
    const positions = new Float32Array(data.positions);
    const normals   = new Float32Array(data.normals);
    const colors    = new Float32Array(data.colors);
    const indices   = new Uint32Array(data.indices);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("normal",   new THREE.BufferAttribute(normals, 3));
    geom.setAttribute("color",    new THREE.BufferAttribute(colors, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    geom.applyMatrix4(new THREE.Matrix4().set(
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    ));

    geom.computeBoundingBox();
    const bb = geom.boundingBox;
    if (!bb) return null;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    const swRange = bb.max.x - bb.min.x;
    const stRange = bb.max.y - bb.min.y;
    const shRange = bb.max.z - bb.min.z;
    if (swRange < 0.001 || stRange < 0.001 || shRange < 0.001) return null;

    geom.applyMatrix4(new THREE.Matrix4().makeTranslation(-cx, -cy, -bb.min.z));
    geom.scale(targetW / swRange, targetThick / stRange, targetH / shRange);

    if (data.groups && data.groups.length > 0) {
      for (const grp of data.groups) {
        geom.addGroup(grp.start, grp.count, grp.material === "glass" ? 1 : 0);
      }
      return {
        geom,
        mat: [
          new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.55, metalness: 0.05 }),
          new THREE.MeshPhysicalMaterial({
            color: 0x88aacc, transparent: true, opacity: 0.30,
            transmission: 0.85, roughness: 0.05, metalness: 0.0,
          }),
        ],
      };
    }

    // Fallback: old JSON without groups — single vertex-colored material
    return {
      geom,
      mat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }),
    };
  } catch {
    return null;
  }
}

// ── Synthetic fallbacks (used when FZK template not yet loaded) ───────────────

function _syntheticDoor(w: number, t: number, h: number): { geom: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } {
  const fw = 0.05;
  const panelW = w - 2 * fw;
  const panelH = h - fw;
  const g0 = new THREE.BoxGeometry(fw, t, h);   g0.translate(-w / 2 + fw / 2, 0, h / 2);
  const g1 = new THREE.BoxGeometry(fw, t, h);   g1.translate(w / 2 - fw / 2, 0, h / 2);
  const g2 = new THREE.BoxGeometry(w, t, fw);   g2.translate(0, 0, h - fw / 2);
  const g3 = new THREE.BoxGeometry(panelW, t * 0.5, panelH); g3.translate(0, 0, panelH / 2);
  const geom = mergeGeometries([g0, g1, g2, g3]);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.6, metalness: 0 });
  return { geom, mat };
}

function _syntheticWindow(w: number, t: number, h: number): { geom: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[] } {
  const fw = 0.06;
  const g0 = new THREE.BoxGeometry(w, t, fw);   g0.translate(0, 0, h - fw / 2);
  const g1 = new THREE.BoxGeometry(w, t, fw);   g1.translate(0, 0, fw / 2);
  const g2 = new THREE.BoxGeometry(fw, t, h);   g2.translate(-w / 2 + fw / 2, 0, h / 2);
  const g3 = new THREE.BoxGeometry(fw, t, h);   g3.translate(w / 2 - fw / 2, 0, h / 2);
  const g4 = new THREE.BoxGeometry(w - 2 * fw, t * 0.3, h - 2 * fw); g4.translate(0, 0, h / 2);
  const geom = mergeGeometries([g0, g1, g2, g3, g4], true);
  const mat  = [
    new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.4, metalness: 0.2 }),
    new THREE.MeshStandardMaterial({ color: 0x88c4e8, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0 }),
  ];
  return { geom, mat };
}

// ── Public builders ────────────────────────────────────────────────────────────

export function buildDoor(p: { x: number; y: number }, dims?: { w?: number; h?: number }): { mesh: THREE.Mesh; chain: string } {
  const w = dims?.w ?? DEFAULT_DOOR_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = dims?.h ?? DEFAULT_DOOR_H;

  // Prefer GLB asset (#1127); fall back to JSON-based geometry, then synthetic.
  const glbGroup = _doorGlbCache[_doorVariant];
  const glbMesh  = glbGroup ? _buildFromGlb(glbGroup, w, t, h, "glb") : null;

  let mesh: THREE.Mesh;
  if (glbMesh) {
    mesh = glbMesh;
  } else {
    const fzk = _doorData ? _buildFromFzkData(_doorData, w, t, h) : null;
    const { geom, mat } = fzk ?? _syntheticDoor(w, t, h);
    mesh = new THREE.Mesh(geom, mat as THREE.Material);
  }

  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind    = "mesh";
  mesh.userData.creator = "door";
  mesh.userData.variant = _doorVariant;
  const hostId = getPendingHostId();
  if (hostId) mesh.userData.hostExpressID = hostId;
  const vW = 0.9, vT = t, vH = 2.1;
  const chain = `door: makeBox(${vW}, ${vT}, ${vH}) translate([${round(p.x)}, ${round(p.y)}, ${vH / 2}])`;
  return { mesh, chain };
}

export function buildWindow(p: { x: number; y: number }, dims?: { w?: number; h?: number; sill?: number }): { mesh: THREE.Mesh; chain: string } {
  const w    = dims?.w    ?? FZK_WINDOW_W;
  const t    = DEFAULT_WALL_THICKNESS;
  const h    = dims?.h    ?? FZK_WINDOW_H;
  const sill = dims?.sill ?? FZK_WINDOW_SILL;

  // Prefer GLB asset (#1127); fall back to JSON-based geometry, then synthetic.
  const glbGroup = _windowGlbCache[_windowVariant];
  const glbMesh  = glbGroup ? _buildFromGlb(glbGroup, w, t, h, "glb") : null;

  let mesh: THREE.Mesh;
  if (glbMesh) {
    mesh = glbMesh;
  } else {
    const fzk = _windowData ? _buildWindowFromFzkData(_windowData, w, t, h) : null;
    const { geom, mat } = fzk ?? _syntheticWindow(w, t, h);
    mesh = new THREE.Mesh(geom, mat as THREE.Material | THREE.Material[]);
  }

  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind    = "mesh";
  mesh.userData.creator = "window";
  mesh.userData.variant = _windowVariant;
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
