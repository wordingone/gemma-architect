// Tests for door/window cross-wall rehosting (#1221).
// rehostVoidCut: restore old wall void, cut new void in nearest wall.

import { describe, it, expect, beforeEach } from "bun:test";
import * as THREE from "three";
import {
  cutRectVoidFromBoxMesh,
  rehostVoidCut,
  restoreVoidCut,
} from "../src/tools/join-groups.js";

function makeWall(x: number, y: number, w = 5, d = 0.2, h = 3): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, d, h));
  mesh.position.set(x, y, h / 2);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = "wall";
  mesh.userData.expressID = `wall-${x}-${y}`;
  return mesh;
}

function makeDoor(x: number, y: number): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.885, 0.1, 2.01));
  mesh.position.set(x, y, 0);
  mesh.updateMatrixWorld(true);
  mesh.userData.creator = "SdDoor";
  mesh.userData.voidW = 0.885;
  mesh.userData.voidH = 2.01;
  return mesh;
}

describe("rehostVoidCut — same-wall repositioning", () => {
  it("restores old void and re-cuts at new position on same wall", () => {
    const scene = new THREE.Scene();
    const wallA = makeWall(0, 0);
    const door = makeDoor(0, 0);
    scene.add(wallA, door);

    // Initial void cut
    const voidCenter1 = new THREE.Vector3(-1, 0, 1.005);
    const group1 = cutRectVoidFromBoxMesh(wallA, voidCenter1, 0.885, 2.01);
    expect(group1).not.toBeNull();
    door.userData.hostExpressID = wallA.userData.expressID;

    // Move door to x=+1 within same wall
    door.position.set(1, 0, 0);
    door.updateMatrixWorld(true);

    const result = rehostVoidCut(door, scene);
    expect(result).not.toBeNull();
    expect(result!.isCrossWall).toBe(false);
    expect(result!.newVoidGroup).toBeInstanceOf(THREE.Group);
    expect(result!.oldVoidGroup).toBeInstanceOf(THREE.Group);
  });
});

describe("rehostVoidCut — cross-wall rehost", () => {
  let scene: THREE.Scene;
  let wallA: THREE.Mesh;
  let wallB: THREE.Mesh;
  let door: THREE.Object3D;

  beforeEach(() => {
    scene = new THREE.Scene();
    wallA = makeWall(0, 0);   // centered at x=0
    wallB = makeWall(8, 0);   // centered at x=8 — 8m away
    door = makeDoor(0, 0);
    scene.add(wallA, wallB, door);

    // Place door on Wall A with void cut
    const voidCenter = new THREE.Vector3(0, 0, 1.005);
    const group = cutRectVoidFromBoxMesh(wallA, voidCenter, 0.885, 2.01);
    expect(group).not.toBeNull();
    door.userData.hostExpressID = wallA.userData.expressID;
  });

  it("Wall A restored to solid Mesh, Wall B gets void Group", () => {
    // Move door to Wall B's position
    door.position.set(8, 0, 0);
    door.updateMatrixWorld(true);

    const result = rehostVoidCut(door, scene);
    expect(result).not.toBeNull();
    expect(result!.isCrossWall).toBe(true);

    // Wall A should be back as a solid Mesh (restoredWallMesh)
    expect(result!.restoredWallMesh).toBeInstanceOf(THREE.Mesh);

    // Wall B's void Group should be in scene
    expect(result!.newVoidGroup).toBeInstanceOf(THREE.Group);
    // Wall B uuid now resolves to the void Group (uuid preserved on replacement, #1235)
    const wallBInScene = scene.getObjectByProperty("uuid", wallB.uuid);
    expect(wallBInScene).toBeInstanceOf(THREE.Group);
    expect(result!.newVoidGroup.parent).toBe(scene); // void group added

    // hostExpressID updated to Wall B
    expect(door.userData.hostExpressID).toBe(wallB.userData.expressID);
  });

  it("oldVoidGroup is the original Wall A cut group", () => {
    door.position.set(8, 0, 0);
    door.updateMatrixWorld(true);

    const result = rehostVoidCut(door, scene);
    expect(result).not.toBeNull();
    expect(result!.oldVoidGroup).toBeInstanceOf(THREE.Group);
  });

  it("returns null when no wall within 3m of new position", () => {
    // Move door far away from any wall
    door.position.set(100, 100, 0);
    door.updateMatrixWorld(true);

    const result = rehostVoidCut(door, scene);
    expect(result).toBeNull();
  });

  it("restoreVoidCut succeeds after rehostVoidCut updates hostExpressID", () => {
    door.position.set(8, 0, 0);
    door.updateMatrixWorld(true);
    rehostVoidCut(door, scene);

    // After rehost, hostExpressID points to Wall B.
    // restoreVoidCut should find and restore Wall B's void.
    const restore2 = restoreVoidCut(door, scene);
    expect(restore2).not.toBeNull();
    expect(restore2!.newWall.userData.expressID).toBe(wallB.userData.expressID);
  });
});
