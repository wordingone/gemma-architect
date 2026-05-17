// join-groups.ts
// Universal structural join: whenever any structural element is placed,
// detect AABB overlaps with existing structural elements, compute CSG unions,
// and replace individual display meshes with the unioned display mesh.

import * as THREE from "three";
import { Brush, Evaluator, ADDITION, SUBTRACTION } from "three-bvh-csg";

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
 * Build a CSG Brush for a mesh. Wall brushes are extended by their own thickness
 * so corner overlap regions are robust enough for three-bvh-csg ADDITION.
 * Miter trim (SUBTRACTION) is applied after union to remove the resulting protrusions.
 */
function _brushForCsg(mesh: THREE.Mesh): Brush {
  if (mesh.userData?.creator === "wall") {
    const params = (mesh.geometry as THREE.BoxGeometry).parameters;
    if (params?.width) {
      const extGeom = new THREE.BoxGeometry(
        params.width + params.height,
        params.height,
        params.depth,
      );
      extGeom.translate(0, 0, params.depth / 2);
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

/**
 * For two walls meeting endpoint-to-endpoint, returns a half-space cutter Brush
 * that covers the "protrusion zone" on the negative side of the miter plane.
 * Subtracting this from the CSG union result removes the star artifact at any angle.
 */
function _wallMiterCutter(wallA: THREE.Mesh, wallB: THREE.Mesh): Brush | null {
  const cpsA = wallA.userData.controlPoints as THREE.Vector3[] | undefined;
  const cpsB = wallB.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cpsA || cpsA.length < 2 || !cpsB || cpsB.length < 2) return null;

  wallA.updateMatrixWorld(true);
  wallB.updateMatrixWorld(true);

  const wpA = [
    cpsA[0].clone().applyMatrix4(wallA.matrixWorld),
    cpsA[1].clone().applyMatrix4(wallA.matrixWorld),
  ];
  const wpB = [
    cpsB[0].clone().applyMatrix4(wallB.matrixWorld),
    cpsB[1].clone().applyMatrix4(wallB.matrixWorld),
  ];

  // Find closest endpoint pair — this identifies the junction end of each wall.
  let minDist = Infinity;
  let iA = 0, iB = 0;
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      const d = wpA[a].distanceTo(wpB[b]);
      if (d < minDist) { minDist = d; iA = a; iB = b; }
    }
  }

  // Only trim L-junctions (endpoint-to-endpoint within 1 m).
  if (minDist > 1.0) return null;

  const P = wpA[iA].clone().add(wpB[iB]).multiplyScalar(0.5);

  // Directions pointing AWAY from P along each wall's body.
  const outA = wpA[1 - iA].clone().sub(P).normalize();
  const outB = wpB[1 - iB].clone().sub(P).normalize();

  // Miter normal bisects outA and outB — points into the "corner space"
  // where both walls' extended geometry protrudes.
  const miterNormal = outA.clone().add(outB).normalize();
  if (miterNormal.length() < 0.1) return null; // collinear walls — no junction to trim

  // Cutter: a large box on the NEGATIVE side of the miter plane from P.
  // IMPORTANT: the box must be ROTATED so its local X axis aligns with miterNormal.
  // An axis-aligned box would straddle the miter plane and incorrectly remove wall bodies.
  const LARGE = 500;
  const miterAngle = Math.atan2(miterNormal.y, miterNormal.x);
  const cutCenter = P.clone().addScaledVector(miterNormal, -LARGE / 2);

  const cutGeom = new THREE.BoxGeometry(LARGE, LARGE, LARGE);
  // Bake rotation (local X → miterNormal) and translation into the geometry so the
  // Evaluator sees a world-space brush at position (0,0,0).
  const cutMatrix = new THREE.Matrix4().makeRotationZ(miterAngle);
  cutMatrix.setPosition(cutCenter.x, cutCenter.y, cutCenter.z);
  cutGeom.applyMatrix4(cutMatrix);

  const mat = Array.isArray(wallA.material) ? wallA.material[0] : wallA.material;
  const cutter = new Brush(cutGeom, mat);
  cutter.position.set(0, 0, 0);
  cutter.rotation.set(0, 0, 0);
  cutter.scale.set(1, 1, 1);
  cutter.updateMatrixWorld(true);
  return cutter;
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

  // Compute miter cutters for all wall-to-wall L-junctions before attempting CSG.
  const wallMembers = members.filter(m => m.userData?.creator === "wall");
  const mitreCutters: Brush[] = [];
  for (let i = 0; i < wallMembers.length; i++) {
    for (let j = i + 1; j < wallMembers.length; j++) {
      const cutter = _wallMiterCutter(wallMembers[i], wallMembers[j]);
      if (cutter) mitreCutters.push(cutter);
    }
  }

  let resultBrush: Brush;
  try {
    const union = buildUnion();
    if (!union) { mitreCutters.forEach(c => c.geometry.dispose()); return; }

    // Apply miter trim: subtract the protrusion zone at each L-junction.
    resultBrush = union;
    for (const cutter of mitreCutters) {
      try {
        const trimmed = _evaluator.evaluate(resultBrush, cutter, SUBTRACTION);
        if (resultBrush !== union) resultBrush.geometry.dispose();
        resultBrush = trimmed;
      } catch (e) {
        console.warn("[join-groups] miter trim failed, skipping", e);
      } finally {
        cutter.geometry.dispose();
      }
    }
  } catch (err) {
    console.warn("[join-groups] CSG union failed for group", groupId, err);
    for (const m of members) m.visible = true;
    mitreCutters.forEach(c => c.geometry.dispose());
    return;
  }

  // Clone material so display mesh doesn't share emissive state with logical members.
  resultBrush.material = (primaryMat as THREE.Material).clone();
  resultBrush.userData.isJoinDisplay = true;
  resultBrush.userData.joinGroupId = groupId;
  resultBrush.userData.noSnap = true;

  scene.add(resultBrush);
  _displayMesh.set(groupId, resultBrush.uuid);
}

/** Dissolve the join group containing mesh `uuid`:
 *  removes the CSG display mesh, restores logical-member visibility,
 *  and clears all group bookkeeping so elements can be moved independently.
 */
export function dissolveGroupForMesh(uuid: string, scene: THREE.Scene): void {
  const groupId = _meshToGroup.get(uuid);
  if (!groupId) return;
  _removeDisplayMesh(scene, groupId);
  const members = _groups.get(groupId);
  if (members) {
    for (const id of members) {
      const obj = scene.getObjectByProperty("uuid", id);
      if (obj) obj.visible = true;
      _meshToGroup.delete(id);
    }
  }
  _groups.delete(groupId);
  _displayMesh.delete(groupId);
}

/** Among the logical members of `groupId`, return the mesh whose bounding-box center
 *  is nearest to `point` in world space. Returns null if no live members exist. */
export function nearestGroupMember(groupId: string, point: THREE.Vector3, scene: THREE.Scene): THREE.Mesh | null {
  const memberIds = _groups.get(groupId);
  if (!memberIds) return null;
  let best: THREE.Mesh | null = null;
  let bestDist = Infinity;
  const center = new THREE.Vector3();
  for (const id of memberIds) {
    const obj = scene.getObjectByProperty("uuid", id);
    if (!(obj instanceof THREE.Mesh)) continue;
    obj.updateMatrixWorld(true);
    new THREE.Box3().setFromObject(obj).getCenter(center);
    const d = point.distanceTo(center);
    if (d < bestDist) { bestDist = d; best = obj; }
  }
  return best;
}

// ── Hover peek: wireframe overlay for the nearest logical member ──────────────

let _peekWireframe: THREE.LineSegments | null = null;
let _peekMemberUuid: string | null = null;

/** Show an edge-wireframe outline of the logical member nearest to `hitPoint`
 *  inside `groupId`. Safe to call on every pointermove — no-ops when same member. */
export function peekNearestMember(groupId: string, hitPoint: THREE.Vector3, scene: THREE.Scene): void {
  const nearest = nearestGroupMember(groupId, hitPoint, scene);
  if (nearest?.uuid === _peekMemberUuid) return; // Same member — skip rebuild
  clearMemberPeek(scene);
  if (!nearest) return;
  nearest.updateMatrixWorld(true);
  const edges = new THREE.EdgesGeometry(nearest.geometry);
  const mat = new THREE.LineBasicMaterial({ color: 0x44aaff, depthTest: false });
  const wf = new THREE.LineSegments(edges, mat);
  wf.matrix.copy(nearest.matrixWorld);
  wf.matrixAutoUpdate = false;
  wf.renderOrder = 10;
  wf.userData.isPeekWireframe = true;
  scene.add(wf);
  _peekWireframe = wf;
  _peekMemberUuid = nearest.uuid;
}

/** Remove any active member peek wireframe. */
export function clearMemberPeek(scene: THREE.Scene): void {
  if (!_peekWireframe) return;
  scene.remove(_peekWireframe);
  (_peekWireframe.geometry as THREE.BufferGeometry).dispose();
  (_peekWireframe.material as THREE.Material).dispose();
  _peekWireframe = null;
  _peekMemberUuid = null;
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
