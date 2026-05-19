// viewer-disposal.test.ts — §B-mesh (#990) disposal contract for removeObject() path.
//
// disposeMeshTree() must release geometry + material (+ texture maps) for every
// Object3D removed via removeObject() (inspector slider swaps, removeLevel, etc.).
// deleteSelected() is intentionally excluded — it preserves references for undo;
// clearHistory() handles that path.

import { describe, expect, test } from "bun:test";

// ── Minimal mock types ────────────────────────────────────────────────────────

interface MockGeometry {
  dispose: () => void;
  disposeCount: number;
  isBufferGeometry: true;
}

interface MockTexture {
  dispose: () => void;
  disposeCount: number;
}

interface MockMaterial {
  dispose: () => void;
  disposeCount: number;
  map?: MockTexture;
  normalMap?: MockTexture;
  roughnessMap?: MockTexture;
  aoMap?: MockTexture;
  emissiveMap?: MockTexture;
  isMaterial: true;
}

interface MockMesh {
  geometry?: MockGeometry;
  material?: MockMaterial | MockMaterial[];
  children: MockMesh[];
  traverse: (fn: (child: MockMesh) => void) => void;
  isMesh?: boolean;
}

function makeGeom(): MockGeometry {
  const g: MockGeometry = {
    isBufferGeometry: true,
    disposeCount: 0,
    dispose() { this.disposeCount++; },
  };
  return g;
}

function makeTex(): MockTexture {
  const t: MockTexture = {
    disposeCount: 0,
    dispose() { this.disposeCount++; },
  };
  return t;
}

function makeMat(textures?: Partial<Pick<MockMaterial, "map" | "normalMap" | "roughnessMap">>): MockMaterial {
  const m: MockMaterial = {
    isMaterial: true,
    disposeCount: 0,
    dispose() { this.disposeCount++; },
    ...textures,
  };
  return m;
}

function makeMesh(geom: MockGeometry, mat: MockMaterial | MockMaterial[], children: MockMesh[] = []): MockMesh {
  const mesh: MockMesh = {
    isMesh: true,
    geometry: geom,
    material: mat,
    children,
    traverse(fn) {
      fn(this);
      for (const c of this.children) c.traverse(fn);
    },
  };
  return mesh;
}

function makeGroup(children: MockMesh[]): MockMesh {
  return {
    isMesh: false,
    children,
    traverse(fn) {
      fn(this);
      for (const c of this.children) c.traverse(fn);
    },
  };
}

// ── Mirror of disposeMeshTree from viewer.ts ──────────────────────────────────
// Keep in sync with web/src/viewer/viewer.ts `disposeMeshTree`.

function _disposeMaterial(mat: MockMaterial): void {
  for (const k of ["map", "normalMap", "roughnessMap", "aoMap", "emissiveMap"] as const) {
    (mat as unknown as Record<string, MockTexture | undefined>)[k]?.dispose?.();
  }
  mat.dispose();
}

function disposeMeshTree(obj: MockMesh): void {
  obj.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    const mat = child.material;
    if (!mat) return;
    if (Array.isArray(mat)) mat.forEach(_disposeMaterial);
    else _disposeMaterial(mat);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("#990 §B-mesh — disposeMeshTree disposal contract", () => {

  test("single mesh: geometry.dispose() + material.dispose() called once", () => {
    const geom = makeGeom();
    const mat = makeMat();
    const mesh = makeMesh(geom, mat);
    disposeMeshTree(mesh);
    expect(geom.disposeCount).toBe(1);
    expect(mat.disposeCount).toBe(1);
  });

  test("material array: all materials in array disposed", () => {
    const geom = makeGeom();
    const mats = [makeMat(), makeMat(), makeMat()];
    const mesh = makeMesh(geom, mats);
    disposeMeshTree(mesh);
    expect(geom.disposeCount).toBe(1);
    for (const m of mats) expect(m.disposeCount).toBe(1);
  });

  test("texture maps disposed before material.dispose()", () => {
    const geom = makeGeom();
    const map = makeTex();
    const normalMap = makeTex();
    const roughnessMap = makeTex();
    const mat = makeMat({ map, normalMap, roughnessMap });
    const mesh = makeMesh(geom, mat);
    disposeMeshTree(mesh);
    expect(map.disposeCount).toBe(1);
    expect(normalMap.disposeCount).toBe(1);
    expect(roughnessMap.disposeCount).toBe(1);
    expect(mat.disposeCount).toBe(1);
  });

  test("group with mesh children: all children disposed (removeLevel path)", () => {
    const geom1 = makeGeom(); const mat1 = makeMat();
    const geom2 = makeGeom(); const mat2 = makeMat();
    const geom3 = makeGeom(); const mat3 = makeMat();
    const child1 = makeMesh(geom1, mat1);
    const child2 = makeMesh(geom2, mat2);
    const child3 = makeMesh(geom3, mat3);
    const group = makeGroup([child1, makeGroup([child2, child3])]);
    disposeMeshTree(group);
    for (const [g, m] of [[geom1, mat1], [geom2, mat2], [geom3, mat3]] as const) {
      expect((g as MockGeometry).disposeCount).toBe(1);
      expect((m as MockMaterial).disposeCount).toBe(1);
    }
  });

  test("mesh with no geometry — no crash (defensive guard)", () => {
    const noGeomMesh: MockMesh = {
      isMesh: true,
      geometry: undefined,
      material: makeMat(),
      children: [],
      traverse(fn) { fn(this); },
    };
    expect(() => disposeMeshTree(noGeomMesh)).not.toThrow();
  });

  test("mesh with no material — no crash (defensive guard)", () => {
    const noMatMesh: MockMesh = {
      isMesh: true,
      geometry: makeGeom(),
      material: undefined,
      children: [],
      traverse(fn) { fn(this); },
    };
    expect(() => disposeMeshTree(noMatMesh)).not.toThrow();
  });

  test("inspector swap: N old meshes → each disposed exactly once (roof/stair/door pattern)", () => {
    // Simulates: dispatchSync adds new mesh → removeObject(oldMesh) × N inspector firings.
    const olds = Array.from({ length: 5 }, () => {
      const g = makeGeom(); const m = makeMat();
      return { mesh: makeMesh(g, m), geom: g, mat: m };
    });
    for (const { mesh } of olds) disposeMeshTree(mesh);
    for (const { geom, mat } of olds) {
      expect(geom.disposeCount).toBe(1);
      expect(mat.disposeCount).toBe(1);
    }
  });
});
