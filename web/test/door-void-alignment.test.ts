// #1679 — Door/window mesh bbox must match the wall void cut rect within ε.
// Verifies the single-rect placement principle: mesh position and void center
// are derived from the same wall-projected XY origin, so no gap can exist.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildDoor, buildWindow } from "../src/tools/openings";
import { addVoidToWallObject } from "../src/tools/join-groups";
import {
  DEFAULT_DOOR_W, DEFAULT_DOOR_H,
  FZK_DOOR_W, FZK_DOOR_H,
  FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL,
} from "../src/tools/dimensions";

const ε = 0.002; // 2 mm — tighter than a visible gap

/** Axis-aligned wall along world X, bottom at z=0. */
function makeWall(cx: number, cy: number, len = 5, thick = 0.2, ht = 3): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, thick, ht));
  mesh.position.set(cx, cy, ht / 2);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = "SdWall";
  return mesh;
}

/** Get void local bounds from cutHistory relative to the given Group. */
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

/** Get door/window mesh local bounds relative to the given Group (wall local space). */
function meshLocalBounds(mesh: THREE.Mesh, group: THREE.Group) {
  const worldBb = new THREE.Box3().setFromObject(mesh);
  // Transform bbox min/max corners to group local space
  const minL = group.worldToLocal(worldBb.min.clone());
  const maxL = group.worldToLocal(worldBb.max.clone());
  return {
    xMin: Math.min(minL.x, maxL.x),
    xMax: Math.max(minL.x, maxL.x),
    zMin: Math.min(minL.z, maxL.z),
    zMax: Math.max(minL.z, maxL.z),
  };
}

describe("door-void-alignment (#1679)", () => {
  // ── Door tests ──────────────────────────────────────────────────────────────

  test("door mesh X bounds == void cut X bounds — centered on wall", () => {
    const scene = new THREE.Scene();
    const wall = makeWall(0, 0);
    scene.add(wall);

    const w = DEFAULT_DOOR_W, h = DEFAULT_DOOR_H, elev = 0;
    const { mesh } = buildDoor({ x: 0, y: 0 }, { w, h });
    mesh.position.z = elev;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
  });

  test("door mesh Z bounds == void cut Z bounds — ground floor", () => {
    const scene = new THREE.Scene();
    const wall = makeWall(0, 0);
    scene.add(wall);

    const w = DEFAULT_DOOR_W, h = DEFAULT_DOOR_H, elev = 0;
    const { mesh } = buildDoor({ x: 0, y: 0 }, { w, h });
    mesh.position.z = elev;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.zMin - mb.zMin)).toBeLessThan(ε);
    expect(Math.abs(vb.zMax - mb.zMax)).toBeLessThan(ε);
  });

  test("door mesh bounds == void bounds — offset along wall axis", () => {
    const scene = new THREE.Scene();
    const wall = makeWall(0, 0, 5);
    scene.add(wall);

    const w = FZK_DOOR_W, h = FZK_DOOR_H, elev = 0;
    const px = 1.2; // 1.2 m from wall center along X
    const { mesh } = buildDoor({ x: px, y: 0 }, { w, h });
    mesh.position.z = elev;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(px, 0, elev + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
    expect(Math.abs(vb.zMin - mb.zMin)).toBeLessThan(ε);
    expect(Math.abs(vb.zMax - mb.zMax)).toBeLessThan(ε);
  });

  test("door mesh bounds == void bounds — elevated floor", () => {
    const scene = new THREE.Scene();
    const ht = 3, wallElev = 3;
    // Wall positioned at elevation 3 (second floor): bottom at z=3, center at z=4.5
    const wall = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, ht));
    wall.position.set(0, 0, wallElev + ht / 2);
    wall.updateMatrixWorld(true);
    wall.userData.creator = "SdWall";
    scene.add(wall);

    const w = FZK_DOOR_W, h = FZK_DOOR_H, elev = wallElev;
    const { mesh } = buildDoor({ x: 0, y: 0 }, { w, h });
    mesh.position.z = elev;
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
    expect(Math.abs(vb.zMin - mb.zMin)).toBeLessThan(ε);
    expect(Math.abs(vb.zMax - mb.zMax)).toBeLessThan(ε);
  });

  // ── Window tests ─────────────────────────────────────────────────────────────

  test("window mesh X bounds == void cut X bounds — centered on wall", () => {
    const scene = new THREE.Scene();
    const wall = makeWall(0, 0);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL, elev = 0;
    const { mesh } = buildWindow({ x: 0, y: 0 }, { w, h, sill });
    mesh.position.z = elev + mesh.position.z; // elev + sill
    mesh.updateMatrixWorld(true);

    const voidCenter = new THREE.Vector3(0, 0, elev + sill + h / 2);
    const voidGroup = addVoidToWallObject(wall, voidCenter, w, h);
    expect(voidGroup).not.toBeNull();

    const vb = voidLocalBounds(voidGroup!);
    const mb = meshLocalBounds(mesh, voidGroup!);
    expect(Math.abs(vb.xMin - mb.xMin)).toBeLessThan(ε);
    expect(Math.abs(vb.xMax - mb.xMax)).toBeLessThan(ε);
  });

  test("window mesh Z bounds == void cut Z bounds — standard sill height", () => {
    const scene = new THREE.Scene();
    const wall = makeWall(0, 0);
    scene.add(wall);

    const w = FZK_WINDOW_W, h = FZK_WINDOW_H, sill = FZK_WINDOW_SILL, elev = 0;
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
});
