// #1665 — SdWindow void-cut must work on level 1+ walls.
// Root cause: XY-only wall-find distance ties between stacked same-XY walls on
// different floors; 3-D distance from expected window world Z selects the right floor.
// Also verifies void bbox == window mesh bbox within 2mm for elevated levels.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildWindow } from "../src/tools/openings";
import { addVoidToWallObject } from "../src/tools/join-groups";
import { FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL } from "../src/tools/dimensions";

const ε = 0.002;

/** Axis-aligned wall along world X, bottom at z=elev. Simulates SdWall geometry+position. */
function makeWall(cx: number, cy: number, elev: number, len = 5, thick = 0.2, ht = 3): THREE.Mesh {
  // buildWall creates geometry with local Z from 0..ht, then handler sets mesh.position.z = elevation.
  // We reproduce that: BoxGeometry (center at 0), translate Z by ht/2 so local bbox = [0, ht].
  const geom = new THREE.BoxGeometry(len, thick, ht);
  geom.translate(0, 0, ht / 2);  // local Z now 0..ht
  const mesh = new THREE.Mesh(geom);
  mesh.position.set(cx, cy, elev);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = "SdWall";
  return mesh;
}

/** Get void local bounds from cutHistory relative to given Group. */
function voidLocalBounds(group: THREE.Group, entryIdx = 0) {
  const hist = group.userData.cutHistory as Array<{
    cx: number; cy: number; cz: number; w: number; h: number;
  }>;
  const e = hist[entryIdx];
  const lc = group.worldToLocal(new THREE.Vector3(e.cx, e.cy, e.cz));
  return {
    xMin: lc.x - e.w / 2,
    xMax: lc.x + e.w / 2,
    zMin: lc.z - e.h / 2,
    zMax: lc.z + e.h / 2,
  };
}

/** Get mesh bounds in group local space. */
function meshLocalBounds(mesh: THREE.Mesh, group: THREE.Group) {
  const worldBb = new THREE.Box3().setFromObject(mesh);
  const minL = group.worldToLocal(worldBb.min.clone());
  const maxL = group.worldToLocal(worldBb.max.clone());
  return {
    xMin: Math.min(minL.x, maxL.x),
    xMax: Math.max(minL.x, maxL.x),
    zMin: Math.min(minL.z, maxL.z),
    zMax: Math.max(minL.z, maxL.z),
  };
}

describe("window-void-multilevel (#1665)", () => {
  // ── Level 1 (elevation = 2.74m = 9ft, one-storey FZK building) ──────────────

  test("window mesh + void aligned on level 1 wall (elev=2.74m) — X axis", () => {
    const scene = new THREE.Scene();
    const elev = 2.74;
    const wall = makeWall(0, 0, elev);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL;
    const { mesh } = buildWindow({ x: 0, y: 0 }, { w, h, sill });
    mesh.position.z = elev + mesh.position.z;  // elev + sill
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
  });

  test("window mesh + void aligned on level 1 wall (elev=2.74m) — Z axis", () => {
    const scene = new THREE.Scene();
    const elev = 2.74;
    const wall = makeWall(0, 0, elev);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL;
    const { mesh } = buildWindow({ x: 0, y: 0 }, { w, h, sill });
    mesh.position.z = elev + mesh.position.z;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.zMin - mb.zMin)).toBeLessThan(ε);
    expect(Math.abs(vb.zMax - mb.zMax)).toBeLessThan(ε);
  });

  // ── Level 2 (elevation = 5.48m = 18ft, two-storey building) ─────────────────

  test("window mesh + void aligned on level 2 wall (elev=5.48m) — X axis", () => {
    const scene = new THREE.Scene();
    const elev = 5.48;
    const wall = makeWall(0, 0, elev);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL;
    const { mesh } = buildWindow({ x: 0, y: 0 }, { w, h, sill });
    mesh.position.z = elev + mesh.position.z;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
  });

  test("window mesh + void aligned on level 2 wall (elev=5.48m) — Z axis", () => {
    const scene = new THREE.Scene();
    const elev = 5.48;
    const wall = makeWall(0, 0, elev);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL;
    const { mesh } = buildWindow({ x: 0, y: 0 }, { w, h, sill });
    mesh.position.z = elev + mesh.position.z;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.zMin - mb.zMin)).toBeLessThan(ε);
    expect(Math.abs(vb.zMax - mb.zMax)).toBeLessThan(ε);
  });

  // ── 3-D wall-find test: stacked same-XY walls — verifies correct floor selected ──

  test("3-D wall-find: stacked same-XY walls — void cut on level 1 wall not level 0", () => {
    // Two walls at same XY, different elevations (level 0 and level 1)
    const scene = new THREE.Scene();
    const w0 = makeWall(0, 0, 0);   // level 0 wall
    const w1 = makeWall(0, 0, 2.74); // level 1 wall
    scene.add(w0, w1);

    const sill = FZK_WINDOW_SILL, h = FZK_WINDOW_H;
    const elev = 2.74; // active level elevation
    // Window void center at level 1 height
    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);

    // Simulate 3-D wall-find: prefer wall whose center is nearest in 3D
    const winRef = new THREE.Vector3(0, 0, elev + sill + h / 2);
    let bestWall: THREE.Mesh | null = null;
    let bestDist = Infinity;
    for (const wall of [w0, w1]) {
      const wc = new THREE.Box3().setFromObject(wall).getCenter(new THREE.Vector3());
      const d = winRef.distanceTo(wc);
      if (d < bestDist) { bestDist = d; bestWall = wall as THREE.Mesh; }
    }

    // bestWall must be w1 (level 1)
    expect(bestWall!.position.z).toBeCloseTo(2.74, 2);

    // Cut void in the correctly-selected wall
    const voidGroup = addVoidToWallObject(bestWall!, voidCenter, FZK_WINDOW_W, h);
    expect(voidGroup).not.toBeNull();

    // Verify void is within w1's Z bounds (local Z = sill to sill+h, all within [0, wallHt])
    const cut = (voidGroup!.userData.cutHistory as Array<{cx: number; cy: number; cz: number; w: number; h: number}>)[0];
    const lcCenter = voidGroup!.worldToLocal(new THREE.Vector3(cut.cx, cut.cy, cut.cz));
    const voidZMin = lcCenter.z - cut.h / 2;
    const voidZMax = lcCenter.z + cut.h / 2;
    // In w1's local space (Z from 0 to 3), window should be at [sill, sill+h]
    expect(voidZMin).toBeCloseTo(sill, 2);
    expect(voidZMax).toBeCloseTo(sill + h, 2);
  });
});
