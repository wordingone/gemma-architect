// join-groups.ts
// Universal structural join: whenever any structural element is placed,
// detect AABB overlaps with existing structural elements, compute CSG unions,
// and replace individual display meshes with the unioned display mesh.

import * as THREE from "three";
import { Brush, Evaluator, ADDITION } from "three-bvh-csg";

// Structural types eligible for boolean union.
const JOIN_CREATORS = new Set([
  "wall", "slab", "column", "beam", "stair", "roof",
  "foundation", "curtainwall", "ceiling",
]);

// Creators that must never be joined.
const SKIP_CREATORS = new Set([
  "section-box", "IfcGridLine", "IfcReferenceLine", "IfcLevel",
  "clip-plane", "space", "SdClippingPlane", "SdSectionBox",
]);

// Shared Evaluator instance (re-used across calls).
const _evaluator = new Evaluator();

// groupId → Set of logical mesh UUIDs in that group.
const _groups = new Map<string, Set<string>>();

// logical mesh UUID → groupId.
const _meshToGroup = new Map<string, string>();

// groupId → current display mesh UUID.
const _displayMesh = new Map<string, string>();

let _groupCounter = 0;
function _nextGroupId(): string {
  return `jg-${++_groupCounter}`;
}

function _isJoinable(mesh: THREE.Object3D): boolean {
  if (!(mesh instanceof THREE.Mesh)) return false;
  const creator = mesh.userData?.creator as string | undefined;
  if (!creator) return false;
  if (SKIP_CREATORS.has(creator)) return false;
  if (mesh.userData?.isJoinDisplay) return false;
  if (mesh.userData?.noSnap) return false;
  return JOIN_CREATORS.has(creator);
}

/** Build a world-space Brush from a mesh (position/rotation baked into geometry). */
function _worldBrush(mesh: THREE.Mesh): Brush {
  mesh.updateMatrixWorld(true);
  const cloned = mesh.geometry.clone();
  cloned.applyMatrix4(mesh.matrixWorld);
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const brush = new Brush(cloned, mat);
  brush.position.set(0, 0, 0);
  brush.rotation.set(0, 0, 0);
  brush.scale.set(1, 1, 1);
  brush.updateMatrixWorld(true);
  return brush;
}

/**
 * Build a Brush for CSG. Wall meshes in multi-member groups get extended by their own
 * thickness (t) so perpendicular corners fill — the outer t/2×t/2 void is covered.
 * This extension lives only in the CSG brush geometry; the stored mesh geometry and
 * chain string keep the honest user-clicked length (no contract change).
 */
function _brushForCsg(mesh: THREE.Mesh): Brush {
  if (mesh.userData?.creator === "wall") {
    const params = (mesh.geometry as THREE.BoxGeometry).parameters;
    if (params?.width) {
      // params: { width: wallLength, height: thickness, depth: wallHeight }
      const extLen = params.width + params.height; // length + t
      const extGeom = new THREE.BoxGeometry(extLen, params.height, params.depth);
      extGeom.translate(0, 0, params.depth / 2); // same floor-anchor as original
      mesh.updateMatrixWorld(true);
      extGeom.applyMatrix4(mesh.matrixWorld);
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const brush = new Brush(extGeom, mat);
      brush.position.set(0, 0, 0);
      brush.rotation.set(0, 0, 0);
      brush.scale.set(1, 1, 1);
      brush.updateMatrixWorld(true);
      return brush;
    }
  }
  return _worldBrush(mesh);
}

/** Remove an existing display mesh for a group from the scene. */
function _removeDisplayMesh(scene: THREE.Scene, groupId: string): void {
  const displayId = _displayMesh.get(groupId);
  if (!displayId) return;
  const existing = scene.getObjectByProperty("uuid", displayId);
  if (existing) {
    scene.remove(existing);
    if (existing instanceof THREE.Mesh) {
      existing.geometry.dispose();
    }
  }
  _displayMesh.delete(groupId);
}

/** Compute the CSG union of all logical meshes in a group and add the display mesh to the scene. */
function _rebuildGroupDisplay(scene: THREE.Scene, groupId: string, primaryMat: THREE.Material): void {
  const memberIds = _groups.get(groupId);
  if (!memberIds || memberIds.size === 0) return;

  // Collect live mesh objects (may have been removed from scene externally).
  const members: THREE.Mesh[] = [];
  for (const uuid of memberIds) {
    const obj = scene.getObjectByProperty("uuid", uuid);
    if (obj instanceof THREE.Mesh) members.push(obj);
  }

  if (members.length === 0) return;

  if (members.length === 1) {
    // Single member — show it directly, no CSG needed.
    members[0].visible = true;
    return;
  }

  // Hide all logical members; display mesh will represent them.
  for (const m of members) m.visible = false;

  // Fold union: result = A ∪ B ∪ C ∪ …
  // Wall brushes are extended by t so corners fill without changing stored geometry.
  // Returns the folded Brush, or null if CSG fails.
  const buildUnion = (): Brush | null => {
    let acc: Brush = _brushForCsg(members[0]);
    for (let i = 1; i < members.length; i++) {
      const brushB = _brushForCsg(members[i]);
      const merged: Brush = _evaluator.evaluate(acc, brushB, ADDITION);
      if (i > 1) acc.geometry.dispose();
      brushB.geometry.dispose();
      acc = merged;
    }
    return acc;
  };

  let resultBrush: Brush;
  try {
    const union = buildUnion();
    if (!union) return;
    resultBrush = union;
  } catch (err) {
    console.warn("[join-groups] CSG union failed for group", groupId, err);
    // Fall back: keep all members visible.
    for (const m of members) m.visible = true;
    return;
  }

  // Apply primary material and tag the display mesh.
  resultBrush.material = primaryMat;
  resultBrush.userData.isJoinDisplay = true;
  resultBrush.userData.joinGroupId = groupId;
  resultBrush.userData.noSnap = true;

  scene.add(resultBrush);
  _displayMesh.set(groupId, resultBrush.uuid);
}

/**
 * Call immediately after any structural mesh is added to the scene.
 * Detects AABB overlaps with existing structural elements, merges into join groups,
 * and rebuilds CSG union display meshes.
 */
export function onElementCommitted(newMesh: THREE.Mesh, scene: THREE.Scene): void {
  if (!_isJoinable(newMesh)) return;

  newMesh.updateMatrixWorld(true);
  const newBox = new THREE.Box3().setFromObject(newMesh);

  // Find all joinable scene meshes that overlap with newMesh.
  const overlapping: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj === newMesh) return;
    if (!_isJoinable(obj)) return;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (newBox.intersectsBox(box)) overlapping.push(obj);
  });

  if (overlapping.length === 0) {
    // No overlaps — newMesh stays visible on its own; no group needed.
    return;
  }

  // Collect all group IDs that the overlapping meshes already belong to.
  const affectedGroupIds = new Set<string>();
  for (const m of overlapping) {
    const gid = _meshToGroup.get(m.uuid);
    if (gid) affectedGroupIds.add(gid);
  }

  // Determine or create the target group for newMesh.
  let targetGroupId: string;
  const existingGroupId = _meshToGroup.get(newMesh.uuid);

  if (affectedGroupIds.size === 0) {
    // No existing groups — create a fresh one.
    targetGroupId = existingGroupId ?? _nextGroupId();
  } else if (affectedGroupIds.size === 1) {
    // One existing group — merge newMesh into it.
    targetGroupId = [...affectedGroupIds][0];
  } else {
    // Multiple existing groups — merge all into the first (alphabetically by id is fine).
    const sorted = [...affectedGroupIds].sort();
    targetGroupId = sorted[0];

    // Absorb all other groups into targetGroupId.
    for (let i = 1; i < sorted.length; i++) {
      const srcId = sorted[i];
      const srcMembers = _groups.get(srcId);
      if (srcMembers) {
        let tgt = _groups.get(targetGroupId);
        if (!tgt) { tgt = new Set(); _groups.set(targetGroupId, tgt); }
        for (const uuid of srcMembers) {
          tgt.add(uuid);
          _meshToGroup.set(uuid, targetGroupId);
        }
        _groups.delete(srcId);
      }
      // Remove old display mesh for absorbed group.
      _removeDisplayMesh(scene, srcId);
      _displayMesh.delete(srcId);
    }
  }

  // Ensure target group exists.
  if (!_groups.has(targetGroupId)) _groups.set(targetGroupId, new Set());
  const targetGroup = _groups.get(targetGroupId)!;

  // Add newMesh and all overlapping meshes to the group.
  targetGroup.add(newMesh.uuid);
  _meshToGroup.set(newMesh.uuid, targetGroupId);
  for (const m of overlapping) {
    targetGroup.add(m.uuid);
    _meshToGroup.set(m.uuid, targetGroupId);
  }

  // Remove stale display mesh for this group before rebuilding.
  _removeDisplayMesh(scene, targetGroupId);

  // Use newMesh's material as the primary display material.
  const primaryMat = Array.isArray(newMesh.material)
    ? newMesh.material[0]
    : newMesh.material;

  _rebuildGroupDisplay(scene, targetGroupId, primaryMat);
}
